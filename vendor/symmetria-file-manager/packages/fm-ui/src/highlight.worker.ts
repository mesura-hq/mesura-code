import hljs from "highlight.js/lib/common";

/**
 * Syntax highlighting, off the interface thread.
 *
 * **`highlight.js` has no size guards at all** — no document limit, no
 * line-length guard. One documented pathological case took five seconds on a
 * four-line comment. So the guards are here and they are mandatory: the caller
 * caps the bytes, this caps the lines, and the whole thing runs where a slow
 * document cannot freeze the cursor.
 *
 * **Never call automatic language detection.** It was measured at 35 times the
 * explicit cost and it misidentified JavaScript as a DNS zone file. The
 * language always arrives explicitly, and an unknown one returns the text
 * unhighlighted rather than guessing.
 *
 * Why `highlight.js` rather than Shiki: measured at 2.42 megabytes per second
 * against Shiki's 0.42, and Shiki's output inflates to nine times its input —
 * that memory, not the processor time, is what kills a preview pane.
 */

/** A preview pane never needs the whole file. */
const MAX_LINES = 2000;

export interface HighlightRequest {
  readonly id: number;
  readonly text: string;
  readonly language: string;
}

export interface HighlightResponse {
  readonly id: number;
  /** HTML with `hljs-*` classes, or the escaped source when the language is unknown. */
  readonly html: string;
  /** True when lines beyond the cap were dropped. */
  readonly truncated: boolean;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function highlight(request: HighlightRequest): HighlightResponse {
  const lines = request.text.split("\n");
  const truncated = lines.length > MAX_LINES;
  const text = truncated ? lines.slice(0, MAX_LINES).join("\n") : request.text;

  if (!hljs.getLanguage(request.language)) {
    // A language the bundle does not carry. Plain text is a correct answer.
    return { id: request.id, html: escapeHtml(text), truncated };
  }

  try {
    const { value } = hljs.highlight(text, { language: request.language, ignoreIllegals: true });
    return { id: request.id, html: value, truncated };
  } catch {
    // Highlighting is decoration. A failure must show the file, not an error.
    return { id: request.id, html: escapeHtml(text), truncated };
  }
}

self.addEventListener("message", (event: MessageEvent<HighlightRequest>) => {
  self.postMessage(highlight(event.data));
});
