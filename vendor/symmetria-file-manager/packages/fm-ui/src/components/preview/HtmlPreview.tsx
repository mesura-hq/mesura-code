import { basename } from "@symmetria/fm-core/pane";

import { usePreviewDirectoryUrl } from "./previewUrl.ts";

export interface HtmlPreviewProps {
  readonly path: string;
}

/**
 * The frame's whole permission list, and the security boundary of this file.
 *
 * ── `allow-scripts` is absent, and that is the point ────────────────────────
 * A previewed page is a stranger's file reached by moving a cursor. Without
 * this token nothing in the framed document executes at all — which is the
 * same posture the Qt build reaches by turning JavaScript off in its engine.
 * See `HtmlPreview.qml` in the Qt tree for the reasoning being copied.
 *
 * ── The two flags are safe apart and unsafe TOGETHER ────────────────────────
 * **Do not add `allow-scripts` here.** `allow-same-origin` alone is harmless:
 * it keeps the document on the application's own origin, which is what makes
 * `'self'` in the content policy the main process serves match the document's
 * own directory — so a page's sibling stylesheet and images load, and a page
 * rendered without its own stylesheet is not a faithful render.
 *
 * The dangerous combination is the PAIR. With scripts allowed AND the origin
 * shared, framed code can reach the parent document, and the parent document
 * holds the bridge to the filesystem. Each flag on its own grants nothing of
 * the sort, which is precisely why a future reader will be tempted to add the
 * second one — and why this comment is here rather than in a commit message.
 *
 * Everything else is withheld by omission: no navigation, no popups, no
 * forms, no modals, no downloads. This stays a preview, which is the decision
 * the Qt build already made when it ignored every navigation but the first.
 */
const FRAME_PERMISSIONS = "allow-same-origin";

/**
 * An HTML file, rendered as the page it is.
 *
 * The counterpart to `MarkdownPreview`: both replace a wall of markup with the
 * thing the markup describes. This one needs no renderer of its own — the
 * platform already has one — so the whole component is a frame, an address,
 * and a list of things that frame may not do.
 *
 * ── The address is the DIRECTORY grant, and it has to be ────────────────────
 * Not the file grant every other preview uses, and verification found out why
 * the hard way. A file grant addresses `…/__preview/<token>` with nothing
 * after it, and a browser resolving `./style.css` against that drops the LAST
 * SEGMENT — the token itself — and asks for `…/__preview/style.css`, which is
 * not a grant at all and answers 404. Every sibling a page references is lost
 * that way: the stylesheet, the images, the fonts, all of it, silently, with
 * the page rendering unstyled and nothing saying why.
 *
 * Addressing the file as `<directory token>/<name>` puts it one level down, so
 * an ordinary relative reference resolves to a sibling under the same grant —
 * which is the route `serveNeighbour` was built for and the reason the grant
 * exists at all.
 *
 * The main process serves the file with a content policy naming no remote
 * origin, so the page cannot fetch a tracker, a remote font or a remote
 * stylesheet. That lock and this one are independent and neither is stated
 * where a reader of the other would see it: see `fileResponse.ts`.
 */
export function HtmlPreview({ path }: HtmlPreviewProps) {
  const directory = usePreviewDirectoryUrl(path);

  // Nothing to point a frame at until the main process has authorised the
  // path. An empty frame would flash a white rectangle over the column.
  if (directory === null) return <div data-testid="preview-loading">reading…</div>;

  const url = `${directory}/${encodeURIComponent(basename(path))}`;

  return (
    <div className="preview preview--html" data-testid="preview-html">
      <iframe
        className="preview__html-frame"
        data-testid="preview-html-frame"
        // Named for the reader of the accessibility tree, which otherwise
        // announces an unlabelled frame.
        title={basename(path)}
        src={url}
        sandbox={FRAME_PERMISSIONS}
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
