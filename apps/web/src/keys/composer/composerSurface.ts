import { TextBuffer, createInitialContext, processKeystroke, type VimContext } from "@vimee/core";

import type { KeySurface } from "../keyEngine";
import { updateKeyEngineSnapshot, type EngineModeLabel } from "../keyEngineStore";
import { composerEditorElement, isComposerMenuOpen } from "../focusScope";
import { paintHighlight } from "../highlights";
import { chatSurface } from "../chat/chatSurface";
import { copyToClipboard } from "../clipboard";
import { setCursorOverlay } from "../cursorOverlayStore";
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
 * Known prototype limits: `u` undoes within one normal-mode session only,
 * because typing in insert mode goes to Lexical's history, not Vim's.
 */

export interface ComposerVimAdapter {
  /** The expanded prompt and the collapsed cursor. */
  read(): { prompt: string; cursor: number };
  /** Replaces the whole prompt and places the collapsed cursor; keeps focus. */
  write(prompt: string, cursor: number): void;
  setCursor(cursor: number): void;
}

const OWNED_BY_KEYMAP = new Set(["s", "[", "]"]);

let adapter: ComposerVimAdapter | null = null;
let mode: "insert" | "normal" = "insert";
let context: VimContext = createInitialContext({ line: 0, col: 0 });
let session: { projection: ComposerProjection; buffer: TextBuffer; prompt: string } | null = null;
let focusListenerInstalled = false;
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

/** Focus arriving from outside the composer always lands in insert mode. */
function installFocusListener(): void {
  if (focusListenerInstalled) return;
  focusListenerInstalled = true;
  window.addEventListener(
    "focusin",
    (event) => {
      const editor = composerEditorElement();
      if (!editor || !(event.target instanceof Node) || !editor.contains(event.target)) return;
      if (event.relatedTarget instanceof Node && editor.contains(event.relatedTarget)) return;
      enterInsert();
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

function isVisual(): boolean {
  return context.mode === "visual" || context.mode === "visual-line";
}

function enterInsert(): void {
  mode = "insert";
  session = null;
  context = createInitialContext({ line: 0, col: 0 });
  paintHighlight("mesura-composer-cursor", []);
  paintHighlight("mesura-composer-visual", []);
  setCursorOverlay(null);
  markComposerVimMode(null);
  bumpComposerLayout();
}

function enterNormal(): void {
  if (!adapter) return;
  const { prompt, cursor } = adapter.read();
  const projection = projectPrompt(prompt);
  session = { projection, buffer: new TextBuffer(projection.text), prompt };
  // Leaving insert mode steps the cursor back one, as Vim does.
  const offset = Math.max(0, cursor - 1);
  const position = positionOf(projection.text, Math.min(offset, projection.text.length));
  context = createInitialContext(position);
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
    session = { projection, buffer: new TextBuffer(projection.text), prompt };
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
    paintHighlight("mesura-composer-cursor", []);
    const rect = caretRectAt(editor, offset);
    setCursorOverlay(rect ? { left: rect.left, top: rect.top, height: rect.height } : null);
  } else {
    setCursorOverlay(null);
    const cursorRange = rangeAt(editor, offset, offset + 1);
    paintHighlight("mesura-composer-cursor", cursorRange ? [cursorRange] : []);
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
  const key = vimKey(token);
  if (key === null) return false;

  const before = current.buffer.getContent();
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
    paintHighlight("mesura-composer-cursor", []);
    paintHighlight("mesura-composer-visual", []);
    setCursorOverlay(null);
    markComposerVimMode(null);
    if (!changed) adapter.setCursor(offset);
    session = null;
    return true;
  }
  markComposerVimMode(isVisual() ? "visual" : "normal");
  paint(!changed);
  return true;
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
    if (mode !== "insert") enterInsert();
  },
};
