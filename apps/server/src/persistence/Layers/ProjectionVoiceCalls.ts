import {
  NonNegativeInt,
  PositiveInt,
  VoiceCallId,
  VoiceHistoryItemId,
  VoiceTranscriptSpeaker,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  EndProjectionVoiceCallInput,
  GetProjectionVoiceBatchInput,
  InsertProjectionVoiceCallInput,
  ProjectionVoiceCall,
  ProjectionVoiceCallRepository,
  type ProjectionVoiceCallRepositoryShape,
  type ProjectionVoiceFragment,
  voiceBatchContentDigest,
} from "../Services/ProjectionVoiceCalls.ts";

const ProjectionVoiceFragmentRow = Schema.Struct({
  fragmentId: VoiceHistoryItemId,
  batchId: VoiceHistoryItemId,
  sequence: PositiveInt,
  speaker: VoiceTranscriptSpeaker,
  text: Schema.String,
  startOffsetMs: Schema.NullOr(NonNegativeInt),
  endOffsetMs: Schema.NullOr(NonNegativeInt),
});
type ProjectionVoiceFragmentRow = typeof ProjectionVoiceFragmentRow.Type;

// Absent offsets stay absent: a fragment reads back exactly as it was sent.
const toFragment = (row: ProjectionVoiceFragmentRow): ProjectionVoiceFragment => ({
  fragmentId: row.fragmentId,
  batchId: row.batchId,
  sequence: row.sequence,
  speaker: row.speaker,
  text: row.text,
  ...(row.startOffsetMs === null ? {} : { startOffsetMs: row.startOffsetMs }),
  ...(row.endOffsetMs === null ? {} : { endOffsetMs: row.endOffsetMs }),
});

const makeProjectionVoiceCallRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const callColumns = sql`
    call_id AS "callId",
    thread_id AS "threadId",
    owner_key AS "ownerKey",
    started_at AS "startedAt",
    ended_at AS "endedAt",
    end_reason AS "endReason",
    final_sequence AS "finalSequence",
    last_sequence AS "lastSequence"
  `;
  const fragmentColumns = sql`
    fragment_id AS "fragmentId",
    batch_id AS "batchId",
    sequence,
    speaker,
    text,
    start_offset_ms AS "startOffsetMs",
    end_offset_ms AS "endOffsetMs"
  `;

  const insertCallRow = SqlSchema.void({
    Request: InsertProjectionVoiceCallInput,
    execute: (row) => sql`
      INSERT INTO projection_voice_calls (call_id, thread_id, owner_key, started_at)
      VALUES (${row.callId}, ${row.threadId}, ${row.ownerKey}, ${row.startedAt})
      ON CONFLICT (call_id) DO NOTHING
    `,
  });

  const markEndedRow = SqlSchema.void({
    Request: EndProjectionVoiceCallInput,
    execute: (row) => sql`
      UPDATE projection_voice_calls
      SET
        ended_at = COALESCE(ended_at, ${row.endedAt}),
        end_reason = COALESCE(end_reason, ${row.reason}),
        final_sequence = COALESCE(final_sequence, ${row.finalSequence})
      WHERE call_id = ${row.callId}
    `,
  });

  const getCallRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ callId: VoiceCallId }),
    Result: ProjectionVoiceCall,
    execute: ({ callId }) => sql`
      SELECT ${callColumns} FROM projection_voice_calls WHERE call_id = ${callId}
    `,
  });

  const getBatchDigestRow = SqlSchema.findOneOption({
    Request: GetProjectionVoiceBatchInput,
    Result: Schema.Struct({ contentDigest: Schema.String }),
    execute: ({ callId, batchId }) => sql`
      SELECT content_digest AS "contentDigest" FROM projection_voice_batches
      WHERE call_id = ${callId} AND batch_id = ${batchId}
    `,
  });

  const decodeCalls = Schema.decodeUnknownEffect(Schema.Array(ProjectionVoiceCall));
  const decodeFragments = Schema.decodeUnknownEffect(Schema.Array(ProjectionVoiceFragmentRow));

  const insertCall: ProjectionVoiceCallRepositoryShape["insertCall"] = (input) =>
    insertCallRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionVoiceCallRepository.insertCall:query")),
    );

  // The voice projector runs this inside the event append transaction.
  const appendFragments: ProjectionVoiceCallRepositoryShape["appendFragments"] = Effect.fn(
    "ProjectionVoiceCallRepository.appendFragments",
  )(
    function* (input) {
      yield* sql`
        INSERT INTO projection_voice_batches (call_id, batch_id, content_digest)
        VALUES (${input.callId}, ${input.batchId}, ${voiceBatchContentDigest(input.fragments)})
        ON CONFLICT (call_id, batch_id) DO NOTHING
      `;
      for (const fragment of input.fragments) {
        yield* sql`
          INSERT INTO projection_voice_fragments (
            call_id, sequence, fragment_id, batch_id, speaker, text, start_offset_ms, end_offset_ms
          )
          VALUES (
            ${input.callId},
            ${fragment.sequence},
            ${fragment.fragmentId},
            ${input.batchId},
            ${fragment.speaker},
            ${fragment.text},
            ${fragment.startOffsetMs ?? null},
            ${fragment.endOffsetMs ?? null}
          )
          ON CONFLICT (call_id, sequence) DO NOTHING
        `;
      }
      const highest = Math.max(...input.fragments.map((fragment) => fragment.sequence));
      yield* sql`
        UPDATE projection_voice_calls
        SET last_sequence = MAX(last_sequence, ${highest})
        WHERE call_id = ${input.callId}
      `;
    },
    Effect.mapError(toPersistenceSqlError("ProjectionVoiceCallRepository.appendFragments:query")),
  );

  const markEnded: ProjectionVoiceCallRepositoryShape["markEnded"] = (input) =>
    markEndedRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionVoiceCallRepository.markEnded:query")),
    );

  const deleteByThreadId: ProjectionVoiceCallRepositoryShape["deleteByThreadId"] = Effect.fn(
    "ProjectionVoiceCallRepository.deleteByThreadId",
  )(
    function* ({ threadId }) {
      yield* sql`
        DELETE FROM projection_voice_fragments
        WHERE call_id IN (SELECT call_id FROM projection_voice_calls WHERE thread_id = ${threadId})
      `;
      yield* sql`
        DELETE FROM projection_voice_batches
        WHERE call_id IN (SELECT call_id FROM projection_voice_calls WHERE thread_id = ${threadId})
      `;
      yield* sql`DELETE FROM projection_voice_calls WHERE thread_id = ${threadId}`;
    },
    Effect.mapError(toPersistenceSqlError("ProjectionVoiceCallRepository.deleteByThreadId:query")),
  );

  // Mesura: reads the v2 thread row directly; a missing or deleted thread holds no voice history.
  const isLiveThread: ProjectionVoiceCallRepositoryShape["isLiveThread"] = ({ threadId }) =>
    sql<{ readonly deletedAt: string | null }>`
      SELECT deleted_at AS "deletedAt" FROM orchestration_v2_projection_threads
      WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map((rows) => rows.length > 0 && rows[0]!.deletedAt === null),
      Effect.mapError(toPersistenceSqlError("ProjectionVoiceCallRepository.isLiveThread:query")),
    );

  const getCall: ProjectionVoiceCallRepositoryShape["getCall"] = (input) =>
    getCallRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionVoiceCallRepository.getCall:query")),
    );

  const listCalls: ProjectionVoiceCallRepositoryShape["listCalls"] = ({
    threadId,
    limit,
    before,
  }) =>
    sql`
      SELECT ${callColumns} FROM projection_voice_calls
      WHERE thread_id = ${threadId}
      ${
        before === null
          ? sql``
          : sql`AND (
              started_at < ${before.startedAt}
              OR (started_at = ${before.startedAt} AND call_id < ${before.callId})
            )`
      }
      ORDER BY started_at DESC, call_id DESC
      LIMIT ${limit}
    `.pipe(
      Effect.flatMap(decodeCalls),
      Effect.mapError(toPersistenceSqlError("ProjectionVoiceCallRepository.listCalls:query")),
    );

  const listOpenCalls: ProjectionVoiceCallRepositoryShape["listOpenCalls"] = () =>
    sql`
      SELECT ${callColumns} FROM projection_voice_calls
      WHERE ended_at IS NULL
      ORDER BY started_at ASC, call_id ASC
    `.pipe(
      Effect.flatMap(decodeCalls),
      Effect.mapError(toPersistenceSqlError("ProjectionVoiceCallRepository.listOpenCalls:query")),
    );

  const listFragments: ProjectionVoiceCallRepositoryShape["listFragments"] = ({
    callId,
    afterSequence,
    limit,
  }) =>
    sql`
      SELECT ${fragmentColumns} FROM projection_voice_fragments
      WHERE call_id = ${callId} AND sequence > ${afterSequence}
      ORDER BY sequence ASC
      LIMIT ${limit}
    `.pipe(
      Effect.flatMap(decodeFragments),
      Effect.map((rows) => rows.map(toFragment)),
      Effect.mapError(toPersistenceSqlError("ProjectionVoiceCallRepository.listFragments:query")),
    );

  const findFragments: ProjectionVoiceCallRepositoryShape["findFragments"] = ({
    callId,
    sequences,
    fragmentIds,
  }) =>
    sql`
      SELECT ${fragmentColumns} FROM projection_voice_fragments
      WHERE call_id = ${callId}
        AND (${sql.in("sequence", sequences)} OR ${sql.in("fragment_id", fragmentIds)})
      ORDER BY sequence ASC
    `.pipe(
      Effect.flatMap(decodeFragments),
      Effect.map((rows) => rows.map(toFragment)),
      Effect.mapError(toPersistenceSqlError("ProjectionVoiceCallRepository.findFragments:query")),
    );

  const getBatchDigest: ProjectionVoiceCallRepositoryShape["getBatchDigest"] = (input) =>
    getBatchDigestRow(input).pipe(
      Effect.map((row) => row.pipe(Option.map(({ contentDigest }) => contentDigest))),
      Effect.mapError(toPersistenceSqlError("ProjectionVoiceCallRepository.getBatchDigest:query")),
    );

  return {
    insertCall,
    appendFragments,
    markEnded,
    deleteByThreadId,
    isLiveThread,
    getCall,
    listCalls,
    listOpenCalls,
    listFragments,
    findFragments,
    getBatchDigest,
  } satisfies ProjectionVoiceCallRepositoryShape;
});

export const ProjectionVoiceCallRepositoryLive = Layer.effect(
  ProjectionVoiceCallRepository,
  makeProjectionVoiceCallRepository,
);
