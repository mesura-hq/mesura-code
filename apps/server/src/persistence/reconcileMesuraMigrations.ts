import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import ProjectionThreadsAutoSettleDisabledAt from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";

/**
 * Mesura: fork builds recorded migrations under ids upstream later took, and the migrator skips
 * ids at or below the latest recorded one. Run upstream's idempotent migration for that id and
 * rename the row. Fork schema stays: icon discovery's column, the voice prototype's tables.
 */
const FORK_LEDGER_ROWS = [
  {
    id: 53,
    forkName: "ProjectionProjectIconDiscovery",
    name: "PullRequestFilesViewed",
    migration: PullRequestFilesViewed,
  },
  {
    id: 53,
    forkName: "ProjectionVoiceCalls",
    name: "PullRequestFilesViewed",
    migration: PullRequestFilesViewed,
  },
  {
    id: 54,
    forkName: "ProjectionVoiceBatches",
    name: "ProjectionThreadsAutoSettleDisabledAt",
    migration: ProjectionThreadsAutoSettleDisabledAt,
  },
] as const;

export const reconcileMesuraMigrations = Effect.fn("reconcileMesuraMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];
      const repaired: Array<readonly [number, string]> = [];
      for (const row of FORK_LEDGER_ROWS) {
        const forkRows = yield* sql<{ readonly migration_id: number }>`
          SELECT migration_id FROM effect_sql_migrations
          WHERE migration_id = ${row.id} AND name = ${row.forkName}
        `;
        if (forkRows.length === 0) continue;
        yield* row.migration;
        yield* sql`
          UPDATE effect_sql_migrations SET name = ${row.name}
          WHERE migration_id = ${row.id} AND name = ${row.forkName}
        `;
        repaired.push([row.id, row.name] as const);
      }
      return repaired;
    }),
  );
});
