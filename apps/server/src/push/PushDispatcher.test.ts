/**
 * Phase 3 fence of phone push notifications: acceptance criteria 1 to 6.
 *
 * The harness is in `pushDispatcherHarness.testkit.ts`.
 *
 * Entry point: `PushDispatcher.layer` and its `start()`, which `server.ts`
 * runs as a parked fiber. It is built over the real orchestrator stack:
 * `ProviderReplayHarness` (orchestrator, event sink, projections), the real
 * `ThreadManagementService`, in-memory SQLite with upstream's migrations and
 * `MESURA_SCHEMA_STATEMENTS`, and the real `PushSubscriptions`. Domain events
 * are committed through `EventSinkV2.write`, the path every orchestrator
 * decision takes, so the dispatcher reads them from the live
 * `streamDomainEvents` tail and the thread shells from the projections.
 * Only the edges are fakes: `PushSender` records each send instead of
 * reaching a push service, and `ProjectService` and `ServerEnvironment` answer
 * with one project title and one environment id, as in upstream's relay test.
 *
 * What the specs rely on, from the plan:
 * - `PushDispatcher` has `start(): Effect<void, never, Scope>` and
 *   `drain: Effect<void>`, like `AgentAwarenessRelay`.
 * - `start()` returns after the startup keys are recorded and the dispatcher
 *   is subscribed to the domain events, so an event committed after it
 *   returns is never missed.
 * - Project titles come from `ProjectService.getById` and the environment id
 *   from `ServerEnvironment.getEnvironmentId`, as the relay reads them.
 *
 * No sleeps: `flushSends` commits an approval on a fresh barrier thread, waits
 * for the barrier device to receive it, then drains the dispatcher. Events
 * reach the dispatcher in commit order, so every send caused by an earlier
 * event is recorded by then.
 */
import { DEFAULT_PUSH_PREFERENCES, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  ALL_ON,
  assertAllFor,
  BROKEN,
  DEFAULTS,
  endpointsOf,
  ENVIRONMENT_ID,
  MESSAGE_TEXT,
  NONE,
  PHONE,
  PROJECT_TITLE,
  QUIET,
  TABLET,
  withHarness,
} from "./pushDispatcherHarness.testkit.ts";
import { buildPushPayload } from "./pushPayload.ts";

it.effect(
  "push phase 3 AC1: approval, input and failure each push once to every device that wants that kind",
  () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* h.subscribe(PHONE, DEFAULTS);
        yield* h.subscribe(TABLET, { ...NONE, approval: true, completed: true });
        yield* h.subscribe(QUIET, NONE);
        yield* h.startServer;

        const approval = ThreadId.make("ac1-approval");
        yield* h.createThread(approval, "Needs approval");
        yield* h.startRun(approval);
        yield* h.requestApproval(approval, "request:ac1-approval");
        yield* h.expectPhase(approval, "waiting_for_approval");
        const approvalSends = yield* h.flushSends;
        assert.deepStrictEqual(endpointsOf(approvalSends), [PHONE, TABLET].toSorted());
        assertAllFor(approvalSends, approval);

        const input = ThreadId.make("ac1-input");
        yield* h.createThread(input, "Asks a question");
        yield* h.startRun(input);
        yield* h.requestInput(input, "request:ac1-input");
        yield* h.expectPhase(input, "waiting_for_input");
        const inputSends = yield* h.flushSends;
        assert.deepStrictEqual(endpointsOf(inputSends), [PHONE]);
        assertAllFor(inputSends, input);

        const failed = ThreadId.make("ac1-failed");
        yield* h.createThread(failed, "Breaks");
        yield* h.startRun(failed);
        yield* h.expectPhase(failed, "running");
        assert.deepStrictEqual(yield* h.flushSends, [], "a running thread sends nothing");
        yield* h.finishRun(failed, "failed");
        yield* h.expectPhase(failed, "failed");
        const failedSends = yield* h.flushSends;
        assert.deepStrictEqual(endpointsOf(failedSends), [PHONE]);
        assertAllFor(failedSends, failed);
      }),
    ),
);

it.effect(
  "push phase 3 AC1: one device whose push fails does not keep the others from theirs",
  () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* h.subscribe(BROKEN, DEFAULTS);
        yield* h.subscribe(PHONE, DEFAULTS);
        yield* h.subscribe(TABLET, DEFAULTS);
        yield* h.startServer;

        const threadId = ThreadId.make("ac1-broken");
        yield* h.createThread(threadId, "Needs approval");
        yield* h.startRun(threadId);
        yield* h.requestApproval(threadId, "request:ac1-broken");
        const sent = yield* h.flushSends;
        assert.deepStrictEqual(endpointsOf(sent), [PHONE, TABLET].toSorted());

        // The dispatcher keeps working after the failure.
        const next = ThreadId.make("ac1-after-broken");
        yield* h.createThread(next, "Fails later");
        yield* h.startRun(next);
        yield* h.finishRun(next, "failed");
        assert.deepStrictEqual(endpointsOf(yield* h.flushSends), [PHONE, TABLET].toSorted());
      }),
    ),
);

it.effect(
  "push phase 3 AC2: a completed thread pushes only to devices with the completion preference on",
  () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* h.subscribe(PHONE, DEFAULTS);
        yield* h.subscribe(TABLET, { ...NONE, completed: true });
        yield* h.startServer;

        const threadId = ThreadId.make("ac2-completed");
        yield* h.createThread(threadId, "Finishes");
        yield* h.startRun(threadId);
        yield* h.finishRun(threadId, "completed");
        yield* h.expectPhase(threadId, "completed");
        const sent = yield* h.flushSends;
        assert.deepStrictEqual(endpointsOf(sent), [TABLET]);
        assertAllFor(sent, threadId);
      }),
    ),
);

it.effect(
  "push phase 3 AC2: a device subscribed with the default preferences gets no completion push",
  () =>
    withHarness((h) =>
      Effect.gen(function* () {
        assert.isFalse(DEFAULT_PUSH_PREFERENCES.completed, "completion is off by default");
        yield* h.subscribe(PHONE, DEFAULT_PUSH_PREFERENCES);
        yield* h.startServer;

        const threadId = ThreadId.make("ac2-default");
        yield* h.createThread(threadId, "Finishes");
        yield* h.startRun(threadId);
        yield* h.finishRun(threadId, "completed");
        yield* h.expectPhase(threadId, "completed");
        assert.deepStrictEqual(yield* h.flushSends, []);
      }),
    ),
);

it.effect(
  "push phase 3 AC3: the same pending request pushes once, across later events and a restart",
  () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* h.subscribe(PHONE, DEFAULTS);
        yield* h.startServer;

        const threadId = ThreadId.make("ac3-request");
        yield* h.createThread(threadId, "Needs approval");
        yield* h.startRun(threadId);
        yield* h.requestApproval(threadId, "request:ac3-first");
        assert.deepStrictEqual(endpointsOf(yield* h.flushSends), [PHONE]);
        assert.include(
          (yield* h.dispatchRows).map((row) => row.thread_id),
          threadId,
          "the send key is kept in mesura_push_announced",
        );

        // Later events on the thread, and the same request committed again.
        yield* h.touch(threadId, "Needs approval, renamed");
        yield* h.requestApproval(threadId, "request:ac3-first");
        yield* h.expectPhase(threadId, "waiting_for_approval");
        assert.deepStrictEqual(yield* h.flushSends, [], "no second push for the same request");

        yield* h.restartServer;
        yield* h.touch(threadId, "Needs approval, after the restart");
        assert.deepStrictEqual(yield* h.flushSends, [], "no push for it after a restart");

        // A new request on the same thread is a new reason to push.
        yield* h.resolveRequest(threadId, "request:ac3-first");
        yield* h.requestApproval(threadId, "request:ac3-second");
        yield* h.expectPhase(threadId, "waiting_for_approval");
        assert.deepStrictEqual(endpointsOf(yield* h.flushSends), [PHONE]);

        yield* h.restartServer;
        yield* h.touch(threadId, "Second request, after another restart");
        yield* h.requestApproval(threadId, "request:ac3-second");
        assert.deepStrictEqual(yield* h.flushSends, []);
      }),
    ),
);

it.effect("push phase 3 AC3: a failed thread pushes once, however often it is touched", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      yield* h.subscribe(PHONE, DEFAULTS);
      yield* h.startServer;

      const threadId = ThreadId.make("ac3-failed");
      yield* h.createThread(threadId, "Breaks");
      yield* h.startRun(threadId);
      yield* h.finishRun(threadId, "failed");
      assert.deepStrictEqual(endpointsOf(yield* h.flushSends), [PHONE]);

      yield* h.touch(threadId, "Breaks, renamed");
      yield* h.finishRun(threadId, "failed");
      assert.deepStrictEqual(yield* h.flushSends, []);

      yield* h.restartServer;
      yield* h.touch(threadId, "Breaks, after the restart");
      assert.deepStrictEqual(yield* h.flushSends, []);
    }),
  ),
);

it.effect("push phase 3 AC4: threads that already need attention at startup do not push", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      yield* h.subscribe(PHONE, ALL_ON);

      const approval = ThreadId.make("ac4-approval");
      const input = ThreadId.make("ac4-input");
      const failed = ThreadId.make("ac4-failed");
      const completed = ThreadId.make("ac4-completed");
      yield* h.createThread(approval, "Waiting before the boot");
      yield* h.startRun(approval);
      yield* h.requestApproval(approval, "request:ac4-approval");
      yield* h.createThread(input, "Asking before the boot");
      yield* h.startRun(input);
      yield* h.requestInput(input, "request:ac4-input");
      yield* h.createThread(failed, "Failed before the boot");
      yield* h.startRun(failed);
      yield* h.finishRun(failed, "failed");
      yield* h.createThread(completed, "Finished before the boot");
      yield* h.startRun(completed);
      yield* h.finishRun(completed, "completed");
      yield* h.expectPhase(approval, "waiting_for_approval");
      yield* h.expectPhase(input, "waiting_for_input");
      yield* h.expectPhase(failed, "failed");
      yield* h.expectPhase(completed, "completed");

      yield* h.startServer;
      assert.deepStrictEqual(yield* h.flushSends, [], "the boot itself sends nothing");

      for (const threadId of [approval, input, failed, completed]) {
        yield* h.touch(threadId, `${threadId}, touched after the boot`);
      }
      assert.deepStrictEqual(yield* h.flushSends, [], "nor does a later event on those threads");

      // The startup record does not silence what happens next.
      yield* h.resolveRequest(approval, "request:ac4-approval");
      yield* h.requestApproval(approval, "request:ac4-approval-next");
      const sent = yield* h.flushSends;
      assert.deepStrictEqual(endpointsOf(sent), [PHONE]);
      assertAllFor(sent, approval);
    }),
  ),
);

it.effect(
  "push phase 3 AC5: a device receives the payload buildPushPayload makes, with no message text",
  () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* h.subscribe(PHONE, DEFAULTS);
        yield* h.startServer;

        const threadId = ThreadId.make("ac5-thread");
        yield* h.createThread(threadId, "Wire the dispatcher");
        yield* h.startRun(threadId);
        yield* h.assistantMessage(threadId);
        yield* h.requestApproval(threadId, "request:ac5");
        const awareness = yield* h.expectPhase(threadId, "waiting_for_approval");

        const sent = yield* h.flushSends;
        assert.strictEqual(sent.length, 1);
        const payload = sent[0]!.payload;
        assert.deepStrictEqual(payload, buildPushPayload(awareness!));
        assert.strictEqual(payload.title, PROJECT_TITLE);
        assert.include(payload.body, "Wire the dispatcher");
        assert.strictEqual(payload.tag, `thread:${ENVIRONMENT_ID}:${threadId}`);
        assert.strictEqual(
          payload.url,
          `/${encodeURIComponent(ENVIRONMENT_ID)}/${encodeURIComponent(threadId)}`,
        );
        assert.notInclude(JSON.stringify(payload), MESSAGE_TEXT);
      }),
    ),
);

it.effect("push phase 3 AC6: a thread created by a v1 import never pushes", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      yield* h.subscribe(PHONE, ALL_ON);
      yield* h.startServer;

      const threadId = ThreadId.make("ac6-v1-import");
      yield* h.createThread(threadId, "Imported from v1", { historyOrigin: "v1_import" });
      yield* h.startRun(threadId);
      yield* h.requestApproval(threadId, "request:ac6-import");
      yield* h.expectPhase(threadId, "waiting_for_approval");
      assert.deepStrictEqual(yield* h.flushSends, []);

      yield* h.resolveRequest(threadId, "request:ac6-import");
      yield* h.finishRun(threadId, "failed");
      yield* h.expectPhase(threadId, "failed");
      assert.deepStrictEqual(yield* h.flushSends, []);
    }),
  ),
);

it.effect("push phase 3 AC6: a thread the developer archived never pushes", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      yield* h.subscribe(PHONE, ALL_ON);
      yield* h.startServer;

      const threadId = ThreadId.make("ac6-archived");
      yield* h.createThread(threadId, "Archived");
      yield* h.startRun(threadId);
      yield* h.archive(threadId);
      yield* h.requestApproval(threadId, "request:ac6-archived");
      assert.deepStrictEqual(yield* h.flushSends, []);

      yield* h.resolveRequest(threadId, "request:ac6-archived");
      yield* h.finishRun(threadId, "failed");
      assert.deepStrictEqual(yield* h.flushSends, []);

      // The same thread pushed before it was archived: archiving stops it.
      const later = ThreadId.make("ac6-archived-later");
      yield* h.createThread(later, "Archived later");
      yield* h.startRun(later);
      yield* h.requestApproval(later, "request:ac6-later-first");
      assert.deepStrictEqual(endpointsOf(yield* h.flushSends), [PHONE]);
      yield* h.archive(later);
      yield* h.resolveRequest(later, "request:ac6-later-first");
      yield* h.requestApproval(later, "request:ac6-later-second");
      assert.deepStrictEqual(yield* h.flushSends, []);
    }),
  ),
);

const at = (second: number) =>
  DateTime.makeUnsafe(`2026-10-26T09:00:${String(second).padStart(2, "0")}.000Z`);

it.effect(
  "push phase 3 regression: an older pending request that becomes current again does not push twice",
  () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* h.subscribe(PHONE, DEFAULTS);
        yield* h.startServer;

        const threadId = ThreadId.make("regression-overlap");
        yield* h.createThread(threadId, "Two approvals at once");
        yield* h.startRun(threadId);
        yield* h.requestApproval(threadId, "request:older", at(1));
        assert.deepStrictEqual(endpointsOf(yield* h.flushSends), [PHONE], "the older request");
        yield* h.requestApproval(threadId, "request:newer", at(2));
        assert.strictEqual(
          (yield* h.shellOf(threadId))?.pendingRuntimeRequest?.id,
          "request:newer",
        );
        assert.deepStrictEqual(endpointsOf(yield* h.flushSends), [PHONE], "the newer request");

        // Answering the newer request brings the older one back as current.
        yield* h.resolveRequest(threadId, "request:newer");
        assert.strictEqual(
          (yield* h.shellOf(threadId))?.pendingRuntimeRequest?.id,
          "request:older",
        );
        yield* h.expectPhase(threadId, "waiting_for_approval");
        assert.deepStrictEqual(yield* h.flushSends, [], "the older request was already announced");

        // The announced keys survive a restart, not only the latest one.
        yield* h.requestApproval(threadId, "request:third", at(3));
        assert.deepStrictEqual(endpointsOf(yield* h.flushSends), [PHONE]);
        yield* h.restartServer;
        yield* h.resolveRequest(threadId, "request:third");
        assert.strictEqual(
          (yield* h.shellOf(threadId))?.pendingRuntimeRequest?.id,
          "request:older",
        );
        assert.deepStrictEqual(yield* h.flushSends, [], "nor after a restart");

        yield* h.resolveRequest(threadId, "request:older");
        yield* h.requestApproval(threadId, "request:fourth", at(4));
        assert.deepStrictEqual(
          endpointsOf(yield* h.flushSends),
          [PHONE],
          "a new request still pushes",
        );
      }),
    ),
);

it.effect.each(["secret_request", "link_request"] as const)(
  "push phase 3 regression: a %s card pushes once as a question and its answer pushes nothing",
  (type) =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* h.subscribe(PHONE, DEFAULTS);
        yield* h.subscribe(TABLET, { ...NONE, approval: true });
        yield* h.startServer;

        const threadId = ThreadId.make(`regression-${type}`);
        yield* h.createThread(threadId, "Needs a card answered");
        yield* h.startRun(threadId);
        assert.deepStrictEqual(yield* h.flushSends, []);
        yield* h.inputCard(threadId, `card:${type}`, type, true);
        yield* h.expectPhase(threadId, "waiting_for_input");
        const sent = yield* h.flushSends;
        assert.deepStrictEqual(endpointsOf(sent), [PHONE], "input preference only");
        assertAllFor(sent, threadId);

        yield* h.inputCard(threadId, `card:${type}`, type, false);
        yield* h.expectPhase(threadId, "running");
        assert.deepStrictEqual(yield* h.flushSends, []);
      }),
    ),
);

it.effect(
  "push phase 3 regression: the thread shell carries the v1 import origin the dispatcher reads",
  () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("regression-v1-shell");
        yield* h.createThread(threadId, "Imported from v1", { historyOrigin: "v1_import" });
        assert.strictEqual((yield* h.shellOf(threadId))?.historyOrigin, "v1_import");
      }),
    ),
);
