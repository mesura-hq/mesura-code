import type { ComponentProps } from "react";
import { useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { resolveDocumentAsset } from "./markdownAssets.ts";
import { usePreviewDirectoryUrl } from "./previewUrl.ts";
import { TruncationMarker, useFileText } from "./TextPreview.tsx";
import { useHighlighted } from "./useHighlighted.ts";

export interface MarkdownPreviewProps {
  readonly path: string;
}

/**
 * A markdown file, read as a document.
 *
 * ── Elements, never an HTML string ──────────────────────────────────────────
 * `react-markdown` produces React elements. A string renderer — `marked`,
 * `markdown-it` — would have to reach the DOM through `dangerouslySetInnerHTML`
 * with a sanitiser in front of it, and every question would then be "is the
 * sanitiser right". Here the question does not arise: there is no markup step
 * to sanitise, and the three refusals below are ordinary component overrides
 * rather than a pass over generated markup.
 *
 * ── Raw HTML is shown, never honoured ───────────────────────────────────────
 * Markdown permits inline HTML. Rendering it would mean honouring a stranger's
 * `<iframe>`, `<object>` or `<script>` on a cursor move. `react-markdown`
 * leaves raw HTML alone by default — no `rehype-raw` here, deliberately — so a
 * tag written in the file appears as the text it is.
 */
export function MarkdownPreview({ path }: MarkdownPreviewProps) {
  const loaded = useFileText(path);
  const directory = usePreviewDirectoryUrl(path);

  // Memoised on the grant alone: a new object here would remount every node in
  // the document on each render, which for a long file is the difference
  // between a preview and a stutter.
  const components = useMemo(() => documentComponents(directory), [directory]);

  if (loaded === null) return <div data-testid="preview-loading">reading…</div>;

  return (
    <div className="preview preview--markdown" data-testid="preview-markdown">
      <div className="preview__markdown-body">
        <Markdown remarkPlugins={[remarkGfm]} components={components}>
          {loaded.text}
        </Markdown>
      </div>
      {loaded.truncated ? <TruncationMarker /> : null}
    </div>
  );
}

/**
 * The three node types this renderer refuses to render as themselves.
 *
 * Built per grant rather than declared once, because the image override needs
 * the prefix and a component that reads it from a context would be a context
 * for one value.
 */
function documentComponents(directory: string | null) {
  return {
    img: ({ src, alt }: ComponentProps<"img">) => {
      const resolved = resolveDocumentAsset(typeof src === "string" ? src : undefined, directory);

      // Text, not an `<img>` with a missing source. See `markdownAssets.ts`:
      // an element with a remote `src` has already made the request by the
      // time anything could object to it.
      if (resolved === null) {
        return <span className="preview__markdown-missing">{alt ?? ""}</span>;
      }
      return <img className="preview__markdown-image" src={resolved} alt={alt ?? ""} />;
    },

    // A link is DRAWN as a link and is not one: no `href`, so nothing can be
    // followed and nothing can be opened by a stray click. What replaces
    // following it is seeing it — the destination rides along as the title, so
    // a reader can tell where a reference points without leaving the preview,
    // which is the question they actually have about a link in a document they
    // are skimming.
    a: ({ children, href }: ComponentProps<"a">) => (
      <span className="preview__markdown-link" title={href}>
        {children}
      </span>
    ),

    code: FencedCode,
  };
}

const FENCE_LANGUAGE = /language-([\w-]+)/;

/**
 * The language of a fenced block, or `null` for an inline span.
 *
 * `react-markdown` uses one node type for both, and the `language-…` class is
 * the only thing that tells them apart. Its own function because the component
 * below reached the project's complexity bound with it inlined, and the gate
 * was right: "is this a fenced block, and in what language" is one question.
 */
function fenceLanguage(className: string | undefined, children: unknown): string | null {
  const language = FENCE_LANGUAGE.exec(className ?? "")?.[1];
  // A block whose body is not a plain string is one `react-markdown` has
  // already split into nodes, and re-joining it to highlight it would throw
  // away what it decided.
  return language === undefined || typeof children !== "string" ? null : language;
}

/**
 * A code span, or a fenced block sent through the shared highlighter.
 *
 * An inline span is not worth a round trip to a worker, so only a block makes
 * one — the hook is handed `null` otherwise and does nothing.
 */
function FencedCode({ className, children }: ComponentProps<"code">) {
  const language = fenceLanguage(className, children);
  const source = language === null ? null : String(children);
  const { html } = useHighlighted(source, language ?? "");

  if (source === null) return <code className={className}>{children}</code>;
  if (html === null) return <code className={className}>{source}</code>;

  // The worker either escapes the text or hands it to `highlight.js`, whose
  // output is escaped by construction. Nothing from the file reaches the DOM
  // unescaped — the same guarantee `CodePreview` relies on.
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: the worker escapes everything it emits
    <code className={`${className ?? ""} hljs`} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
