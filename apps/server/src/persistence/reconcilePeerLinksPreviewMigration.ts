import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import LegacyPeerLinks from "./Migrations/061_PeerLinks.ts";

const PEER_LINK_SERIES = ["PeerLinks", "PeerLinkFence", "WaitingLinkRequestIndex"] as const;

// Previews recorded the peer-link series at 61 and releases at 68–70; main moved it to 70–72.
// The migrator skips ids below the highest recorded one, so this moves the series and applies
// and records the migrations it skipped, in one transaction.
export const reconcilePeerLinksPreviewMigration = Effect.fn("reconcilePeerLinksPreviewMigration")(
  function* <E, R>(
    migrations: ReadonlyArray<readonly [number, string, Effect.Effect<unknown, E, R>]>,
  ) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
        if (tables.length === 0) return [];
        const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 55
      `;
        const manifestIds = new Map(migrations.map(([id, name]) => [name, id]));
        const targetId = manifestIds.get(PEER_LINK_SERIES[0]);
        const recorded = history.find((row) => row.name === PEER_LINK_SERIES[0]);
        if (targetId === undefined || !recorded || recorded.migration_id === targetId) return [];

        const fromId = recorded.migration_id;
        const earlier = migrations.filter(([id]) => id >= 55 && id < fromId);
        const later = history.filter((row) => row.migration_id >= fromId);
        if (
          fromId > targetId ||
          earlier.some(
            ([id, name]) => !history.some((row) => row.migration_id === id && row.name === name),
          ) ||
          later.some((row) => row.name !== PEER_LINK_SERIES[row.migration_id - fromId])
        ) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: "Cannot upgrade peer-link preview with unexpected migration history.",
          });
        }

        // The 061 preview DDL is idempotent and leaves existing links and secret names intact.
        if (fromId === 61) yield* LegacyPeerLinks;
        // Keep the original rows and timestamps. Move the latest first to avoid key collisions.
        const moved = later
          .toSorted((a, b) => b.migration_id - a.migration_id)
          .map(
            (row) =>
              [row.migration_id, manifestIds.get(row.name) ?? row.migration_id, row.name] as const,
          );
        for (const [oldId, newId, name] of moved) {
          yield* sql`
          UPDATE effect_sql_migrations SET migration_id = ${newId}
          WHERE migration_id = ${oldId} AND name = ${name}
        `;
        }
        const executed: Array<readonly [number, string]> = [];
        for (const [id, name, migration] of migrations) {
          if (id < fromId || id >= targetId) continue;
          yield* migration;
          yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})
        `;
          executed.push([id, name]);
        }
        return [
          ...executed,
          ...moved.toReversed().map(([, newId, name]) => [newId, name] as const),
        ];
      }),
    );
  },
);
