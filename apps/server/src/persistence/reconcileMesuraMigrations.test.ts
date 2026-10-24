import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "./Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("reconcileMesuraMigrations", (it) => {
  it.effect("repairs a fork dev ledger that recorded icon discovery as migration 53", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      // What a fork dev build left behind: its own 053 under upstream's id.
      yield* sql`ALTER TABLE projection_projects ADD COLUMN icon_discovery_json TEXT`;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (53, 'ProjectionProjectIconDiscovery')
      `;

      yield* runMigrations();

      const ledger = yield* sql<{ readonly name: string }>`
        SELECT name FROM effect_sql_migrations WHERE migration_id = 53
      `;
      assert.deepEqual(ledger, [{ name: "PullRequestFilesViewed" }]);
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('pull_request_files_viewed', 'mesura_project_icon_discovery')
        ORDER BY name
      `;
      assert.deepEqual(tables, [
        { name: "mesura_project_icon_discovery" },
        { name: "pull_request_files_viewed" },
      ]);
    }),
  );

  it.effect("creates the fork tables idempotently on every full run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* runMigrations();
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'mesura_project_icon_discovery'
      `;
      assert.equal(tables.length, 1);
    }),
  );
});
