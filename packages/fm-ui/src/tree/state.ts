import { isAncestorPath } from "@symmetria/fm-core/overview/model";
import { parentOf } from "@symmetria/fm-core/pane";
import type { TreeRow } from "./model.ts";

export interface TreeShape {
  selected: string;
  collapsed: ReadonlySet<string>;
  preset: "expanded" | "collapsed" | null;
  checkpoint: ReadonlySet<string> | null;
}
export interface TreeAnchor {
  path: string;
  offset: number;
  left: number;
}
export interface TreeRecord {
  shape: TreeShape;
  anchor: TreeAnchor | null;
  pendingReveal: string | null;
  restoreAnchor?: boolean;
}

/** Visual state has its own lifetime, independent of directory snapshot eviction. */
export class TreeStateCache {
  private tabs = new Map<string, Map<string, TreeRecord>>();
  get(tab: string, root: string, hidden: boolean): TreeRecord {
    const records = this.tabs.get(tab) ?? new Map<string, TreeRecord>();
    this.tabs.set(tab, records);
    const key = JSON.stringify([root, hidden]);
    const record = records.get(key) ?? {
      shape: { selected: root, collapsed: new Set<string>(), preset: null, checkpoint: null },
      anchor: null,
      pendingReveal: null,
    };
    records.delete(key);
    records.set(key, record);
    while (records.size > 3) {
      const oldest = records.keys().next().value;
      if (oldest === undefined) break;
      records.delete(oldest);
    }
    return record;
  }
  retain(ids: readonly string[]) {
    for (const id of this.tabs.keys()) if (!ids.includes(id)) this.tabs.delete(id);
  }
}

export function visibleFallback(
  path: string,
  rows: readonly TreeRow[],
  previous: readonly TreeRow[] = [],
): string {
  const visible = new Set(rows.map((row) => row.path));
  let ancestor = path;
  while (ancestor !== parentOf(ancestor)) {
    if (visible.has(ancestor)) return ancestor;
    ancestor = parentOf(ancestor);
  }
  if (visible.has(ancestor)) return ancestor;
  const oldIndex = previous.findIndex((row) => row.path === path);
  const neighbors = [...previous.slice(oldIndex + 1), ...previous.slice(0, oldIndex).reverse()];
  return neighbors.find((row) => visible.has(row.path))?.path ?? rows[0]?.path ?? path;
}

export function revealShape(shape: TreeShape, path: string): TreeShape {
  const collapsed = new Set(
    [...shape.collapsed].filter((folder) => folder === path || !isAncestorPath(folder, path)),
  );
  return { ...shape, selected: path, collapsed, preset: null };
}
