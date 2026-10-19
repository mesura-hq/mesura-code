// @effect-diagnostics nodeBuiltinImport:off - writes a scratch configuration for a real Neovim.
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { EditorSessionEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { NodeNvimAdapter } from "../NodeNvimAdapter.ts";
import * as EditorSessionManager from "../Manager.ts";
import { NvimBridge } from "../NvimBridge.ts";
import { nvimAvailable, reportMissingNvim } from "./nvimOnPath.ts";

/**
 * Entry point: `EditorSessionManager.attachEventStream`, the stream the
 * websocket layer serves for `editorSession.attach` (`wsMesura.ts`), over a
 * real Neovim spawned by `NodeNvimAdapter`.
 *
 * Phase 1 of the editor latency cycle, criterion 4: the text change and the
 * cursor move caused by one key reach the client in the same attach-stream
 * chunk. The RPC server sends one stream chunk per message and waits for the
 * client's Ack before it sends the next, so a cursor event that lands one chunk
 * after its `lines` event reaches the client one round trip after the text:
 * the caret trails the letter it typed.
 *
 * The consumer here pulls the next chunk the moment it has recorded the last
 * one, which is the strictest a consumer can be: anything that arrives
 * separately here would arrive separately over the wire too. A slow consumer
 * would let both events pile into one chunk by accident and pass for the
 * wrong reason.
 *
 * Every wait is on an event. The key is `input` (`nvim_input`), the call a
 * keystroke goes through, not `type`.
 */

const layer = NodeNvimAdapter.layer.pipe(Layer.provideMerge(NodeServices.layer));

const THREAD_ID = "attach-chunks-thread";

/**
 * The developer's configuration when `MESURA_NVIM_CONFIG_DIR` names one, as
 * `realConfig.test.ts` reads it; otherwise a directory with an empty
 * `init.lua`, so the real launch path runs in continuous integration too.
 */
const realConfigDirectory = (() => {
  const raw = process.env["MESURA_NVIM_CONFIG_DIR"];
  if (raw === undefined || raw.trim() === "") return null;
  return raw.startsWith("~/") ? `${NodeOS.homedir()}/${raw.slice(2)}` : raw;
})();

const scratchManager = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "editor-attach-chunks-" });
  if (realConfigDirectory !== null) {
    const manager = yield* EditorSessionManager.makeWithOptions({
      configDirectory: realConfigDirectory,
      stateDir: `${root}/state`,
    });
    return { manager, root };
  }
  const configDirectory = `${root}/config`;
  yield* fs.makeDirectory(configDirectory, { recursive: true });
  yield* fs.writeFileString(`${configDirectory}/init.lua`, "-- a configuration\n");
  const manager = yield* EditorSessionManager.makeWithOptions({
    configDirectory,
    stateDir: `${root}/state`,
    homeDir: root,
  });
  return { manager, root };
});

/** Records every chunk the attachment yields, in order, as the RPC server would pull them. */
const recordChunks = (manager: EditorSessionManager.EditorSessionManager["Service"]) =>
  Effect.gen(function* () {
    const chunks: Array<ReadonlyArray<EditorSessionEvent>> = [];
    const watchers = new Set<() => void>();
    const attached = yield* Deferred.make<void>();
    yield* Stream.runForEachArray(
      EditorSessionManager.attachEventStream(manager, { threadId: THREAD_ID }),
      (chunk) =>
        Effect.gen(function* () {
          chunks.push(chunk);
          for (const watcher of watchers) watcher();
          yield* Deferred.succeed(attached, undefined);
        }),
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(attached);

    /** Waits until some recorded event satisfies `matches`. */
    const waitFor = (matches: (event: EditorSessionEvent) => boolean) =>
      Effect.gen(function* () {
        const seen = yield* Deferred.make<void>();
        const check = () => {
          if (chunks.some((chunk) => chunk.some(matches))) Deferred.doneUnsafe(seen, Effect.void);
        };
        watchers.add(check);
        check();
        yield* Deferred.await(seen);
        watchers.delete(check);
      });

    return { chunks, waitFor };
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
          const { chunks, waitFor } = yield* recordChunks(manager);

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
