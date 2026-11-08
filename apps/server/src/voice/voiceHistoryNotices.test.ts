// Entry point: makeVoiceHistoryNoticeStream, the stream behind orchestration.subscribeVoiceHistory.
// The composed WebSocket route is covered by VH-I1 in server.test.ts; this file pins the bounded
// queue's overflow contract, which needs a producer that runs ahead of the reader.
import { EventId, ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { makeVoiceHistoryNoticeStream } from "./voiceHistoryNotices.ts";

const threadId = ThreadId.make("thread-voice-notice-overflow");

const appended = (sequence: number): OrchestrationEvent =>
  ({
    sequence,
    eventId: EventId.make(`event-voice-notice-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: "2026-11-08T10:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.voice-transcript-appended",
    payload: {
      threadId,
      callId: `voice-notice-call-${String(sequence).padStart(4, "0")}`,
      batchId: `batch-${sequence}`,
      fragments: [{ fragmentId: `fragment-${sequence}`, sequence: 1, speaker: "user", text: "x" }],
      appendedAt: "2026-11-08T10:00:01.000Z",
    },
  }) as OrchestrationEvent;

/** Reads `count` items, after the producer has offered every notice for `events`. */
const readAfterProducerDrained = (
  events: ReadonlyArray<OrchestrationEvent>,
  capacity: number,
  count: number,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const drained = yield* Deferred.make<void>();
      const stream = yield* makeVoiceHistoryNoticeStream(
        Stream.concat(
          Stream.fromIterable(events),
          Stream.fromEffectDrain(Deferred.succeed(drained, undefined)),
        ),
        threadId,
        capacity,
      );
      yield* Deferred.await(drained);
      return Array.from(yield* stream.pipe(Stream.take(count), Stream.runCollect));
    }),
  );

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
});
