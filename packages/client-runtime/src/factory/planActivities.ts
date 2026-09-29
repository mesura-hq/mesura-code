import {
  FACTORY_PLAN_ACTIVITY_KIND,
  FACTORY_REPORT_ACTIVITY_KIND,
  FactoryPlanActivityPayload,
  FactoryReportActivityPayload,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { deriveFactoryRunItemsById, type FactoryRunTimelineItem } from "./runActivities.ts";

/** One presented plan file, as a thread's timeline or feed places it: its latest activity. */
export interface FactoryPlanTimelineItem {
  readonly kind: "plan";
  /** The `factory.plan` activity id, stable per plan file across revisions. */
  readonly id: string;
  readonly createdAt: string;
  readonly plan: FactoryPlanActivityPayload;
}

/** One written report, as a thread's timeline or feed places it: its latest activity. */
export interface FactoryReportTimelineItem {
  readonly kind: "report";
  /** The `factory.report` activity id, one per thread and run. */
  readonly id: string;
  readonly createdAt: string;
  readonly report: FactoryReportActivityPayload;
  /** The latest `factory.run` activity of the report's run: the card's numbers. */
  readonly run: FactoryRunTimelineItem | null;
}

/** A card the Factory places in a thread by time: a presented plan or a written report. */
export type FactoryTimelineItem = FactoryPlanTimelineItem | FactoryReportTimelineItem;

const isFactoryPlanActivityPayload = Schema.is(FactoryPlanActivityPayload);
const isFactoryReportActivityPayload = Schema.is(FactoryReportActivityPayload);

// Activities are immutable, so one item per activity object keeps the item's
// reference stable across derivations; timeline rows compare it by reference.
// A report item also depends on its run's item, so it is cached per pair.
const itemByActivity = new WeakMap<OrchestrationThreadActivity, FactoryPlanTimelineItem | null>();
const NO_RUN = {};
const reportItemByActivity = new WeakMap<
  OrchestrationThreadActivity,
  WeakMap<object, FactoryReportTimelineItem | null>
>();

function factoryTimelineItem(
  activity: OrchestrationThreadActivity,
  runsById: () => ReadonlyMap<string, FactoryRunTimelineItem>,
): FactoryTimelineItem | null {
  const { id, createdAt, payload } = activity;
  if (activity.kind === FACTORY_PLAN_ACTIVITY_KIND) {
    const cached = itemByActivity.get(activity);
    if (cached !== undefined) return cached;
    const item: FactoryPlanTimelineItem | null = isFactoryPlanActivityPayload(payload)
      ? { kind: "plan", id, createdAt, plan: payload }
      : null;
    itemByActivity.set(activity, item);
    return item;
  }
  if (!isFactoryReportActivityPayload(payload)) return null;
  const run = runsById().get(payload.runId) ?? null;
  let byRun = reportItemByActivity.get(activity);
  if (byRun === undefined) {
    byRun = new WeakMap();
    reportItemByActivity.set(activity, byRun);
  }
  const cached = byRun.get(run ?? NO_RUN);
  if (cached !== undefined) return cached;
  const item: FactoryReportTimelineItem = { kind: "report", id, createdAt, report: payload, run };
  byRun.set(run ?? NO_RUN, item);
  return item;
}

/**
 * The plan and report cards of a thread: the latest `factory.plan` or
 * `factory.report` activity per id, in time order. A payload that does not
 * decode shows nothing rather than a row. Web places these in its timeline
 * and mobile in its feed.
 */
export function deriveFactoryTimelineItems(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<FactoryTimelineItem> {
  const latestById = new Map<string, OrchestrationThreadActivity>();
  for (const activity of activities) {
    if (
      activity.kind !== FACTORY_PLAN_ACTIVITY_KIND &&
      activity.kind !== FACTORY_REPORT_ACTIVITY_KIND
    ) {
      continue;
    }
    const current = latestById.get(activity.id);
    if (current === undefined || current.createdAt <= activity.createdAt) {
      latestById.set(activity.id, activity);
    }
  }
  let runsById: ReadonlyMap<string, FactoryRunTimelineItem> | null = null;
  const runs = () => (runsById ??= deriveFactoryRunItemsById(activities));
  const items: FactoryTimelineItem[] = [];
  for (const activity of latestById.values()) {
    const item = factoryTimelineItem(activity, runs);
    if (item !== null) items.push(item);
  }
  // Sorted in place on a fresh array: Hermes has no `toSorted`.
  return items.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/** The plan cards of a thread alone, for the Factory pane's and screen's Plan tab. */
export function deriveFactoryPlanTimelineItems(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<FactoryPlanTimelineItem> {
  return deriveFactoryTimelineItems(activities).filter(
    (item): item is FactoryPlanTimelineItem => item.kind === "plan",
  );
}

/** The report a run wrote, among a thread's Factory cards; null before it wrote one. */
export function findFactoryReportItem(
  items: ReadonlyArray<FactoryTimelineItem>,
  runId: string | null,
): FactoryReportTimelineItem | null {
  let found: FactoryReportTimelineItem | null = null;
  for (const item of items) {
    if (item.kind === "report" && item.report.runId === runId) found = item;
  }
  return found;
}
