import {
  isVoiceHistoryEventType,
  VOICE_HISTORY_CALL_CHANGES,
  type OrchestrationEvent,
  type ThreadId,
  type VoiceHistoryEventType,
  type VoiceHistoryStreamItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

type VoiceHistoryEvent = Extract<OrchestrationEvent, { readonly type: VoiceHistoryEventType }>;

/** A viewer that falls this far behind is told to re-read instead of receiving every notice. */
const MAX_PENDING_NOTICES = 256;

const RESYNC: VoiceHistoryStreamItem = { kind: "resync" };

/**
 * Change notices for one thread's voice history, for an open history viewer.
 *
 * Live delivery is attached before the `subscribed` receipt is emitted, so a viewer that re-reads
 * after the receipt misses no change. A notice names the call, the kind of change and the event
 * sequence; the transcript text and the owner digest stay on the server. The queue is bounded:
 * when it is full, the pending notices are replaced by one `resync`, so a viewer that fell behind
 * re-reads everything rather than silently losing a call's only notice.
 */
export const makeVoiceHistoryNoticeStream = Effect.fn("makeVoiceHistoryNoticeStream")(function* (
  domainEvents: Stream.Stream<OrchestrationEvent>,
  threadId: ThreadId,
  capacity: number = MAX_PENDING_NOTICES,
): Effect.fn.Return<Stream.Stream<VoiceHistoryStreamItem>, never, Scope.Scope> {
  const notices = yield* Queue.dropping<VoiceHistoryStreamItem>(capacity);
  const deliver = Effect.fn("deliverVoiceHistoryNotice")(function* (
    notice: VoiceHistoryStreamItem,
  ) {
    if (yield* Queue.offer(notices, notice)) return;
    yield* Queue.clear(notices);
    yield* Queue.offer(notices, RESYNC);
  });
  yield* Effect.forkScoped(
    domainEvents.pipe(
      Stream.filter(
        (event): event is VoiceHistoryEvent =>
          event.aggregateKind === "thread" &&
          event.aggregateId === threadId &&
          isVoiceHistoryEventType(event.type) &&
          (event as VoiceHistoryEvent).payload.threadId === threadId,
      ),
      Stream.map((event): VoiceHistoryStreamItem => ({
        kind: "call-changed",
        callId: event.payload.callId,
        change: VOICE_HISTORY_CALL_CHANGES[event.type],
        sequence: event.sequence,
      })),
      Stream.runForEach(deliver),
    ),
    { startImmediately: true },
  );
  const subscribed: VoiceHistoryStreamItem = { kind: "subscribed" };
  return Stream.concat(Stream.make(subscribed), Stream.fromQueue(notices));
});
