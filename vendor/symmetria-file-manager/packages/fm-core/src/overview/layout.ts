import { parentOf } from "../pane.ts";
import type { OverviewFolder } from "./model.ts";
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface GraphGroup extends OverviewFolder, Box {
  readonly parent: string | null;
  readonly columns: number;
}
export interface Measurement {
  readonly width: number;
  readonly height: number;
}
/** Retain assigned slots; resize only the affected box and following collisions. */
export function layoutGroups(
  folders: readonly OverviewFolder[],
  previous: ReadonlyMap<string, Box>,
  measurements: ReadonlyMap<string, Measurement> = new Map(),
): GraphGroup[] {
  const result: GraphGroup[] = [];
  const lanes = new Map<number, number>();
  const byPath = new Map<string, GraphGroup>();
  for (const folder of [...folders].sort((a, b) => a.depth - b.depth)) {
    const columns = Math.max(1, Math.ceil(folder.entries.length / 12));
    const measured = measurements.get(folder.path);
    const width = columns * 240;
    const height = measured?.height ?? 68 + Math.min(12, folder.entries.length) * 24;
    const old = previous.get(folder.path);
    const parent = folder.depth === 0 ? null : parentOf(folder.path);
    const parentBox = parent === null ? undefined : byPath.get(parent);
    const x = Math.max(old?.x ?? 24, parentBox ? parentBox.x + parentBox.width + 80 : 24);
    let y = Math.max(old?.y ?? 24, lanes.get(folder.depth) ?? 24);
    // Mixed-width lanes can intersect across depths. Clear occupied rectangles,
    // not only siblings, while keeping every non-colliding slot unchanged.
    let collision = result.find((box) => intersects(box, { x, y, width, height }, 0));
    while (collision) {
      y = collision.y + collision.height + 24;
      collision = result.find((box) => intersects(box, { x, y, width, height }, 0));
    }
    const group = { ...folder, x, y, width, height, parent, columns };
    result.push(group);
    byPath.set(folder.path, group);
    lanes.set(folder.depth, y + height + 24);
  }
  return result;
}
export function visibleGroups(
  groups: readonly GraphGroup[],
  collapsed: ReadonlySet<string>,
): GraphGroup[] {
  const hidden = new Set<string>();
  return groups.filter((group) => {
    if (group.parent !== null && (collapsed.has(group.parent) || hidden.has(group.parent))) {
      hidden.add(group.path);
      return false;
    }
    return true;
  });
}
export function intersects(box: Box, viewport: Box, overscan = 200): boolean {
  return (
    box.x + box.width >= viewport.x - overscan &&
    box.x <= viewport.x + viewport.width + overscan &&
    box.y + box.height >= viewport.y - overscan &&
    box.y <= viewport.y + viewport.height + overscan
  );
}
export function graphBounds(groups: readonly GraphGroup[]): Box {
  return {
    x: 0,
    y: 0,
    width: Math.max(1, ...groups.map((group) => group.x + group.width + 24)),
    height: Math.max(1, ...groups.map((group) => group.y + group.height + 24)),
  };
}
