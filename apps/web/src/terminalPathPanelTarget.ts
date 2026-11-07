import { resolvePathLinkTarget, splitFilePathPosition } from "@t3tools/shared/fileLinks";
import { workspaceRelativeFilePath } from "@t3tools/shared/path";

/** Where a terminal runs, and the root its thread's file panel opens paths relative to. */
export interface TerminalPathLocation {
  readonly cwd: string;
  readonly worktreePath?: string | null | undefined;
  /** The thread's file panel root; a terminal can run in a subfolder of it. */
  readonly fileWorkspaceRoot?: string | undefined;
}

/**
 * Mesura: the file panel target for a terminal path link. The link resolves against the
 * terminal's cwd. A path inside the panel's root opens by its relative path; any other path opens
 * as a host file. Null when `~` cannot resolve.
 */
export function terminalPathPanelTarget(
  linkText: string,
  location: TerminalPathLocation,
): { readonly path: string; readonly line: number | undefined } | null {
  const { path, line } = splitFilePathPosition(resolvePathLinkTarget(linkText, location.cwd));
  if (path.startsWith("~")) return null;
  const workspaceRoot = location.fileWorkspaceRoot ?? location.worktreePath ?? location.cwd;
  return { path: workspaceRelativeFilePath(path, workspaceRoot) ?? path, line };
}
