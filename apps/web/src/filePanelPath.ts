import { resolvePathLinkTarget, splitFilePathPosition } from "@t3tools/shared/fileLinks";
import { resolveWorkspaceFilePath, workspaceRelativeFilePath } from "@t3tools/shared/path";

/**
 * Mesura: the path the file panel opens for a host file. A file inside the panel's root opens by
 * its relative path; any other file opens as a host file.
 */
function filePanelPath(absolutePath: string, workspaceRoot: string): string {
  return workspaceRelativeFilePath(absolutePath, workspaceRoot) ?? absolutePath;
}

/** Where a terminal runs, and the root its thread's file panel opens paths relative to. */
export interface TerminalPathLocation {
  readonly cwd: string;
  readonly worktreePath?: string | null | undefined;
  /** The thread's file panel root; a terminal can run in a subfolder of it. */
  readonly fileWorkspaceRoot?: string | undefined;
}

/** A terminal path link resolves against the terminal's cwd. Null when `~` cannot resolve. */
export function terminalPathPanelTarget(
  linkText: string,
  location: TerminalPathLocation,
): { readonly path: string; readonly line: number | undefined } | null {
  const { path, line } = splitFilePathPosition(resolvePathLinkTarget(linkText, location.cwd));
  if (path.startsWith("~")) return null;
  const workspaceRoot = location.fileWorkspaceRoot ?? location.worktreePath ?? location.cwd;
  return { path: filePanelPath(path, workspaceRoot), line };
}

/** A changed file's path is relative to its repository, which can hold the project in a subfolder. */
export function changedFilePanelPath(
  repositoryRelativePath: string,
  repositoryRoot: string,
  workspaceRoot: string,
): string {
  return filePanelPath(
    resolveWorkspaceFilePath(repositoryRelativePath, repositoryRoot),
    workspaceRoot,
  );
}
