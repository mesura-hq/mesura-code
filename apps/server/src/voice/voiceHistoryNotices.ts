import type { ThreadId, VoiceHistoryCallChange, VoiceHistoryStreamItem } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/** One committed voice event. It never carries transcript text or the owner digest. */
export interface VoiceHistoryChange {
  readonly threadId: ThreadId;
  readonly callId: string;
  readonly change: VoiceHistoryCallChange;
  /** The event store sequence of the committed voice event. */
  readonly sequence: number;
}

/** A viewer that falls this far behind is told to re-read instead of receiving every notice. */
const MAX_PENDING_NOTICES = 256;

const RESYNC: VoiceHistoryStreamItem = { kind: "resync" };

export interface VoiceHistoryNoticesShape {
  /** Called by `VoiceHistoryEvents` after an event commits. */
  readonly publish: (change: VoiceHistoryChange) => Effect.Effect<void>;
  /** Change notices for one thread, for an open history viewer. */
  readonly subscribe: (
    threadId: ThreadId,
    capacity?: number,
  ) => Effect.Effect<Stream.Stream<VoiceHistoryStreamItem>, never, Scope.Scope>;
}

export class VoiceHistoryNotices extends Context.Service<
  VoiceHistoryNotices,
  VoiceHistoryNoticesShape
>()("t3/voice/voiceHistoryNotices") {}

/**
 * Live delivery is attached before `subscribed`, so a viewer that re-reads then misses nothing.
 * A full per-viewer queue becomes one `resync`: a lagging viewer re-reads instead of losing a
 * call's only notice.
 */
const makeVoiceHistoryNotices = Effect.gen(function* () {
  const hub = yield* PubSub.unbounded<VoiceHistoryChange>();

  const publish: VoiceHistoryNoticesShape["publish"] = (change) =>
    PubSub.publish(hub, change).pipe(Effect.asVoid);

  const subscribe: VoiceHistoryNoticesShape["subscribe"] = Effect.fn(
    "VoiceHistoryNotices.subscribe",
  )(function* (threadId, capacity = MAX_PENDING_NOTICES) {
    const notices = yield* Queue.dropping<VoiceHistoryStreamItem>(capacity);
    const deliver = Effect.fn("deliverVoiceHistoryNotice")(function* (
      notice: VoiceHistoryStreamItem,
    ) {
      if (yield* Queue.offer(notices, notice)) return;
      yield* Queue.clear(notices);
      yield* Queue.offer(notices, RESYNC);
    });
    const subscription = yield* PubSub.subscribe(hub);
    yield* Effect.forkScoped(
      Stream.fromSubscription(subscription).pipe(
        Stream.filter((change) => change.threadId === threadId),
        Stream.map((change): VoiceHistoryStreamItem => ({
          kind: "call-changed",
          callId: change.callId,
          change: change.change,
          sequence: change.sequence,
        })),
        Stream.runForEach(deliver),
      ),
      { startImmediately: true },
    );
    const subscribed: VoiceHistoryStreamItem = { kind: "subscribed" };
    return Stream.concat(Stream.make(subscribed), Stream.fromQueue(notices));
  });

  return { publish, subscribe } satisfies VoiceHistoryNoticesShape;
});

export const VoiceHistoryNoticesLive = Layer.effect(VoiceHistoryNotices, makeVoiceHistoryNotices);
