import { representedEntries } from "../overview/session.ts";
import type { OverviewModel } from "../overview/useOverview.ts";

export function treeSummary(root: string | null, model: OverviewModel, showHidden: boolean) {
  if (root === null) return null;
  return (
    <>
      <span>{representedEntries(model.folders)} represented entries</span>
      {showHidden ? <span>hidden shown</span> : null}
    </>
  );
}

export function treeDirectoryError(root: string | null, error: string | null) {
  return root === null ? error : null;
}
