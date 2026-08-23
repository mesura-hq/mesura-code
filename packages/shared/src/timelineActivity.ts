import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export function activityRemainsVisibleOutsideTurnFold(
  kind: OrchestrationThreadActivity["kind"] | undefined,
): boolean {
  return kind === "context-compaction";
}

export function contextCompactionActivityDetail(
  kind: OrchestrationThreadActivity["kind"],
  detail: unknown,
): string | undefined {
  if (kind !== "context-compaction") {
    return undefined;
  }
  if (typeof detail === "string" && detail.trim().length > 0) {
    return detail.trim();
  }
  return "The provider did not expose the compaction summary for this earlier event.";
}
