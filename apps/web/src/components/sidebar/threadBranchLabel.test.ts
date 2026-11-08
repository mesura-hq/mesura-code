import { describe, expect, it } from "vite-plus/test";

import { threadBranchCardLabel } from "./threadBranchLabel";

describe("threadBranchCardLabel", () => {
  it("drops the app's own namespace, old and new", () => {
    expect(threadBranchCardLabel("mesura/redesign-file-manager")).toBe("redesign-file-manager");
    expect(threadBranchCardLabel("t3code/embedded-previews")).toBe("embedded-previews");
    expect(threadBranchCardLabel("t3/ab12cd34")).toBe("ab12cd34");
  });

  it("keeps a prefix the user or agent chose", () => {
    expect(threadBranchCardLabel("feat/search")).toBe("feat/search");
    expect(threadBranchCardLabel("main")).toBe("main");
  });

  it.each(["mesura/", "t3/", "t3code/"])("keeps the empty namespace %s", (branch) => {
    expect(threadBranchCardLabel(branch)).toBe(branch);
  });

  it("keeps a name that merely starts like an app namespace", () => {
    expect(threadBranchCardLabel("t3codex/thing")).toBe("t3codex/thing");
  });
});
