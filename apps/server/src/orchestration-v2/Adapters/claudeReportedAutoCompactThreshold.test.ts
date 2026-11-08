import { describe, expect, it } from "vite-plus/test";

import {
  claudeReportedAutoCompactThreshold,
  withClaudeReportedAutoCompactThreshold,
} from "./claudeReportedAutoCompactThreshold.ts";

describe("claudeReportedAutoCompactThreshold", () => {
  it("reads the threshold while automatic compaction is on", () => {
    expect(
      claudeReportedAutoCompactThreshold({
        autoCompactThreshold: 717_000,
        isAutoCompactEnabled: true,
      }),
    ).toBe(717_000);
  });

  it("reports no threshold when Claude does not compact on its own", () => {
    expect(
      claudeReportedAutoCompactThreshold({
        autoCompactThreshold: 717_000,
        isAutoCompactEnabled: false,
      }),
    ).toBeNull();
    expect(claudeReportedAutoCompactThreshold({ isAutoCompactEnabled: true })).toBeNull();
  });
});

describe("withClaudeReportedAutoCompactThreshold", () => {
  const usage = { usedTokens: 1_000, autoCompactThreshold: 150_000 };

  it("keeps the settings threshold until Claude answers", () => {
    expect(withClaudeReportedAutoCompactThreshold(usage, undefined)).toEqual(usage);
  });

  it("replaces it with the reported one, or removes it", () => {
    expect(withClaudeReportedAutoCompactThreshold(usage, 717_000)).toEqual({
      usedTokens: 1_000,
      autoCompactThreshold: 717_000,
    });
    expect(withClaudeReportedAutoCompactThreshold(usage, null)).toEqual({ usedTokens: 1_000 });
  });
});
