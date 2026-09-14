import { DirectoryScope, snapshotStatus } from "../directory/DirectoryScope.tsx";
import type { OverviewModel } from "../overview/useOverview.ts";

export function TreeToolbar({
  model,
  labelId,
  onMiller,
  showScope = true,
  preset,
  canRestore,
}: {
  model: OverviewModel;
  labelId: string;
  onMiller?: (() => void) | undefined;
  showScope?: boolean | undefined;
  preset(value: "expanded" | "collapsed" | "restore"): void;
  canRestore: boolean;
}) {
  return (
    <header className="tree-toolbar">
      <strong id={labelId}>File tree</strong>
      <span className="tree-scope" role="status">
        {snapshotStatus(model)}
        {model.coverage?.size ? " · Live updates unavailable" : ""}
      </span>
      <details className="tree-expansion">
        <summary>Expansion</summary>
        <div className="tree-expansion-menu">
          <button type="button" onClick={() => preset("expanded")}>
            Expand project
          </button>
          <button type="button" onClick={() => preset("collapsed")}>
            Collapse all
          </button>
          <button type="button" disabled={!canRestore} onClick={() => preset("restore")}>
            Restore my expansion
          </button>
        </div>
      </details>
      {showScope ? <DirectoryScope model={model} /> : null}
      {onMiller ? (
        <button type="button" onClick={onMiller}>
          Miller · Esc
        </button>
      ) : null}
      {model.refresh ? (
        <button type="button" onClick={model.refresh}>
          Refresh
        </button>
      ) : null}
    </header>
  );
}
