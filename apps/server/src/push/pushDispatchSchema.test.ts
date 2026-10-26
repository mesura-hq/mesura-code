/**
 * Phase 3 fence of phone push notifications: the table behind acceptance
 * criterion 3, every send key a thread announced, which survives a server
 * restart, is fork DDL.
 *
 * Entry point: `runMigrations`, which every server boot runs and which ends
 * with `MESURA_SCHEMA_STATEMENTS` (`persistence/mesuraSchema.ts`).
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("push dispatch table phase 3 fence", (it) => {
  it.effect(
    "push phase 3 AC3: every boot creates mesura_push_announced idempotently, with no migration id",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* runMigrations();

        const columns = yield* sql<{
          readonly name: string;
          readonly notnull: number;
          readonly pk: number;
        }>`SELECT name, "notnull", pk FROM pragma_table_info('mesura_push_announced')`;
        assert.deepStrictEqual(
          columns.map((column) => [column.name, column.notnull, column.pk]),
          [
            ["thread_id", 1, 1],
            ["push_key", 1, 2],
            ["sent_at", 1, 0],
          ],
        );

        const ledger = yield* sql<{ readonly name: string }>`
          SELECT name FROM effect_sql_migrations WHERE name LIKE '%mesura_push%'
        `;
        assert.deepStrictEqual(ledger, [], "the dispatch table takes no migration id");
      }),
  );
});
