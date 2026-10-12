import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Mesura: the fork's own tables, created with idempotent DDL after upstream's
 * migrations on every boot.
 *
 * A fork table never takes a migration id. The Effect migrator runs only ids
 * above the latest recorded one, so a fork id at the tail would hide the next
 * migration upstream ships under the same number, and every weekly sync would
 * need a ledger repair. Idempotent DDL has no id to collide with. Use it only
 * for tables and indexes the fork owns; a change to an upstream table still
 * needs an upstream-style migration and a reconcile step
 * (`reconcileMesuraMigrations.ts`).
 */
export const MESURA_SCHEMA_STATEMENTS: ReadonlyArray<string> = [
  // The current agent icon search for each project (`ProjectIconDiscoveryState`
  // JSON). One row per project with a search; absent means no search yet.
  `CREATE TABLE IF NOT EXISTS mesura_project_icon_discovery (
    project_id TEXT PRIMARY KEY NOT NULL,
    state_json TEXT NOT NULL
  )`,
];

export const ensureMesuraSchema = Effect.fn("ensureMesuraSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of MESURA_SCHEMA_STATEMENTS) {
    yield* sql.unsafe(statement);
  }
});
