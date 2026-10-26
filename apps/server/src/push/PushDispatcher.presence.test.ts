/**
 * Phase 4 fence of phone push notifications: acceptance criteria 3 to 6 on
 * the dispatcher.
 *
 * Entry point: `PushDispatcher.layer` and its `start()`, over the phase 3
 * harness (`pushDispatcherHarness.testkit.ts`: the real orchestrator
 * stack, the real `PushSubscriptions`, a recording `PushSender`). The real
 * `ClientPresence` is added to the dispatcher's context, wrapped only so a
 * spec can see each time the dispatcher asks `isAnyClientActive()`.
 *
 * How a held push is observed without sleeps: the harness's `flushSends`
 * needs a push to reach its barrier device, which a held push never does.
 * While a client is active, a spec instead commits the one event under test,
 * waits for the dispatcher to ask the presence map or for a send, whichever
 * comes first, drains the dispatcher, and then reads the recorded sends. Before that, it clears the questions the
 * barrier traffic asked.
 *
 * Time is the `TestClock` of `it.effect`.
 */
import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as ClientPresence from "./ClientPresence.ts";
import {
  DEFAULTS,
  endpointsOf,
  type Harness,
  PHONE,
  withHarness,
} from "./pushDispatcherHarness.testkit.ts";

interface PresenceFixture {
  readonly presence: ClientPresence.ClientPresence["Service"];
  /** One entry per `isAnyClientActive()` the dispatcher asked, with its answer. */
  readonly asked: Queue.Queue<boolean>;
}

const withPresenceHarness = <E>(
  body: (h: Harness, fixture: PresenceFixture) => Effect.Effect<void, E>,
) =>
  Effect.gen(function* () {
    const presence = Context.get(
      yield* Layer.build(ClientPresence.layer),
      ClientPresence.ClientPresence,
    );
    const asked = yield* Queue.unbounded<boolean>();
    const observed = ClientPresence.ClientPresence.of({
      ...presence,
      isAnyClientActive: () =>
        presence.isAnyClientActive().pipe(Effect.tap((active) => Queue.offer(asked, active))),
    });
    yield* withHarness(
      (h) => body(h, { presence, asked }),
      Layer.succeed(ClientPresence.ClientPresence, observed),
    );
  }).pipe(Effect.scoped);

/** A thread with a running run, settled, and the questions so far cleared. */
const runningThread = (h: Harness, fixture: PresenceFixture, threadId: ThreadId) =>
  Effect.gen(function* () {
    yield* h.createThread(threadId, `Thread ${threadId}`);
    yield* h.startRun(threadId);
    assert.deepStrictEqual(yield* h.flushSends, [], "a running thread sends nothing");
    yield* Queue.clear(fixture.asked);
  });

/** Commits one approval while a client is active and returns what was sent for it. */
const approvalWhileActive = (
  h: Harness,
  fixture: PresenceFixture,
  threadId: ThreadId,
  requestId: string,
) =>
  Effect.gen(function* () {
    yield* h.requestApproval(threadId, requestId);
    yield* h.expectPhase(threadId, "waiting_for_approval");
    // A dispatcher that never asks pushes instead; the race reports that
    // rather than waiting forever for a question.
    const first = yield* Effect.raceFirst(
      Queue.take(fixture.asked).pipe(Effect.map((active) => ({ asked: active }) as const)),
      h.nextRecordedSend.pipe(Effect.map((send) => ({ sent: send }) as const)),
    );
    if ("sent" in first) return [first.sent];
    assert.isTrue(first.asked, "the dispatcher saw an active client");
    yield* h.drain;
    return yield* h.takeRecordedSends;
  });

it.effect("push phase 4 AC3: no push goes out while one connected client reports active", () =>
  withPresenceHarness((h, fixture) =>
    Effect.gen(function* () {
      yield* h.subscribe(PHONE, DEFAULTS);
      yield* h.startServer;
      const threadId = ThreadId.make("p4-ac3-held");
      yield* runningThread(h, fixture, threadId);

      yield* fixture.presence.report("phone", false);
      yield* fixture.presence.report("desktop", true);
      const sent = yield* approvalWhileActive(h, fixture, threadId, "request:p4-ac3-held");

      assert.deepStrictEqual(sent, [], "the approval was held");
    }),
  ),
);

it.effect(
  "push phase 4 AC5: a push held while the developer was active is not sent when they leave",
  () =>
    withPresenceHarness((h, fixture) =>
      Effect.gen(function* () {
        yield* h.subscribe(PHONE, DEFAULTS);
        yield* h.startServer;
        const threadId = ThreadId.make("p4-ac5-dropped");
        yield* runningThread(h, fixture, threadId);
        yield* fixture.presence.report("desktop", true);
        assert.deepStrictEqual(
          yield* approvalWhileActive(h, fixture, threadId, "request:p4-ac5-first"),
          [],
        );

        yield* fixture.presence.disconnect("desktop");
        // A change the awareness filter passes that leaves the thread waiting on
        // the same request: a queued push would go out now.
        yield* h.touch(threadId, "Renamed while nobody watched");
        assert.deepStrictEqual(yield* h.flushSends, [], "the held approval stays dropped");

        // A new request after the developer left is a new push.
        yield* h.requestApproval(threadId, "request:p4-ac5-second");
        assert.deepStrictEqual(endpointsOf(yield* h.flushSends), [PHONE]);
      }),
    ),
);

it.effect("push phase 4 AC4: once the active client's connection closes, pushes go out again", () =>
  withPresenceHarness((h, fixture) =>
    Effect.gen(function* () {
      yield* h.subscribe(PHONE, DEFAULTS);
      yield* h.startServer;
      const threadId = ThreadId.make("p4-ac4-closed");
      yield* runningThread(h, fixture, threadId);
      yield* fixture.presence.report("desktop", true);

      yield* fixture.presence.disconnect("desktop");
      yield* h.requestApproval(threadId, "request:p4-ac4-closed");

      assert.deepStrictEqual(endpointsOf(yield* h.flushSends), [PHONE]);
    }),
  ),
);

it.effect(
  "push phase 4 AC4: once two minutes pass with no report from the active client, pushes go out again",
  () =>
    withPresenceHarness((h, fixture) =>
      Effect.gen(function* () {
        yield* h.subscribe(PHONE, DEFAULTS);
        yield* h.startServer;
        const threadId = ThreadId.make("p4-ac4-stale");
        yield* runningThread(h, fixture, threadId);
        yield* fixture.presence.report("desktop", true);

        yield* TestClock.adjust("2 minutes");
        yield* h.requestApproval(threadId, "request:p4-ac4-stale");

        assert.deepStrictEqual(endpointsOf(yield* h.flushSends), [PHONE]);
      }),
    ),
);

it.effect("push phase 4 AC6: with every client reporting inactive, pushes send as before", () =>
  withPresenceHarness((h, fixture) =>
    Effect.gen(function* () {
      yield* h.subscribe(PHONE, DEFAULTS);
      yield* h.startServer;
      const threadId = ThreadId.make("p4-ac6-inactive");
      yield* runningThread(h, fixture, threadId);
      yield* fixture.presence.report("phone", false);
      yield* fixture.presence.report("desktop", false);

      yield* h.requestApproval(threadId, "request:p4-ac6-inactive");

      assert.deepStrictEqual(endpointsOf(yield* h.flushSends), [PHONE]);
    }),
  ),
);
