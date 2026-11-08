// Entry point: `VoiceHistoryNotices`, the service behind `voice.subscribeHistory`. This file pins
// the bounded queue's overflow contract, which needs a producer that runs ahead of the reader.
import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { VoiceHistoryNotices, VoiceHistoryNoticesLive } from "./voiceHistoryNotices.ts";

const threadId = ThreadId.make("thread-voice-notice-overflow");
const otherThreadId = ThreadId.make("thread-voice-notice-other");

const appended = (sequence: number, thread: ThreadId = threadId) => ({
  threadId: thread,
  callId: `voice-notice-call-${String(sequence).padStart(4, "0")}`,
  change: "appended" as const,
  sequence,
});

/**
 * Subscribes, publishes every change, lets the delivery fiber drain the hub, then reads `count`
 * items. The service runs on one Effect scheduler, so yielding lets the forked fiber run first.
 */
const readAfterProducerDrained = (
  changes: ReadonlyArray<ReturnType<typeof appended>>,
  capacity: number,
  count: number,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const notices = yield* VoiceHistoryNotices;
      const stream = yield* notices.subscribe(threadId, capacity);
      for (const change of changes) yield* notices.publish(change);
      for (let turn = 0; turn < 10; turn += 1) yield* Effect.yieldNow;
      return Array.from(yield* stream.pipe(Stream.take(count), Stream.runCollect));
    }),
  ).pipe(Effect.provide(VoiceHistoryNoticesLive));

describe("voice history notice stream", () => {
  it.effect(
    "voice history notices replace an overflowed backlog with one resync and continue",
    () =>
      Effect.gen(function* () {
        const items = yield* readAfterProducerDrained(
          [appended(1), appended(2), appended(3), appended(4)],
          2,
          3,
        );

        // Notices 1 and 2 filled the queue; 3 overflowed it, so the backlog became one resync and
        // the reader re-reads everything. Notice 4 still arrives after it.
        assert.deepEqual(items, [
          { kind: "subscribed" },
          { kind: "resync" },
          {
            kind: "call-changed",
            callId: "voice-notice-call-0004",
            change: "appended",
            sequence: 4,
          },
        ]);
      }),
  );

  it.effect("voice history notices within capacity arrive one per change without resync", () =>
    Effect.gen(function* () {
      const items = yield* readAfterProducerDrained([appended(1), appended(2)], 4, 3);
      assert.deepEqual(
        items.map((item) => item.kind),
        ["subscribed", "call-changed", "call-changed"],
      );
    }),
  );

  it.effect("voice history notices for another thread never reach the viewer", () =>
    Effect.gen(function* () {
      const items = yield* readAfterProducerDrained(
        [appended(1, otherThreadId), appended(2), appended(3, otherThreadId)],
        4,
        2,
      );
      assert.deepEqual(items, [
        { kind: "subscribed" },
        { kind: "call-changed", callId: "voice-notice-call-0002", change: "appended", sequence: 2 },
      ]);
    }),
  );
});
