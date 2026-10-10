import {
  TextBuffer,
  createInitialContext,
  processKeystroke,
  type VimAction,
  type VimContext,
} from "@vimee/core";

import type { KeySurface } from "../keyEngine";
import { updateKeyEngineSnapshot, type EngineModeLabel } from "../keyEngineStore";
import { paintBlockCursor } from "../blockCursor";
import { copyToClipboard } from "../clipboard";
import {
  findOccurrences,
  handleFlashKey,
  isFlashActive,
  applyFlashLook,
  startFlash,
  startFlashPick,
  stopFlash,
  type FlashPickTarget,
  type FlashProvider,
  type FlashTarget,
} from "../flashSession";
import { requestChatCite } from "./chatCiteBus";
import { timelineRowOf } from "./citeFlash";
import { requestTurnJump } from "./chatTurnBus";
import {
  buildChatBuffer,
  chatScroller,
  chatViewport,
  fromRowPosition,
  isRangeUnobscured,
  lineAtOrBelow,
  readingBounds,
  rangeBetween,
  sentenceSpans,
  toRowPosition,
  type BufferPosition,
  type ChatBuffer,
  type RowPosition,
} from "./chatBuffer";

/**
 * The chat buffer's key surface: a read-only Vim over the timeline.
 *
 * Motions run in `@vimee/core`, a pure Vim engine, over the text projection
 * in `chatBuffer.ts`. The cursor is painted with a CSS highlight; a visual
 * selection is the browser's native selection, so the existing cite toolbar,
 * copy and the selection colours all work on it unchanged.
 *
 * The cursor is stored as a row and an offset, never as a line number,
 * because the buffer is rebuilt on every key from whatever rows are mounted.
 * Each thread keeps its last cursor for the page's lifetime, in memory only.
 */

const MOTION_KEYS = new Set([
  ..."hjklwbeWBE0^$gGfFtT;,{}nN*#%vV",
  ..."123456789",
  "<Left>",
  "<Right>",
  "<Up>",
  "<Down>",
]);
const VISUAL_EXTRA_KEYS = new Set(["i", "a", "o", "y", "<Esc>"]);
const SCROLL_KEYS = new Set(["<C-d>", "<C-u>", "<C-e>", "<C-y>", "<C-f>", "<C-b>"]);
const ARROW_TO_VIM: Readonly<Record<string, string>> = {
  "<Left>": "h",
  "<Right>": "l",
  "<Up>": "k",
  "<Down>": "j",
};
/** How many threads keep a remembered cursor; the least recently used goes first. */
const REMEMBERED_THREADS = 50;
/** A smooth scroll that never reports `scrollend` must not hold the cursor forever. */
const SCROLL_SETTLE_TIMEOUT_MS = 800;

let context: VimContext = createInitialContext({ line: 0, col: 0 });
let cursor: RowPosition | null = null;
/**
 * Whether the last sync put the Vim cursor on the first visible line because
 * `cursor` did not resolve (a fresh thread, or a remembered row not mounted).
 * A key that leaves that fallback where it is must not replace the
 * remembered position.
 */
let cursorIsFallback = false;
/** The open thread's key, from the chat route; `null` off a thread route. */
let threadKey: string | null = null;
/** Each thread's last cursor, most recently used last. Never persisted. */
const threadCursors = new Map<string, RowPosition>();
/** Bumped by every scroll motion, so only the latest one places the cursor. */
let scrollGeneration = 0;

/** Moves the cursor and remembers it for the open thread. */
function storeCursor(next: RowPosition | null): void {
  cursor = next;
  if (threadKey === null || next === null) return;
  threadCursors.delete(threadKey);
  threadCursors.set(threadKey, next);
  if (threadCursors.size > REMEMBERED_THREADS) {
    threadCursors.delete(threadCursors.keys().next().value!);
  }
}

/**
 * Tells the chat surface which thread is open. Its remembered cursor comes
 * back, painted where it was if its row is mounted; a thread not seen this
 * session paints nothing and starts at the first visible line on the first
 * key. A remembered row the virtual list has not mounted yet stays stored,
 * and a key puts the cursor on the first visible line until it mounts.
 */
export function setChatThreadKey(key: string | null): void {
  if (key === threadKey) return;
  threadKey = key;
  // The left thread's cursor is not this one's: clear its paint and stop
  // following it. The memory of where it was stays in `threadCursors`.
  paintBlockCursor("mesura-chat-cursor", null, null);
  cursor = key === null ? null : (threadCursors.get(key) ?? null);
  // A scroll motion still settling belongs to the thread that was left.
  scrollGeneration += 1;
  if (isVisual()) clearVisualSelection();
  context = createInitialContext(context.cursor);
  stopFlash();
  // The remembered cursor shows where it was left, without a key. The thread's
  // rows are normally in this commit; a virtual list that mounts them a frame
  // later gets one more try, and a row still not mounted waits for a key.
  if (cursor !== null && !paintRememberedCursor()) {
    const returnedTo = threadKey;
    window.requestAnimationFrame(() => {
      if (threadKey === returnedTo) paintRememberedCursor();
    });
  }
}

/**
 * Paints the open thread's remembered cursor if its row is mounted, with no
 * scroll and no reveal; false when the row is not there.
 */
function paintRememberedCursor(): boolean {
  const viewport = chatViewport();
  if (viewport === null || cursor === null) return false;
  const buffer = buildChatBuffer(viewport);
  const position = fromRowPosition(buffer, cursor);
  if (position === null) return false;
  context = { ...context, cursor: clampPosition(buffer, position) };
  paint(buffer, false);
  return true;
}

function vimKey(token: string): { key: string; ctrl: boolean } {
  if (ARROW_TO_VIM[token]) return { key: ARROW_TO_VIM[token]!, ctrl: false };
  if (token === "<Esc>") return { key: "Escape", ctrl: false };
  if (token === "<CR>") return { key: "Enter", ctrl: false };
  if (token === "<BS>") return { key: "Backspace", ctrl: false };
  const ctrl = /^<C-(.)>$/.exec(token);
  if (ctrl) return { key: ctrl[1]!, ctrl: true };
  return { key: token, ctrl: false };
}

function isVisual(): boolean {
  return context.mode === "visual" || context.mode === "visual-line";
}

function currentScroller(): HTMLElement | null {
  const viewport = chatViewport();
  return viewport ? chatScroller(viewport) : null;
}

/** Rebuilds the buffer and puts the Vim cursor where the stored cursor is. */
function syncBuffer(): { buffer: ChatBuffer; text: TextBuffer } | null {
  const viewport = chatViewport();
  if (viewport === null) return null;
  const buffer = buildChatBuffer(viewport);
  if (buffer.lines.length === 0) return null;
  const remembered = cursor && fromRowPosition(buffer, cursor);
  cursorIsFallback = !remembered;
  const position = remembered ?? firstVisiblePosition(buffer);
  context = { ...context, cursor: clampPosition(buffer, position) };
  if (context.visualAnchor) {
    context = { ...context, visualAnchor: clampPosition(buffer, context.visualAnchor) };
  }
  return { buffer, text: new TextBuffer(buffer.lines.join("\n")) };
}

function clampPosition(buffer: ChatBuffer, position: BufferPosition): BufferPosition {
  const line = Math.max(0, Math.min(buffer.lines.length - 1, position.line));
  const length = buffer.lines[line]?.length ?? 0;
  return { line, col: Math.max(0, Math.min(Math.max(0, length - 1), position.col)) };
}

/** The first line on screen: where a fresh cursor starts. */
function firstVisiblePosition(buffer: ChatBuffer): BufferPosition {
  const scroller = currentScroller();
  const top = scroller ? readingBounds(scroller).top : 0;
  return lineAtOrBelow(buffer, top + 4) ?? { line: buffer.lines.length - 1, col: 0 };
}

function setCursor(buffer: ChatBuffer, position: BufferPosition): void {
  context = { ...context, cursor: clampPosition(buffer, position) };
  storeCursor(toRowPosition(buffer, context.cursor));
}

function cursorRange(buffer: ChatBuffer): Range | null {
  const at = context.cursor;
  if ((buffer.lines[at.line]?.length ?? 0) === 0) return null;
  return rangeBetween(buffer, at, { line: at.line, col: at.col + 1 });
}

function paint(buffer: ChatBuffer, reveal: boolean): void {
  const range = cursorRange(buffer);
  // Reveal first: a widened cursor is measured where the glyph ends up.
  if (reveal && range) revealRange(range);
  paintBlockCursor("mesura-chat-cursor", range, range ? timelineRowOf(range) : null);
  paintVisualSelection(buffer);
}

/** The text the visual selection covers, or null outside visual mode. */
function visualRange(buffer: ChatBuffer): Range | null {
  if (!isVisual() || context.visualAnchor === null) return null;
  const anchor = context.visualAnchor;
  const head = context.cursor;
  const forward = anchor.line < head.line || (anchor.line === head.line && anchor.col <= head.col);
  const [from, to] = forward ? [anchor, head] : [head, anchor];
  return context.mode === "visual-line"
    ? rangeBetween(
        buffer,
        { line: from.line, col: 0 },
        { line: to.line, col: buffer.lines[to.line]?.length ?? 0 },
      )
    : rangeBetween(buffer, from, { line: to.line, col: to.col + 1 });
}

function paintVisualSelection(buffer: ChatBuffer): void {
  const selection = window.getSelection();
  const range = visualRange(buffer);
  if (!selection || range === null) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

function clearVisualSelection(): void {
  window.getSelection()?.removeAllRanges();
}

/** Keeps the cursor on screen with a margin, the way `scrolloff` does. */
function revealRange(range: Range): void {
  const scroller = currentScroller();
  if (!scroller) return;
  const rect = range.getBoundingClientRect();
  const bounds = readingBounds(scroller);
  const margin = Math.min(96, bounds.height / 4);
  if (rect.top < bounds.top + margin) {
    breakLiveFollow(scroller, "up");
    scroller.scrollTop -= bounds.top + margin - rect.top;
  } else if (rect.bottom > bounds.bottom - margin) {
    scroller.scrollTop += rect.bottom - (bounds.bottom - margin);
  }
}

/**
 * WORKAROUND: tells ChatView the reader moved away from the live edge, so a
 * streaming reply does not yank the timeline back to the end. ChatView only
 * learns that from wheel, touch, pointer and a few keys on its scroll node;
 * a synthetic upward wheel event reaches its existing handler without an
 * edit to ChatView. Remove once live-follow exposes a "reader moved" call.
 */
function breakLiveFollow(scroller: HTMLElement, direction: "up" | "down"): void {
  scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: direction === "up" ? -1 : 1 }));
}

/**
 * Resolves once a scroll started by the caller has settled: on `scrollend`,
 * or after a timeout for a scroll that never moved (already at the edge).
 */
function whenScrollSettles(scroller: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      scroller.removeEventListener("scrollend", finish);
      window.clearTimeout(timer);
      // The list mounts rows for the final position on its next frame.
      window.requestAnimationFrame(() => resolve());
    };
    const timer = window.setTimeout(finish, SCROLL_SETTLE_TIMEOUT_MS);
    scroller.addEventListener("scrollend", finish);
  });
}

function scrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth";
}

/**
 * Ctrl+D/U/F/B/E/Y: an animated scroll, then the cursor lands on the line at
 * the screen height it had (half pages) or the top line (full pages, lines).
 */
function scrollBy(token: string): void {
  const scroller = currentScroller();
  if (!scroller) return;
  const page = readingBounds(scroller).height;
  const line = 40;
  const delta =
    token === "<C-d>"
      ? page / 2
      : token === "<C-u>"
        ? -page / 2
        : token === "<C-f>"
          ? page - line
          : token === "<C-b>"
            ? -(page - line)
            : token === "<C-e>"
              ? line
              : -line;
  if (delta < 0) breakLiveFollow(scroller, "up");
  const synced = syncBuffer();
  const cursorTop = synced ? cursorRange(synced.buffer)?.getBoundingClientRect().top : undefined;
  const generation = ++scrollGeneration;
  const settled = whenScrollSettles(scroller);
  scroller.scrollBy({ top: delta, behavior: scrollBehavior() });
  void settled.then(() => {
    if (generation !== scrollGeneration) return;
    const next = syncBuffer();
    if (!next) return;
    const bounds = readingBounds(scroller);
    const half = token === "<C-d>" || token === "<C-u>";
    const y = Math.max(
      bounds.top + 8,
      Math.min(bounds.bottom - 8, half && cursorTop !== undefined ? cursorTop : bounds.top + 16),
    );
    const position = lineAtOrBelow(next.buffer, y);
    if (position) setCursor(next.buffer, position);
    paint(next.buffer, false);
  });
}

/** `gg` and `G`: an animated scroll to the list's edge, then the edge line. */
function jumpToEdge(edge: "start" | "end"): void {
  const scroller = currentScroller();
  if (!scroller) return;
  if (edge === "start") breakLiveFollow(scroller, "up");
  const generation = ++scrollGeneration;
  const settled = whenScrollSettles(scroller);
  scroller.scrollTo({
    top: edge === "start" ? 0 : scroller.scrollHeight,
    behavior: scrollBehavior(),
  });
  void settled.then(() => {
    if (generation !== scrollGeneration) return;
    const synced = syncBuffer();
    if (!synced) return;
    setCursor(synced.buffer, {
      line: edge === "start" ? 0 : synced.buffer.lines.length - 1,
      col: 0,
    });
    paint(synced.buffer, true);
  });
}

/**
 * `[u` / `]u`: the previous or next message the developer sent. The timeline
 * minimap owns which turn is current and how to scroll to one; this asks it,
 * then lands the cursor on that message once the scroll settles.
 */
function jumpToUserMessage(direction: "previous" | "next"): void {
  const scroller = currentScroller();
  if (!scroller) return;
  const settled = whenScrollSettles(scroller);
  const rowId = requestTurnJump(direction);
  if (rowId === null) {
    updateKeyEngineSnapshot({ notice: `no ${direction} message of yours` });
    return;
  }
  const generation = ++scrollGeneration;
  void settled.then(() => {
    if (generation !== scrollGeneration) return;
    storeCursor({ rowId, offset: 0 });
    const synced = syncBuffer();
    if (synced) paint(synced.buffer, false);
  });
}

/**
 * Cites `range` through the selection toolbar's pipeline, which flashes the
 * cited text (`citeAndFlash`). The composer takes the cite and focus with it,
 * so the keys go on in insert mode right after the citation, where its
 * comment is typed.
 */
function citeRange(range: Range | null): void {
  const selection = window.getSelection();
  let cited = false;
  if (range !== null && selection !== null) {
    selection.removeAllRanges();
    selection.addRange(range);
    cited = requestChatCite();
  }
  // The composer may already hold the selection, as its caret; only the
  // chat's own selection is cleared.
  const anchor = selection?.anchorNode;
  if (anchor && chatViewport()?.contains(anchor)) selection.removeAllRanges();
  updateKeyEngineSnapshot({
    notice: cited ? "cited into the composer" : "only assistant text can be cited",
  });
}

/** The text flash fades: each row's prose, or the whole row when it has none. */
function chatBackdrop(buffer: ChatBuffer): Range[] {
  return buffer.rows.map((row) => {
    const range = document.createRange();
    range.selectNodeContents(
      row.element.querySelector("[data-assistant-citation-source]") ?? row.element,
    );
    return range;
  });
}

/** Whether a reader can see `range`: inside the reading area and not under the composer. */
function isOnScreen(range: Range, bounds: DOMRect): boolean {
  const rect = range.getBoundingClientRect();
  if (rect.top < bounds.top || rect.bottom > bounds.bottom || rect.width === 0) return false;
  return isRangeUnobscured(range);
}

/** How far a target is from the cursor; flash labels the nearest first. */
function distanceFromCursor(rect: DOMRect, cursorRect: DOMRect | undefined): number {
  return cursorRect
    ? Math.abs(rect.top - cursorRect.top) * 4 + Math.abs(rect.left - cursorRect.left)
    : rect.top;
}

interface CitableSentence {
  readonly row: number;
  readonly start: BufferPosition;
  readonly end: BufferPosition;
}

/** Every sentence of the assistant prose in the buffer, in reading order. */
function citableSentences(buffer: ChatBuffer): CitableSentence[] {
  const sentences: CitableSentence[] = [];
  buffer.lines.forEach((line, lineIndex) => {
    const row = buffer.lineRow[lineIndex] ?? -1;
    if (row < 0) return;
    if (!buffer.rows[row]?.element.querySelector("[data-assistant-citation-source]")) return;
    for (const span of sentenceSpans(line)) {
      sentences.push({
        row,
        start: { line: lineIndex, col: span.start },
        end: { line: lineIndex, col: span.end },
      });
    }
  });
  return sentences;
}

function characterAt(buffer: ChatBuffer, at: BufferPosition): Range | null {
  return rangeBetween(buffer, at, { line: at.line, col: at.col + 1 });
}

const NOTHING_TO_CITE_NOTICE = "no assistant text on screen to cite";

/**
 * `<leader>c` in normal mode: a cite in two flash picks, with no selection to
 * make first. The first labels the start of every sentence on screen, the
 * second the end of every sentence from there to the end of that message;
 * the text between the two is cited.
 */
function startCitePick(buffer: ChatBuffer): void {
  const scroller = currentScroller();
  if (!scroller) return;
  // Labels are measured on the text as flash draws it.
  applyFlashLook("chat");
  const bounds = readingBounds(scroller);
  const cursorRect = cursorRange(buffer)?.getBoundingClientRect();
  const starts = new Map<string, CitableSentence>();
  const targets: (FlashPickTarget & { distance: number })[] = [];
  for (const sentence of citableSentences(buffer)) {
    const range = characterAt(buffer, sentence.start);
    if (range === null || !isOnScreen(range, bounds)) continue;
    const id = `${sentence.start.line}:${sentence.start.col}`;
    starts.set(id, sentence);
    targets.push({
      id,
      range,
      distance: distanceFromCursor(range.getBoundingClientRect(), cursorRect),
    });
  }
  const started = startFlashPick({
    scope: "chat",
    hint: "cite: where it starts",
    placement: "over",
    backdrop: chatBackdrop(buffer),
    targets: targets.toSorted((left, right) => left.distance - right.distance),
    pick: (target) => {
      const start = starts.get(target.id);
      if (start) pickCiteEnd(start);
    },
  });
  if (!started) updateKeyEngineSnapshot({ notice: NOTHING_TO_CITE_NOTICE });
}

function pickCiteEnd(start: CitableSentence): void {
  const synced = syncBuffer();
  const scroller = currentScroller();
  if (!synced || !scroller) return;
  const { buffer } = synced;
  applyFlashLook("chat");
  const bounds = readingBounds(scroller);
  const ends = new Map<string, CitableSentence>();
  const targets: FlashPickTarget[] = [];
  for (const sentence of citableSentences(buffer)) {
    const after =
      sentence.start.line > start.start.line ||
      (sentence.start.line === start.start.line && sentence.start.col >= start.start.col);
    if (sentence.row !== start.row || !after) continue;
    const range = characterAt(buffer, sentence.end);
    if (range === null || !isOnScreen(range, bounds)) continue;
    const id = `${sentence.end.line}:${sentence.end.col}`;
    ends.set(id, sentence);
    targets.push({ id, range });
  }
  const startRange = characterAt(buffer, start.start);
  const started = startFlashPick({
    scope: "chat",
    hint: "cite: where it ends",
    placement: "after",
    backdrop: chatBackdrop(buffer),
    targets,
    marked: startRange ? [startRange] : [],
    pick: (target) => {
      const end = ends.get(target.id);
      const current = syncBuffer();
      if (!end || !current) return;
      setCursor(current.buffer, start.start);
      paint(current.buffer, false);
      citeRange(
        rangeBetween(current.buffer, start.start, { line: end.end.line, col: end.end.col + 1 }),
      );
    },
  });
  if (!started) updateKeyEngineSnapshot({ notice: "that sentence ends off screen" });
}

/** Flash targets in the chat: matches a reader can see, not under the composer. */
function chatFlashProvider(): FlashProvider {
  return {
    scope: "chat",
    backdrop() {
      const synced = syncBuffer();
      return synced ? chatBackdrop(synced.buffer) : [];
    },
    collect(pattern, caseSensitive) {
      const synced = syncBuffer();
      const scroller = currentScroller();
      if (!synced || !scroller) return [];
      const bounds = readingBounds(scroller);
      const cursorRect = cursorRange(synced.buffer)?.getBoundingClientRect();
      const targets: FlashTarget[] = [];
      synced.buffer.lines.forEach((line, lineIndex) => {
        for (const col of findOccurrences(line, pattern, caseSensitive)) {
          const range = rangeBetween(
            synced.buffer,
            { line: lineIndex, col },
            { line: lineIndex, col: col + pattern.length },
          );
          if (!range || !isOnScreen(range, bounds)) continue;
          targets.push({
            id: `${lineIndex}:${col}`,
            range,
            nextChar: line[col + pattern.length],
            distance: distanceFromCursor(range.getBoundingClientRect(), cursorRect),
          });
        }
      });
      return targets;
    },
    jump(target) {
      const synced = syncBuffer();
      if (!synced) return;
      const [line, col] = target.id.split(":").map(Number);
      setCursor(synced.buffer, { line: line!, col: col! });
      paint(synced.buffer, true);
    },
  };
}

// ── Surface ────────────────────────────────────────────────────────────────

export const chatSurface: KeySurface = {
  scope: "chat",
  mode: () => (isVisual() ? "visual" : "normal"),
  label(): EngineModeLabel {
    if (isFlashActive()) return "FLASH";
    if (context.mode === "visual") return "VISUAL";
    if (context.mode === "visual-line") return "V-LINE";
    return "NORMAL";
  },
  isPending: () => isFlashActive() || context.phase !== "idle" || context.count > 0,
  handleKey(token) {
    if (isFlashActive()) return handleFlashKey(token);
    if (SCROLL_KEYS.has(token) && context.phase === "idle") {
      scrollBy(token);
      return true;
    }
    const pending = context.phase !== "idle" || context.count > 0;
    const accepted =
      pending ||
      MOTION_KEYS.has(token) ||
      (isVisual() && VISUAL_EXTRA_KEYS.has(token)) ||
      (token === "y" && !isVisual());
    if (!accepted) return false;

    const synced = syncBuffer();
    if (!synced) return false;
    const previousPhase = context.phase;
    const { key, ctrl } = vimKey(token);
    const wasVisual = isVisual();
    const before = context.cursor;
    const result = processKeystroke(key, context, synced.text, ctrl, true);
    context = result.newCtx;
    // Read-only: a key that would enter insert mode never leaves normal.
    if (context.mode === "insert" || context.mode === "command-line") {
      context = processKeystroke("Escape", context, synced.text, false, true).newCtx;
    }
    applyActions(result.actions);
    const moved = context.cursor.line !== before.line || context.cursor.col !== before.col;
    if (moved || !cursorIsFallback) storeCursor(toRowPosition(synced.buffer, context.cursor));
    if (wasVisual && !isVisual()) clearVisualSelection();
    paint(synced.buffer, true);

    if (previousPhase === "idle" && token === "G" && result.newCtx.count === 0) jumpToEdge("end");
    if (previousPhase === "g-pending" && token === "g") jumpToEdge("start");
    return true;
  },
  runCommand(command) {
    switch (command) {
      case "flash.jump":
        startFlash(chatFlashProvider());
        return true;
      case "chat.previousUserMessage":
        jumpToUserMessage("previous");
        return true;
      case "chat.nextUserMessage":
        jumpToUserMessage("next");
        return true;
      case "chat.cite": {
        const synced = syncBuffer();
        // An empty timeline has no buffer, and so nothing to cite.
        if (!synced) {
          updateKeyEngineSnapshot({ notice: NOTHING_TO_CITE_NOTICE });
          return true;
        }
        if (!isVisual()) {
          startCitePick(synced.buffer);
          return true;
        }
        const range = visualRange(synced.buffer);
        context = processKeystroke("Escape", context, synced.text, false, true).newCtx;
        paint(synced.buffer, false);
        citeRange(range);
        return true;
      }
      default:
        return false;
    }
  },
  reset() {
    if (isVisual()) clearVisualSelection();
    context = createInitialContext(context.cursor);
    stopFlash();
  },
};

function applyActions(actions: readonly VimAction[]): void {
  for (const action of actions) {
    if (action.type === "yank") {
      copyToClipboard(action.text);
      updateKeyEngineSnapshot({ notice: `yanked ${action.text.length} characters` });
    }
  }
}

/** Clears everything the chat surface painted, for when Vim mode turns off. */
export function clearChatSurfacePaint(): void {
  paintBlockCursor("mesura-chat-cursor", null, null);
  stopFlash();
  cursor = null;
  // The host sets the key again when it turns Vim mode back on, which brings
  // the thread's remembered cursor back.
  threadKey = null;
}
