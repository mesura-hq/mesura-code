import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.effect("preserves legacy activities for the Mesura Factory importer", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 60 });
    yield* sql`
      INSERT INTO projection_thread_activities
        (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
      VALUES ('factory-card', 'legacy-thread', 'info', 'mesura.factory.run',
        'Factory run', '{"runId":"run"}', '2026-10-10T00:00:00Z')
    `;
    const activities = yield* sql`SELECT * FROM projection_thread_activities`;

    yield* runMigrations();

    assert.deepStrictEqual(yield* sql`SELECT * FROM projection_thread_activities`, activities);
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE name = 'projection_turns'`,
      [],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
