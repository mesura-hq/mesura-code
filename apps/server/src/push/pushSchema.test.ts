/**
 * Phase 1 fence of phone push notifications: the subscription table behind
 * acceptance criteria 2 and 3 is fork DDL.
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

layer("push subscription table phase 1 fence", (it) => {
  it.effect(
    "push phase 1 AC2: every boot creates mesura_push_subscriptions idempotently, with no migration id",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* runMigrations();

        const columns = yield* sql<{
          readonly name: string;
          readonly notnull: number;
          readonly pk: number;
        }>`SELECT name, "notnull", pk FROM pragma_table_info('mesura_push_subscriptions')`;
        assert.deepStrictEqual(
          columns.map((column) => [column.name, column.notnull, column.pk]),
          [
            ["endpoint", 0, 1],
            ["p256dh", 1, 0],
            ["auth", 1, 0],
            ["label", 1, 0],
            ["preferences_json", 1, 0],
            ["created_at", 1, 0],
            ["last_success_at", 0, 0],
            ["last_failure", 0, 0],
          ],
        );

        const ledger = yield* sql<{ readonly name: string }>`
          SELECT name FROM effect_sql_migrations WHERE name LIKE '%mesura_push%'
        `;
        assert.deepStrictEqual(ledger, [], "the push table takes no migration id");
      }),
  );
});
