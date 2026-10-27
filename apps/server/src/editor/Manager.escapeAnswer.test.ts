import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { createManager } from "./Manager.testkit.ts";

/**
 * `EditorSessionManager.input` against the fake Neovim. When the read after the keys
 * (`modeAfterKeys`) fails or hangs, Neovim already has the keys: the batch succeeds, is recorded
 * once and answers `blocking`. A failed batch would make the client send the keys again.
 */

const THREAD_ID = "thread-escape-answer";

const isEscapeRead = (method: string, params: ReadonlyArray<unknown>) =>
  method === "nvim_exec_lua" && String(params[0]).includes("mesura.escape_state");

it.layer(NodeServices.layer)("the answer to an input batch", (it) => {
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
        const escapeRead = yield* Deferred.make<void>();
        fake.holdReplies((method, params) => {
          if (!isEscapeRead(method, params)) return false;
          Deferred.doneUnsafe(escapeRead, Effect.void);
          return true;
        });

        const answered = yield* Deferred.make<void>();
        const started = yield* Clock.currentTimeMillis;
        const answering = yield* manager
          .input({
            threadId: THREAD_ID,
            keys: "l",
            sequence: { lane: "L", index: 0 },
          })
          .pipe(Effect.ensuring(Deferred.succeed(answered, undefined)), Effect.forkChild);
        yield* Deferred.await(escapeRead);
        yield* TestClock.adjust("199 millis");
        assert.isFalse(
          yield* Deferred.isDone(answered),
          "the answer did not wait for the escape read at all",
        );
        yield* TestClock.adjust("51 millis");
        const answer = yield* Fiber.join(answering);
        const waited = (yield* Clock.currentTimeMillis) - started;

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
});
