// @effect-diagnostics nodeBuiltinImport:off - names a scratch directory for files the test opens.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { NodeNvimAdapter } from "../NodeNvimAdapter.ts";
import { makeScratchManager, recordChunks } from "./managerHarness.ts";
import { nvimAvailable, reportMissingNvim } from "./nvimOnPath.ts";

/**
 * While Neovim waits for the rest of a command (`Z` in normal mode), it defers non-fast requests
 * such as `nvim_exec_lua`. A cursor read, viewport or text write then never answered, held the
 * thread's lock, and queued the releasing key behind it: "2 requests waiting longer than 15s".
 */

const layer = NodeNvimAdapter.layer.pipe(Layer.provideMerge(NodeServices.layer));
const THREAD_ID = "waiting-for-key-thread";
/** Far above a real answer, far below the test's own timeout. */
const PATIENCE_MS = 3_000;

/** The call's outcome, or `"no answer"` when it hangs. */
const settleWithin = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.exit,
    Effect.timeoutOption(Duration.millis(PATIENCE_MS)),
    Effect.map((outcome) => (Option.isSome(outcome) ? "answered" : "no answer")),
  );

/** A manager with `lines` open in `relativePath`, and a key lane into it. */
const openScratch = (prefix: string, relativePath: string, lines: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix });
    const manager = yield* makeScratchManager(root);
    yield* manager.open({ threadId: THREAD_ID, cwd: root, relativePath, lines: [...lines] });
    let index = 0;
    const send = (keys: string) =>
      manager.input({ threadId: THREAD_ID, keys, sequence: { lane: prefix, index: index++ } });
    return { manager, root, send };
  });

if (!nvimAvailable) reportMissingNvim("waitingForKey.test.ts");

if (nvimAvailable)
  it.layer(layer, { excludeTestServices: true })(
    "Neovim waiting for the rest of a command (phase 6)",
    (it) => {
      // oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- Real Neovim must answer blocking commands within PATIENCE_MS; retain the enclosing subprocess budget.
      it.effect(
        "a cursor move, a viewport or a text write while Neovim waits for a key does not take the thread",
        () =>
          Effect.gen(function* () {
            const { manager, send } = yield* openScratch("editor-waiting-for-key-", "notes.md", [
              "alpha",
              "beta",
              "gamma",
            ]);
            // `g` waits for the rest of the command, as `Z` did at the base.
            assert.isTrue((yield* send("g")).blocking, "Neovim waits for the rest of `g`");
            assert.strictEqual(
              yield* settleWithin(manager.setCursor({ threadId: THREAD_ID, line: 2, col: 1 })),
              "answered",
              "setCursor",
            );
            assert.strictEqual(
              yield* settleWithin(
                manager.viewport({
                  threadId: THREAD_ID,
                  topline: 1,
                  rows: 20,
                  cols: 80,
                  source: "pointer",
                }),
              ),
              "answered",
              "viewport",
            );
            assert.strictEqual(
              yield* settleWithin(
                manager.replaceText({
                  threadId: THREAD_ID,
                  edits: [{ startLine: 1, startCol: 1, endLine: 1, endCol: 1, text: "x" }],
                }),
              ),
              "answered",
              "replaceText",
            );
            // And the thread still takes keys.
            const done = yield* send("g");
            assert.strictEqual(done.mode, "n");
          }).pipe(Effect.scoped),
        30_000,
      );

      // oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- Real Neovim must answer blocking commands within PATIENCE_MS; retain the enclosing subprocess budget.
      it.effect(
        "an outside write while Neovim waits for a key lands, and typing goes on after it",
        () =>
          Effect.gen(function* () {
            const { manager, send } = yield* openScratch("editor-waiting-write-", "notes.md", [
              "alpha",
              "beta",
              "gamma",
            ]);
            assert.isTrue((yield* send("g")).blocking, "Neovim waits for the rest of `g`");

            // An agent rewrote line 1 while a command was half typed. Refusing the
            // write left the editor on the old text, which the next save wrote back
            // over the agent's (review finding P1-1).
            const written = yield* settleWithin(
              manager.replaceText({
                threadId: THREAD_ID,
                edits: [{ startLine: 1, startCol: 1, endLine: 1, endCol: 6, text: "ALPHA" }],
              }),
            );
            assert.strictEqual(written, "answered");
            yield* send("A!<Esc>");
            const recorder = yield* recordChunks(manager, THREAD_ID);
            const snapshot = recorder.chunks.flat().find((event) => event.type === "snapshot");
            assert.deepStrictEqual(
              snapshot?.type === "snapshot" ? snapshot.snapshot.lines.slice(0, 3) : null,
              ["ALPHA!", "beta", "gamma"],
              "the write survived, and the keys after it typed on top of it",
            );
          }).pipe(Effect.scoped),
        30_000,
      );

      // oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- Real Neovim must answer blocking commands within PATIENCE_MS; retain the enclosing subprocess budget.
      it.effect(
        "opening another file while Neovim waits for a key opens it",
        () =>
          Effect.gen(function* () {
            const { manager, root, send } = yield* openScratch("editor-waiting-open-", "notes.md", [
              "alpha",
              "beta",
            ]);
            assert.isTrue((yield* send("g")).blocking, "Neovim waits for the rest of `g`");

            // `open` holds the thread's lock through non-fast requests, and the key
            // that would release Neovim needs the same lock (review finding P1-3).
            const opened = yield* manager
              .open({ threadId: THREAD_ID, cwd: root, relativePath: "other.md", lines: ["other"] })
              .pipe(Effect.timeoutOption(Duration.millis(PATIENCE_MS)));
            assert.isTrue(Option.isSome(opened), "the open answered");
            if (Option.isSome(opened)) {
              assert.strictEqual(opened.value.relativePath, "other.md");
              assert.deepStrictEqual(opened.value.lines, ["other"]);
            }
            assert.isFalse((yield* send("j")).blocking, "the thread still takes keys");
          }).pipe(Effect.scoped),
        30_000,
      );
    },
  );
