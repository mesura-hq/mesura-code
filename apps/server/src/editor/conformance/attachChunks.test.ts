import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { EditorSessionEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { NodeNvimAdapter } from "../NodeNvimAdapter.ts";
import { NvimBridge } from "../NvimBridge.ts";
import { makeScratchManager, recordChunks } from "./managerHarness.ts";
import { nvimAvailable, reportMissingNvim } from "./nvimOnPath.ts";

/**
 * One `input` key's `lines` and `cursor` events must share one `attachEventStream` chunk: the RPC
 * server waits for the client's Ack per chunk, so a split chunk makes the caret trail the text.
 * The consumer pulls each chunk at once; a slow consumer would merge the events and pass falsely.
 * Every wait is on an event, never a clock.
 */

const layer = NodeNvimAdapter.layer.pipe(Layer.provideMerge(NodeServices.layer));

const THREAD_ID = "attach-chunks-thread";

const scratchManager = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "editor-attach-chunks-" });
  const manager = yield* makeScratchManager(root);
  return { manager, root };
});

const isMode = (mode: string) => (event: EditorSessionEvent) =>
  event.type === "mode" && event.mode === mode;

const isLines = (text: string) => (event: EditorSessionEvent) =>
  event.type === "lines" && event.lines.includes(text);

const isCursorAt = (line: number, col: number) => (event: EditorSessionEvent) =>
  event.type === "cursor" && event.line === line && event.col === col;

/** The index of the first recorded chunk holding a matching event, or -1. */
const chunkIndexOf = (
  chunks: ReadonlyArray<ReadonlyArray<EditorSessionEvent>>,
  matches: (event: EditorSessionEvent) => boolean,
  from: number,
) => {
  for (let index = from; index < chunks.length; index += 1) {
    if (chunks[index]?.some(matches)) return index;
  }
  return -1;
};

if (!nvimAvailable) reportMissingNvim("attach-chunk harness");

if (nvimAvailable)
  it.layer(layer, { excludeTestServices: true })("the attach stream for one key", (it) => {
    // oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- Real Neovim startup and redraws share this existing subprocess budget; virtual time cannot drive the process.
    it.effect(
      "delivers the lines event and the cursor event of one inserted key in one attach-stream chunk",
      () =>
        Effect.gen(function* () {
          const { manager, root } = yield* scratchManager;
          yield* manager.open({
            threadId: THREAD_ID,
            cwd: root,
            relativePath: "notes.txt",
            lines: ["hello"],
          });
          const { chunks, waitFor } = yield* recordChunks(manager, THREAD_ID);

          yield* manager.input({ threadId: THREAD_ID, keys: "i" });
          yield* waitFor(isMode("i"));

          // Five keys, one at a time, each waited out before the next: one key
          // landing in a single chunk by luck says nothing, five in a row do.
          const typed = "abcde";
          const placements: Array<{ key: string; lines: number; cursor: number }> = [];
          for (let index = 0; index < typed.length; index += 1) {
            const key = typed[index] ?? "";
            const text = `${typed.slice(0, index + 1)}hello`;
            const col = index + 2;
            const from = chunks.length;
            yield* manager.input({ threadId: THREAD_ID, keys: key });
            yield* waitFor(isLines(text));
            yield* waitFor(isCursorAt(1, col));
            placements.push({
              key,
              lines: chunkIndexOf(chunks, isLines(text), from),
              cursor: chunkIndexOf(chunks, isCursorAt(1, col), from),
            });
          }

          for (const placement of placements) {
            assert.strictEqual(
              placement.cursor,
              placement.lines,
              `the cursor for "${placement.key}" arrived in chunk ${placement.cursor}, the text in chunk ${placement.lines}: the caret trails the text by an Ack round trip`,
            );
          }
        }).pipe(Effect.scoped),
      20_000,
    );

    it.effect("sends Neovim no cursor read for a key typed in insert mode", () =>
      Effect.gen(function* () {
        const bridge = yield* NvimBridge.spawn({ cols: 80, rows: 24 });
        yield* bridge.setLines(["hello"]);
        yield* bridge.settle;
        yield* bridge.type("i");

        // The caret for each key comes from Neovim itself, in the same burst
        // as the text; a read per key is a Neovim round trip the text waits on.
        const before = bridge.metrics.cursorReads;
        for (const [index, key] of [..."abcde"].entries()) {
          const moved = yield* Deferred.make<void>();
          const stop = bridge.subscribe((event) => {
            if (event.kind === "cursor" && bridge.cursor.col === index + 2) {
              Deferred.doneUnsafe(moved, Effect.void);
            }
          });
          yield* bridge.input(key);
          yield* Deferred.await(moved);
          stop();
        }
        assert.strictEqual(bridge.metrics.cursorReads - before, 0, "cursor reads for five keys");
      }).pipe(Effect.scoped),
    );

    it.effect("pushes an exact UTF-16 cursor across tabs, accents and wide characters", () =>
      Effect.gen(function* () {
        const bridge = yield* NvimBridge.spawn({ cols: 80, rows: 24 });
        const line = "\tcafé 😀 naïve\tend";
        yield* bridge.setLines([line]);
        yield* bridge.settle;

        const before = bridge.metrics.cursorReads;
        for (const key of ["$", "0", "w", "w", "w", "e", "b"]) {
          const pushed = yield* Deferred.make<void>();
          const stop = bridge.subscribe((event) => {
            if (event.kind === "cursor" && event.source === "push") {
              Deferred.doneUnsafe(pushed, Effect.void);
            }
          });
          yield* bridge.input(key);
          yield* Deferred.await(pushed);
          stop();
          const [row, byte] = (yield* bridge.request("nvim_win_get_cursor", [0])) as [
            number,
            number,
          ];
          const col = Buffer.from(line).subarray(0, byte).toString().length + 1;
          assert.deepStrictEqual(bridge.cursor, { line: row, col }, `after ${key}`);
        }
        assert.strictEqual(bridge.metrics.cursorReads - before, 0, "no cursor read was needed");
      }).pipe(Effect.scoped),
    );

    /**
     * Guard: `type` feeds keys with `nvim_feedkeys`'s `x` flag and answers
     * once they have run, with the cursor and the mode already read back.
     * This phase changes how `input` events are grouped; `type` must keep
     * meaning "done when it returns".
     */
    it.effect("type returns with the keys executed and the cursor and mode read back", () =>
      Effect.gen(function* () {
        const bridge = yield* NvimBridge.spawn({ cols: 80, rows: 24 });
        yield* bridge.setLines(["hello"]);
        yield* bridge.settle;

        yield* bridge.type("Aabc<Esc>");

        assert.strictEqual(bridge.mode, "n");
        assert.deepStrictEqual(bridge.cursor, { line: 1, col: 8 });
        yield* bridge.settle;
        assert.deepStrictEqual([...bridge.lines], ["helloabc"]);
      }).pipe(Effect.scoped),
    );
  });
