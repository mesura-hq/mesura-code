/**
 * Mesura: reads recorded Software Factory cards across threads. Card ids start
 * with a kind prefix, so a kind is a range scan on the turn item primary key.
 * Archived threads are included; deleted threads are not.
 * @module FactoryCardQuery
 */
import {
  FactoryThreadCard,
  ThreadId,
  TurnItemId,
  type FactoryThreadCard as FactoryThreadCardType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export type FactoryCardKind = FactoryThreadCardType["kind"];

/**
 * One recorded card, with `card` narrowed to the kind asked for. Distributive,
 * so a record of one kind is assignable to the record of every kind.
 */
export type FactoryCardRecord<K extends FactoryCardKind = FactoryCardKind> =
  K extends FactoryCardKind
    ? {
        readonly turnItemId: TurnItemId;
        readonly threadId: ThreadId;
        readonly card: Extract<FactoryThreadCardType, { readonly kind: K }>;
        readonly updatedAt: DateTime.Utc;
      }
    : never;

/** How many cards `listByKind` returns when the caller names no limit, and at most. */
const FACTORY_CARD_QUERY_DEFAULT_LIMIT = 256;
const FACTORY_CARD_QUERY_MAX_LIMIT = 4096;

/**
 * The id prefix of each card kind. They match the contract's id helpers in
 * `packages/contracts/src/factory.ts`; `FactoryCardQuery.test.ts` checks that.
 */
export const FACTORY_CARD_ID_PREFIXES: Record<FactoryCardKind, string> = {
  plan: "factory-plan:",
  run: "factory-run:",
  report: "factory-report:",
};

export class FactoryCardQueryError extends Schema.TaggedError<FactoryCardQueryError>()(
  "FactoryCardQueryError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the recorded Software Factory cards.";
  }
}

export class FactoryCardQuery extends Context.Service<
  FactoryCardQuery,
  {
    /**
     * The newest `limit` cards of one kind, returned oldest first by
     * `updatedAt`, so a caller folding them in order ends on each thread's
     * newest card. A row whose card does not decode is skipped.
     */
    readonly listByKind: <K extends FactoryCardKind>(
      kind: K,
      options?: { readonly limit?: number },
    ) => Effect.Effect<ReadonlyArray<FactoryCardRecord<K>>, FactoryCardQueryError>;
    /** One card by its turn item id, when it exists on a thread that is not deleted. */
    readonly get: (
      turnItemId: TurnItemId,
    ) => Effect.Effect<Option.Option<FactoryCardRecord>, FactoryCardQueryError>;
  }
>()("t3/orchestration-v2/FactoryCardQuery") {}

/** The part of a stored `factory_card` turn item a reader needs. */
const StoredCard = Schema.fromJsonString(
  Schema.Struct({
    card: FactoryThreadCard,
    updatedAt: Schema.DateTimeUtcFromString,
  }),
);
const decodeStoredCard = Schema.decodeUnknownOption(StoredCard);

interface CardRow {
  readonly turn_item_id: string;
  readonly thread_id: string;
  readonly payload_json: string;
}

/** The smallest string above every id that starts with `prefix`. */
const prefixUpperBound = (prefix: string) =>
  prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);

const clampLimit = (limit: number | undefined) =>
  Math.max(
    1,
    Math.min(FACTORY_CARD_QUERY_MAX_LIMIT, Math.floor(limit ?? FACTORY_CARD_QUERY_DEFAULT_LIMIT)),
  );

function recordOfRow(row: CardRow): Option.Option<FactoryCardRecord> {
  return decodeStoredCard(row.payload_json).pipe(
    Option.map(
      (stored) =>
        // One object whose `card` is any kind is one of the per-kind records;
        // TypeScript does not distribute a nested union by itself.
        ({
          turnItemId: TurnItemId.make(row.turn_item_id),
          threadId: ThreadId.make(row.thread_id),
          card: stored.card,
          updatedAt: stored.updatedAt,
        }) as FactoryCardRecord,
    ),
  );
}

const isRecordOfKind = <K extends FactoryCardKind>(
  kind: K,
  record: FactoryCardRecord,
): record is FactoryCardRecord<K> => record.card.kind === kind;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listByKind: FactoryCardQuery["Service"]["listByKind"] = Effect.fn(
    "FactoryCardQuery.listByKind",
  )(
    function* <K extends FactoryCardKind>(kind: K, options?: { readonly limit?: number }) {
      const prefix = FACTORY_CARD_ID_PREFIXES[kind];
      const rows = yield* sql<CardRow>`
        SELECT item.turn_item_id, item.thread_id, item.payload_json
        FROM orchestration_v2_projection_turn_items AS item
        JOIN orchestration_v2_projection_threads AS thread
          ON thread.thread_id = item.thread_id
        WHERE item.turn_item_id >= ${prefix}
          AND item.turn_item_id < ${prefixUpperBound(prefix)}
          AND item.type = 'factory_card'
          AND thread.deleted_at IS NULL
        ORDER BY item.updated_at DESC, item.turn_item_id DESC
        LIMIT ${clampLimit(options?.limit)}
      `;
      return rows
        .flatMap((row) => Option.toArray(recordOfRow(row)))
        .filter((record) => isRecordOfKind(kind, record))
        .toReversed();
    },
    Effect.mapError((cause) => new FactoryCardQueryError({ cause })),
  );

  const get: FactoryCardQuery["Service"]["get"] = Effect.fn("FactoryCardQuery.get")(
    function* (turnItemId: TurnItemId) {
      const rows = yield* sql<CardRow>`
        SELECT item.turn_item_id, item.thread_id, item.payload_json
        FROM orchestration_v2_projection_turn_items AS item
        JOIN orchestration_v2_projection_threads AS thread
          ON thread.thread_id = item.thread_id
        WHERE item.turn_item_id = ${turnItemId}
          AND item.type = 'factory_card'
          AND thread.deleted_at IS NULL
        LIMIT 1
      `;
      const row = rows[0];
      return row === undefined ? Option.none<FactoryCardRecord>() : recordOfRow(row);
    },
    Effect.mapError((cause) => new FactoryCardQueryError({ cause })),
  );

  return FactoryCardQuery.of({ listByKind, get });
});

export const layer = Layer.effect(FactoryCardQuery, make);
