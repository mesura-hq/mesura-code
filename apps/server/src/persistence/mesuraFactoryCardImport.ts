import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Fork-owned import state takes no upstream migration number. */
export const ensureMesuraFactoryCardImportSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS mesura_factory_card_imports (
      thread_id TEXT PRIMARY KEY NOT NULL,
      imported_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS mesura_factory_card_message_positions (
      thread_id TEXT NOT NULL,
      turn_item_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (thread_id, turn_item_id),
      UNIQUE (thread_id, ordinal)
    )
  `;
});

/** Restore lazy-message reservations that projection rebuild deliberately deletes. */
export const restoreMesuraFactoryMessagePositions = Effect.fn(
  "MesuraFactoryCardImport.restoreMessagePositions",
)(function* (threadId?: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureMesuraFactoryCardImportSchema;
  yield* sql`
    INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
    SELECT reservation.thread_id, reservation.turn_item_id, reservation.ordinal
    FROM mesura_factory_card_message_positions AS reservation
    JOIN mesura_factory_card_imports AS imported ON imported.thread_id = reservation.thread_id
    WHERE (${threadId ?? null} IS NULL OR reservation.thread_id = ${threadId ?? null})
    ON CONFLICT(thread_id, turn_item_id) DO NOTHING
  `;
  if (threadId === undefined) return new Map<string, number>();
  const reservations = yield* sql<{ readonly turn_item_id: string; readonly ordinal: number }>`
    SELECT reservation.turn_item_id, reservation.ordinal
    FROM mesura_factory_card_message_positions AS reservation
    JOIN mesura_factory_card_imports AS imported ON imported.thread_id = reservation.thread_id
    WHERE reservation.thread_id = ${threadId}
  `;
  return new Map(reservations.map((row) => [row.turn_item_id, row.ordinal]));
});
