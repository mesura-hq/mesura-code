import { usePreviewUrl } from "./previewUrl.ts";

export interface DocumentPreviewProps {
  readonly path: string;
  readonly mime: string;
}

/**
 * A document, through Chromium's own viewer.
 *
 * A straight gain over the Qt build, which rendered page one as a cached image
 * and nothing else: this is the real viewer, so every page is reachable and so
 * is its search.
 *
 * Two things are load-bearing and neither is visible from this file:
 * `plugins: true` in the window's preferences is what turns the viewer on at
 * all, and the URL must come from the application's own scheme — the viewer
 * refuses a `blob:` whose origin is a custom scheme and the embed resolves to
 * an error page, silently.
 */
export function DocumentPreview({ path, mime }: DocumentPreviewProps) {
  const url = usePreviewUrl(path);
  if (url === null) return <div data-testid="preview-loading">reading…</div>;

  return (
    <div className="preview preview--document" data-testid="preview-document">
      <embed src={url} type={mime} data-testid="preview-document-embed" />
    </div>
  );
}
