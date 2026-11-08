// Phase 2 fence: the voice history projection tables. Entry point is `runMigrations`, the same
// migration runner the server executes at startup.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationManifest, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const indexedColumnSets = Effect.fn("indexedColumnSets")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  const indexes = yield* sql<{ readonly name: string; readonly unique: number }>`
    SELECT name, "unique" FROM pragma_index_list(${table})
  `;
  const result: Array<{ readonly columns: ReadonlyArray<string>; readonly unique: boolean }> = [];
  for (const index of indexes) {
    const columns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_index_info(${index.name}) ORDER BY seqno
    `;
    result.push({ columns: columns.map((column) => column.name), unique: index.unique === 1 });
  }
  return result;
});

layer("053_ProjectionVoiceCalls", (it) => {
  it.effect("VH-M1 creates indexed voice call and fragment projection tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });

      assert.deepInclude(migrationManifest, [53, "ProjectionVoiceCalls"]);
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('projection_voice_calls', 'projection_voice_fragments')
        ORDER BY name
      `;
      assert.deepEqual(
        tables.map((table) => table.name),
        ["projection_voice_calls", "projection_voice_fragments"],
      );

      const callIndexes = yield* indexedColumnSets("projection_voice_calls");
      assert.isTrue(
        callIndexes.some((index) => index.columns[0] === "call_id" && index.unique),
        "projection_voice_calls needs a unique call_id key",
      );
      assert.isTrue(
        callIndexes.some((index) => index.columns[0] === "thread_id"),
        "projection_voice_calls needs a thread_id index for the call list",
      );

      // One fragment per call sequence keeps a re-sent batch from duplicating text.
      const fragmentIndexes = yield* indexedColumnSets("projection_voice_fragments");
      assert.isTrue(
        fragmentIndexes.some(
          (index) =>
            index.unique && index.columns[0] === "call_id" && index.columns[1] === "sequence",
        ),
        "projection_voice_fragments needs a unique (call_id, sequence) key",
      );
    }),
  );

  it.effect("VH-M2 keys each accepted voice batch identity by call and batch ID", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 54 });
      assert.deepInclude(migrationManifest, [54, "ProjectionVoiceBatches"]);
      const batchIndexes = yield* indexedColumnSets("projection_voice_batches");
      assert.isTrue(
        batchIndexes.some(
          (index) =>
            index.unique && index.columns[0] === "call_id" && index.columns[1] === "batch_id",
        ),
        "projection_voice_batches needs a unique (call_id, batch_id) key",
      );
    }),
  );
});
