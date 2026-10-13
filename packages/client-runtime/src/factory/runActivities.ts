import {
  FACTORY_RUN_ACTIVITY_KIND,
  FactoryRunActivityPayload,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * One Factory card as the activity-based derivations read it. Orchestrator v1
 * carried cards as thread activities, and upstream's v2 deleted
 * `OrchestrationThreadActivity`, so the shape is structural. v2 threads carry
 * cards as `factory_card` turn items; see the `FromTurnItems` derivations.
 */
export interface FactoryCardActivity {
  /** Stable per card: the plan file, or the thread and run. */
  readonly id: string;
  /** `factory.plan`, `factory.run` or `factory.report`. */
  readonly kind: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

/** A thread's attached run, as its timeline or feed places it: its latest activity. */
export interface FactoryRunTimelineItem {
  /** The `factory.run` activity id, fixed per run while its content is replaced. */
  readonly id: string;
  readonly createdAt: string;
  readonly run: FactoryRunActivityPayload;
}

const isFactoryRunActivityPayload = Schema.is(FactoryRunActivityPayload);

// Activities are immutable, so one item per activity object keeps the item's
// reference stable across derivations; rows compare it by reference.
const itemByActivity = new WeakMap<FactoryCardActivity, FactoryRunTimelineItem | null>();

function factoryRunItem(activity: FactoryCardActivity): FactoryRunTimelineItem | null {
  const cached = itemByActivity.get(activity);
  if (cached !== undefined) return cached;
  const item = isFactoryRunActivityPayload(activity.payload)
    ? { id: activity.id, createdAt: activity.createdAt, run: activity.payload }
    : null;
  itemByActivity.set(activity, item);
  return item;
}

/**
 * The run card of a thread: the latest-started run whose `factory.run`
 * payload decodes, or null. A thread shows one run card; an earlier run's
 * outcome stays in its report.
 */
export function deriveLatestFactoryRunItem(
  activities: ReadonlyArray<FactoryCardActivity>,
): FactoryRunTimelineItem | null {
  let latest: FactoryRunTimelineItem | null = null;
  for (const activity of activities) {
    if (activity.kind !== FACTORY_RUN_ACTIVITY_KIND) continue;
    const item = factoryRunItem(activity);
    // `>=`: a later copy of the same run replaces the earlier one.
    if (item !== null && (latest === null || item.createdAt >= latest.createdAt)) latest = item;
  }
  return latest;
}

/** Each run's latest `factory.run` item, by run id: a report card reads its own run's. */
export function deriveFactoryRunItemsById(
  activities: ReadonlyArray<FactoryCardActivity>,
): ReadonlyMap<string, FactoryRunTimelineItem> {
  const byId = new Map<string, FactoryRunTimelineItem>();
  for (const activity of activities) {
    if (activity.kind !== FACTORY_RUN_ACTIVITY_KIND) continue;
    const item = factoryRunItem(activity);
    if (item === null) continue;
    const current = byId.get(item.run.runId);
    if (current === undefined || item.createdAt >= current.createdAt)
      byId.set(item.run.runId, item);
  }
  return byId;
}

// ---------------------------------------------------------------------------
// Orchestrator v2: cards are `factory_card` turn items, upserted by item id.
// ---------------------------------------------------------------------------

type FactoryCardTurnItem = Extract<OrchestrationV2TurnItem, { readonly type: "factory_card" }>;
type FactoryRunCardTurnItem = FactoryCardTurnItem & {
  readonly card: Extract<FactoryCardTurnItem["card"], { readonly kind: "run" }>;
};

/** The creation time a v2 card sorts and places by: when it was first recorded. */
export function factoryCardCreatedAt(item: FactoryCardTurnItem): string {
  return DateTime.formatIso(item.startedAt ?? item.updatedAt);
}

// Turn items are replaced, never mutated, so one timeline item per item object keeps the
// reference stable across derivations; rows compare it by reference.
const runItemByTurnItem = new WeakMap<FactoryCardTurnItem, FactoryRunTimelineItem>();

export function factoryRunItemFromCard(item: FactoryRunCardTurnItem): FactoryRunTimelineItem {
  const cached = runItemByTurnItem.get(item);
  if (cached !== undefined) return cached;
  const startedAt =
    item.card.payload.startedAt === null
      ? Option.none()
      : DateTime.make(item.card.payload.startedAt);
  const runItem = {
    id: item.id,
    // A run can attach after it starts. Normalize its start to UTC so string
    // ordering handles offsets and absent fractions. Unparseable or missing
    // starts retain the card timestamp fallback without throwing in rendering.
    createdAt: Option.isSome(startedAt)
      ? DateTime.formatIso(startedAt.value)
      : factoryCardCreatedAt(item),
    run: item.card.payload,
  };
  runItemByTurnItem.set(item, runItem);
  return runItem;
}

export function isFactoryRunCardItem(
  item: OrchestrationV2TurnItem,
): item is FactoryRunCardTurnItem {
  return (
    item.type === "factory_card" &&
    item.card.kind === "run" &&
    isFactoryRunActivityPayload(item.card.payload)
  );
}

/** Each run's card by run id, from a thread's turn items: a report card reads its own run's. */
export function deriveFactoryRunItemsByIdFromTurnItems(
  entries: ReadonlyArray<{ readonly item: OrchestrationV2TurnItem }>,
): ReadonlyMap<string, FactoryRunTimelineItem> {
  const byId = new Map<string, FactoryRunTimelineItem>();
  for (const { item } of entries) {
    if (!isFactoryRunCardItem(item)) continue;
    const runItem = factoryRunItemFromCard(item);
    const current = byId.get(runItem.run.runId);
    if (current === undefined || runItem.createdAt >= current.createdAt) {
      byId.set(runItem.run.runId, runItem);
    }
  }
  return byId;
}

/** The thread's run card: the latest-started run, or null. */
export function deriveLatestFactoryRunItemFromTurnItems(
  entries: ReadonlyArray<{ readonly item: OrchestrationV2TurnItem }>,
): FactoryRunTimelineItem | null {
  let latest: FactoryRunTimelineItem | null = null;
  for (const runItem of deriveFactoryRunItemsByIdFromTurnItems(entries).values()) {
    if (latest === null || runItem.createdAt >= latest.createdAt) latest = runItem;
  }
  return latest;
}
