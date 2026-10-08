import {
  TextBuffer,
  createInitialContext,
  processKeystroke,
  type VimAction,
  type VimContext,
} from "@vimee/core";

import type { KeySurface } from "../keyEngine";
import { updateKeyEngineSnapshot, type EngineModeLabel } from "../keyEngineStore";
import { paintHighlight } from "../highlights";
import { copyToClipboard } from "../clipboard";
import {
  findOccurrences,
  handleFlashKey,
  isFlashActive,
  startFlash,
  stopFlash,
  type FlashProvider,
  type FlashTarget,
} from "../flashSession";
import { requestChatCite } from "./chatCiteBus";
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
/** A smooth scroll that never reports `scrollend` must not hold the cursor forever. */
const SCROLL_SETTLE_TIMEOUT_MS = 800;

let context: VimContext = createInitialContext({ line: 0, col: 0 });
let cursor: RowPosition | null = null;
/** Bumped by every scroll motion, so only the latest one places the cursor. */
let scrollGeneration = 0;

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
  const position = (cursor && fromRowPosition(buffer, cursor)) ?? firstVisiblePosition(buffer);
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
  cursor = toRowPosition(buffer, context.cursor);
}

function cursorRange(buffer: ChatBuffer): Range | null {
  const at = context.cursor;
  if ((buffer.lines[at.line]?.length ?? 0) === 0) return null;
  return rangeBetween(buffer, at, { line: at.line, col: at.col + 1 });
}

function paint(buffer: ChatBuffer, reveal: boolean): void {
  const range = cursorRange(buffer);
  paintHighlight("mesura-chat-cursor", range ? [range] : []);
  paintVisualSelection(buffer);
  if (reveal && range) revealRange(range);
}

function paintVisualSelection(buffer: ChatBuffer): void {
  const selection = window.getSelection();
  if (!selection) return;
  if (!isVisual() || context.visualAnchor === null) return;
  const anchor = context.visualAnchor;
  const head = context.cursor;
  const forward = anchor.line < head.line || (anchor.line === head.line && anchor.col <= head.col);
  const [from, to] = forward ? [anchor, head] : [head, anchor];
  const range =
    context.mode === "visual-line"
      ? rangeBetween(
          buffer,
          { line: from.line, col: 0 },
          { line: to.line, col: buffer.lines[to.line]?.length ?? 0 },
        )
      : rangeBetween(buffer, from, { line: to.line, col: to.col + 1 });
  if (range === null) return;
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
    cursor = { rowId, offset: 0 };
    const synced = syncBuffer();
    if (synced) paint(synced.buffer, false);
  });
}

/**
 * WORKAROUND: the composer's editor syncs its DOM selection after the prompt
 * changes, and a selection inside a contenteditable takes focus with it, so
 * the cite would leave the chat for the composer. The cite asks the composer
 * not to focus, but that flag does not reach the editor's selection sync.
 * Remove once the composer can apply a replacement without moving the DOM
 * selection (ADR-009, "Cite").
 */
function keepFocusInChat(): void {
  window.requestAnimationFrame(() =>
    window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest('[data-testid="composer-editor"]')) {
        active.blur();
      }
    }),
  );
}

/** Flash targets in the chat: matches a reader can see, not under the composer. */
function chatFlashProvider(): FlashProvider {
  return {
    scope: "chat",
    backdrop() {
      const synced = syncBuffer();
      if (!synced) return [];
      return synced.buffer.rows.map((row) => {
        const range = document.createRange();
        range.selectNodeContents(
          row.element.querySelector("[data-assistant-citation-source]") ?? row.element,
        );
        return range;
      });
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
          if (!range) continue;
          const rect = range.getBoundingClientRect();
          if (rect.top < bounds.top || rect.bottom > bounds.bottom || rect.width === 0) continue;
          if (!isRangeUnobscured(range)) continue;
          targets.push({
            id: `${lineIndex}:${col}`,
            range,
            nextChar: line[col + pattern.length],
            distance: cursorRect
              ? Math.abs(rect.top - cursorRect.top) * 4 + Math.abs(rect.left - cursorRect.left)
              : rect.top,
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
    const result = processKeystroke(key, context, synced.text, ctrl, true);
    context = result.newCtx;
    // Read-only: a key that would enter insert mode never leaves normal.
    if (context.mode === "insert" || context.mode === "command-line") {
      context = processKeystroke("Escape", context, synced.text, false, true).newCtx;
    }
    applyActions(result.actions);
    cursor = toRowPosition(synced.buffer, context.cursor);
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
        if (!isVisual() || !synced) return false;
        paintVisualSelection(synced.buffer);
        const cited = requestChatCite();
        if (cited) keepFocusInChat();
        context = processKeystroke("Escape", context, synced.text, false, true).newCtx;
        clearVisualSelection();
        paint(synced.buffer, false);
        updateKeyEngineSnapshot({
          notice: cited ? "cited into the composer" : "only assistant text can be cited",
        });
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
  paintHighlight("mesura-chat-cursor", []);
  stopFlash();
  cursor = null;
}
