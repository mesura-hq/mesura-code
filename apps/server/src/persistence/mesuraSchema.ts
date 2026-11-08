import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Mesura: the fork's own tables, created with idempotent DDL on every boot after upstream's
 * migrations. A fork table never takes a migration id: the migrator runs only ids above the
 * latest recorded one, so a fork id would hide upstream's next migration under that number.
 * A change to an upstream table still needs a migration and `reconcileMesuraMigrations.ts`.
 */
export const MESURA_SCHEMA_STATEMENTS: ReadonlyArray<string> = [
  // The current agent icon search for each project (`ProjectIconDiscoveryState`
  // JSON). One row per project with a search; absent means no search yet.
  `CREATE TABLE IF NOT EXISTS mesura_project_icon_discovery (
    project_id TEXT PRIMARY KEY NOT NULL,
    state_json TEXT NOT NULL
  )`,
  // One row per device subscribed to Web Push (`push/PushSubscriptions.ts`),
  // keyed by its push endpoint. `preferences_json` is `PushPreferences` JSON.
  `CREATE TABLE IF NOT EXISTS mesura_push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    label TEXT NOT NULL,
    preferences_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_success_at TEXT,
    last_failure TEXT
  )`,
  // Every push reason each thread has announced (`push/PushDispatcher.ts`),
  // so a repeated or returning state does not push twice. The dispatcher keeps
  // the newest 32 keys per thread.
  `CREATE TABLE IF NOT EXISTS mesura_push_announced (
    thread_id TEXT NOT NULL,
    push_key TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, push_key)
  )`,
  // Voice history (`voice/VoiceHistoryEvents.ts`): events under aggregate kind 'voice', and the
  // rebuildable projection below. The voice prototype stored the same events as v1 thread rows,
  // which `ProjectionMaintenance` deletes once a thread is imported; moving them keeps every ID,
  // sequence and payload, and a subset of a stream's versions stays unique.
  `UPDATE orchestration_events SET aggregate_kind = 'voice'
    WHERE aggregate_kind = 'thread'
      AND event_type IN (
        'thread.voice-call-started', 'thread.voice-transcript-appended', 'thread.voice-call-ended'
      )`,
  // The voice projector reads voice rows and v2 thread deletions in sequence order.
  `CREATE INDEX IF NOT EXISTS idx_mesura_voice_projection_source
    ON orchestration_events(sequence)
    WHERE aggregate_kind = 'voice'
      OR (aggregate_kind = 'thread' AND application_event_version = 2
        AND event_type = 'thread.deleted')`,
  // One row: the last event sequence the voice projection applied. Absent means rebuild.
  `CREATE TABLE IF NOT EXISTS mesura_voice_projection_state (
    projector TEXT PRIMARY KEY NOT NULL,
    last_sequence INTEGER NOT NULL
  )`,
  // `final_sequence` is the owner's transcript boundary: NULL while the call is open and after a
  // server-side end until the owner declares it. `last_sequence` is the highest stored fragment.
  `CREATE TABLE IF NOT EXISTS projection_voice_calls (
    call_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    owner_key TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    end_reason TEXT,
    final_sequence INTEGER,
    last_sequence INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_projection_voice_calls_thread_started
    ON projection_voice_calls(thread_id, started_at DESC, call_id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_projection_voice_calls_open
    ON projection_voice_calls(ended_at) WHERE ended_at IS NULL`,
  // `batch_id` is the batch that first stored each fragment.
  `CREATE TABLE IF NOT EXISTS projection_voice_fragments (
    call_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    fragment_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    speaker TEXT NOT NULL,
    text TEXT NOT NULL,
    start_offset_ms INTEGER,
    end_offset_ms INTEGER,
    PRIMARY KEY (call_id, sequence)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_voice_fragments_fragment
    ON projection_voice_fragments(call_id, fragment_id)`,
  `CREATE INDEX IF NOT EXISTS idx_projection_voice_fragments_batch
    ON projection_voice_fragments(call_id, batch_id)`,
  // The complete accepted content of each transcript batch, as a digest, so a re-sent batch ID
  // is compared with the whole request it was first accepted with, also after a replay.
  `CREATE TABLE IF NOT EXISTS projection_voice_batches (
    call_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    content_digest TEXT NOT NULL,
    PRIMARY KEY (call_id, batch_id)
  )`,
];

export const ensureMesuraSchema = Effect.fn("ensureMesuraSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of MESURA_SCHEMA_STATEMENTS) {
    yield* sql.unsafe(statement);
  }
});
