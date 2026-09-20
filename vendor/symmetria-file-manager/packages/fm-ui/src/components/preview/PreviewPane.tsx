import type { EntrySummary } from "@symmetria/fm-core/entry";
import { humanSize } from "@symmetria/fm-core/format";
import type { PreviewRoute, RenderableAs } from "@symmetria/fm-core/preview/route";
import { FileIcon } from "@symmetria/fm-search/ui";
import { useCallback, useEffect, useState } from "react";
import { ROW_HEIGHT, type VisibleRange } from "../FileList.tsx";
import { flashStateOf } from "../FileRow.tsx";
import { FlashName, type FlashRowLabel } from "../FlashName.tsx";
import { INITIAL_RECT } from "../virtualize.ts";
import { ArchivePreview } from "./ArchivePreview.tsx";
import { AudioPreview } from "./AudioPreview.tsx";
import { CodePreview } from "./CodePreview.tsx";
import { DocumentPreview } from "./DocumentPreview.tsx";
import { HtmlPreview } from "./HtmlPreview.tsx";
import { ImagePreview } from "./ImagePreview.tsx";
import { MarkdownPreview } from "./MarkdownPreview.tsx";
import { SpreadsheetPreview } from "./SpreadsheetPreview.tsx";
import { TextPreview } from "./TextPreview.tsx";
import { VideoPreview } from "./VideoPreview.tsx";

/** What a previewed directory's rows need in order to join a flash session. */
interface DirectoryFlash {
  readonly labels: ReadonlyMap<number, FlashRowLabel>;
  readonly active: boolean;
  readonly onVisibleRange: ((range: VisibleRange) => void) | undefined;
}

/** No labels. Shared, so a preview that is not a directory churns nothing. */
const NO_LABELS: ReadonlyMap<number, FlashRowLabel> = new Map();

export interface PreviewPaneProps {
  /**
   * Flash labels for a previewed DIRECTORY's rows, by index.
   *
   * Empty for every other kind of preview, because a code or text preview is
   * not a list of names and has nothing a jump could land on.
   */
  readonly flashLabels?: ReadonlyMap<number, FlashRowLabel>;
  readonly flashActive?: boolean;
  /** Which of the listing's rows are on screen. See `FileList`'s own. */
  readonly onVisibleRange?: (range: VisibleRange) => void;
  readonly route: PreviewRoute;
  readonly path: string | null;
  readonly size: number;
  /** Why there is nothing to show, when there is a reason. */
  readonly error?: string | null;
  /**
   * Whether this file has a rendered form, and which.
   *
   * Beside the route rather than inside it: the route says what KIND of thing
   * the file is, and this says whether that kind has a second presentation.
   * See `renderableAs` in the shared router.
   */
  readonly renderAs?: RenderableAs | null;
  /**
   * Whether a file with a rendered form shows it, or shows its source.
   *
   * One flag for the whole panel, not one per file. Owned by the listing store
   * beside the sort order and hidden-file visibility, and passed in rather than
   * read here — a component that fetches its own configuration makes a test set
   * up a store in order to render a preview.
   */
  readonly renderDocuments?: boolean;
  /**
   * Whether the user has asked the audio under the cursor to play.
   *
   * Owned by `App` rather than by the pane, because clearing it needs to know
   * where the cursor is and the pane does not. It must survive a re-render and
   * must NOT survive a move to another file, which is why `App` stores it as a
   * path rather than as a flag.
   */
  readonly audioPlaying?: boolean;
}

/**
 * Render whatever the router chose.
 *
 * The router decides; this only draws. Keeping the decision out of here is what
 * lets a second consumer — the fuzzy finder's info pane, next — show the same
 * previews without re-deriving which one applies. In the Qt build that
 * separation is why a preview type added once appeared in both panes.
 */
export function PreviewPane({
  route,
  path,
  size,
  error,
  renderAs,
  renderDocuments,
  audioPlaying,
  flashLabels,
  flashActive,
  onVisibleRange,
}: PreviewPaneProps) {
  // Rendering is the default, so an absent flag means rendered. The prop is
  // optional because most callers — every existing preview test among them —
  // have no opinion about a mode that only applies to two file types.
  //
  // Nothing here says WHICH mode is showing. That indicator lives in the status
  // line beside the sort order and the hidden-file state — it was a badge over
  // the preview first, and the operator moved it: an indicator drawn on top of
  // the document either covers its first line or costs a strip of every preview
  // to avoid doing so, and the bar already exists and already has a fixed
  // height. See `StatusBar`.
  const rendered = renderDocuments !== false;
  const flash: DirectoryFlash = {
    labels: flashLabels ?? NO_LABELS,
    active: flashActive === true,
    onVisibleRange,
  };

  return (
    <div
      className="list preview-pane"
      data-testid="column-preview"
      data-kind={route.kind}
      data-rendered={renderAs ?? undefined}
    >
      {error == null ? (
        body(route, path, size, audioPlaying === true, rendered ? (renderAs ?? null) : null, flash)
      ) : (
        <p className="preview__failed" data-testid="preview-error">
          {error}
        </p>
      )}
    </div>
  );
}

function body(
  route: PreviewRoute,
  path: string | null,
  size: number,
  audioPlaying: boolean,
  renderAs: RenderableAs | null,
  flash: DirectoryFlash,
) {
  if (path === null || route.kind === "none") return null;
  return contents(route, path, size, audioPlaying, renderAs) ?? notice(route, size, flash);
}

/**
 * A text file: its rendered form where it has one, its source otherwise.
 *
 * Split out of the switch below rather than nested inside its `code` case. The
 * pane is measured as one function by the complexity gate, and the gate was
 * right to push here — "which of three ways to show text" is a decision worth
 * reading on its own.
 */
function textual(path: string, language: string | null, renderAs: RenderableAs | null) {
  if (renderAs === "markdown") return <MarkdownPreview path={path} />;
  if (renderAs === "html") return <HtmlPreview path={path} />;
  return language === null ? (
    <TextPreview path={path} />
  ) : (
    <CodePreview path={path} language={language} />
  );
}

/**
 * The branches that render the file itself.
 *
 * `size` is passed through for the archive branch alone: a zip's index is at
 * the END of the file, so reading one starts from its length — and the scan
 * already knows it, which saves the pane a round trip to ask.
 */
function contents(
  route: PreviewRoute,
  path: string,
  size: number,
  audioPlaying: boolean,
  renderAs: RenderableAs | null,
) {
  switch (route.kind) {
    case "image":
      return <ImagePreview path={path} mime={route.mime} />;
    case "document":
      return <DocumentPreview path={path} mime={route.mime} />;
    case "video":
      return <VideoPreview path={path} mime={route.mime} />;
    case "audio":
      return <AudioPreview path={path} mime={route.mime} playing={audioPlaying} />;
    case "spreadsheet":
      return <SpreadsheetPreview path={path} mime={route.mime} />;
    case "archive":
      return (
        <ArchivePreview
          path={path}
          format={route.format}
          compression={route.compression}
          size={size}
        />
      );
    case "code":
      return textual(path, route.language, renderAs);
    case "text":
      return textual(path, null, renderAs);
    default:
      return null;
  }
}

/**
 * A directory, listed.
 *
 * A directory is not a file, so reading it as one would show nothing — but a
 * count is a fact ABOUT the directory rather than the directory itself, and
 * Miller columns are three columns precisely because the third shows what
 * entering would reveal.
 *
 * The rows reuse `.row` and `FileIcon` so a folder looks the same here as it
 * does in the two navigable columns. They are deliberately NOT `FileRow`: that
 * component takes a cursor and a mark, and this column has neither — passing
 * `false` for both would imply a cursor could live here.
 */
interface DirectoryListingProps {
  readonly entries: readonly EntrySummary[];
  /** How many the directory really holds. The listing itself is capped. */
  readonly total: number;
  readonly flash: DirectoryFlash;
}

/**
 * Which rows of an unvirtualised, fixed-height listing are on screen.
 *
 * The same question `FileList` asks its virtualiser, answered by arithmetic
 * because this listing has none: every row is in the document and only some are
 * in view. `ROW_HEIGHT` is the virtualiser's own figure, imported rather than
 * repeated, and the viewport falls back to `INITIAL_RECT` for the same reason
 * `observeWithFallback` does — an element that has not laid out measures zero,
 * and zero would say nothing is visible.
 */
function useListingRange(
  count: number,
  report: ((range: VisibleRange) => void) | undefined,
): (node: HTMLDivElement | null) => void {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const attach = useCallback((node: HTMLDivElement | null) => setElement(node), []);

  useEffect(() => {
    if (element === null || report === undefined) return;

    const send = () => {
      const height = element.clientHeight > 0 ? element.clientHeight : INITIAL_RECT.height;
      report({
        start: Math.max(0, Math.floor(element.scrollTop / ROW_HEIGHT)),
        end: Math.min(count - 1, Math.floor((element.scrollTop + height) / ROW_HEIGHT)),
      });
    };

    send();
    element.addEventListener("scroll", send);
    // A resize with no scroll changes the window too. The virtualised columns
    // get this from their own `ResizeObserver`; this one has to ask.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(send);
    observer?.observe(element);

    return () => {
      element.removeEventListener("scroll", send);
      observer?.disconnect();
    };
  }, [element, count, report]);

  return attach;
}

function DirectoryListing({ entries, total, flash }: DirectoryListingProps) {
  const attach = useListingRange(entries.length, flash.onVisibleRange);
  const hidden = total - entries.length;

  return (
    <div data-testid="preview-directory" className="preview preview--directory">
      {entries.length === 0 ? (
        <p className="preview__empty">empty</p>
      ) : (
        <div className="preview__listing" ref={attach}>
          {entries.map((entry, index) => {
            const label = flash.labels.get(index) ?? null;
            const dimmed = flash.active && label === null;
            return (
              <div
                key={entry.name}
                data-testid="preview-entry"
                data-kind={entry.kind}
                data-flash={flashStateOf(flash.active, dimmed)}
                className={`row${dimmed ? " row--flash-dim" : ""}`}
              >
                <FileIcon name={entry.name} kind={entry.kind} />
                <span className="row__name">
                  <FlashName name={entry.name} flash={label} />
                </span>
              </div>
            );
          })}
        </div>
      )}
      {hidden > 0 ? <p className="preview__truncated">and {hidden} more</p> : null}
    </div>
  );
}

/** The branches that describe the entry instead of showing it. */
function notice(route: PreviewRoute, size: number, flash: DirectoryFlash) {
  if (route.kind === "directory") {
    return <DirectoryListing entries={route.entries} total={route.entryCount} flash={flash} />;
  }

  // Naming what is missing is a different statement from showing a size and
  // hoping the reader works it out.
  if (route.kind === "unbuilt") {
    return (
      <p data-testid="preview-unbuilt">
        no {route.what} preview yet — {humanSize(size)}
      </p>
    );
  }

  const mime = route.kind === "fallback" ? route.mime : null;
  return (
    <p data-testid="preview-fallback">
      {mime ?? "unknown type"} — {humanSize(size)}
    </p>
  );
}
