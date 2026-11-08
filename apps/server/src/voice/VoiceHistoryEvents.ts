/**
 * VoiceHistoryEvents - Mesura: voice events in the application event store, as rows with
 * aggregate kind 'voice' that upstream reads, replay and compaction never select, and their
 * projection behind a cursor. One transaction commits an event, its projection and the cursor.
 */
import {
  type OrchestrationV2StoredEvent,
  ThreadId,
  VOICE_HISTORY_CALL_CHANGES,
  VOICE_HISTORY_EVENT_TYPES,
  VoiceHistoryEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../persistence/Errors.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import { ProjectionVoiceCallRepositoryLive } from "../persistence/Layers/ProjectionVoiceCalls.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { ProjectionVoiceCallRepository } from "../persistence/Services/ProjectionVoiceCalls.ts";
import { VoiceHistoryNotices, VoiceHistoryNoticesLive } from "./voiceHistoryNotices.ts";

export const VOICE_EVENT_AGGREGATE_KIND = "voice";
const PROJECTOR = "projection.voice-calls";
const CATCH_UP_PAGE_SIZE = 500;

export interface VoiceHistoryEventsShape {
  /**
   * Commit one voice event and its projection. `commandId` names the operation, as the
   * prototype's command IDs did. Returns the event sequence.
   */
  readonly append: (input: {
    readonly commandId: string;
    readonly occurredAt: string;
    readonly event: VoiceHistoryEvent;
  }) => Effect.Effect<number, ProjectionRepositoryError>;
  /** Apply every pending event. Runs on startup and after a committed thread deletion. */
  readonly catchUp: Effect.Effect<void, ProjectionRepositoryError>;
}

export class VoiceHistoryEvents extends Context.Service<
  VoiceHistoryEvents,
  VoiceHistoryEventsShape
>()("t3/voice/VoiceHistoryEvents") {}

interface SourceRow {
  readonly sequence: number;
  readonly aggregate_kind: string;
  readonly stream_id: string;
  readonly event_type: string;
  readonly payload_json: string;
}

const VoiceEventRow = Schema.fromJsonString(Schema.Unknown);
const decodePayloadJson = Schema.decodeUnknownEffect(VoiceEventRow);
const decodeVoiceEvent = Schema.decodeUnknownEffect(VoiceHistoryEvent);
const encodeVoiceEvent = Schema.encodeEffect(VoiceHistoryEvent);
// The stored `payload_json` is the encoded payload alone, as the prototype stored it.
const encodePayloadJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isVoiceEventType = (type: string): type is VoiceHistoryEvent["type"] =>
  (VOICE_HISTORY_EVENT_TYPES as ReadonlyArray<string>).includes(type);

const makeVoiceHistoryEvents = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const calls = yield* ProjectionVoiceCallRepository;
  const notices = yield* VoiceHistoryNotices;
  const crypto = yield* Crypto.Crypto;
  // One projector at a time: an append and a deletion catch-up must not interleave.
  const projector = yield* Semaphore.make(1);

  const sqlError = (operation: string) => toPersistenceSqlError(`VoiceHistoryEvents.${operation}`);

  const readCursor = sql<{ readonly lastSequence: number }>`
    SELECT last_sequence AS "lastSequence" FROM mesura_voice_projection_state
    WHERE projector = ${PROJECTOR}
  `.pipe(Effect.map((rows) => rows[0]?.lastSequence ?? null));

  const writeCursor = (sequence: number) => sql`
    INSERT INTO mesura_voice_projection_state (projector, last_sequence)
    VALUES (${PROJECTOR}, ${sequence})
    ON CONFLICT (projector) DO UPDATE SET last_sequence = excluded.last_sequence
  `;

  // The WHERE clause matches `idx_mesura_voice_projection_source` exactly, so SQLite uses it.
  const readSourceRows = (afterSequence: number) => sql<SourceRow>`
    SELECT sequence, aggregate_kind, stream_id, event_type, payload_json
    FROM orchestration_events
    WHERE sequence > ${afterSequence}
      AND (
        aggregate_kind = 'voice'
        OR (aggregate_kind = 'thread' AND application_event_version = 2
          AND event_type = 'thread.deleted')
      )
    ORDER BY sequence ASC
    LIMIT ${CATCH_UP_PAGE_SIZE}
  `;

  const applyEvent = (event: VoiceHistoryEvent) => {
    switch (event.type) {
      case "thread.voice-call-started":
        return calls.insertCall({
          callId: event.payload.callId,
          threadId: event.payload.threadId,
          ownerKey: event.payload.ownerKey,
          startedAt: event.payload.startedAt,
        });
      case "thread.voice-transcript-appended":
        return calls.appendFragments({
          callId: event.payload.callId,
          batchId: event.payload.batchId,
          fragments: event.payload.fragments,
        });
      case "thread.voice-call-ended":
        return calls.markEnded({
          callId: event.payload.callId,
          reason: event.payload.reason,
          endedAt: event.payload.endedAt,
          finalSequence: event.payload.lastSequence,
        });
    }
  };

  const applyRow = Effect.fn("VoiceHistoryEvents.applyRow")(function* (row: SourceRow) {
    if (row.aggregate_kind === "thread") {
      // A deleted thread keeps no voice history.
      return yield* calls.deleteByThreadId({ threadId: ThreadId.make(row.stream_id) });
    }
    if (!isVoiceEventType(row.event_type)) {
      return yield* Effect.logWarning("voice projection skipped an unknown voice event type", {
        sequence: row.sequence,
      });
    }
    const event = yield* decodePayloadJson(row.payload_json).pipe(
      Effect.flatMap((payload) => decodeVoiceEvent({ type: row.event_type, payload })),
      Effect.mapError(toPersistenceDecodeError("VoiceHistoryEvents.applyRow:decode")),
    );
    yield* applyEvent(event);
  });

  /** Apply pending rows through the store's head. Callers hold the projector permit. */
  const catchUpLocked = Effect.gen(function* () {
    let cursor = (yield* readCursor.pipe(Effect.mapError(sqlError("catchUp:cursor")))) ?? 0;
    while (true) {
      const rows = yield* readSourceRows(cursor).pipe(Effect.mapError(sqlError("catchUp:read")));
      for (const row of rows) yield* applyRow(row);
      const last = rows.at(-1);
      if (last !== undefined) {
        cursor = last.sequence;
        yield* writeCursor(cursor).pipe(Effect.mapError(sqlError("catchUp:cursor")));
      }
      if (rows.length < CATCH_UP_PAGE_SIZE) return;
    }
  });

  const catchUp: VoiceHistoryEventsShape["catchUp"] = projector.withPermits(1)(
    sql.withTransaction(catchUpLocked).pipe(Effect.mapError(sqlError("catchUp:transaction"))),
  );

  const append: VoiceHistoryEventsShape["append"] = ({ commandId, occurredAt, event }) =>
    projector
      .withPermits(1)(
        sql.withTransaction(
          Effect.gen(function* () {
            const encoded = yield* encodeVoiceEvent(event).pipe(
              Effect.flatMap(({ payload }) => encodePayloadJson(payload)),
              Effect.mapError(toPersistenceDecodeError("VoiceHistoryEvents.append:encode")),
            );
            const eventId = yield* crypto
              .randomUUIDv4()
              .pipe(Effect.mapError(sqlError("append:eventId")));
            const threadId = event.payload.threadId;
            const rows = yield* sql<{ readonly sequence: number }>`
              INSERT INTO orchestration_events (
                event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
                command_id, causation_event_id, correlation_id, actor_kind, payload_json,
                metadata_json, application_event_version
              )
              VALUES (
                ${eventId},
                ${VOICE_EVENT_AGGREGATE_KIND},
                ${threadId},
                COALESCE(
                  (
                    SELECT MAX(stream_version) + 1 FROM orchestration_events
                    WHERE aggregate_kind = ${VOICE_EVENT_AGGREGATE_KIND} AND stream_id = ${threadId}
                  ),
                  0
                ),
                ${event.type},
                ${occurredAt},
                ${commandId},
                NULL,
                ${commandId},
                'server',
                ${encoded},
                '{}',
                2
              )
              RETURNING sequence
            `.pipe(Effect.mapError(sqlError("append:insert")));
            yield* catchUpLocked;
            return rows[0]!.sequence;
          }),
        ),
      )
      .pipe(
        Effect.mapError((cause) =>
          cause._tag === "PersistenceDecodeError" || cause._tag === "PersistenceSqlError"
            ? cause
            : sqlError("append:transaction")(cause),
        ),
        // Published after commit: a viewer that re-reads on a notice finds the write.
        Effect.tap((sequence) =>
          notices.publish({
            threadId: event.payload.threadId,
            callId: event.payload.callId,
            change: VOICE_HISTORY_CALL_CHANGES[event.type],
            sequence,
          }),
        ),
      );

  // A missing cursor means the projection was never built from events: a fresh database, or one
  // the prototype wrote. Rebuild it from the event store, so every row has an event behind it.
  yield* projector.withPermits(1)(
    sql
      .withTransaction(
        Effect.gen(function* () {
          if ((yield* readCursor) !== null) return;
          yield* sql`DELETE FROM projection_voice_batches`;
          yield* sql`DELETE FROM projection_voice_fragments`;
          yield* sql`DELETE FROM projection_voice_calls`;
          yield* writeCursor(0);
        }),
      )
      .pipe(Effect.mapError(sqlError("rebuild"))),
  );
  yield* catchUp;

  return { append, catchUp } satisfies VoiceHistoryEventsShape;
});

const isThreadDeletion = (event: { readonly sequence: number }) =>
  "event" in event && (event as OrchestrationV2StoredEvent).event.type === "thread.deleted";

/**
 * Deletes a thread's voice history when the thread is deleted while the server runs. Startup
 * catch-up covers deletions committed while it was down.
 */
const followThreadDeletions = Layer.effectDiscard(
  Effect.gen(function* () {
    const eventStore = yield* OrchestrationEventStore.OrchestrationEventStore;
    const events = yield* VoiceHistoryEvents;
    const afterSequence = yield* eventStore.latestApplicationSequence;
    yield* Effect.forkScoped(
      eventStore
        .streamProjectedApplicationEvents({
          afterSequence,
          project: (event) => ({ sequence: event.sequence, event }),
          filter: isThreadDeletion,
        })
        .pipe(
          Stream.runForEach(() => events.catchUp),
          Effect.catch((cause) =>
            Effect.logWarning("voice history stopped following thread deletions", { cause }),
          ),
        ),
    );
  }),
);

/** Built after the event store, so startup replay sees every committed event. */
export const VoiceHistoryEventsLive = followThreadDeletions.pipe(
  Layer.provideMerge(Layer.effect(VoiceHistoryEvents, makeVoiceHistoryEvents)),
  Layer.provide(ProjectionVoiceCallRepositoryLive),
  Layer.provideMerge(VoiceHistoryNoticesLive),
);
