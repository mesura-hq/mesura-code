import {
  FACTORY_PLAN_ACTIVITY_KIND,
  FactoryPlanActivityPayload,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** One presented plan file, as the timeline places it: its latest activity. */
export interface FactoryPlanTimelineItem {
  /** The `factory.plan` activity id, stable per plan file across revisions. */
  readonly id: string;
  readonly createdAt: string;
  readonly plan: FactoryPlanActivityPayload;
}

const isFactoryPlanActivityPayload = Schema.is(FactoryPlanActivityPayload);

// Activities are immutable, so one item per activity object keeps the item's
// reference stable across derivations; timeline rows compare it by reference.
const itemByActivity = new WeakMap<OrchestrationThreadActivity, FactoryPlanTimelineItem | null>();

function factoryPlanItem(activity: OrchestrationThreadActivity): FactoryPlanTimelineItem | null {
  const cached = itemByActivity.get(activity);
  if (cached !== undefined) return cached;
  const item = isFactoryPlanActivityPayload(activity.payload)
    ? { id: activity.id, createdAt: activity.createdAt, plan: activity.payload }
    : null;
  itemByActivity.set(activity, item);
  return item;
}

/**
 * The plan cards of a thread: the latest `factory.plan` activity per id, in
 * time order. A payload that does not decode shows nothing rather than a row.
 */
export function deriveFactoryPlanTimelineItems(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<FactoryPlanTimelineItem> {
  const latestById = new Map<string, OrchestrationThreadActivity>();
  for (const activity of activities) {
    if (activity.kind !== FACTORY_PLAN_ACTIVITY_KIND) continue;
    const current = latestById.get(activity.id);
    if (current === undefined || current.createdAt <= activity.createdAt) {
      latestById.set(activity.id, activity);
    }
  }
  const items: FactoryPlanTimelineItem[] = [];
  for (const activity of latestById.values()) {
    const item = factoryPlanItem(activity);
    if (item !== null) items.push(item);
  }
  return items.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}
