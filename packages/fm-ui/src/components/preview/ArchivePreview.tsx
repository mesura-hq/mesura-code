import { humanSize } from "@symmetria/fm-core/format";
import type { ArchiveListing } from "@symmetria/fm-core/preview/archive/listing";
import type { ArchiveCompression, ArchiveFormat } from "@symmetria/fm-core/preview/route";
import { FileIcon } from "@symmetria/fm-search/ui";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useState } from "react";
import type { ArchiveRequest, ArchiveResponse } from "../../archive.worker.ts";
import { lazyWorker } from "../../lazyWorker.ts";
import { INITIAL_RECT, observeWithFallback } from "../virtualize.ts";
import { usePreviewUrl } from "./previewUrl.ts";

export interface ArchivePreviewProps {
  readonly path: string;
  readonly format: ArchiveFormat;
  readonly compression: ArchiveCompression;
  /** The file's length, from the directory scan. A zip is read backwards from it. */
  readonly size: number;
}

/** Row height in pixels. Fixed, so the virtualiser needs no measurement pass. */
const ROW_HEIGHT = 20;

/** How far one level of nesting indents. Matches the Qt build's 18 pixels. */
const INDENT = 18;

const reader = lazyWorker(
  () => new Worker(new URL("../../archive.worker.ts", import.meta.url), { type: "module" }),
);

/** Drop the shared worker. For tests, which must not inherit another's. */
export function forgetArchiveWorker(): void {
  reader.forget();
}

type ArchiveState =
  | { readonly kind: "reading" }
  | { readonly kind: "listing"; readonly listing: ArchiveListing; readonly partial: boolean }
  | { readonly kind: "unreadable" };

const READING: ArchiveState = { kind: "reading" };

/**
 * Ask the worker for one archive's contents.
 *
 * Keyed on the URL, so landing on another file discards whatever the previous
 * one would have answered. The id check is the same discipline every worker in
 * this package uses and it matters more here than most: an archive takes longer
 * to read than a spreadsheet, so a late answer is the ordinary case.
 */
function useArchive(
  url: string | null,
  format: ArchiveFormat,
  compression: ArchiveCompression,
  size: number,
): ArchiveState {
  const [state, setState] = useState<ArchiveState>(READING);

  useEffect(() => {
    if (url === null) {
      setState(READING);
      return;
    }

    setState(READING);

    const instance = reader.get();
    // Unlike a waveform there is no lesser thing to show — the listing IS the
    // preview — so a host without workers gets a notice rather than a pane
    // that stays empty and explains nothing.
    if (instance === null) {
      setState({ kind: "unreadable" });
      return;
    }

    // Per effect rather than per component: a monotonic counter on a ref would
    // survive a remount and let a stale answer match a fresh request.
    let current = true;
    const id = nextRequestId();

    const onMessage = (event: MessageEvent<ArchiveResponse>) => {
      if (!current || event.data.id !== id) return;
      setState(
        event.data.kind === "unreadable"
          ? { kind: "unreadable" }
          : { kind: "listing", listing: event.data.listing, partial: event.data.partial },
      );
    };

    instance.addEventListener("message", onMessage);
    const request: ArchiveRequest = { id, url, format, compression, size };
    instance.postMessage(request);

    return () => {
      current = false;
      instance.removeEventListener("message", onMessage);
    };
  }, [url, format, compression, size]);

  return state;
}

/**
 * Request ids, unique across every pane in this document.
 *
 * Module scope rather than a ref, because the worker is shared: two panes
 * numbering from zero independently would each accept the other's answers.
 */
let requestCounter = 0;
function nextRequestId(): number {
  requestCounter += 1;
  return requestCounter;
}

/** What the pane says under the listing about the whole archive. */
function counts(listing: ArchiveListing, partial: boolean): string {
  const exact = `${listing.dirCount} dirs, ${listing.fileCount} files`;
  // "or more" rather than a bare number when the walk stopped early. A tar has
  // no index, so a listing that hit its bound genuinely does not know the rest,
  // and printing its counts plainly would state a floor as a total.
  return partial ? `${exact} or more` : exact;
}

/**
 * An archive, as the tree it holds.
 *
 * ── Read once, drawn from memory ────────────────────────────────────────────
 * The whole listing arrives in one answer and never changes, so nothing here
 * fetches or re-reads. What is left is layout: which rows are mounted, and how
 * far each is indented.
 *
 * ── Nothing here is interactive, deliberately ───────────────────────────────
 * No focus, no click, no expanding. The preview column has never taken either,
 * and giving it one for archives alone would mean a cursor that can be in two
 * columns at once. Everything is expanded and the cap is what bounds it.
 */
export function ArchivePreview({ path, format, compression, size }: ArchivePreviewProps) {
  const url = usePreviewUrl(path);
  const state = useArchive(url, format, compression, size);

  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const attach = useCallback((node: HTMLDivElement | null) => setScrollElement(node), []);

  const rows = state.kind === "listing" ? state.listing.rows : EMPTY_ROWS;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    // Shared with `FileList` rather than copied: a virtualiser told its
    // viewport is zero pixels tall renders zero rows, and a headless DOM
    // always reports zero.
    initialRect: INITIAL_RECT,
    observeElementRect: observeWithFallback,
  });

  if (url === null || state.kind === "reading") {
    return <div data-testid="preview-loading">reading…</div>;
  }

  if (state.kind === "unreadable") {
    return (
      <p className="preview__failed" data-testid="preview-archive-failed">
        could not read this archive
      </p>
    );
  }

  const { listing } = state;

  return (
    <div className="preview preview--archive" data-testid="preview-archive">
      <div className="preview__archive-scroll" ref={attach}>
        <div className="preview__archive-body" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const entry = rows[item.index];
            if (entry === undefined) return null;

            return (
              <div
                key={entry.path}
                className="row preview__archive-row"
                data-testid="preview-archive-row"
                data-depth={entry.depth}
                data-kind={entry.isDirectory ? "directory" : "file"}
                style={{ height: item.size, transform: `translateY(${item.start}px)` }}
                title={entry.path}
              >
                {/* A spacer rather than padding on the row. `.row` already sets
                    its own horizontal inset, and an inline `paddingLeft` of 0 —
                    which is what depth 0 computes to — overrides it, so every
                    top-level row sat flush against the pane edge while every
                    other `.row` in the application did not. */}
                {entry.depth === 0 ? null : (
                  <span
                    className="preview__archive-indent"
                    style={{ width: entry.depth * INDENT }}
                    aria-hidden="true"
                  />
                )}
                <FileIcon name={entry.name} kind={entry.isDirectory ? "directory" : "file"} />
                <span className="row__name">{entry.name}</span>
                {/* A folder shows no size. The Qt build shows none either, and
                    a zero would read as an empty folder rather than a folder. */}
                {entry.isDirectory ? null : (
                  <span className="preview__archive-size" data-testid="preview-archive-size">
                    {humanSize(entry.size)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {listing.truncated ? (
        <p className="preview__truncated" data-testid="preview-archive-truncated">
          showing {listing.rows.length} of {listing.totalRows}
        </p>
      ) : null}

      <p className="preview__archive-counts" data-testid="preview-archive-counts">
        {counts(listing, state.partial)}
      </p>
    </div>
  );
}

/** One shared empty list, so a `useMemo` keyed on it does not re-run per render. */
const EMPTY_ROWS: ArchiveListing["rows"] = [];
