/**
 * What the highlighted result is, beside a live preview of it.
 *
 * **The preview is INJECTED, and that is a correction to the plan.** The plan
 * said this file should call the file-manager panel's `usePreviewPane` and
 * render its `PreviewPane` directly. It cannot: this package must not import
 * the panel package — a later phase asserts that with an invariant test, and it
 * is the whole reason a host can mount the finder without dragging the file
 * manager along — and the panel now depends on this package, so the import
 * would also be a cycle.
 *
 * So the finder owns the LAYOUT and the metadata, and the consumer supplies the
 * renderer. The file manager passes a component that calls its own preview
 * router, which is how every preview type still arrives at once and nothing is
 * re-routed here. A host that mounts the finder in an editor passes its own —
 * which is better than inheriting a file manager's preview, and was always the
 * more honest reading of "a host runs the privileged half itself".
 *
 * **There is deliberately no second debounce here.** The file manager's
 * renderer debounces the path at 150 ms inside `usePreview`, which is exactly
 * the figure a stage here would have used, so adding one would cost 300 ms of
 * latency and protect nothing. The metadata below is not debounced at all: it
 * comes from the row already on screen, not from a round trip, so delaying it
 * would be delay for its own sake.
 */
import type { SearchReplyRow } from "@symmetria/fm-core/contract";
import { humanAge, humanSize } from "@symmetria/fm-core/format";
import type { ReactNode } from "react";

import { withoutTrailingSeparator } from "./paths.ts";

/**
 * Renders a live preview of one path. Supplied by whoever mounts the finder.
 *
 * `isDir` is passed because the finder knows it for free — the engine's result
 * says which kind of item it returned — and a renderer that had to discover it
 * would pay a `stat` for something already established.
 *
 * **The file manager's renderer deliberately ignores it**, and that is not an
 * oversight: its preview router re-derives the kind from a real `describeEntry`
 * of the path, which is more authoritative than the engine's row. A row is a
 * snapshot of the last scan; a symlink to a directory, or a path that changed
 * kind since the scan, is decided correctly only by the stat. Do not "simplify"
 * that renderer by trusting this flag instead.
 */
export type RenderPreview = (path: string, isDir: boolean) => ReactNode;

export interface FinderInfoPanelProps {
  readonly row: SearchReplyRow;
  // `| undefined` explicitly, because `exactOptionalPropertyTypes` is on and
  // the overlay forwards its own optional prop straight through.
  readonly renderPreview?: RenderPreview | undefined;
  /** Injected so a test does not have to freeze the clock. */
  readonly now?: number;
}

/**
 * The type, from the name.
 *
 * The engine's row carries no MIME type, and asking for one per highlighted row
 * would be a round trip to answer a question the extension already answers. Qt
 * shows the MIME comment here; this shows the extension, which is what a reader
 * is checking for anyway — "is this the .ts or the .d.ts".
 */
function typeLabel(row: SearchReplyRow): string {
  if (row.isDir) return "dir";
  const dot = row.name.lastIndexOf(".");
  return dot > 0 ? row.name.slice(dot + 1).toUpperCase() : "file";
}

/** One label-and-value pair. Four of them make the two-up grid. */
function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="finder-info__fact">
      <span className="finder-info__label">{label}</span>
      <span className="finder-info__value">{value}</span>
    </div>
  );
}

export function FinderInfoPanel({ row, renderPreview, now }: FinderInfoPanelProps) {
  // A directory carries no size, no modification time and no git status — the
  // engine's directory item has none of them — so those read as "dir" and "—"
  // rather than as zero, which would be a fact nobody established.
  return (
    <aside className="finder-info" data-testid="finder-info">
      <p className="finder-info__name" data-testid="finder-info-name">
        {row.name}
      </p>
      {/* A compact two-up grid, as in the Qt original: four facts in two tight
          rows, so the preview keeps the room. */}
      <div className="finder-info__facts" data-testid="finder-info-facts">
        <Fact label="Size" value={row.isDir ? "dir" : humanSize(row.size)} />
        <Fact label="Type" value={typeLabel(row)} />
        <Fact label="Git" value={row.gitStatus === "" ? "—" : row.gitStatus} />
        <Fact label="Modified" value={humanAge(row.modifiedMs, now ?? Date.now())} />
      </div>
      <div className="finder-info__preview" data-testid="finder-info-preview">
        {/* The clean path, for the same reason the confirm handler hands out a
            clean one: a renderer will `stat` this, and no other path in a host
            carries the engine's trailing separator. */}
        {renderPreview?.(withoutTrailingSeparator(row.fullPath), row.isDir) ?? null}
      </div>
    </aside>
  );
}
