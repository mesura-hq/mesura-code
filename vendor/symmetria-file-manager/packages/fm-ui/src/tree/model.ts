import type { OverviewEntry } from "@symmetria/fm-core/overview/contract";
import { basename, type OverviewFolder } from "@symmetria/fm-core/overview/model";
import { joinPath } from "@symmetria/fm-core/pane";

export interface TreeRow extends OverviewEntry {
  readonly path: string;
  readonly parent: string | null;
  readonly depth: number;
  readonly position: number;
  readonly siblings: number;
  readonly status: string;
  readonly expanded: boolean;
}

export function isTreeDirectory(entry: OverviewEntry): boolean {
  return entry.kind === "directory" && !entry.isSymlink;
}

function rowState(
  path: string,
  entry: OverviewEntry,
  folder: OverviewFolder | undefined,
  collapsed: ReadonlySet<string>,
) {
  const status = isTreeDirectory(entry) ? (folder?.status ?? "Not loaded") : "Loaded";
  return {
    status,
    expanded: isTreeDirectory(entry) && !collapsed.has(path) && status !== "Excluded by scope",
  };
}

export function projectTree(
  root: string,
  folders: ReadonlyMap<string, OverviewFolder>,
  collapsed: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const visit = (
    path: string,
    entry: OverviewEntry,
    parent: string | null,
    depth: number,
    position: number,
    siblings: number,
  ) => {
    const folder = folders.get(path);
    const { status, expanded } = rowState(path, entry, folder, collapsed);
    rows.push({ ...entry, path, parent, depth, position, siblings, status, expanded });
    if (!expanded || !folder) return;
    const total = folder.status === "Loaded" ? folder.entries.length : -1;
    folder.entries.forEach((child, index) => {
      visit(joinPath(path, child.name), child, path, depth + 1, index + 1, total);
    });
  };
  visit(
    root,
    { name: basename(root), kind: "directory", isHidden: false, isSymlink: false },
    null,
    0,
    1,
    1,
  );
  return rows;
}

export function treeItemId(path: string): string {
  return `tree-item-${encodeURIComponent(path)}`;
}
