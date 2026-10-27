import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// V2 never reads these copied V1 projections; pre-0.1.0 builds use state.sqlite, preserving rollback.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // MesuraFactoryCardImport still reads activities during shell and transcript import.
  // Dropping this table loses legacy Factory cards even when V2 message counts match.
  yield* sql`DROP TABLE IF EXISTS projection_turns`;
  yield* sql`DROP TABLE IF EXISTS projection_thread_proposed_plans`;
  yield* sql`DROP TABLE IF EXISTS projection_pending_approvals`;
  yield* sql`DROP TABLE IF EXISTS projection_state`;
  yield* sql`DROP TABLE IF EXISTS checkpoint_diff_blobs`;
});
