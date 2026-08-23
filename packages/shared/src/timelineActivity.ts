import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { formatDuration } from "./orchestrationTiming.ts";

const COMPACTION_DETAILS_MARKER = "\n\nCompaction details\n";

function finiteCompactionMetric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function activityPayload(activity: OrchestrationThreadActivity): Record<string, unknown> {
  return activity.payload !== null && typeof activity.payload === "object"
    ? (activity.payload as Record<string, unknown>)
    : {};
}

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatContextCompactionDetail(input: {
  readonly provider?: string;
  readonly summary?: string;
  readonly fallbackDetail?: string;
  readonly preTokens?: number;
  readonly postTokens?: number;
  readonly durationMs?: number;
  readonly trigger?: "manual" | "auto";
}): string {
  const summary = input.summary?.trim();
  const fallbackDetail = input.fallbackDetail?.trim();
  const summarySection = summary
    ? `Summary\n${summary}`
    : fallbackDetail ||
      (input.provider === "codex"
        ? "Codex does not expose the compaction summary."
        : "Claude Code did not provide a compaction summary for this event.");

  const preTokens = finiteCompactionMetric(input.preTokens);
  const postTokens = finiteCompactionMetric(input.postTokens);
  const durationMs = finiteCompactionMetric(input.durationMs);
  const metrics: string[] = [];
  if (preTokens !== undefined) metrics.push(`Before: ${formatTokenCount(preTokens)} tokens`);
  if (postTokens !== undefined) metrics.push(`After: ${formatTokenCount(postTokens)} tokens`);
  if (preTokens !== undefined && postTokens !== undefined && preTokens >= postTokens) {
    const reduction = preTokens - postTokens;
    const percentage = preTokens > 0 ? Math.round((reduction / preTokens) * 100) : 0;
    metrics.push(`Reduced: ${formatTokenCount(reduction)} tokens (${percentage}%)`);
  }
  if (durationMs !== undefined) metrics.push(`Duration: ${formatDuration(durationMs)}`);
  if (input.trigger) metrics.push(`Trigger: ${input.trigger}`);

  return metrics.length > 0
    ? `${summarySection}${COMPACTION_DETAILS_MARKER}${metrics.join("\n")}`
    : summarySection;
}

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

export function contextCompactionActivityDetailFromHistory(
  activity: OrchestrationThreadActivity,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): string | undefined {
  const fallbackDetail = contextCompactionActivityDetail(
    activity.kind,
    activityPayload(activity).detail,
  );
  if (
    activity.kind !== "context-compaction" ||
    fallbackDetail?.includes(COMPACTION_DETAILS_MARKER)
  ) {
    return fallbackDetail;
  }

  const compactionSequence = activity.sequence ?? Number.MAX_SAFE_INTEGER;
  const contextSnapshots = activities
    .filter(
      (candidate) =>
        candidate.kind === "context-window.updated" &&
        (candidate.sequence === undefined
          ? candidate.createdAt <= activity.createdAt
          : candidate.sequence <= compactionSequence),
    )
    .toSorted(
      (left, right) =>
        (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER) ||
        left.createdAt.localeCompare(right.createdAt),
    );
  const postSnapshot = contextSnapshots.at(-1);
  const preSnapshot = contextSnapshots.at(-2);
  const preTokens = finiteCompactionMetric(
    preSnapshot ? activityPayload(preSnapshot).usedTokens : undefined,
  );
  const postTokens = finiteCompactionMetric(
    postSnapshot ? activityPayload(postSnapshot).usedTokens : undefined,
  );
  const hasCompactionReduction =
    preTokens !== undefined && postTokens !== undefined && preTokens > postTokens;

  const provider = activityPayload(activity).provider;
  return formatContextCompactionDetail({
    ...(typeof provider === "string" ? { provider } : {}),
    ...(fallbackDetail ? { fallbackDetail } : {}),
    ...(hasCompactionReduction ? { preTokens, postTokens } : {}),
  });
}
