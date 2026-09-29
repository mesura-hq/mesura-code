import {
  isFactoryRunFinished,
  type FactoryRunActivityPayload,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import {
  deriveLatestFactoryRunItem,
  type FactoryRunTimelineItem,
} from "@t3tools/client-runtime/factory/run-activities";

/** The thread's run card in the feed. Its id is the `factory.run` activity id, fixed per run. */
export interface FactoryRunFeedEntry {
  readonly type: "factory-run";
  readonly id: string;
  readonly createdAt: string;
  readonly run: FactoryRunActivityPayload;
}

// One entry per item, and items are cached per activity: an unchanged run
// hands the list the same entry, so its memoized row does not re-render.
const entryByItem = new WeakMap<FactoryRunTimelineItem, FactoryRunFeedEntry>();

export function getFactoryRunFeedEntry(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): FactoryRunFeedEntry | null {
  const item = deriveLatestFactoryRunItem(activities);
  if (item === null) return null;
  let entry = entryByItem.get(item);
  if (entry === undefined) {
    entry = { type: "factory-run", id: item.id, createdAt: item.createdAt, run: item.run };
    entryByItem.set(item, entry);
  }
  return entry;
}

/**
 * A live run (running or waiting) follows the end of the feed instead of its
 * start time, so it is placed after the feed is sorted and grouped and never
 * splits the coordinator's tool rows. A finished run sits at its start time.
 */
export function isLiveFactoryRunEntry(entry: {
  readonly type: string;
}): entry is FactoryRunFeedEntry {
  return (
    entry.type === "factory-run" && !isFactoryRunFinished((entry as FactoryRunFeedEntry).run.status)
  );
}
