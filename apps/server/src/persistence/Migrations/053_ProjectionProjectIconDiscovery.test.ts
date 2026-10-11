import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("053_ProjectionProjectIconDiscovery", (it) => {
  it.effect("icon discovery fence: migration 053 adds nullable discovery state to projects", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
        ) VALUES ('existing', 'Existing', '/tmp/existing', '[]', '2026-10-11', '2026-10-11', NULL)
      `;
      yield* runMigrations({ toMigrationInclusive: 53 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_projects)
      `;
      const discovery = columns.find((column) => column.name === "icon_discovery_json");
      assert.equal(discovery?.name, "icon_discovery_json");
      assert.equal(discovery?.notnull, 0);

      // A project from before the migration has no previous job.
      const rows = yield* sql<{ readonly icon_discovery_json: string | null }>`
        SELECT icon_discovery_json FROM projection_projects WHERE project_id = 'existing'
      `;
      assert.deepEqual(rows, [{ icon_discovery_json: null }]);
    }),
  );
});
