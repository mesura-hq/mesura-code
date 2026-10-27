import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import LegacyPeerLinks from "./Migrations/061_PeerLinks.ts";
import ReleasedPeerLinks from "./Migrations/070_PeerLinks.ts";
import ReleasedPeerLinkFence from "./Migrations/071_PeerLinkFence.ts";
import ReleasedWaitingLinkRequestIndex from "./Migrations/072_WaitingLinkRequestIndex.ts";

const seedPeerLinkPreview = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 60 });
  yield* Migrator.make({})({
    loader: Migrator.fromRecord({ "61_PeerLinks": LegacyPeerLinks }),
  });
  yield* sql`
    UPDATE effect_sql_migrations SET created_at = '2026-10-10 00:00:00'
    WHERE migration_id = 61
  `;
  yield* sql`
    INSERT INTO peer_environment_links
      (environment_id, secret_name, label, urls_json, access, linked_at, expires_at)
    VALUES ('peer', 'peer-secret', 'Laptop', '["https://peer.example"]', 'auto',
      '2026-10-10T00:00:00Z', '2026-11-10T00:00:00Z')
  `;
});

// Releases from upstream's preview branch recorded the series at 68–70, before main's 68 and 69.
const seedPeerLinkRelease = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 67 });
  yield* Migrator.make({})({
    loader: Migrator.fromRecord({
      "68_PeerLinks": ReleasedPeerLinks,
      "69_PeerLinkFence": ReleasedPeerLinkFence,
      "70_WaitingLinkRequestIndex": ReleasedWaitingLinkRequestIndex,
    }),
  });
  yield* sql`
    UPDATE effect_sql_migrations SET created_at = '2026-10-13 23:57:18'
    WHERE migration_id = 68
  `;
});

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`
    SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id
  `;
});

describe("peer-link preview upgrade", () => {
  it.effect("fills the intervening history and preserves links, timestamps and fork tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPeerLinkPreview;
      const before = yield* sql`SELECT * FROM peer_environment_links`;
      yield* sql`CREATE TABLE mesura_upgrade_sentinel (value TEXT)`;
      yield* sql`INSERT INTO mesura_upgrade_sentinel VALUES ('keep')`;

      yield* runMigrations();
      const recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        recorded.map((row) => [row.migration_id, row.name]),
        migrationManifest.map(([id, name]) => [id, name]),
      );
      assert.deepStrictEqual(
        yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 70`,
        [{ created_at: "2026-10-10 00:00:00" }],
      );
      assert.deepStrictEqual(yield* sql`SELECT * FROM peer_environment_links`, [
        { ...before[0], fenced: 0 },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT * FROM mesura_upgrade_sentinel`, [
        { value: "keep" },
      ]);
      assert.strictEqual((yield* sql`SELECT * FROM mesura_project_icon_discovery`).length, 0);
      const settledHistory = yield* history;
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* history, settledHistory);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rolls back the history and schema together after an interrupted upgrade", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPeerLinkPreview;
      const before = yield* history;
      const links = yield* sql`SELECT * FROM peer_environment_links`;
      yield* sql`
        CREATE TRIGGER fail_peer_upgrade BEFORE INSERT ON effect_sql_migrations
        WHEN NEW.migration_id = 64
        BEGIN SELECT RAISE(ABORT, 'injected failure'); END
      `;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* history, before);
      assert.deepStrictEqual(yield* sql`SELECT * FROM peer_environment_links`, links);
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'pull_request_review_guides'`,
        [],
      );
      yield* sql`DROP TRIGGER fail_peer_upgrade`;
      yield* runMigrations();
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rejects unexpected later history without changing it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPeerLinkPreview;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (62, 'OtherBuild')`;
      const before = yield* history;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* history, before);
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'pull_request_review_guides'`,
        [],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("moves the release-numbered series after main's migrations and applies them", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPeerLinkRelease;

      yield* runMigrations();
      const recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        recorded.map((row) => [row.migration_id, row.name]),
        migrationManifest.map(([id, name]) => [id, name]),
      );
      assert.deepStrictEqual(
        yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 70`,
        [{ created_at: "2026-10-13 23:57:18" }],
      );
      assert.strictEqual(
        (yield* sql`
          SELECT name FROM sqlite_master
          WHERE name = 'orchestration_v2_projection_turn_items_stop_request_idx'
        `).length,
        1,
      );
      const settledHistory = yield* history;
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* history, settledHistory);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
