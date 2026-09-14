import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { fileManagerTarget } from "./fileManagerTarget";

const environmentId = EnvironmentId.make("env-1");
const project = { environmentId, workspaceRoot: "/home/dev/repos/app" };

describe("fileManagerTarget", () => {
  it("starts at the thread's worktree when it has one", () => {
    expect(
      fileManagerTarget({ environmentId, worktreePath: "/home/dev/repos/app/.wt/x" }, project),
    ).toEqual({ environmentId, cwd: "/home/dev/repos/app/.wt/x" });
  });

  it("starts at the project's workspace root otherwise", () => {
    expect(fileManagerTarget({ environmentId, worktreePath: null }, project)).toEqual({
      environmentId,
      cwd: "/home/dev/repos/app",
    });
  });

  it("has nowhere to start without a thread or a project", () => {
    expect(fileManagerTarget(null, project)).toBeNull();
    expect(fileManagerTarget({ environmentId, worktreePath: null }, null)).toBeNull();
  });
});
