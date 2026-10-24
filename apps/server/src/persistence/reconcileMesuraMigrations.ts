import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";

/**
 * Mesura: dev builds of the fork recorded `053_ProjectionProjectIconDiscovery`
 * under the id upstream later gave to `053_PullRequestFilesViewed`. The
 * migrator skips every id at or below the latest recorded one, so such a
 * database would never get upstream's table. Run upstream's 053 (idempotent
 * DDL) and rename the ledger row. The fork's `icon_discovery_json` column
 * stays behind unused; icon discovery state now lives in the fork table that
 * `ensureMesuraSchema` creates.
 */
export const reconcileMesuraMigrations = Effect.fn("reconcileMesuraMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];
      const forkRows = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM effect_sql_migrations
        WHERE migration_id = 53 AND name = 'ProjectionProjectIconDiscovery'
      `;
      if (forkRows.length === 0) return [];
      yield* PullRequestFilesViewed;
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'PullRequestFilesViewed'
        WHERE migration_id = 53 AND name = 'ProjectionProjectIconDiscovery'
      `;
      return [[53, "PullRequestFilesViewed"] as const];
    }),
  );
});
