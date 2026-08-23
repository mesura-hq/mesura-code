import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import {
  activityRemainsVisibleOutsideTurnFold,
  contextCompactionActivityDetail,
  contextCompactionActivityDetailFromHistory,
} from "./timelineActivity.ts";

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
      {
        kind: "context-window.updated",
        sequence: 37,
        createdAt: "2026-08-22T17:44:27.990Z",
        payload: { usedTokens: 26_826 },
      },
      {
        kind: "context-window.updated",
        sequence: 45,
        createdAt: "2026-08-22T17:44:43.614Z",
        payload: { usedTokens: 4_707 },
      },
      {
        kind: "context-compaction",
        sequence: 46,
        createdAt: "2026-08-22T17:44:43.615Z",
        payload: {},
      },
    ] as unknown as OrchestrationThreadActivity[];

    expect(contextCompactionActivityDetailFromHistory(activities[2]!, activities)).toBe(
      "The provider did not expose the compaction summary for this earlier event.\n\n" +
        "Compaction details\n" +
        "Before: 26,826 tokens\n" +
        "After: 4,707 tokens\n" +
        "Reduced: 22,119 tokens (82%)",
    );
  });
});
