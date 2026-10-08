import type { GitWorkingTreeChange } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatGitChangeDecoration,
  gitChangeLetter,
  gitChangeRows,
  gitChangeTreeStatus,
  isPathInsideRepository,
  summarizeGitChanges,
} from "./treeDiff.logic";

function change(
  path: string,
  index: GitWorkingTreeChange["index"],
  worktree: GitWorkingTreeChange["worktree"],
  staged: [number, number] = [0, 0],
  unstaged: [number, number] = [0, 0],
  binary = false,
): GitWorkingTreeChange {
  return {
    path,
    index,
    worktree,
    staged: { insertions: staged[0], deletions: staged[1] },
    unstaged: { insertions: unstaged[0], deletions: unstaged[1] },
    binary,
  };
}

describe("summarizeGitChanges", () => {
  it("splits Tree diff's files into staged, unstaged and untracked sides", () => {
    const summary = summarizeGitChanges([
      change("staged.ts", "M", ".", [4, 1]),
      change("unstaged.ts", ".", "M", [0, 0], [7, 2]),
      change("both.ts", "A", "M", [10, 0], [2, 3]),
      change("new.ts", "?", "?", [0, 0], [5, 0]),
    ]);

    expect(summary).toEqual({
      total: 4,
      staged: { files: 2, insertions: 14, deletions: 1 },
      unstaged: { files: 2, insertions: 9, deletions: 5 },
      untracked: { files: 1, insertions: 5, deletions: 0 },
      conflicted: 0,
    });
  });

  it("counts a Tree diff conflict on either side once", () => {
    const summary = summarizeGitChanges([change("a.ts", "U", "U"), change("b.ts", "A", "U")]);

    expect(summary.conflicted).toBe(2);
  });

  it("leaves every Tree diff side empty for a clean working tree", () => {
    const empty = { files: 0, insertions: 0, deletions: 0 };
    expect(summarizeGitChanges([])).toEqual({
      total: 0,
      staged: empty,
      unstaged: empty,
      untracked: empty,
      conflicted: 0,
    });
  });
});

describe("gitChangeLetter", () => {
  it("shows the working tree side of a Tree diff row when both sides changed", () => {
    expect(gitChangeLetter(change("a.ts", "A", "M"))).toBe("M");
    expect(gitChangeLetter(change("a.ts", "A", "."))).toBe("A");
    expect(gitChangeLetter(change("a.ts", ".", "D"))).toBe("D");
    expect(gitChangeLetter(change("a.ts", "R", "."))).toBe("R");
  });

  it("letters an untracked Tree diff row ?, a conflict U and a type change M", () => {
    expect(gitChangeLetter(change("a.ts", "?", "?"))).toBe("?");
    expect(gitChangeLetter(change("a.ts", "A", "U"))).toBe("U");
    expect(gitChangeLetter(change("a.ts", ".", "T"))).toBe("M");
  });
});

describe("gitChangeTreeStatus", () => {
  // The tree colours rows by this status: modified amber, added green,
  // deleted red, renamed orange, untracked blue.
  it("maps each Tree diff letter to the tree status its colour comes from", () => {
    expect(gitChangeTreeStatus(change("a.ts", ".", "M"))).toBe("modified");
    expect(gitChangeTreeStatus(change("a.ts", "A", "."))).toBe("added");
    expect(gitChangeTreeStatus(change("a.ts", ".", "D"))).toBe("deleted");
    expect(gitChangeTreeStatus(change("a.ts", "R", "."))).toBe("renamed");
    expect(gitChangeTreeStatus(change("a.ts", "C", "."))).toBe("renamed");
    expect(gitChangeTreeStatus(change("a.ts", "?", "?"))).toBe("untracked");
  });
});

describe("formatGitChangeDecoration", () => {
  it("adds staged and unstaged lines into one Tree diff row count", () => {
    expect(formatGitChangeDecoration(change("a.ts", "M", "M", [4, 1], [7, 2]))).toBe("+11 −3");
  });

  it("leaves a zero side out of a Tree diff row count", () => {
    expect(formatGitChangeDecoration(change("a.ts", "?", "?", [0, 0], [3, 0]))).toBe("+3");
    expect(formatGitChangeDecoration(change("a.ts", ".", "D", [0, 0], [0, 9]))).toBe("−9");
  });

  it("marks a binary Tree diff row bin, a conflict conflict and a pure rename nothing", () => {
    expect(formatGitChangeDecoration(change("a.png", ".", "M", [0, 0], [0, 0], true))).toBe("bin");
    expect(formatGitChangeDecoration(change("a.ts", "U", "U"))).toBe("conflict");
    expect(formatGitChangeDecoration(change("a.ts", "R", "."))).toBeNull();
  });
});

describe("gitChangeRows", () => {
  it("keeps a nested project's Tree diff rows distinct when paths inside and outside it match", () => {
    const rows = gitChangeRows(
      [change("apps/web/shared/x.ts", ".", "M"), change("shared/x.ts", ".", "M")],
      "/repo",
      "/repo/apps/web",
    );

    expect(rows.map((row) => row.path)).toEqual(["apps/web/shared/x.ts", "shared/x.ts"]);
    expect(rows.map((row) => row.workspacePath)).toEqual(["shared/x.ts", null]);
  });

  it("opens a Tree diff row at its repository path when the cwd is the root", () => {
    const [row] = gitChangeRows([change("src/a.ts", ".", "M")], "/repo", "/repo/");

    expect(row).toMatchObject({ path: "src/a.ts", workspacePath: "src/a.ts" });
  });

  it("keeps a Tree diff row's repository path when the server sent no root", () => {
    const [row] = gitChangeRows([change("src/a.ts", ".", "M")], null, "/repo");

    expect(row).toMatchObject({ path: "src/a.ts", workspacePath: "src/a.ts" });
  });
});

describe("isPathInsideRepository", () => {
  it("accepts a Tree diff cwd at or below the repository root", () => {
    expect(isPathInsideRepository("/repo", "/repo")).toBe(true);
    expect(isPathInsideRepository("/repo/", "/repo/apps/web")).toBe(true);
  });

  it("rejects a Tree diff cwd in another repository or a sibling with the same prefix", () => {
    expect(isPathInsideRepository("/repo", "/other")).toBe(false);
    expect(isPathInsideRepository("/repo", "/repo-worktree")).toBe(false);
    expect(isPathInsideRepository(null, "/repo")).toBe(false);
  });
});
