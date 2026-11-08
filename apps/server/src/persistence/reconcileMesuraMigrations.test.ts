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

// A database of its own: the prototype's ledger exists only before upstream's 053 runs.
it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })))(
  "reconcileMesuraMigrations voice prototype",
  (it) => {
    it.effect("upgrades a voice prototype ledger and keeps its voice events and history", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 52 });
        // What the voice prototype left: its 053/054 under upstream's ids, its projection tables
        // and its events as v1 thread rows.
        yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (53, 'ProjectionVoiceCalls'), (54, 'ProjectionVoiceBatches')
      `;
        yield* sql`
        CREATE TABLE projection_voice_calls (
          call_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, owner_key TEXT NOT NULL,
          started_at TEXT NOT NULL, ended_at TEXT, end_reason TEXT, final_sequence INTEGER,
          last_sequence INTEGER NOT NULL DEFAULT 0
        )
      `;
        yield* sql`
        INSERT INTO projection_voice_calls (call_id, thread_id, owner_key, started_at)
        VALUES ('voice-call-prototype', 'thread-prototype', 'owner-digest', '2026-11-01T10:00:00.000Z')
      `;
        const payload = JSON.stringify({
          threadId: "thread-prototype",
          callId: "voice-call-prototype",
          ownerKey: "owner-digest",
          startedAt: "2026-11-01T10:00:00.000Z",
        });
        yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, actor_kind, payload_json, metadata_json
        ) VALUES (
          'event-voice-prototype', 'thread', 'thread-prototype', 3, 'thread.voice-call-started',
          '2026-11-01T10:00:00.000Z', 'voice:voice-call-prototype:start', 'server', ${payload}, '{}'
        )
      `;
        const [before] = yield* sql<{ readonly sequence: number }>`
        SELECT sequence FROM orchestration_events WHERE event_id = 'event-voice-prototype'
      `;

        yield* runMigrations();

        const ledger = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations
        WHERE migration_id IN (53, 54) ORDER BY migration_id
      `;
        assert.deepEqual(ledger, [
          { migration_id: 53, name: "PullRequestFilesViewed" },
          { migration_id: 54, name: "ProjectionThreadsAutoSettleDisabledAt" },
        ]);
        // Upstream's 053 and 054 schema exists, and every later migration ran.
        const filesViewed = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pull_request_files_viewed'
      `;
        assert.equal(filesViewed.length, 1);
        const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
        assert.isTrue(threadColumns.some((column) => column.name === "auto_settle_disabled_at"));
        const latest = yield* sql<{ readonly id: number }>`
        SELECT MAX(migration_id) AS id FROM effect_sql_migrations
      `;
        assert.isAbove(latest[0]!.id, 54);
        // The prototype event keeps its ID, sequence, type, command and payload; only its
        // aggregate kind moves to voice, out of v2 replay and compaction.
        const events = yield* sql<{
          readonly sequence: number;
          readonly aggregate_kind: string;
          readonly event_type: string;
          readonly command_id: string;
          readonly payload_json: string;
        }>`
        SELECT sequence, aggregate_kind, event_type, command_id, payload_json
        FROM orchestration_events WHERE event_id = 'event-voice-prototype'
      `;
        assert.deepEqual(events, [
          {
            sequence: before!.sequence,
            aggregate_kind: "voice",
            event_type: "thread.voice-call-started",
            command_id: "voice:voice-call-prototype:start",
            payload_json: payload,
          },
        ]);
        // The prototype's history rows stay until the projection rebuilds them from events.
        const calls = yield* sql`SELECT call_id FROM projection_voice_calls`;
        assert.equal(calls.length, 1);
      }),
    );
  },
);
