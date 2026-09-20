import type { EnvironmentId } from "@t3tools/contracts";

export interface FileManagerTarget {
  readonly environmentId: EnvironmentId;
  /** The directory the file manager starts in: the thread's project. */
  readonly cwd: string;
}

/**
 * Where the file manager starts for the active thread. The same pair the
 * file panel is keyed on: the thread's worktree when it works in one, the
 * project's workspace root otherwise.
 */
export function fileManagerTarget(
  thread: { readonly environmentId: EnvironmentId; readonly worktreePath: string | null } | null,
  project: { readonly workspaceRoot: string } | null,
): FileManagerTarget | null {
  if (thread === null || project === null) return null;
  return { environmentId: thread.environmentId, cwd: thread.worktreePath ?? project.workspaceRoot };
}
