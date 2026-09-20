import { isAncestorPath, type OverviewFolder } from "@symmetria/fm-core/overview/model";
import { useEffect } from "react";
import type { OverviewModel } from "../overview/useOverview.ts";

/** An explicit reveal may cross the automatic depth boundary, one ancestor at a time. */
export function useTreeReveal(path: string | null, model: OverviewModel): boolean {
  const ancestor = path === null ? null : missingAncestor(path, model.folders);
  useEffect(() => {
    if (ancestor !== null) model.include(ancestor);
  }, [ancestor, model.include]);
  return ancestor !== null;
}

function missingAncestor(
  path: string,
  folders: ReadonlyMap<string, OverviewFolder>,
): string | null {
  let nearest: OverviewFolder | undefined;
  for (const folder of folders.values()) {
    if (folder.path === path || !isAncestorPath(folder.path, path)) continue;
    if (!nearest || folder.depth > nearest.depth) nearest = folder;
  }
  // An unreadable or budget-limited result is terminal for this reveal. Retrying
  // it here would loop forever and consume the same session's remaining budget.
  return nearest &&
    ["Depth limit reached", "Not loaded", "Excluded by scope"].includes(nearest.status)
    ? nearest.path
    : null;
}
