import type { ThreadFeedActivity } from "../../lib/threadActivity";

type WorkLogDetailSource = Pick<
  ThreadFeedActivity,
  "detail" | "getFullDetail" | "sourceActivityKind"
>;

export function workLogRowDetailPresentation(
  row: WorkLogDetailSource,
  expanded: boolean,
): {
  readonly collapsedDetail: string | null;
  readonly expandedDetail: string | null;
} {
  return {
    collapsedDetail: row.sourceActivityKind === "context-compaction" ? null : row.detail,
    expandedDetail: expanded ? row.getFullDetail() : null,
  };
}
