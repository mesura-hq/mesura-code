import { joinPath } from "../pane.ts";
import type { OverviewEntry } from "./contract.ts";
export interface OverviewFolder {
  readonly path: string;
  readonly depth: number;
  readonly entries: readonly OverviewEntry[];
  readonly status: string;
}
export function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? "/";
}

export function isAncestorPath(parent: string, child: string): boolean {
  return parent === child || child.startsWith(parent === "/" ? "/" : `${parent}/`);
}

/** All known targets, including a folder represented both by a row and a group. */
export function overviewPaths(
  root: string,
  folders: ReadonlyMap<string, OverviewFolder>,
): Set<string> {
  const paths = new Set([root]);
  for (const folder of folders.values()) {
    paths.add(folder.path);
    for (const entry of folder.entries) paths.add(joinPath(folder.path, entry.name));
  }
  return paths;
}
