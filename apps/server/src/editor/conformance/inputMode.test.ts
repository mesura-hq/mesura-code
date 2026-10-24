// @effect-diagnostics nodeBuiltinImport:off - names a scratch directory for files the test opens.
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { EditorSessionInputResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { NodeNvimAdapter } from "../NodeNvimAdapter.ts";
import type * as EditorSessionManager from "../Manager.ts";
import { makeScratchManager, realConfigDirectory } from "./managerHarness.ts";
import { nvimAvailable, reportMissingNvim } from "./nvimOnPath.ts";

/**
 * Entry point: `EditorSessionManager.input`, the handler the websocket layer
 * serves for `editorSession.input` (`wsMesura.ts`), over a real Neovim.
 *
 * Phase 3 of the editor latency cycle: the answer to a key batch says where
 * Neovim is once it has consumed the batch, and the client releases the
 * editor on Escape only on an answer of plain normal mode, not blocking, no
 * flash label. `nvim_input` is asynchronous, so the read has to be one Neovim
 * orders after the keys; each case runs `REPEATS` times, so a read that
 * overtook the keys would show as a stale mode at least once.
 *
 * With `MESURA_NVIM_CONFIG_DIR` set, the same cases run under the developer's
 * configuration, where `f` is flash's and waits in `getcharstr()` with the
 * mode at plain `n`; `s` then a character shows flash's labels.
 */

const layer = NodeNvimAdapter.layer.pipe(Layer.provideMerge(NodeServices.layer));

const THREAD_ID = "input-mode-thread";
const REPEATS = 10;

const scratchManager = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "editor-input-mode-" });
  const manager = yield* makeScratchManager(root);
  yield* manager.open({
    threadId: THREAD_ID,
    cwd: root,
    relativePath: "notes.txt",
    lines: ["alpha beta gamma", "delta epsilon", "zeta"],
  });
  return manager;
});

/** Sends one batch the way the client's key lane does, with a sequence. */
const makeSender = (manager: EditorSessionManager.EditorSessionManager["Service"]) => {
  let index = 0;
  const send = (keys: string) =>
    manager.input({ threadId: THREAD_ID, keys, sequence: { lane: "conformance", index: index++ } });
  return {
    send,
    /** Re-sends batch `at`, as a lane that lost its reply does. */
    resend: (keys: string, at: number) =>
      manager.input({ threadId: THREAD_ID, keys, sequence: { lane: "conformance", index: at } }),
    get lastIndex() {
      return index - 1;
    },
    /** Back to plain normal mode at the top of the file, confirmed by the answer. */
    reset: Effect.gen(function* () {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const answer = yield* send("<Esc>");
        if (answer.mode === "n" && !answer.blocking && !answer.jumping) break;
      }
      return yield* send("gg0");
    }),
  };
};

const describeAnswer = (answer: EditorSessionInputResult) =>
  `${answer.mode}${answer.blocking ? " blocking" : ""}${answer.jumping ? " jumping" : ""}`;

interface ModeCase {
  readonly name: string;
  /** Keys sent and answered before the measured batch. */
  readonly before: ReadonlyArray<string>;
  readonly keys: string;
  readonly expected: string;
}

const CASES: ReadonlyArray<ModeCase> = [
  { name: "i enters insert", before: [], keys: "i", expected: "i" },
  { name: "Escape leaves insert", before: ["i"], keys: "<Esc>", expected: "n" },
  { name: "x then Escape in one batch", before: ["i"], keys: "x<Esc>", expected: "n" },
  { name: "d waits for a motion", before: [], keys: "d", expected: "no" },
  { name: "f waits for a character", before: [], keys: "f", expected: "n blocking" },
  { name: "a count waits for a command", before: [], keys: "3", expected: "n blocking" },
  { name: "l at the end of a line changes nothing", before: ["$"], keys: "l", expected: "n" },
];

if (!nvimAvailable) reportMissingNvim("input-mode harness");

if (nvimAvailable)
  it.layer(layer, { excludeTestServices: true })("the answer to an input batch", (it) => {
    it.effect(
      "answers every input batch with the mode Neovim is in after consuming it",
      () =>
        Effect.gen(function* () {
          const manager = yield* scratchManager;
          const lane = makeSender(manager);
          const seen: Array<string> = [];
          for (const modeCase of CASES) {
            for (let repeat = 0; repeat < REPEATS; repeat += 1) {
              yield* lane.reset;
              for (const keys of modeCase.before) yield* lane.send(keys);
              const answer = yield* lane.send(modeCase.keys);
              if (describeAnswer(answer) !== modeCase.expected) {
                seen.push(`${modeCase.name}: ${describeAnswer(answer)} (try ${repeat + 1})`);
              }
            }
          }
          assert.deepStrictEqual(seen, [], "answers that did not match the keys just consumed");
        }).pipe(Effect.scoped),
      120_000,
    );

    it.effect(
      "answers a re-sent input batch it skipped with the mode Neovim is in now",
      () =>
        Effect.gen(function* () {
          const manager = yield* scratchManager;
          const lane = makeSender(manager);
          yield* lane.reset;
          const entered = yield* lane.send("i");
          const enteredAt = lane.lastIndex;
          assert.strictEqual(describeAnswer(entered), "i");
          const left = yield* lane.send("<Esc>");
          assert.strictEqual(describeAnswer(left), "n");

          // The reply to `i` was lost and the lane sends it again: the server
          // skips it, and the answer is where Neovim is, not where `i` left it.
          const resent = yield* lane.resend("i", enteredAt);
          assert.strictEqual(describeAnswer(resent), "n", "a skipped batch answered a stale mode");
          // And the last batch, sent again, is skipped the same way.
          const resentLast = yield* lane.resend("<Esc>", lane.lastIndex);
          assert.strictEqual(describeAnswer(resentLast), "n");
        }).pipe(Effect.scoped),
      30_000,
    );

    it.effect(
      "answers an open with the escape state Neovim is in",
      () =>
        Effect.gen(function* () {
          const manager = yield* scratchManager;
          const lane = makeSender(manager);
          yield* lane.reset;
          const reopen = (relativePath: string) =>
            manager.open({
              threadId: THREAD_ID,
              cwd: NodeOS.tmpdir(),
              relativePath,
              lines: ["one", "two"],
            });
          const resting = yield* reopen("other.txt");
          assert.deepStrictEqual(resting.escape, { mode: "n", blocking: false, jumping: false });
          // Not asked while a native `f` waits: `open` itself makes calls a
          // blocked Neovim does not answer, before the escape read is reached.
        }).pipe(Effect.scoped),
      30_000,
    );

    if (realConfigDirectory !== null)
      it.effect(
        "answers a flash jump waiting for its label as jumping under the developer's configuration",
        () =>
          Effect.gen(function* () {
            const manager = yield* scratchManager;
            const lane = makeSender(manager);
            const seen: Array<string> = [];
            for (let repeat = 0; repeat < REPEATS; repeat += 1) {
              yield* lane.reset;
              const answer = yield* lane.send("sa");
              if (!answer.jumping) seen.push(`try ${repeat + 1}: ${describeAnswer(answer)}`);
            }
            assert.deepStrictEqual(seen, [], "flash's labels were up and the answer missed them");
          }).pipe(Effect.scoped),
        120_000,
      );
  });
