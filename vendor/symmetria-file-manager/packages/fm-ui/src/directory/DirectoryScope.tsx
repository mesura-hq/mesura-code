import { OVERVIEW_LIMITS } from "../overview/limits.ts";
import { EXCLUSIONS } from "../overview/session.ts";
import type { OverviewModel } from "../overview/useOverview.ts";

export function snapshotStatus(model: OverviewModel): string {
  if (model.paused) return "Live updates paused";
  if (model.refreshing) return "Refreshing…";
  if (model.loading) return "Loading…";
  return `${model.inspected} entries inspected`;
}

export function DirectoryScope({ model }: { model: OverviewModel }) {
  const label = model.coverage?.size ? "Scope · Live updates unavailable" : "Scope";
  return (
    <details className="overview-scope">
      <summary title={label}>{label}</summary>
      <div className="overview-popover">
        {model.coverage?.size ? (
          <p>
            Coverage degraded in {model.coverage.size} folders. {[...model.coverage.values()][0]}
          </p>
        ) : null}
        <button type="button" aria-label="Refresh snapshot" onClick={model.refresh}>
          Refresh
        </button>
        <p>
          Depth {model.automaticDepth ?? OVERVIEW_LIMITS.automaticDepth} · 5,000 entries ·{" "}
          {OVERVIEW_LIMITS.directoryReads} directories
        </p>
        <p>At most 1,000 entries per directory. Counts describe inspected contents.</p>
        <p>Excluded: {EXCLUSIONS.join(", ")}</p>
      </div>
    </details>
  );
}
