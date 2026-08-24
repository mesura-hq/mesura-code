import { describe, expect, it } from "@effect/vitest";

import { workLogRowDetailPresentation } from "./thread-work-log-presentation";

describe("work log row detail presentation", () => {
  const compactionRow = {
    detail: "Summary and flattened compaction metrics",
    sourceActivityKind: "context-compaction",
    getFullDetail: () => "Before: 26,826 tokens\nAfter: 4,707 tokens",
  } as const;

  it("keeps compaction detail out of the collapsed row", () => {
    expect(workLogRowDetailPresentation(compactionRow, false)).toEqual({
      collapsedDetail: null,
      expandedDetail: null,
    });
  });

  it("shows compaction detail only inside the expanded disclosure", () => {
    expect(workLogRowDetailPresentation(compactionRow, true)).toEqual({
      collapsedDetail: null,
      expandedDetail: "Before: 26,826 tokens\nAfter: 4,707 tokens",
    });
  });
});
