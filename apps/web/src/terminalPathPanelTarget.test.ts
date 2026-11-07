import { describe, expect, it } from "vite-plus/test";

import { terminalPathPanelTarget } from "./terminalPathPanelTarget";

describe("terminalPathPanelTarget", () => {
  it("opens a relative link by its workspace path, with its line", () => {
    expect(terminalPathPanelTarget("src/app.ts:12:3", { cwd: "/repo" })).toEqual({
      path: "src/app.ts",
      line: 12,
    });
  });

  it("resolves a link from a terminal in a subfolder of the thread's root", () => {
    expect(
      terminalPathPanelTarget("src/app.ts:12", {
        cwd: "/repo/packages/web",
        fileWorkspaceRoot: "/repo",
      }),
    ).toEqual({ path: "packages/web/src/app.ts", line: 12 });
  });

  it("opens a worktree terminal's link relative to the worktree", () => {
    expect(
      terminalPathPanelTarget("app.ts:4", {
        cwd: "/worktrees/feature/src",
        worktreePath: "/worktrees/feature",
        fileWorkspaceRoot: "/worktrees/feature",
      }),
    ).toEqual({ path: "src/app.ts", line: 4 });
  });

  it("opens a terminal's link from another checkout as a host file", () => {
    expect(
      terminalPathPanelTarget("src/app.ts", {
        cwd: "/worktrees/old",
        worktreePath: "/worktrees/old",
        fileWorkspaceRoot: "/repo",
      }),
    ).toEqual({ path: "/worktrees/old/src/app.ts", line: undefined });
  });

  it("opens an absolute path inside the workspace by its workspace path", () => {
    expect(terminalPathPanelTarget("/repo/README.md:4", { cwd: "/repo" })).toEqual({
      path: "README.md",
      line: 4,
    });
  });

  it("opens nothing when the terminal cannot tell where ~ is", () => {
    expect(terminalPathPanelTarget("~/notes.txt:3", { cwd: "/tmp/project" })).toBeNull();
  });

  it("opens a path outside the workspace as a host file", () => {
    expect(terminalPathPanelTarget("/etc/hosts", { cwd: "/repo" })).toEqual({
      path: "/etc/hosts",
      line: undefined,
    });
  });
});
