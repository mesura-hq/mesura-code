import {
  EventId,
  FactoryThreadCard,
  OrchestrationV2AppThreadJson,
  OrchestrationV2TurnItemJson,
  type OrchestrationV2DomainEvent,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { restoreMesuraFactoryMessagePositions } from "../../persistence/mesuraFactoryCardImport.ts";
import * as EventSink from "../EventSink.ts";
import { factoryCardTitle } from "../FactoryCards.ts";

interface LegacyTimelineRow {
  readonly id: string;
  readonly kind: string;
  readonly payload_json: string | null;
  readonly created_at: string;
}

const legacyTurnItemId = (row: LegacyTimelineRow) =>
  TurnItemId.make(row.kind === "message" ? `migration:v1:turn-item:${row.id}` : row.id);

const decodeCard = Schema.decodeUnknownEffect(FactoryThreadCard);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));
const decodeThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);

/** Historical item events must not replace current thread activity metadata on replay. */
export const writeLegacyFactoryEvents = Effect.fn("MesuraFactoryCardImport.writeEvents")(function* (
  threadId: ThreadId,
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
  metadataEventId: EventId,
) {
  const sql = yield* SqlClient.SqlClient;
  const eventSink = yield* EventSink.EventSinkV2;
  if (events.length === 0) return;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      // Capture inside the transaction. A timestamp from v1 or before the transaction
      // would erase newer v2 activity. The final event also preserves it on rebuild.
      const rows = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
    `;
      const thread = yield* decodeThread(rows[0]?.payload_json);
      yield* eventSink.write({
        events: [
          ...events,
          {
            id: metadataEventId,
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId: thread.providerInstanceId,
            occurredAt: thread.updatedAt,
            payload: thread,
          },
        ],
      });
    }),
  );
});

/**
 * Runs after shell import, before recovery and Factory run reattachment.
 * V1 has no v2 provider runs, so cards share the null run anchor of imported
 * messages. Reserve the entire legacy timeline before lazy hydration. A
 * one-time event updates any message previews (or already hydrated messages)
 * whose old message-only position changes. Subsequent boots must not overwrite
 * a card that the run tracker updated, or move its pinned position again.
 */
export const importLegacyFactoryCards = Effect.fn("MesuraFactoryCardImport.import")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* restoreMesuraFactoryMessagePositions();
  const threads = yield* sql<{ readonly thread_id: string }>`
    SELECT DISTINCT activity.thread_id
    FROM projection_thread_activities AS activity
    JOIN orchestration_v2_legacy_imports AS legacy ON legacy.thread_id = activity.thread_id
    WHERE activity.kind IN ('factory.plan', 'factory.run', 'factory.report')
      AND NOT EXISTS (
        SELECT 1 FROM mesura_factory_card_imports AS imported
        WHERE imported.thread_id = activity.thread_id
      )
    ORDER BY activity.thread_id
  `;
  for (const thread of threads) {
    const threadId = ThreadId.make(thread.thread_id);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const timeline = yield* sql<LegacyTimelineRow>`
        SELECT id, kind, payload_json, created_at
        FROM (
          SELECT message_id AS id, 'message' AS kind, NULL AS payload_json,
            created_at, 0 AS source, 0 AS sequence
          FROM projection_thread_messages
          WHERE thread_id = ${threadId} AND role IN ('user', 'assistant')
          UNION ALL
          SELECT activity_id AS id, kind, payload_json, created_at,
            1 AS source, COALESCE(sequence, 0) AS sequence
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
            AND kind IN ('factory.plan', 'factory.run', 'factory.report')
        )
        ORDER BY created_at, source, sequence, id
      `;
        const existingCards = yield* sql<{ readonly turn_item_id: string }>`
          SELECT item.turn_item_id
          FROM orchestration_v2_projection_turn_items AS item
          JOIN projection_thread_activities AS activity
            ON activity.activity_id = item.turn_item_id AND activity.thread_id = item.thread_id
          WHERE item.thread_id = ${threadId}
            AND activity.kind IN ('factory.plan', 'factory.run', 'factory.report')
        `;
        const existingCardIds = new Set(existingCards.map((row) => row.turn_item_id));
        // An existing v2 card keeps its current anchor, position and payload.
        const pending = timeline.filter(
          (row) => row.kind === "message" || !existingCardIds.has(row.id),
        );
        const movingIds = new Set(pending.map(legacyTurnItemId));
        const positions = yield* sql<{ readonly turn_item_id: string; readonly ordinal: number }>`
          SELECT turn_item_id, ordinal FROM orchestration_v2_turn_item_positions
          WHERE thread_id = ${threadId}
        `;
        const occupied = new Set(
          positions
            .filter((row) => !movingIds.has(TurnItemId.make(row.turn_item_id)))
            .map((row) => row.ordinal),
        );
        let nextOrdinal = 1;
        const positioned = pending.map((row) => {
          // Keep v2 positions pinned. Legacy items retain their relative order
          // across those slots instead of moving a v2 item or colliding with it.
          while (occupied.has(nextOrdinal)) nextOrdinal += 1;
          return { ...row, turnItemId: legacyTurnItemId(row), ordinal: nextOrdinal++ };
        });
        const events: OrchestrationV2DomainEvent[] = [];
        // Insertions only increase message ordinals. Move the newest positions
        // first so the unique (thread_id, ordinal) constraint stays satisfied.
        for (const row of positioned.toReversed()) {
          const { turnItemId } = row;
          yield* sql`
          INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
          VALUES (${threadId}, ${turnItemId}, ${row.ordinal})
          ON CONFLICT(thread_id, turn_item_id) DO UPDATE SET ordinal = excluded.ordinal
        `;
          if (row.kind === "message") {
            // A position without an item event vanishes on projection rebuild.
            // Keep the exact allocation outside projections until lazy hydration.
            yield* sql`
              INSERT INTO mesura_factory_card_message_positions (thread_id, turn_item_id, ordinal)
              VALUES (${threadId}, ${turnItemId}, ${row.ordinal})
            `;
            const stored = yield* sql<{ readonly payload_json: string }>`
              SELECT payload_json FROM orchestration_v2_projection_turn_items
              WHERE thread_id = ${threadId} AND turn_item_id = ${turnItemId}
                AND ordinal <> ${row.ordinal}
            `;
            const existing = stored[0];
            if (existing === undefined) continue;
            const item = yield* decodeItem(existing.payload_json);
            events.push({
              id: EventId.make(`mesura:migration:v1:factory-position:${row.id}`),
              type: "turn-item.updated",
              threadId,
              occurredAt: item.updatedAt,
              payload: { ...item, ordinal: row.ordinal },
            });
            continue;
          }
          const card = yield* decodeCard({
            kind: row.kind.slice("factory.".length),
            payload: yield* decodeJson(row.payload_json),
          });
          const at = DateTime.makeUnsafe(row.created_at);
          events.push({
            id: EventId.make(`mesura:migration:v1:factory-card:${row.id}`),
            type: "turn-item.updated",
            threadId,
            occurredAt: at,
            payload: {
              id: turnItemId,
              threadId,
              runId: null,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: row.ordinal,
              status: "completed",
              title: factoryCardTitle(card),
              startedAt: at,
              completedAt: at,
              updatedAt: at,
              type: "factory_card",
              card,
            },
          });
        }
        yield* writeLegacyFactoryEvents(
          threadId,
          events,
          EventId.make(`mesura:migration:v1:factory-metadata:${threadId}`),
        );
        yield* sql`
        INSERT INTO mesura_factory_card_imports (thread_id, imported_at)
        VALUES (${threadId}, ${DateTime.formatIso(yield* DateTime.now)})
      `;
      }),
    );
  }
});
