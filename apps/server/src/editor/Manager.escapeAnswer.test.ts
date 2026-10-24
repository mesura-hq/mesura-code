import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createManager } from "./Manager.testkit.ts";

/**
 * Entry point: `EditorSessionManager.input`, against the fake Neovim.
 *
 * The answer to a key batch is read after Neovim took the keys (`modeAfterKeys`
 * in `Manager.ts`). When that read fails or never answers, the keys are
 * Neovim's already: the batch has to succeed, be recorded once, and answer
 * `blocking`, so the client keeps the next Escape for Neovim. A failed batch
 * would make the client send the keys again.
 */

const THREAD_ID = "thread-escape-answer";

const isEscapeRead = (method: string, params: ReadonlyArray<unknown>) =>
  method === "nvim_exec_lua" && String(params[0]).includes("mesura.escape_state");

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "the answer to an input batch",
  (it) => {
    it.effect(
      "answers a batch as blocking when the escape read never comes back, and records it once",
      () =>
        Effect.gen(function* () {
          const { manager, fake, root } = yield* createManager();
          yield* manager.open({
            threadId: THREAD_ID,
            cwd: root,
            relativePath: "a.ts",
            lines: [""],
          });
          const inputs = () => fake.calls.filter((call) => call.method === "nvim_input");
          // A Neovim that started waiting for a key after `nvim_get_mode` said
          // plain normal: the flash read is held past its patience.
          fake.holdReplies(isEscapeRead);

          const started = performance.now();
          const answer = yield* manager.input({
            threadId: THREAD_ID,
            keys: "l",
            sequence: { lane: "L", index: 0 },
          });
          const waited = performance.now() - started;

          assert.deepStrictEqual(answer, { mode: "n", blocking: true, jumping: false });
          assert.isAtLeast(waited, 200, "the answer did not wait for the escape read at all");
          fake.releaseReplies();

          // The client re-sends only on a failure; a re-send that happens anyway
          // is skipped, so the keys reach Neovim once.
          yield* manager.input({
            threadId: THREAD_ID,
            keys: "l",
            sequence: { lane: "L", index: 0 },
          });
          assert.deepStrictEqual(
            inputs().map((call) => call.params[0]),
            ["l"],
            "a batch whose escape read timed out was given to Neovim again",
          );
        }).pipe(Effect.scoped),
      10_000,
    );

    it.effect("answers a batch as blocking when nvim_get_mode fails, and records it once", () =>
      Effect.gen(function* () {
        const { manager, fake, root } = yield* createManager();
        yield* manager.open({ threadId: THREAD_ID, cwd: root, relativePath: "a.ts", lines: [""] });
        const inputs = () => fake.calls.filter((call) => call.method === "nvim_input");
        fake.failReplies((method) => method === "nvim_get_mode");

        const answer = yield* manager.input({
          threadId: THREAD_ID,
          keys: "i",
          sequence: { lane: "L", index: 0 },
        });
        assert.strictEqual(answer.blocking, true, "a failed mode read answered as resting");

        yield* manager.input({ threadId: THREAD_ID, keys: "i", sequence: { lane: "L", index: 0 } });
        assert.deepStrictEqual(
          inputs().map((call) => call.params[0]),
          ["i"],
          "a batch whose mode read failed was given to Neovim again",
        );
      }).pipe(Effect.scoped),
    );

    it.effect("answers a plain normal batch from nvim_get_mode and the escape read together", () =>
      Effect.gen(function* () {
        const { manager, fake, root } = yield* createManager();
        yield* manager.open({ threadId: THREAD_ID, cwd: root, relativePath: "a.ts", lines: [""] });
        fake.respondWith((method, params) =>
          isEscapeRead(method, params) ? { waiting: true, jumping: false } : null,
        );

        const waiting = yield* manager.input({
          threadId: THREAD_ID,
          keys: "f",
          sequence: { lane: "L", index: 0 },
        });
        assert.deepStrictEqual(
          waiting,
          { mode: "n", blocking: true, jumping: false },
          "a command waiting in state() answered as resting",
        );

        fake.respondWith((method, params) =>
          isEscapeRead(method, params) ? { waiting: false, jumping: true } : null,
        );
        const jumping = yield* manager.input({
          threadId: THREAD_ID,
          keys: "sa",
          sequence: { lane: "L", index: 1 },
        });
        assert.deepStrictEqual(jumping, { mode: "n", blocking: false, jumping: true });

        // Not plain normal: the escape read is skipped, one fast call is the cost.
        fake.mode = { mode: "i", blocking: false };
        const before = fake.calls.filter((call) => isEscapeRead(call.method, call.params)).length;
        const typing = yield* manager.input({
          threadId: THREAD_ID,
          keys: "x",
          sequence: { lane: "L", index: 2 },
        });
        assert.deepStrictEqual(typing, { mode: "i", blocking: false, jumping: false });
        assert.strictEqual(
          fake.calls.filter((call) => isEscapeRead(call.method, call.params)).length,
          before,
          "a batch typed in insert mode paid for the escape read",
        );
      }).pipe(Effect.scoped),
    );
  },
);
