// @effect-diagnostics nodeBuiltinImport:off - owner keys are one-way SHA-256 digests.
/**
 * VoiceHistory - Mesura: the persisted record of spoken voice calls.
 *
 * A call's history lives in the orchestration event store as thread.voice-* events, dispatched
 * through `OrchestrationEngine`. An accepted dispatch has already committed its event, its
 * projection rows and its receipt in one transaction, so every acknowledgement here reads back
 * what it wrote. The projection rows are rebuilt by replay; there is no second journal.
 *
 * Ownership is checked against the persisted call. A call ID is not a credential.
 */
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  type OrchestrationCommand,
  type ThreadId,
  VOICE_HISTORY_DEFAULT_PAGE_SIZE,
  type VoiceCallEndReason,
  type VoiceCallPage,
  type VoiceCallSummary,
  VoiceConversationError,
  type VoiceTranscriptFragment,
  type VoiceTranscriptPage,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { isOrchestrationCommandRejection } from "../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { ProjectionVoiceCallRepositoryLive } from "../persistence/Layers/ProjectionVoiceCalls.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import {
  type ProjectionVoiceCall,
  type ProjectionVoiceCallCursor,
  ProjectionVoiceCallRepository,
  type ProjectionVoiceFragment,
  voiceBatchContentDigest,
} from "../persistence/Services/ProjectionVoiceCalls.ts";

export interface VoiceHistoryShape {
  /** Reject a call ID already used by another client, thread, or an ended call. */
  readonly assertCanStart: (input: {
    readonly threadId: ThreadId;
    readonly callId: string;
    readonly ownerId: string;
  }) => Effect.Effect<void, VoiceConversationError>;
  /** Record a started call. Repeating the same start is a no-op. */
  readonly start: (input: {
    readonly threadId: ThreadId;
    readonly callId: string;
    readonly ownerId: string;
  }) => Effect.Effect<void, VoiceConversationError>;
  readonly append: (input: {
    readonly callId: string;
    readonly ownerId: string;
    readonly batchId: string;
    readonly fragments: ReadonlyArray<VoiceTranscriptFragment>;
  }) => Effect.Effect<{ readonly lastSequence: number }, VoiceConversationError>;
  /**
   * The owner's end. It records the hangup of an open call, or the final transcript boundary of
   * a call that already ended. An unknown call is left to the live session manager. A boundary
   * below the stored fragments is rejected, but an open call still records its hangup without
   * a boundary, so the owner can declare a valid one later.
   */
  readonly end: (input: {
    readonly callId: string;
    readonly ownerId: string;
    readonly lastSequence: number | undefined;
  }) => Effect.Effect<void, VoiceConversationError>;
  /**
   * Record a call the server ended. The owner may declare its final boundary later. When the
   * end cannot be stored, it stays pending with its first reason and time.
   */
  readonly endByServer: (input: {
    readonly callId: string;
    readonly ownerId: string;
    readonly reason: Exclude<VoiceCallEndReason, "hangup">;
  }) => Effect.Effect<void, VoiceConversationError>;
  /** Retry every pending server-side end. Each failure stays pending for the next retry. */
  readonly retryPendingServerEnds: Effect.Effect<void>;
  readonly listCalls: (input: {
    readonly threadId: ThreadId;
    readonly requesterOwnerId: string;
    readonly limit: number | undefined;
    readonly cursor: string | undefined;
  }) => Effect.Effect<VoiceCallPage, VoiceConversationError>;
  readonly listFragments: (input: {
    readonly threadId: ThreadId;
    readonly callId: string;
    readonly requesterOwnerId: string;
    readonly limit: number | undefined;
    readonly afterSequence: number | undefined;
  }) => Effect.Effect<VoiceTranscriptPage, VoiceConversationError>;
}

export class VoiceHistory extends Context.Service<VoiceHistory, VoiceHistoryShape>()(
  "t3/voice/VoiceHistory",
) {}

const unavailable = () =>
  new VoiceConversationError({ status: 404, message: "That voice call is unavailable." });
const conflict = (message: string) => new VoiceConversationError({ status: 409, message });
const storageFailure = () =>
  new VoiceConversationError({
    status: 502,
    message: "The voice history could not be saved or read. Try again.",
  });

/** The owner identity is stored only as a digest, so events never carry a session credential. */
const ownerKeyOf = (ownerId: string) =>
  NodeCrypto.createHash("sha256").update(ownerId).digest("hex");

// The call page cursor is the keyset position of the last call shown: [startedAt, callId].
const VoiceCallCursorJson = Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String]));
const encodeCursorJson = Schema.encodeSync(VoiceCallCursorJson);
const decodeCursorJson = Schema.decodeUnknownOption(VoiceCallCursorJson);

const encodeCursor = (cursor: ProjectionVoiceCallCursor) =>
  Buffer.from(encodeCursorJson([cursor.startedAt, cursor.callId])).toString("base64url");

const decodeCursor = (cursor: string): ProjectionVoiceCallCursor | null =>
  Option.match(decodeCursorJson(Buffer.from(cursor, "base64url").toString("utf8")), {
    onNone: () => null,
    onSome: ([startedAt, callId]) => ({ startedAt, callId }),
  });

const sameFragment = (stored: ProjectionVoiceFragment, fragment: VoiceTranscriptFragment) =>
  stored.fragmentId === fragment.fragmentId &&
  stored.speaker === fragment.speaker &&
  stored.text === fragment.text &&
  stored.startOffsetMs === fragment.startOffsetMs &&
  stored.endOffsetMs === fragment.endOffsetMs;

const toFragment = ({ batchId: _batchId, ...fragment }: ProjectionVoiceFragment) => fragment;

const toSummary = (call: ProjectionVoiceCall, requesterOwnerId: string): VoiceCallSummary => ({
  callId: call.callId,
  threadId: call.threadId,
  startedAt: call.startedAt,
  endedAt: call.endedAt,
  endReason: call.endReason,
  finalSequence: call.finalSequence,
  lastSequence: call.lastSequence,
  ownedByRequester: call.ownerKey === ownerKeyOf(requesterOwnerId),
});

const makeVoiceHistory = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const calls = yield* ProjectionVoiceCallRepository;
  const threads = yield* ProjectionThreadRepository;
  // Validation and dispatch of one operation must not interleave with another. The engine
  // already runs commands one at a time, so one permit costs no parallelism.
  const writes = yield* Semaphore.make(1);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const dispatch = (command: OrchestrationCommand) =>
    engine.dispatch(command).pipe(
      Effect.asVoid,
      // The only rejection a voice command has is a missing or deleted thread.
      Effect.mapError((error) =>
        isOrchestrationCommandRejection(error) ? unavailable() : storageFailure(),
      ),
    );

  const readCall = (callId: string) =>
    calls.getCall({ callId }).pipe(Effect.mapError(storageFailure));

  const readOwnedCall = Effect.fn("VoiceHistory.readOwnedCall")(function* (
    callId: string,
    ownerId: string,
  ) {
    const call = yield* readCall(callId);
    if (Option.isNone(call) || call.value.ownerKey !== ownerKeyOf(ownerId)) {
      return yield* unavailable();
    }
    return call.value;
  });

  // A server-side end the store has not accepted yet. Audio already closed; the end keeps its
  // first reason and time and is retried before any later write on the call and by every
  // completed sweep. It lives in this process: after a restart the call recovers as interrupted.
  const pendingServerEnds = new Map<
    string,
    {
      readonly ownerId: string;
      readonly reason: Exclude<VoiceCallEndReason, "hangup">;
      readonly endedAt: string;
    }
  >();

  /** Store a pending server-side end. Callers hold the write permit. */
  const settlePendingServerEnd = Effect.fn("VoiceHistory.settlePendingServerEnd")(function* (
    callId: string,
  ) {
    const pending = pendingServerEnds.get(callId);
    if (pending === undefined) return;
    const call = yield* readCall(callId);
    if (
      Option.isSome(call) &&
      call.value.ownerKey === ownerKeyOf(pending.ownerId) &&
      call.value.endedAt === null
    ) {
      yield* endWithoutBoundary(call.value, pending.reason, pending.endedAt);
    }
    pendingServerEnds.delete(callId);
  });

  const requireLiveThread = Effect.fn("VoiceHistory.requireLiveThread")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* threads.getById({ threadId }).pipe(Effect.mapError(storageFailure));
    if (Option.isNone(thread) || thread.value.deletedAt !== null) {
      return yield* unavailable();
    }
  });

  const assertCanStart: VoiceHistoryShape["assertCanStart"] = Effect.fn(
    "VoiceHistory.assertCanStart",
  )(function* ({ threadId, callId, ownerId }) {
    const existing = yield* readCall(callId);
    if (Option.isNone(existing)) return;
    const call = existing.value;
    if (call.ownerKey !== ownerKeyOf(ownerId) || call.threadId !== threadId) {
      return yield* unavailable();
    }
    if (call.endedAt !== null) return yield* conflict("That voice call has ended.");
  });

  const start: VoiceHistoryShape["start"] = (input) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        yield* assertCanStart(input);
        if (Option.isSome(yield* readCall(input.callId))) return;
        yield* dispatch({
          type: "thread.voice-call.start",
          commandId: CommandId.make(`voice:${input.callId}:start`),
          threadId: input.threadId,
          callId: input.callId,
          ownerKey: ownerKeyOf(input.ownerId),
          startedAt: yield* nowIso,
        });
      }),
    );

  const append: VoiceHistoryShape["append"] = ({ callId, ownerId, batchId, fragments }) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        for (let index = 1; index < fragments.length; index += 1) {
          const previous = fragments[index - 1]!;
          const fragment = fragments[index]!;
          if (
            fragment.sequence <= previous.sequence ||
            fragments.some(
              (other, otherIndex) => otherIndex < index && other.fragmentId === fragment.fragmentId,
            )
          ) {
            return yield* new VoiceConversationError({
              status: 400,
              message: "Transcript fragments need increasing sequences and distinct IDs.",
            });
          }
        }
        yield* settlePendingServerEnd(callId);
        const call = yield* readOwnedCall(callId, ownerId);
        // A batch ID is bound to the complete request it was first accepted with. An exact
        // retry returns here, before the engine's receipt could answer for changed content.
        const acceptedDigest = yield* calls
          .getBatchDigest({ callId, batchId })
          .pipe(Effect.mapError(storageFailure));
        if (Option.isSome(acceptedDigest)) {
          if (acceptedDigest.value !== voiceBatchContentDigest(fragments)) {
            return yield* conflict("A transcript batch ID was re-sent with different content.");
          }
          return { lastSequence: call.lastSequence };
        }
        const stored = yield* calls
          .findFragments({
            callId,
            sequences: fragments.map((fragment) => fragment.sequence),
            fragmentIds: fragments.map((fragment) => fragment.fragmentId),
          })
          .pipe(Effect.mapError(storageFailure));
        const storedBySequence = new Map(stored.map((entry) => [entry.sequence, entry]));
        const newFragments: Array<VoiceTranscriptFragment> = [];
        for (const fragment of fragments) {
          const atSequence = storedBySequence.get(fragment.sequence);
          if (atSequence !== undefined) {
            if (!sameFragment(atSequence, fragment)) {
              return yield* conflict("A transcript fragment was re-sent with different content.");
            }
            continue;
          }
          if (stored.some((entry) => entry.fragmentId === fragment.fragmentId)) {
            return yield* conflict("A transcript fragment ID was reused for different content.");
          }
          newFragments.push(fragment);
        }
        const highest = newFragments.at(-1)?.sequence ?? call.lastSequence;
        if (newFragments.length > 0 && newFragments[0]!.sequence <= call.lastSequence) {
          return yield* conflict("A transcript fragment arrived after later fragments.");
        }
        if (
          newFragments.length > 0 &&
          call.endedAt !== null &&
          (call.finalSequence === null || highest > call.finalSequence)
        ) {
          return yield* conflict("That voice call has ended.");
        }
        // The event carries the complete batch, also when every fragment is already stored, so
        // the batch identity survives restart and replay. Stored fragments keep their content.
        yield* dispatch({
          type: "thread.voice-transcript.append",
          commandId: CommandId.make(`voice:${callId}:batch:${batchId}`),
          threadId: call.threadId,
          callId,
          batchId,
          fragments,
          appendedAt: yield* nowIso,
        });
        return { lastSequence: Math.max(highest, call.lastSequence) };
      }),
    );

  const end: VoiceHistoryShape["end"] = ({ callId, ownerId, lastSequence }) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        yield* settlePendingServerEnd(callId);
        const existing = yield* readCall(callId);
        if (Option.isNone(existing)) return;
        const call = yield* readOwnedCall(callId, ownerId);
        const belowStored = lastSequence !== undefined && lastSequence < call.lastSequence;
        if (call.endedAt === null) {
          // The hangup is recorded even when its boundary is rejected: audio ended either way.
          yield* dispatch({
            type: "thread.voice-call.end",
            commandId: CommandId.make(`voice:${callId}:end`),
            threadId: call.threadId,
            callId,
            reason: "hangup",
            lastSequence: belowStored ? null : (lastSequence ?? call.lastSequence),
            endedAt: yield* nowIso,
          });
        }
        if (belowStored) {
          return yield* conflict("The final transcript sequence is below stored fragments.");
        }
        if (call.endedAt === null) return;
        if (call.finalSequence !== null) {
          // The boundary is declared once. Repeating it is a retry; another value is a conflict.
          if (lastSequence !== undefined && lastSequence !== call.finalSequence) {
            return yield* conflict("The call already has a different final transcript sequence.");
          }
          return;
        }
        if (lastSequence === undefined) return;
        // The call ended without a boundary: a server-side end, or a hangup whose boundary was
        // rejected. The owner now bounds its pending flush; the original reason and time stay.
        yield* dispatch({
          type: "thread.voice-call.end",
          commandId: CommandId.make(`voice:${callId}:final`),
          threadId: call.threadId,
          callId,
          reason: call.endReason ?? "interrupted",
          lastSequence,
          endedAt: call.endedAt,
        });
      }),
    );

  const endWithoutBoundary = (
    call: ProjectionVoiceCall,
    reason: VoiceCallEndReason,
    endedAt: string,
  ) =>
    dispatch({
      type: "thread.voice-call.end",
      commandId: CommandId.make(`voice:${call.callId}:end`),
      threadId: call.threadId,
      callId: call.callId,
      reason,
      lastSequence: null,
      endedAt,
    });

  const endByServer: VoiceHistoryShape["endByServer"] = ({ callId, ownerId, reason }) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        if (!pendingServerEnds.has(callId)) {
          pendingServerEnds.set(callId, { ownerId, reason, endedAt: yield* nowIso });
        }
        yield* settlePendingServerEnd(callId);
      }),
    );

  const retryPendingServerEnds: VoiceHistoryShape["retryPendingServerEnds"] = writes.withPermits(1)(
    Effect.suspend(() =>
      Effect.forEach(
        [...pendingServerEnds.keys()],
        (callId) =>
          settlePendingServerEnd(callId).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("voice history could not record a server-side call end", {
                callId,
                cause,
              }),
            ),
          ),
        { discard: true },
      ),
    ),
  );

  const listCalls: VoiceHistoryShape["listCalls"] = Effect.fn("VoiceHistory.listCalls")(function* ({
    threadId,
    requesterOwnerId,
    limit,
    cursor,
  }) {
    yield* requireLiveThread(threadId);
    const before = cursor === undefined ? null : decodeCursor(cursor);
    if (cursor !== undefined && before === null) {
      return yield* new VoiceConversationError({
        status: 400,
        message: "The voice call page cursor is invalid.",
      });
    }
    const pageSize = limit ?? VOICE_HISTORY_DEFAULT_PAGE_SIZE;
    const rows = yield* calls
      .listCalls({ threadId, limit: pageSize + 1, before })
      .pipe(Effect.mapError(storageFailure));
    const page = rows.slice(0, pageSize);
    const last = page.at(-1);
    return {
      calls: page.map((call) => toSummary(call, requesterOwnerId)),
      nextCursor: rows.length > pageSize && last !== undefined ? encodeCursor(last) : null,
    };
  });

  const listFragments: VoiceHistoryShape["listFragments"] = Effect.fn("VoiceHistory.listFragments")(
    function* ({ threadId, callId, requesterOwnerId, limit, afterSequence }) {
      yield* requireLiveThread(threadId);
      const call = yield* readCall(callId);
      if (Option.isNone(call) || call.value.threadId !== threadId) {
        return yield* unavailable();
      }
      const pageSize = limit ?? VOICE_HISTORY_DEFAULT_PAGE_SIZE;
      const rows = yield* calls
        .listFragments({ callId, afterSequence: afterSequence ?? 0, limit: pageSize + 1 })
        .pipe(Effect.mapError(storageFailure));
      const page = rows.slice(0, pageSize);
      const last = page.at(-1);
      return {
        call: toSummary(call.value, requesterOwnerId),
        fragments: page.map(toFragment),
        nextAfterSequence: rows.length > pageSize && last !== undefined ? last.sequence : null,
      };
    },
  );

  // A call still open after a restart lost its audio session with the old process. It is
  // recorded as interrupted, without a boundary, so its owner can still flush pending text.
  yield* calls.listOpenCalls().pipe(
    Effect.flatMap((openCalls) =>
      Effect.forEach(
        openCalls,
        (call) =>
          writes.withPermits(1)(
            Effect.flatMap(nowIso, (endedAt) => endWithoutBoundary(call, "interrupted", endedAt)),
          ),
        { discard: true },
      ),
    ),
    Effect.catch((cause) =>
      Effect.logWarning("voice history could not recover interrupted calls", { cause }),
    ),
  );

  return {
    assertCanStart,
    start,
    append,
    end,
    endByServer,
    retryPendingServerEnds,
    listCalls,
    listFragments,
  } satisfies VoiceHistoryShape;
});

/** Built after the engine, so recovery runs after the event replay. */
export const VoiceHistoryLive = Layer.effect(VoiceHistory, makeVoiceHistory).pipe(
  Layer.provide(ProjectionVoiceCallRepositoryLive),
  Layer.provide(ProjectionThreadRepositoryLive),
);
