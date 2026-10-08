import { readAssistantText, type TextChunk } from "~/lib/assistantTextSelection";

/**
 * The chat as a text buffer: every mounted timeline row, projected to text by
 * the same reader the citation feature uses, joined into lines.
 *
 * `readAssistantText` turns block elements into line breaks and maps every
 * character back to a DOM `Text` node, so a buffer position always resolves
 * to a `Range` on the rendered chat. Rows are separated by one empty line, so
 * Vim's paragraph motions step from message to message.
 *
 * Only mounted rows are in the buffer: the timeline is virtualized. Motions
 * near the edge scroll the list, the list mounts more rows, and the next key
 * rebuilds the buffer with them.
 *
 * A `\n` in a text node whose `white-space` collapses newlines (a soft break
 * in a Markdown paragraph) renders as a space, so the projection reads it as
 * one; the swap is one character for one, so every offset stays valid.
 */

export const CHAT_VIEWPORT_SELECTOR = "[data-assistant-citation-viewport]";
const ROW_SELECTOR = "[data-timeline-row-id]";

export interface BufferRow {
  readonly id: string;
  readonly element: HTMLElement;
  readonly text: string;
  readonly chunks: readonly TextChunk[];
  /** The buffer line where this row's text starts. */
  readonly firstLine: number;
  /** Offset into `text` where each of the row's lines starts. */
  readonly lineStarts: readonly number[];
}

export interface ChatBuffer {
  readonly rows: readonly BufferRow[];
  readonly lines: readonly string[];
  /** For each buffer line, the row index that owns it, or -1 for a separator. */
  readonly lineRow: readonly number[];
}

export interface BufferPosition {
  readonly line: number;
  readonly col: number;
}

/**
 * A position that survives a rebuild: the row and an offset into its text.
 * Offset `SEPARATOR_OFFSET` is the blank line between the row and the one
 * before it, so a cursor that stops there (`k` from a row's first line, `{`)
 * moves on from there on the next key instead of snapping back into the row.
 */
export interface RowPosition {
  readonly rowId: string;
  readonly offset: number;
}

export const SEPARATOR_OFFSET = -1;

export function chatViewport(): HTMLElement | null {
  return document.querySelector<HTMLElement>(CHAT_VIEWPORT_SELECTOR);
}

export function buildChatBuffer(viewport: HTMLElement): ChatBuffer {
  const elements = [...viewport.querySelectorAll<HTMLElement>(ROW_SELECTOR)]
    .map((element) => ({ element, top: element.getBoundingClientRect().top }))
    .toSorted((left, right) => left.top - right.top);

  const rows: BufferRow[] = [];
  const lines: string[] = [];
  const lineRow: number[] = [];
  for (const { element } of elements) {
    // An assistant row's prose is its citation source; reading only that
    // keeps the row's author label and controls out of the buffer, and keeps
    // a visual selection inside what the cite pipeline can capture.
    const source =
      element.querySelector<HTMLElement>("[data-assistant-citation-source]") ?? element;
    const { text: rawText, chunks } = readAssistantText(source);
    if (rawText.trim().length === 0) continue;
    const collapses = collapseReader(chunks);
    const text = renderedText(rawText, chunks, collapses);
    // Two kinds of projected line are dropped:
    // - blank lines, from whitespace between HTML blocks: a cursor there has
    //   no character to paint, and the one blank line between rows already
    //   gives `{` and `}` their stops;
    // - lines of screen-reader-only text, such as the "You" and "T3 Code"
    //   author headings: a cursor there would be invisible.
    const rowLines: string[] = [];
    const lineStarts: number[] = [];
    let offset = 0;
    for (const line of text.split("\n")) {
      // Collapsible whitespace at the start of a line renders as nothing,
      // such as the newline remark-breaks puts after a `<br>`.
      const start = offset + leadingCollapsedLength(line, offset, chunks, collapses);
      const end = offset + line.length;
      if (line.trim().length > 0 && !isScreenReaderOnly(chunks, start, end)) {
        rowLines.push(text.slice(start, end));
        lineStarts.push(start);
      }
      offset = end + 1;
    }
    if (rowLines.length === 0) continue;
    if (lines.length > 0) {
      lines.push("");
      lineRow.push(-1);
    }
    rows.push({
      id: element.dataset.timelineRowId ?? "",
      element,
      text,
      chunks,
      firstLine: lines.length,
      lineStarts,
    });
    for (const line of rowLines) {
      lines.push(line);
      lineRow.push(rows.length - 1);
    }
  }
  return { rows, lines, lineRow };
}

/**
 * CSS's collapsible white space: spaces, tabs and segment breaks. Not `\s`,
 * which also matches a no-break space, a character the browser renders.
 */
const COLLAPSIBLE_WHITESPACE = /[ \t\n\r]/;

/** `white-space` values that render a `\n` as a line break. */
const PRESERVED_NEWLINES = new Set(["pre", "pre-wrap", "pre-line", "break-spaces"]);

/**
 * Whether a chunk renders its whitespace collapsed, read lazily: the buffer
 * is rebuilt on every key, so a style is read only for a chunk whose
 * whitespace matters, once per parent. An unstyled element in a DOM without a
 * user-agent stylesheet reports "", the initial `normal`.
 */
function collapseReader(chunks: readonly TextChunk[]): (index: number) => boolean {
  const byParent = new Map<Element, boolean>();
  return (index) => {
    const parent = chunks[index]?.node.parentElement;
    if (!parent) return true;
    let collapses = byParent.get(parent);
    if (collapses === undefined) {
      collapses = !PRESERVED_NEWLINES.has(getComputedStyle(parent).whiteSpace);
      byParent.set(parent, collapses);
    }
    return collapses;
  };
}

/** The projected text with each collapsed `\n` read as the space it renders as. */
function renderedText(
  text: string,
  chunks: readonly TextChunk[],
  collapses: (index: number) => boolean,
): string {
  if (!text.includes("\n")) return text;
  let rendered = "";
  let offset = 0;
  chunks.forEach((chunk, index) => {
    // Separators between chunks are block and `<br>` breaks: always kept.
    rendered += text.slice(offset, chunk.start);
    const span = text.slice(chunk.start, chunk.end);
    rendered += span.includes("\n") && collapses(index) ? span.replaceAll("\n", " ") : span;
    offset = chunk.end;
  });
  return rendered + text.slice(offset);
}

function leadingCollapsedLength(
  line: string,
  lineStart: number,
  chunks: readonly TextChunk[],
  collapses: (index: number) => boolean,
): number {
  let length = 0;
  let index = 0;
  while (length < line.length && COLLAPSIBLE_WHITESPACE.test(line[length]!)) {
    const offset = lineStart + length;
    while (index < chunks.length && chunks[index]!.end <= offset) index += 1;
    const chunk = chunks[index];
    if (chunk === undefined || chunk.start > offset || !collapses(index)) break;
    length += 1;
  }
  return length;
}

function isScreenReaderOnly(chunks: readonly TextChunk[], start: number, end: number): boolean {
  let any = false;
  for (const chunk of chunks) {
    if (chunk.end <= start || chunk.start >= end) continue;
    any = true;
    if (!chunk.node.parentElement?.closest(".sr-only")) return false;
  }
  return any;
}

export function toRowPosition(buffer: ChatBuffer, position: BufferPosition): RowPosition | null {
  const rowIndex = buffer.lineRow[position.line];
  if (rowIndex === undefined) return null;
  if (rowIndex === -1) {
    // A separator belongs to the row after it.
    const next = buffer.rows[buffer.lineRow[position.line + 1] ?? -1];
    return next ? { rowId: next.id, offset: SEPARATOR_OFFSET } : null;
  }
  const row = buffer.rows[rowIndex]!;
  const lineInRow = position.line - row.firstLine;
  return { rowId: row.id, offset: row.lineStarts[lineInRow]! + position.col };
}

export function fromRowPosition(buffer: ChatBuffer, position: RowPosition): BufferPosition | null {
  const row = buffer.rows.find((candidate) => candidate.id === position.rowId);
  if (row === undefined) return null;
  if (position.offset === SEPARATOR_OFFSET) {
    // The row before may have unmounted with its separator: then the row's start.
    return buffer.lineRow[row.firstLine - 1] === -1
      ? { line: row.firstLine - 1, col: 0 }
      : { line: row.firstLine, col: 0 };
  }
  let lineInRow = 0;
  for (let index = 0; index < row.lineStarts.length; index += 1) {
    if (row.lineStarts[index]! <= position.offset) lineInRow = index;
  }
  return {
    line: row.firstLine + lineInRow,
    col: position.offset - row.lineStarts[lineInRow]!,
  };
}

function rowAt(buffer: ChatBuffer, line: number): BufferRow | null {
  const index = buffer.lineRow[line];
  return index === undefined || index === -1 ? null : buffer.rows[index]!;
}

function boundaryAt(row: BufferRow, offset: number): { node: Text; offset: number } | null {
  for (const chunk of row.chunks) {
    if (offset < chunk.end || (offset === chunk.end && chunk === row.chunks.at(-1))) {
      if (offset < chunk.start) return { node: chunk.node, offset: 0 };
      return { node: chunk.node, offset: offset - chunk.start };
    }
  }
  const last = row.chunks.at(-1);
  return last ? { node: last.node, offset: last.node.length } : null;
}

/** The DOM range between two buffer positions, end exclusive. */
export function rangeBetween(
  buffer: ChatBuffer,
  start: BufferPosition,
  end: BufferPosition,
): Range | null {
  const startRow = rowAt(buffer, start.line) ?? rowAt(buffer, start.line + 1);
  const endRow = rowAt(buffer, end.line) ?? rowAt(buffer, end.line - 1);
  if (startRow === null || endRow === null) return null;
  const startOffset =
    rowAt(buffer, start.line) === null
      ? 0
      : startRow.lineStarts[start.line - startRow.firstLine]! + start.col;
  const endOffset =
    rowAt(buffer, end.line) === null
      ? endRow.text.length
      : endRow.lineStarts[end.line - endRow.firstLine]! + end.col;
  const from = boundaryAt(startRow, startOffset);
  const to = boundaryAt(endRow, endOffset);
  if (from === null || to === null) return null;
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

/**
 * The first line whose text sits at or below `y` on screen. Scroll motions
 * and a fresh cursor use it; it reads line boxes instead of hit-testing a
 * point, which misses whenever the point falls between blocks or on a control.
 */
export function lineAtOrBelow(buffer: ChatBuffer, y: number): BufferPosition | null {
  let fallback: BufferPosition | null = null;
  for (let line = 0; line < buffer.lines.length; line += 1) {
    if (buffer.lineRow[line] === -1) continue;
    const range = rangeBetween(buffer, { line, col: 0 }, { line, col: 1 });
    const rect = range?.getBoundingClientRect();
    if (!rect || rect.height === 0) continue;
    fallback = { line, col: 0 };
    if (rect.bottom > y) return fallback;
  }
  return fallback;
}

/** The scroll container of the timeline, found once per viewport. */
const scrollers = new WeakMap<HTMLElement, HTMLElement>();
export function chatScroller(viewport: HTMLElement): HTMLElement | null {
  const cached = scrollers.get(viewport);
  if (cached?.isConnected) return cached;
  const row = viewport.querySelector<HTMLElement>(ROW_SELECTOR);
  for (let element = row?.parentElement ?? null; element; element = element.parentElement) {
    const overflow = getComputedStyle(element).overflowY;
    if (
      (overflow === "auto" || overflow === "scroll") &&
      element.scrollHeight > element.clientHeight
    ) {
      scrollers.set(viewport, element);
      return element;
    }
    if (element === viewport) break;
  }
  return null;
}

/**
 * The part of the timeline a reader can see: the scroller's box, cut off at
 * the top of the floating composer, which sits over the end of the list.
 */
export function readingBounds(scroller: HTMLElement): DOMRect {
  const bounds = scroller.getBoundingClientRect();
  const composer = document.querySelector('[data-slot="composer-shell"]');
  const composerTop = composer?.getBoundingClientRect().top ?? bounds.bottom;
  const bottom = Math.min(bounds.bottom, composerTop);
  return new DOMRect(bounds.left, bounds.top, bounds.width, Math.max(0, bottom - bounds.top));
}

/** Whether a range's first box is actually painted, not covered by an overlay. */
export function isRangeUnobscured(range: Range): boolean {
  const rect = range.getClientRects()[0];
  if (!rect) return false;
  const hit = document.elementFromPoint(rect.left + 1, rect.top + rect.height / 2);
  const container =
    range.startContainer.nodeType === Node.TEXT_NODE
      ? range.startContainer.parentElement
      : (range.startContainer as Element);
  return (
    hit !== null &&
    container !== null &&
    (hit === container || container.contains(hit) || hit.contains(container))
  );
}
