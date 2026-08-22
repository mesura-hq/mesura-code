import { describe, expect, it } from "vite-plus/test";

import { activityRemainsVisibleOutsideTurnFold } from "./timelineActivity.ts";

describe("timeline activity visibility", () => {
  it("keeps context compaction visible without exposing ordinary tool work", () => {
    expect(activityRemainsVisibleOutsideTurnFold("context-compaction")).toBe(true);
    expect(activityRemainsVisibleOutsideTurnFold("tool.completed")).toBe(false);
    expect(activityRemainsVisibleOutsideTurnFold(undefined)).toBe(false);
  });
});
