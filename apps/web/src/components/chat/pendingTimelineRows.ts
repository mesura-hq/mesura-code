import {
  findPlanApprovals,
  resolvePlanApprovalState,
} from "@t3tools/client-runtime/factory/plan-approval";

import type { TimelineEntry } from "../../session-logic";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

type PlanRow = Extract<MessagesTimelineRow, { kind: "factory-plan" }>;

function newestFactoryPlanRow(rows: ReadonlyArray<MessagesTimelineRow>): PlanRow | null {
  let newest: PlanRow | null = null;
  for (const row of rows) {
    if (row.kind !== "factory-plan") continue;
    // A revised plan keeps its original anchor; presentation time decides which card waits last.
    if (
      newest === null ||
      Date.parse(row.factoryPlan.plan.presentedAt) >
        Date.parse(newest.factoryPlan.plan.presentedAt) ||
      (row.factoryPlan.plan.presentedAt === newest.factoryPlan.plan.presentedAt &&
        Date.parse(row.createdAt) >= Date.parse(newest.createdAt))
    ) {
      newest = row;
    }
  }
  return newest;
}

export function placePendingTimelineRows(
  rows: MessagesTimelineRow[],
  entries: ReadonlyArray<TimelineEntry>,
): MessagesTimelineRow[] {
  const newest = newestFactoryPlanRow(rows);
  const approvals = newest
    ? findPlanApprovals(
        entries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
      )
    : [];
  const pendingPlan =
    newest && resolvePlanApprovalState(approvals, newest.factoryPlan.plan).kind !== "approved"
      ? newest
      : null;
  const chronological: MessagesTimelineRow[] = [];
  const questions: MessagesTimelineRow[] = [];
  for (const row of rows) {
    if (row.kind === "pending-user-input") questions.push(row);
    else if (row !== pendingPlan) chronological.push(row);
  }
  return [...chronological, ...(pendingPlan ? [pendingPlan] : []), ...questions];
}
