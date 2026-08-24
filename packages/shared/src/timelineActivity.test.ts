import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";

import {
  activityRemainsVisibleOutsideTurnFold,
  contextCompactionActivityDetail,
  contextCompactionActivityDetailFromHistory,
} from "./timelineActivity.ts";

function timelineActivity(input: {
  readonly id: string;
  readonly kind: string;
  readonly createdAt: string;
  readonly payload: unknown;
  readonly sequence?: number;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(input.id),
    tone: "info",
    kind: input.kind,
    summary: input.kind,
    payload: input.payload,
    turnId: null,
    ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
    createdAt: input.createdAt,
  };
}

describe("timeline activity visibility", () => {
  it("keeps context compaction visible without exposing ordinary tool work", () => {
    expect(activityRemainsVisibleOutsideTurnFold("context-compaction")).toBe(true);
    expect(activityRemainsVisibleOutsideTurnFold("tool.completed")).toBe(false);
    expect(activityRemainsVisibleOutsideTurnFold(undefined)).toBe(false);
  });

  it("gives earlier compaction events an honest expandable fallback", () => {
    expect(contextCompactionActivityDetail("context-compaction", undefined)).toContain(
      "earlier event",
    );
    expect(contextCompactionActivityDetail("context-compaction", "Exact summary")).toBe(
      "Exact summary",
    );
    expect(contextCompactionActivityDetail("tool.completed", undefined)).toBeUndefined();
  });

  it("correlates Codex token snapshots around an earlier compaction", () => {
    const activities = [
      timelineActivity({
        id: "context-before",
        kind: "context-window.updated",
        sequence: 37,
        createdAt: "2026-08-22T17:44:27.990Z",
        payload: { usedTokens: 26_826 },
      }),
      timelineActivity({
        id: "context-after",
        kind: "context-window.updated",
        sequence: 45,
        createdAt: "2026-08-22T17:44:43.614Z",
        payload: { usedTokens: 4_707 },
      }),
      timelineActivity({
        id: "context-compaction",
        kind: "context-compaction",
        sequence: 46,
        createdAt: "2026-08-22T17:44:43.615Z",
        payload: {},
      }),
    ] satisfies ReadonlyArray<OrchestrationThreadActivity>;

    expect(contextCompactionActivityDetailFromHistory(activities[2]!, activities)).toBe(
      "The provider did not expose the compaction summary for this earlier event.\n\n" +
        "Compaction details\n" +
        "Before: 26,826 tokens\n" +
        "After: 4,707 tokens\n" +
        "Reduced: 22,119 tokens (82%)",
    );
  });

  it("does not correlate a future sequenced snapshot to an unsequenced compaction", () => {
    const activities = [
      timelineActivity({
        id: "context-before",
        kind: "context-window.updated",
        sequence: 10,
        createdAt: "2026-08-22T17:44:20.000Z",
        payload: { usedTokens: 20_000 },
      }),
      timelineActivity({
        id: "context-after",
        kind: "context-window.updated",
        sequence: 20,
        createdAt: "2026-08-22T17:44:30.000Z",
        payload: { usedTokens: 4_000 },
      }),
      timelineActivity({
        id: "context-compaction",
        kind: "context-compaction",
        createdAt: "2026-08-22T17:44:31.000Z",
        payload: {},
      }),
      timelineActivity({
        id: "future-context",
        kind: "context-window.updated",
        sequence: 30,
        createdAt: "2026-08-22T17:45:00.000Z",
        payload: { usedTokens: 30_000 },
      }),
    ] satisfies ReadonlyArray<OrchestrationThreadActivity>;

    expect(contextCompactionActivityDetailFromHistory(activities[2]!, activities)).toContain(
      "Before: 20,000 tokens\nAfter: 4,000 tokens",
    );
  });

  it("preserves structured compaction details from earlier Claude events", () => {
    const activities = [
      timelineActivity({
        id: "claude-context-compaction",
        kind: "context-compaction",
        createdAt: "2026-08-22T17:44:31.000Z",
        payload: {
          provider: "claudeAgent",
          detail: {
            compact_summary: "Keep the implementation state.",
            compact_metadata: {
              pre_tokens: 20_000,
              post_tokens: 4_000,
              duration_ms: 1_500,
              trigger: "manual",
            },
          },
        },
      }),
    ] satisfies ReadonlyArray<OrchestrationThreadActivity>;

    expect(contextCompactionActivityDetailFromHistory(activities[0]!, activities)).toBe(
      "Summary\nKeep the implementation state.\n\n" +
        "Compaction details\n" +
        "Before: 20,000 tokens\n" +
        "After: 4,000 tokens\n" +
        "Reduced: 16,000 tokens (80%)\n" +
        "Duration: 1.5s\n" +
        "Trigger: manual",
    );
  });
});
