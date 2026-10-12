import { describe, expect, it } from "vitest";

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

  it("keeps a name that is only the namespace or merely starts like it", () => {
    expect(threadBranchCardLabel("t3code/")).toBe("t3code/");
    expect(threadBranchCardLabel("t3codex/thing")).toBe("t3codex/thing");
  });
});
