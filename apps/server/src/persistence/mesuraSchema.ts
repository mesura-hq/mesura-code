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
];

export const ensureMesuraSchema = Effect.fn("ensureMesuraSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of MESURA_SCHEMA_STATEMENTS) {
    yield* sql.unsafe(statement);
  }
});
