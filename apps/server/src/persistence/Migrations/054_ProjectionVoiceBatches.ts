import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Mesura: the complete accepted content of each voice transcript batch, as a digest. It is a
// projection of thread.voice-transcript-appended events, so a re-sent batch ID is compared with
// the whole request it was first accepted with, also after a restart or a replay.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_voice_batches (
      call_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      PRIMARY KEY (call_id, batch_id)
    )
  `;

  // Keeping the 053 rows and cursor skipped the batch backfill: an accepted command receipt
  // also bypasses projection on retry. Reset the voice projection with its cursor so startup
  // rebuilds all three tables from the same events, including already accepted batch IDs.
  yield* sql`DELETE FROM projection_voice_batches`;
  yield* sql`DELETE FROM projection_voice_fragments`;
  yield* sql`DELETE FROM projection_voice_calls`;
  yield* sql`DELETE FROM projection_state WHERE projector = 'projection.voice-calls'`;
});
