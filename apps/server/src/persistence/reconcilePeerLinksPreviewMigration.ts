import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import LegacyPeerLinks from "./Migrations/061_PeerLinks.ts";

/** Upgrade the published preview's 061_PeerLinks before the history guard runs. */
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
        if (!history.some((row) => row.migration_id === 61 && row.name === "PeerLinks")) {
          return [];
        }
        const earlier = migrations.filter(([id]) => id >= 55 && id <= 60);
        if (
          history.some((row) => row.migration_id > 61) ||
          earlier.some(
            ([id, name]) => !history.some((row) => row.migration_id === id && row.name === name),
          )
        ) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: "Cannot upgrade peer-link preview with unexpected migration history.",
          });
        }

        // Keep the original row and its timestamp. Merely moving it to 068 makes the
        // migrator skip 061–067, so apply and record those migrations in this transaction.
        // The preview DDL is idempotent and leaves existing links and secret names intact.
        yield* LegacyPeerLinks;
        yield* sql`
        UPDATE effect_sql_migrations SET migration_id = 68
        WHERE migration_id = 61 AND name = 'PeerLinks'
      `;
        const executed: Array<readonly [number, string]> = [];
        for (const [id, name, migration] of migrations) {
          if (id < 61 || id > 67) continue;
          yield* migration;
          yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})
        `;
          executed.push([id, name]);
        }
        return [...executed, [68, "PeerLinks"] as const];
      }),
    );
  },
);
