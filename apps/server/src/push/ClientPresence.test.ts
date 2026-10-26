/**
 * Phase 4 fence of phone push notifications: acceptance criteria 3 and 4 on
 * the presence map itself.
 *
 * Entry point: `ClientPresence.layer`, the server-scope service the
 * dispatcher asks before it sends and the `push.presence` handler reports
 * into. Time is the `TestClock` of `it.effect`, so the two-minute window
 * moves only through `TestClock.adjust`.
 *
 * What the specs rely on, from the plan:
 * - `report(connectionId, active)` records one connection's latest report.
 * - `disconnect(connectionId)` ends that connection's state.
 * - `isAnyClientActive()` is true while at least one connection's latest
 *   report is active and younger than two minutes.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ClientPresence from "./ClientPresence.ts";

const withPresence = <E>(
  body: (presence: ClientPresence.ClientPresence["Service"]) => Effect.Effect<void, E>,
) =>
  Effect.gen(function* () {
    const presence = yield* ClientPresence.ClientPresence;
    yield* body(presence);
  }).pipe(Effect.provide(ClientPresence.layer));

describe("ClientPresence phase 4 fence (AC3: any active client holds pushes)", () => {
  it.effect("push phase 4 AC3: with no report from any client, nobody counts as active", () =>
    withPresence((presence) =>
      Effect.gen(function* () {
        assert.isFalse(yield* presence.isAnyClientActive());
      }),
    ),
  );

  it.effect("push phase 4 AC3: one connection reporting active makes the host active", () =>
    withPresence((presence) =>
      Effect.gen(function* () {
        yield* presence.report("desktop", true);
        assert.isTrue(yield* presence.isAnyClientActive());
      }),
    ),
  );

  it.effect(
    "push phase 4 AC3: one active connection beside an inactive one keeps the host active",
    () =>
      withPresence((presence) =>
        Effect.gen(function* () {
          yield* presence.report("phone", false);
          yield* presence.report("desktop", true);
          assert.isTrue(yield* presence.isAnyClientActive());
          yield* presence.report("phone", false);
          assert.isTrue(yield* presence.isAnyClientActive(), "the phone's report changes nothing");
        }),
      ),
  );

  it.effect("push phase 4 AC3: a connection's inactive report replaces its active one", () =>
    withPresence((presence) =>
      Effect.gen(function* () {
        yield* presence.report("desktop", true);
        yield* presence.report("desktop", false);
        assert.isFalse(yield* presence.isAnyClientActive());
      }),
    ),
  );
});

describe("ClientPresence phase 4 fence (AC4: active ends on close or after two minutes)", () => {
  it.effect("push phase 4 AC4: an active connection that closes no longer counts as active", () =>
    withPresence((presence) =>
      Effect.gen(function* () {
        yield* presence.report("desktop", true);
        yield* presence.disconnect("desktop");
        assert.isFalse(yield* presence.isAnyClientActive());
      }),
    ),
  );

  it.effect(
    "push phase 4 AC4: closing one connection leaves another active connection active",
    () =>
      withPresence((presence) =>
        Effect.gen(function* () {
          yield* presence.report("desktop", true);
          yield* presence.report("browser-tab", true);
          yield* presence.disconnect("desktop");
          assert.isTrue(yield* presence.isAnyClientActive());
          yield* presence.disconnect("browser-tab");
          assert.isFalse(yield* presence.isAnyClientActive());
        }),
      ),
  );

  it.effect("push phase 4 AC4: closing a connection that never reported changes nothing", () =>
    withPresence((presence) =>
      Effect.gen(function* () {
        yield* presence.report("desktop", true);
        yield* presence.disconnect("never-reported");
        assert.isTrue(yield* presence.isAnyClientActive());
      }),
    ),
  );

  it.effect(
    "push phase 4 AC4: an active report counts until two minutes pass with no report, then not",
    () =>
      withPresence((presence) =>
        Effect.gen(function* () {
          yield* presence.report("desktop", true);
          yield* TestClock.adjust("119 seconds");
          assert.isTrue(yield* presence.isAnyClientActive(), "1:59 after the report");
          yield* TestClock.adjust("1 second");
          assert.isFalse(yield* presence.isAnyClientActive(), "2:00 after the report");
        }),
      ),
  );

  it.effect("push phase 4 AC4: a fresh active report restarts the two-minute window", () =>
    withPresence((presence) =>
      Effect.gen(function* () {
        yield* presence.report("desktop", true);
        yield* TestClock.adjust("90 seconds");
        yield* presence.report("desktop", true);
        yield* TestClock.adjust("90 seconds");
        assert.isTrue(yield* presence.isAnyClientActive(), "1:30 after the latest report");
        yield* TestClock.adjust("30 seconds");
        assert.isFalse(yield* presence.isAnyClientActive(), "2:00 after the latest report");
      }),
    ),
  );

  it.effect("push phase 4 AC4: a stale connection does not hide a fresh one", () =>
    withPresence((presence) =>
      Effect.gen(function* () {
        yield* presence.report("asleep-laptop", true);
        yield* TestClock.adjust("3 minutes");
        yield* presence.report("desktop", true);
        assert.isTrue(yield* presence.isAnyClientActive());
      }),
    ),
  );
});

/** Opens one `holdReport` call and returns its fiber once the report is held. */
const openHold = (
  presence: ClientPresence.ClientPresence["Service"],
  connectionId: string,
  active: boolean,
) =>
  Effect.gen(function* () {
    const held = yield* Deferred.make<void>();
    const call = yield* presence.holdReport(connectionId, active).pipe(
      Stream.runForEach(() => Deferred.succeed(held, undefined)),
      Effect.forkScoped,
    );
    yield* Deferred.await(held);
    return call;
  });

describe("ClientPresence phase 4 regression (holdReport, the push.presence call)", () => {
  it.effect("push phase 4 regression: a held report ends when its call is interrupted", () =>
    withPresence((presence) =>
      Effect.gen(function* () {
        const call = yield* openHold(presence, "desktop", true);
        assert.isTrue(yield* presence.isAnyClientActive());
        yield* Fiber.interrupt(call);
        assert.isFalse(yield* presence.isAnyClientActive());
      }).pipe(Effect.scoped),
    ),
  );

  // The client interrupts its previous call to replace it, and the server can
  // finish that interrupt after the newer call already recorded its report.
  it.effect(
    "push phase 4 regression: ending a replaced call keeps the newer report from the same connection",
    () =>
      withPresence((presence) =>
        Effect.gen(function* () {
          const older = yield* openHold(presence, "desktop", false);
          const newer = yield* openHold(presence, "desktop", true);
          yield* Fiber.interrupt(older);
          assert.isTrue(yield* presence.isAnyClientActive(), "the newer report survives");
          yield* Fiber.interrupt(newer);
          assert.isFalse(yield* presence.isAnyClientActive());
        }).pipe(Effect.scoped),
      ),
  );
});
