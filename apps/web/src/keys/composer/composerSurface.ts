import { createInitialContext, processKeystroke, type VimContext } from "@vimee/core";

import type { KeySurface } from "../keyEngine";
import { updateKeyEngineSnapshot, type EngineModeLabel } from "../keyEngineStore";
import { composerEditorElement, isComposerMenuOpen } from "../focusScope";
import { paintHighlight } from "../highlights";
import { chatSurface } from "../chat/chatSurface";
import { copyToClipboard } from "../clipboard";
import { paintBlockCursor, paintEmptyLineCursor } from "../blockCursor";
import {
  findOccurrences,
  handleFlashKey,
  isFlashActive,
  startFlash,
  type FlashProvider,
  type FlashTarget,
} from "../flashSession";
import { bumpComposerLayout } from "./composerExpanded";
import {
  caretRectAt,
  domPointAt,
  expandProjection,
  offsetOf,
  positionOf,
  projectPrompt,
  type ComposerProjection,
} from "./composerProjection";
import {
  ComposerTextBuffer,
  recordComposerUndoState,
  redoComposerChange,
  undoComposerChange,
  type ComposerUndoStep,
} from "./composerUndo";

/**
 * Vim inside the composer.
 *
 * Insert mode is the composer as upstream built it: every key goes to Lexical
 * untouched. Escape enters normal mode, where keys run through `@vimee/core`
 * over the projected prompt (`composerProjection.ts`) and the result is
 * written back through the composer's own replacement path. A second Escape
 * leaves the composer for the chat buffer.
 *
 * The composer registers an adapter while it is mounted; that is the only
 * seam in `ChatComposer.tsx`.
 *
 * `u` and `<C-r>` walk the draft's whole edit history (`composerUndo.ts`),
 * not vimee's, whose stack lives in one normal-mode session's buffer: an
 * insert session is one step, and each normal-mode change is one more.
 */

export interface ComposerVimAdapter {
  /** The expanded prompt and the collapsed cursor. */
  read(): { prompt: string; cursor: number };
  /** Replaces the whole prompt and places the collapsed cursor; keeps focus. */
  write(prompt: string, cursor: number): void;
  setCursor(cursor: number): void;
  /** The draft the composer is open on, which keys its undo history. */
  draftKey?(): string;
}

const OWNED_BY_KEYMAP = new Set(["s", "[", "]"]);

let adapter: ComposerVimAdapter | null = null;
let mode: "insert" | "normal" = "insert";
let context: VimContext = createInitialContext({ line: 0, col: 0 });
let session: { projection: ComposerProjection; buffer: ComposerTextBuffer; prompt: string } | null =
  null;
let focusListenerInstalled = false;
/** Where the current insert session started typing: the start of its undo step. */
let insertStartOffset: number | null = null;
/** Set by `resumeComposerNormalOnFocus`: where arriving focus resumes normal mode. */
let pendingNormalOffset: number | null = null;
/** The surface the ring was drawn on, so it clears even once the editor is gone. */
let markedSurface: HTMLElement | null = null;

const COMPOSER_SURFACE_SELECTOR = "[data-chat-composer-main-surface]";
const COMPOSER_SURFACE_VIM_ATTRIBUTE = "data-mesura-composer-vim";

export function registerComposerVimAdapter(next: ComposerVimAdapter): () => void {
  adapter = next;
  installFocusListener();
  return () => {
    if (adapter !== next) return;
    adapter = null;
    pendingNormalOffset = null;
    if (mode !== "insert") enterInsert();
  };
}

/**
 * Writes the Vim mode onto the editor (it hides the caret) and onto the
 * composer's surface (it draws the ring), or clears both in insert mode. The
 * surface carries its own attribute because `mesura.css` keeps `:has()` out.
 */
function markComposerVimMode(vimMode: "normal" | "visual" | null): void {
  const editor = composerEditorElement();
  const surface = editor?.closest<HTMLElement>(COMPOSER_SURFACE_SELECTOR) ?? null;
  if (markedSurface !== null && markedSurface !== surface) {
    markedSurface.removeAttribute(COMPOSER_SURFACE_VIM_ATTRIBUTE);
  }
  if (vimMode === null) {
    editor?.removeAttribute("data-mesura-vim");
    surface?.removeAttribute(COMPOSER_SURFACE_VIM_ATTRIBUTE);
    markedSurface = null;
    return;
  }
  editor?.setAttribute("data-mesura-vim", vimMode);
  surface?.setAttribute(COMPOSER_SURFACE_VIM_ATTRIBUTE, vimMode);
  markedSurface = surface;
}

/**
 * Focus arriving from outside the composer lands in insert mode, unless a
 * surface asked for normal mode back (`resumeComposerNormalOnFocus`).
 */
function installFocusListener(): void {
  if (focusListenerInstalled) return;
  focusListenerInstalled = true;
  // A key ends the resume too, from the engine's own handler
  // (`cancelComposerNormalResume`): it consumes keys before any later
  // window listener could see them.
  window.addEventListener("pointerdown", cancelComposerNormalResume, true);
  window.addEventListener(
    "focusin",
    (event) => {
      const editor = composerEditorElement();
      if (!editor || !(event.target instanceof Node) || !editor.contains(event.target)) return;
      if (event.relatedTarget instanceof Node && editor.contains(event.relatedTarget)) return;
      if (pendingNormalOffset !== null) enterNormal(pendingNormalOffset);
      else enterInsert();
    },
    true,
  );
  // Leaving the composer by any route (a click, a pane chord, `[u`) clears
  // its normal-mode paint, so no cursor is left behind in an unfocused box.
  window.addEventListener(
    "focusout",
    (event) => {
      const editor = composerEditorElement();
      if (!editor || !(event.target instanceof Node) || !editor.contains(event.target)) return;
      if (event.relatedTarget instanceof Node && editor.contains(event.relatedTarget)) return;
      if (mode !== "insert") enterInsert();
    },
    true,
  );
}

/** An adapter that names no draft shares one history. */
function undoDraftKey(): string {
  return adapter?.draftKey?.() ?? "";
}

/** Records `prompt` as the draft's current state; `hint` is where its change started. */
function recordUndoState(prompt: string, hint: number): void {
  if (adapter) recordComposerUndoState(undoDraftKey(), prompt, hint);
}

function isVisual(): boolean {
  return context.mode === "visual" || context.mode === "visual-line";
}

function enterInsert(): void {
  // An insert session starts here: what it types becomes one step when
  // normal mode is entered again.
  if (adapter) {
    const { prompt, cursor } = adapter.read();
    recordUndoState(prompt, cursor);
    insertStartOffset = cursor;
  }
  mode = "insert";
  session = null;
  context = createInitialContext({ line: 0, col: 0 });
  paintBlockCursor("mesura-composer-cursor", null, null);
  paintHighlight("mesura-composer-visual", []);
  markComposerVimMode(null);
  bumpComposerLayout();
}

/** Enters normal mode at `at`, or one back from the caret when leaving insert mode. */
function enterNormal(at?: number): void {
  if (!adapter) return;
  const { prompt, cursor } = adapter.read();
  const projection = projectPrompt(prompt);
  session = { projection, buffer: new ComposerTextBuffer(projection.text), prompt };
  // Leaving insert mode steps the cursor back one, as Vim does.
  const offset = at ?? Math.max(0, cursor - 1);
  const position = positionOf(projection.text, Math.min(offset, projection.text.length));
  context = createInitialContext(position);
  recordUndoState(prompt, insertStartOffset ?? offset);
  insertStartOffset = null;
  mode = "normal";
  markComposerVimMode("normal");
  paint();
}

/** Re-reads the prompt when something else changed it since the last key. */
function currentSession(): NonNullable<typeof session> | null {
  if (!adapter) return null;
  const { prompt } = adapter.read();
  if (session === null || session.prompt !== prompt) {
    const projection = projectPrompt(prompt);
    session = { projection, buffer: new ComposerTextBuffer(projection.text), prompt };
  }
  return session;
}

/**
 * `syncCaret` is false right after a write: the write places the caret itself
 * once the editor has the new prompt. Moving the caret before that makes the
 * editor report its old text as a change, which overwrites the write.
 */
function paint(syncCaret = true): void {
  const editor = composerEditorElement();
  if (!editor || !session) return;
  const text = session.buffer.getContent();
  const offset = offsetOf(text, context.cursor.line, context.cursor.col);
  const char = text[offset];
  if (char === undefined || char === "\n") {
    // Nothing to highlight under the cursor: draw the block as an element.
    const rect = caretRectAt(editor, offset);
    paintEmptyLineCursor(
      "mesura-composer-cursor",
      rect ? { left: rect.left, top: rect.top, height: rect.height } : null,
    );
  } else {
    // Drawn in the editor's host: Lexical owns everything inside the editor.
    paintBlockCursor(
      "mesura-composer-cursor",
      rangeAt(editor, offset, offset + 1),
      editor.parentElement,
    );
  }
  if (isVisual() && context.visualAnchor) {
    const anchor = offsetOf(text, context.visualAnchor.line, context.visualAnchor.col);
    let [from, to] = anchor <= offset ? [anchor, offset + 1] : [offset, anchor + 1];
    if (context.mode === "visual-line") {
      from = text.lastIndexOf("\n", from - 1) + 1;
      const end = text.indexOf("\n", to - 1);
      to = end === -1 ? text.length : end;
    }
    const range = rangeAt(editor, from, Math.min(text.length, to));
    paintHighlight("mesura-composer-visual", range ? [range] : []);
  } else {
    paintHighlight("mesura-composer-visual", []);
  }
  if (syncCaret) adapter?.setCursor(offset);
  bumpComposerLayout();
}

function rangeAt(editor: HTMLElement, start: number, end: number): Range | null {
  if (end <= start) return null;
  const from = domPointAt(editor, start);
  const to = domPointAt(editor, end);
  if (!from || !to) return null;
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

function vimKey(token: string): { key: string; ctrl: boolean } | null {
  if (token === "<Esc>") return { key: "Escape", ctrl: false };
  if (token === "<CR>") return { key: "Enter", ctrl: false };
  if (token === "<BS>") return { key: "Backspace", ctrl: false };
  if (token === "<Left>") return { key: "h", ctrl: false };
  if (token === "<Right>") return { key: "l", ctrl: false };
  if (token === "<Up>") return { key: "k", ctrl: false };
  if (token === "<Down>") return { key: "j", ctrl: false };
  const ctrl = /^<C-(.)>$/.exec(token);
  if (ctrl) return ctrl[1] === "r" ? { key: "r", ctrl: true } : null;
  return token.length === 1 ? { key: token, ctrl: false } : null;
}

function handleNormalKey(token: string): boolean {
  const current = currentSession();
  if (!current || !adapter) return false;
  if (token === "<Esc>" && context.phase === "idle" && !isVisual() && context.count === 0) {
    leaveForChat();
    return true;
  }
  // Keys the keymap owns in the composer's normal mode: flash and the
  // `[` / `]` groups. Vim's own `s` and bracket motions give way to them.
  if (context.phase === "idle" && context.count === 0 && OWNED_BY_KEYMAP.has(token)) return false;
  if (context.phase === "idle" && !isVisual() && (token === "u" || token === "<C-r>")) {
    stepUndoHistory(current, token === "u" ? undoComposerChange : redoComposerChange);
    return true;
  }
  const key = vimKey(token);
  if (key === null) return false;

  const before = current.buffer.getContent();
  const beforeOffset = offsetOf(before, context.cursor.line, context.cursor.col);
  const selectionStart = visualSelectionStart(before);
  const result = processKeystroke(key.key, context, current.buffer, key.ctrl, false);
  context = result.newCtx;
  const text = current.buffer.getContent();
  const offset = offsetOf(text, context.cursor.line, context.cursor.col);
  // Compared, not read from the actions: vimee does not report every edit
  // (`ciw`, a visual `d`) as a `content-change`.
  const changed = text !== before;
  if (changed) {
    const prompt = expandProjection(text, current.projection.tokens);
    session = { ...current, prompt };
    adapter.write(prompt, offset);
    // An edit starts at the leftmost of the cursor before the key, the cursor
    // after it (a backward `dh`, `db`) and a visual selection's start. A
    // change that enters insert mode (`cw`) becomes one step with that insert
    // session.
    const changeHint = Math.min(beforeOffset, offset, selectionStart ?? beforeOffset);
    recordUndoState(current.prompt, beforeOffset);
    if (context.mode === "insert") insertStartOffset = changeHint;
    else recordUndoState(prompt, changeHint);
  } else {
    // Vim fills its register on deletes too; only a pure yank is a copy.
    const yank = result.actions.find((action) => action.type === "yank");
    if (yank?.type === "yank") {
      copyToClipboard(expandProjection(yank.text, current.projection.tokens));
      updateKeyEngineSnapshot({ notice: `yanked ${yank.text.length} characters` });
    }
  }

  if (context.mode === "insert") {
    mode = "insert";
    paintBlockCursor("mesura-composer-cursor", null, null);
    paintHighlight("mesura-composer-visual", []);
    markComposerVimMode(null);
    if (!changed) {
      adapter.setCursor(offset);
      insertStartOffset = offset;
    }
    session = null;
    return true;
  }
  markComposerVimMode(isVisual() ? "visual" : "normal");
  paint(!changed);
  return true;
}

/** The start of the visual selection in `text`, before a key edits it; null outside visual mode. */
function visualSelectionStart(text: string): number | null {
  if (!isVisual() || !context.visualAnchor) return null;
  const anchor = offsetOf(text, context.visualAnchor.line, context.visualAnchor.col);
  const start = Math.min(anchor, offsetOf(text, context.cursor.line, context.cursor.col));
  return context.mode === "visual-line" ? text.lastIndexOf("\n", start - 1) + 1 : start;
}

/**
 * `u` or `<C-r>`, `count` times, through the draft's history. The restored
 * prompt is written as every other change is, with the cursor at the start
 * of the changed text.
 */
function stepUndoHistory(
  current: NonNullable<typeof session>,
  step: (draftKey: string, prompt: string, cursor: number) => ComposerUndoStep | null,
): void {
  let prompt = current.prompt;
  let cursor = offsetOf(current.buffer.getContent(), context.cursor.line, context.cursor.col);
  let moved = false;
  for (let repeat = Math.max(1, context.count); repeat > 0; repeat -= 1) {
    const next = step(undoDraftKey(), prompt, cursor);
    if (next === null) break;
    ({ prompt, cursor } = next);
    moved = true;
  }
  context = { ...context, count: 0 };
  if (!moved || !adapter) return;
  const projection = projectPrompt(prompt);
  session = { projection, buffer: new ComposerTextBuffer(projection.text), prompt };
  context = { ...context, cursor: positionOf(projection.text, cursor) };
  adapter.write(prompt, cursor);
  paint(false);
}

/** Flash targets in the composer: matches inside the editor's visible box. */
const composerFlashProvider: FlashProvider = {
  scope: "composer",
  backdrop() {
    const editor = composerEditorElement();
    if (!editor) return [];
    const range = document.createRange();
    range.selectNodeContents(editor);
    return [range];
  },
  collect(pattern, caseSensitive) {
    const editor = composerEditorElement();
    const current = currentSession();
    if (!editor || !current) return [];
    const text = current.buffer.getContent();
    const bounds = editor.getBoundingClientRect();
    const cursorOffset = offsetOf(text, context.cursor.line, context.cursor.col);
    const targets: FlashTarget[] = [];
    for (const offset of findOccurrences(text, pattern, caseSensitive)) {
      const range = rangeAt(editor, offset, offset + pattern.length);
      if (!range) continue;
      const rect = range.getBoundingClientRect();
      if (rect.top < bounds.top || rect.bottom > bounds.bottom) continue;
      targets.push({
        id: String(offset),
        range,
        nextChar: text[offset + pattern.length],
        distance: Math.abs(offset - cursorOffset),
      });
    }
    return targets;
  },
  jump(target) {
    const current = currentSession();
    if (!current) return;
    const position = positionOf(current.buffer.getContent(), Number(target.id));
    context = { ...context, cursor: position };
    paint();
  },
};

/** The prompt as Vim sees it, one character per token; null with no composer. */
export function composerProjectedText(): string | null {
  return adapter ? projectPrompt(adapter.read().prompt).text : null;
}

/** The composer cursor's line, while in normal mode; null in insert mode. */
export function composerCursorLine(): number | null {
  return mode === "normal" ? context.cursor.line : null;
}

/** The normal-mode cursor's offset in the projected prompt; null in insert mode. */
export function composerNormalOffset(): number | null {
  if (mode !== "normal" || session === null) return null;
  return offsetOf(session.buffer.getContent(), context.cursor.line, context.cursor.col);
}

/**
 * Makes focus arriving in the composer resume normal mode at `offset` instead
 * of entering insert mode, until the next key or pointer press. For a surface
 * that hands focus back, such as the command palette closing: focus arrives
 * more than once as it closes (React restores the focus it saw before the
 * commit, then Lexical takes it back for its selection), so a single resume
 * after the first arrival would be undone by the next.
 */
export function resumeComposerNormalOnFocus(offset: number): void {
  pendingNormalOffset = offset;
}

/** Ends a resume `resumeComposerNormalOnFocus` armed: focus arriving enters insert mode again. */
export function cancelComposerNormalResume(): void {
  pendingNormalOffset = null;
}

/** The second Escape: out of the composer, into the chat buffer. */
function leaveForChat(): void {
  enterInsert();
  const editor = composerEditorElement();
  editor?.blur();
  // Body focus resolves to the chat pane (paneFocus's sticky last pane).
  chatSurface.reset();
}

export const composerSurface: KeySurface = {
  scope: "composer",
  mode: () => (mode === "insert" ? "insert" : isVisual() ? "visual" : "normal"),
  label(): EngineModeLabel {
    if (mode === "insert") return "INSERT";
    if (isFlashActive()) return "FLASH";
    if (context.mode === "visual") return "VISUAL";
    if (context.mode === "visual-line") return "V-LINE";
    return "NORMAL";
  },
  isPending: () =>
    mode === "normal" && (isFlashActive() || context.phase !== "idle" || context.count > 0),
  handleKey(token) {
    if (mode === "insert") {
      if (token !== "<Esc>" || isComposerMenuOpen()) return false;
      enterNormal();
      return true;
    }
    if (isFlashActive()) return handleFlashKey(token);
    return handleNormalKey(token);
  },
  runCommand(command) {
    if (command !== "flash.jump" || mode !== "normal") return false;
    startFlash(composerFlashProvider);
    return true;
  },
  reset() {
    pendingNormalOffset = null;
    if (mode !== "insert") enterInsert();
  },
};
