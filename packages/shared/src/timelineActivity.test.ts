import { describe, expect, it } from "vite-plus/test";

import {
  activityRemainsVisibleOutsideTurnFold,
  contextCompactionActivityDetail,
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
});
