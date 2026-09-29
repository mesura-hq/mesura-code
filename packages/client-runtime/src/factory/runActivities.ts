import {
  FACTORY_RUN_ACTIVITY_KIND,
  FactoryRunActivityPayload,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

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
const itemByActivity = new WeakMap<OrchestrationThreadActivity, FactoryRunTimelineItem | null>();

function factoryRunItem(activity: OrchestrationThreadActivity): FactoryRunTimelineItem | null {
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
  activities: ReadonlyArray<OrchestrationThreadActivity>,
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
  activities: ReadonlyArray<OrchestrationThreadActivity>,
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
