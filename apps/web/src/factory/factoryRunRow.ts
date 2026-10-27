import { isFactoryRunFinished } from "@t3tools/contracts";
import type { FactoryRunTimelineItem } from "@t3tools/client-runtime/factory/run-activities";

import type { MessagesTimelineRow } from "../components/chat/MessagesTimeline.logic";

/**
 * A side input like the worktree setup card, so turn folds and tool groups never touch it.
 * A live run follows the last row; a finished run returns to its start time. The row id
 * is fixed per run, so the row stays mounted while the run moves.
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
  // v2 timelines carry no queued-message rows (queued messages render outside
  // the row list), so a live run simply follows the last row.
  const index = isFactoryRunFinished(item.run.status)
    ? rows.findIndex((entry) => entry.createdAt !== null && entry.createdAt > item.createdAt)
    : -1;
  if (index < 0) rows.push(row);
  else rows.splice(index, 0, row);
  return rows;
}
