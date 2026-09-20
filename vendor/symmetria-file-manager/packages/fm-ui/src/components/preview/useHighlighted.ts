import { useEffect, useState } from "react";

import type { HighlightRequest, HighlightResponse } from "../../highlight.worker.ts";
import { lazyWorker } from "../../lazyWorker.ts";

/**
 * The one highlighting worker, and the hook both text previews drive it with.
 *
 * Extracted from `CodePreview` when the rendered markdown preview needed the
 * same thing for its fenced blocks. A second module-level `lazyWorker` would
 * have been a second worker — the helper's own header says these are shared
 * because "a worker per file costs more than the work inside it", and two
 * panes each starting their own is the same waste one level up.
 */
const highlighter = lazyWorker(
  () => new Worker(new URL("../../highlight.worker.ts", import.meta.url), { type: "module" }),
);

/** Local: nothing outside this module escapes anything. */
/**
 * The request id, counted once for the whole process.
 *
 * **Module level, not `useRef` per component, and that distinction is a bug
 * that shipped and was caught in review.** The worker above is ONE worker
 * shared by every caller, and its responses arrive as broadcast events that
 * every listener sees. A per-component counter starts at 1 in each of them, so
 * two fenced blocks in one markdown file both post id 1, both accept both
 * replies, and each shows whichever answer arrived last — the TypeScript block
 * rendering the Python block's body.
 *
 * It was safe until this phase only because one `CodePreview` was ever mounted
 * at a time. A rendered document mounts one of these per fenced block.
 */
let nextRequestId = 0;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Drop the worker. For tests, which must not inherit another test's.
 *
 * The same reason `lazyWorker` carries `forget` at all, and the same reason
 * `forgetPreviewTokens` exists in the main process: a shared singleton that
 * survives between tests makes one test's state another test's precondition.
 */
export function forgetHighlighter(): void {
  highlighter.forget();
}

export interface Highlighted {
  /** Escaped, highlighted markup. Never raw file content. */
  readonly html: string | null;
  /** The highlighter stopped early because the file had too many lines. */
  readonly lineCapped: boolean;
}

/**
 * Highlight `text` as `language`, off the main thread.
 *
 * **Highlighting is decoration.** Where there is no worker — an embedding host
 * without one, or a test environment — `html` comes back as escaped plain
 * text, and where the language is one the bundle does not carry the worker
 * returns the same. A preview that fails to highlight must never be a preview
 * that fails.
 */
export function useHighlighted(text: string | null, language: string): Highlighted {
  const [html, setHtml] = useState<string | null>(null);
  const [lineCapped, setLineCapped] = useState(false);

  useEffect(() => {
    if (text === null) return;

    const instance = highlighter.get();
    if (instance === null) {
      setHtml(escapeHtml(text));
      return;
    }

    const id = ++nextRequestId;
    const onMessage = (event: MessageEvent<HighlightResponse>) => {
      // A stale answer belongs to a file the cursor has already left.
      if (event.data.id !== id) return;
      setHtml(event.data.html);
      setLineCapped(event.data.truncated);
    };

    instance.addEventListener("message", onMessage);
    const request: HighlightRequest = { id, text, language };
    instance.postMessage(request);

    return () => instance.removeEventListener("message", onMessage);
  }, [text, language]);

  return { html, lineCapped };
}
