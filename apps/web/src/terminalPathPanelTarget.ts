import { resolvePathLinkTarget, splitFilePathPosition } from "@t3tools/shared/fileLinks";
import { workspaceRelativeFilePath } from "@t3tools/shared/path";

/**
 * Mesura: the file panel target for a terminal path link. A path inside the workspace opens by
 * its workspace-relative path; any other path opens as a host file.
 */
export function terminalPathPanelTarget(
  linkText: string,
  cwd: string,
  workspaceRoot: string,
): { readonly path: string; readonly line: number | undefined } {
  const { path, line } = splitFilePathPosition(resolvePathLinkTarget(linkText, cwd));
  return { path: workspaceRelativeFilePath(path, workspaceRoot) ?? path, line };
}
