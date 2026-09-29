import { isFactoryRunFinished } from "@t3tools/contracts";
import type { FactoryRunTimelineItem } from "@t3tools/client-runtime/factory/run-activities";

import type { MessagesTimelineRow } from "../components/chat/MessagesTimeline.logic";

/**
 * Places the run card among the timeline's rows, as a side input like the
 * worktree setup card rather than a timeline entry, so turn folds and tool
 * groups never touch it. A live run (running or waiting) follows the end of
 * the timeline, below the coordinator's newest tool rows and ahead of queued
 * messages; a finished run returns to its start time. The row id is the
 * activity id, fixed per run, so the row stays mounted while the run moves.
 */
export function placeFactoryRunRow(
  rows: MessagesTimelineRow[],
  item: FactoryRunTimelineItem | null,
): MessagesTimelineRow[] {
  if (item === null) return rows;
  const row: MessagesTimelineRow = {
    kind: "factory-run",
    id: item.id,
    createdAt: item.createdAt,
    factoryRun: item,
  };
  const index = isFactoryRunFinished(item.run.status)
    ? rows.findIndex((entry) => entry.createdAt !== null && entry.createdAt > item.createdAt)
    : rows.findIndex((entry) => entry.kind === "queued-message");
  if (index < 0) rows.push(row);
  else rows.splice(index, 0, row);
  return rows;
}
