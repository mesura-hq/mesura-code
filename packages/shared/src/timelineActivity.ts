import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export function activityRemainsVisibleOutsideTurnFold(
  kind: OrchestrationThreadActivity["kind"] | undefined,
): boolean {
  return kind === "context-compaction";
}
