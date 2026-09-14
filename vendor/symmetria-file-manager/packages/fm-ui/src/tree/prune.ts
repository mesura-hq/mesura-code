import { basename, type OverviewFolder } from "@symmetria/fm-core/overview/model";
import { parentOf } from "@symmetria/fm-core/pane";
import type { TreeShape } from "./state.ts";

/** Only a complete parent listing proves removal; failed and pending reads do not. */
export function pruneTreeShape(
  shape: TreeShape,
  root: string,
  folders: ReadonlyMap<string, OverviewFolder>,
): TreeShape {
  const prune = (paths: ReadonlySet<string>) => {
    const kept = new Set([...paths].filter((path) => !removed(path, root, folders)));
    return kept.size === paths.size ? paths : kept;
  };
  const collapsed = prune(shape.collapsed);
  const checkpoint = shape.checkpoint === null ? null : prune(shape.checkpoint);
  return collapsed === shape.collapsed && checkpoint === shape.checkpoint
    ? shape
    : { ...shape, collapsed, checkpoint };
}
function removed(
  path: string,
  root: string,
  folders: ReadonlyMap<string, OverviewFolder>,
): boolean {
  let current = path;
  while (current !== root && current !== parentOf(current)) {
    const parent = folders.get(parentOf(current));
    if (
      parent?.status === "Loaded" &&
      !parent.entries.some((entry) => entry.name === basename(current))
    )
      return true;
    current = parentOf(current);
  }
  return false;
}
