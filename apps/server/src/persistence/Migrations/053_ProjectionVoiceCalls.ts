import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Mesura: voice call history. Both tables are projections of the thread.voice-* events and can
// be rebuilt from the event store.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // `final_sequence` is the owner's transcript boundary. It is NULL while the call is open and
  // after a server-side end until the owner declares it. `last_sequence` is the highest stored
  // fragment sequence, 0 when the call has no speech yet.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_voice_calls (
      call_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      owner_key TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT,
      final_sequence INTEGER,
      last_sequence INTEGER NOT NULL DEFAULT 0
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_voice_calls_thread_started
    ON projection_voice_calls(thread_id, started_at DESC, call_id DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_voice_calls_open
    ON projection_voice_calls(ended_at)
    WHERE ended_at IS NULL
  `;

  // `batch_id` records the batch that first stored each fragment, so a re-sent batch ID with
  // different content is detected.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_voice_fragments (
      call_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      fragment_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      speaker TEXT NOT NULL,
      text TEXT NOT NULL,
      start_offset_ms INTEGER,
      end_offset_ms INTEGER,
      PRIMARY KEY (call_id, sequence)
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_voice_fragments_fragment
    ON projection_voice_fragments(call_id, fragment_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_voice_fragments_batch
    ON projection_voice_fragments(call_id, batch_id)
  `;
});
