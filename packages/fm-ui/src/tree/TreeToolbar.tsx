import { DirectoryScope, snapshotStatus } from "../directory/DirectoryScope.tsx";
import type { OverviewModel } from "../overview/useOverview.ts";

export function TreeToolbar({
  model,
  labelId,
  onMiller,
  preset,
  canRestore,
}: {
  model: OverviewModel;
  labelId: string;
  onMiller(): void;
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
      <DirectoryScope model={model} />
      <button type="button" onClick={onMiller}>
        Miller · Esc
      </button>
      <button type="button" onClick={model.refresh}>
        Refresh
      </button>
    </header>
  );
}
