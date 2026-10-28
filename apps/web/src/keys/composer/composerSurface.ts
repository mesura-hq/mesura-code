import { createInitialContext, processKeystroke, type VimContext } from "@vimee/core";
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";

import { collapseExpandedComposerCursor, expandCollapsedComposerCursor } from "~/composer-logic";
import {
  flatToMarkdown,
  flatToPm,
  markdownToFlat,
  pmToFlat,
  serializeEditorDoc,
} from "~/composer-rich-text-doc";

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
  atomCharacterEpoch,
  inlineNodesFor,
  isObjectCharacter,
  lineIndexAt,
  offsetAtPmPosition,
  pmPositionAt,
  pmRangesBetween,
  snapshotComposerDoc,
  type ComposerDocLine,
  type ComposerDocSnapshot,
} from "./composerDocument";
import { applyComposerTextChange } from "./composerEdits";
import { offsetOf, positionOf } from "./composerProjection";
import {
  ComposerTextBuffer,
  recordComposerUndoState,
  redoComposerChange,
  undoComposerChange,
  type ComposerUndoStep,
} from "./composerUndo";

/**
 * Normal mode runs `@vimee/core` over the shown text (`composerDocument.ts`) and edits through
 * editor transactions (`composerEdits.ts`); insert mode is the editor's. Offsets in this module's
 * API are the composer's collapsed cursor. The last registered composer is active; `u`/`<C-r>`
 * walk `composerUndo.ts`.
 */

export interface ComposerVimAdapter {
  /** The expanded prompt and the collapsed cursor. */
  read(): { prompt: string; cursor: number };
  /** Replaces the whole prompt and places the collapsed cursor; keeps focus. */
  write(prompt: string, cursor: number): void;
  /** Places the caret through the composer's focus path, including mobile expansion. */
  setCursor(cursor: number): void;
  /** The draft the composer is open on, which keys its undo history. */
  draftKey?(): string;
  /** The live editor; without one the composer has no normal mode. */
  editor(): Editor | null;
}

const OWNED_BY_KEYMAP = new Set(["s", "[", "]"]);
/** Keys that, with no operator pending, delete whole lines in visual-line mode. */
const LINE_DELETE_KEYS = new Set(["d", "x", "X", "D"]);

interface Session {
  readonly editor: Editor;
  readonly snapshot: ComposerDocSnapshot;
  readonly buffer: ComposerTextBuffer;
}

/** Mounted composers' adapters, oldest first; the last one is active. */
const adapters: ComposerVimAdapter[] = [];
let adapter: ComposerVimAdapter | null = null;
let mode: "insert" | "normal" = "insert";
let context: VimContext = createInitialContext({ line: 0, col: 0 });
let session: Session | null = null;
/** The editor whose transactions keep the normal-mode cursor and paint current. */
let watchedEditor: Editor | null = null;
/** True while this module dispatches its own edit, which it repaints itself. */
let applyingEdit = false;
/** An undo or redo written through the adapter: where the cursor lands once that prompt arrives. */
let pendingWrite: { readonly prompt: string; readonly cursor: number } | null = null;
let focusListenerInstalled = false;
/** Where the current insert session started typing, collapsed: the start of its undo step. */
let insertStartOffset: number | null = null;
/** Set by `resumeComposerNormalOnFocus`: where arriving focus resumes normal mode, collapsed. */
let pendingNormalOffset: number | null = null;
/** The surface the ring was drawn on, so it clears even once the editor is gone. */
let markedSurface: HTMLElement | null = null;

const COMPOSER_SURFACE_SELECTOR = "[data-chat-composer-main-surface]";
const COMPOSER_SURFACE_VIM_ATTRIBUTE = "data-mesura-composer-vim";

export function registerComposerVimAdapter(next: ComposerVimAdapter): () => void {
  adapters.push(next);
  adapter = next;
  installFocusListener();
  return () => {
    const index = adapters.indexOf(next);
    if (index !== -1) adapters.splice(index, 1);
    if (adapter !== next) return;
    adapter = adapters.at(-1) ?? null;
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

function activeEditor(): Editor | null {
  const editor = adapter?.editor() ?? null;
  return editor && !editor.isDestroyed ? editor : null;
}

/** An adapter that names no draft shares one history. */
function undoDraftKey(): string {
  return adapter?.draftKey?.() ?? "";
}

/** The prompt `snapshot` serializes to: the editor's own Markdown. */
function promptOf(snapshot: ComposerDocSnapshot): string {
  return serializeEditorDoc(snapshot.doc).value;
}

/** Records `prompt` as the draft's current state; `hint` is where its change started, collapsed. */
function recordUndoState(prompt: string, hint: number): void {
  if (adapter) recordComposerUndoState(undoDraftKey(), prompt, hint);
}

/** The composer's collapsed cursor for a buffer offset: the model the adapter and undo speak. */
function collapsedCursorOf(snapshot: ComposerDocSnapshot, offset: number): number {
  const map = serializeEditorDoc(snapshot.doc);
  const expanded = flatToMarkdown(map, pmToFlat(map, pmPositionAt(snapshot, offset)));
  return collapseExpandedComposerCursor(map.value, expanded);
}

function offsetOfCollapsedCursor(snapshot: ComposerDocSnapshot, cursor: number): number {
  const map = serializeEditorDoc(snapshot.doc);
  const expanded = expandCollapsedComposerCursor(map.value, cursor);
  return offsetAtPmPosition(snapshot, flatToPm(map, markdownToFlat(map, expanded)));
}

function isVisual(): boolean {
  return context.mode === "visual" || context.mode === "visual-line";
}

function currentOffset(): number {
  return session
    ? offsetOf(session.buffer.getContent(), context.cursor.line, context.cursor.col)
    : 0;
}

/** A fresh context at `position` that keeps the registers: a yank outlives an insert session. */
function contextAt(position: { line: number; col: number }): VimContext {
  return {
    ...createInitialContext(position),
    register: context.register,
    registers: context.registers,
  };
}

/** The atom table epoch the registers were filled under. */
let registersEpoch = atomCharacterEpoch();

/** Drops registers whose chip characters the atom table has since reassigned. */
function forgetStaleRegisters(): void {
  if (registersEpoch === atomCharacterEpoch()) return;
  registersEpoch = atomCharacterEpoch();
  context = { ...context, register: "", registers: {} };
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
  pendingWrite = null;
  context = contextAt({ line: 0, col: 0 });
  watchEditor(null);
  paintBlockCursor("mesura-composer-cursor", null, null);
  paintHighlight("mesura-composer-visual", []);
  markComposerVimMode(null);
  bumpComposerLayout();
}

/** Enters normal mode at the collapsed cursor `at`, or one back from the caret when leaving insert mode. */
function enterNormal(at?: number): void {
  const editor = activeEditor();
  if (!adapter || !editor) return;
  const snapshot = snapshotComposerDoc(editor.state.doc);
  session = { editor, snapshot, buffer: new ComposerTextBuffer(snapshot.text) };
  let offset: number;
  if (at === undefined) {
    // Leaving insert mode steps the cursor back one, as Vim does, never across a line start.
    const caret = offsetAtPmPosition(snapshot, editor.state.selection.from);
    const line = snapshot.lines[lineIndexAt(snapshot, caret)]!;
    offset = Math.max(line.start, caret - 1);
  } else {
    offset = offsetOfCollapsedCursor(snapshot, at);
  }
  context = contextAt(positionOf(snapshot.text, offset));
  recordUndoState(promptOf(snapshot), insertStartOffset ?? collapsedCursorOf(snapshot, offset));
  insertStartOffset = null;
  mode = "normal";
  watchEditor(editor);
  markComposerVimMode("normal");
  paint();
}

/** The session over the editor's current document, rebuilt when anything else changed it. */
function currentSession(): Session | null {
  const editor = activeEditor();
  if (!editor) return null;
  if (session === null || session.editor !== editor || session.snapshot.doc !== editor.state.doc) {
    const offset = currentOffset();
    const snapshot = snapshotComposerDoc(editor.state.doc);
    session = { editor, snapshot, buffer: new ComposerTextBuffer(snapshot.text) };
    context = {
      ...context,
      cursor: positionOf(snapshot.text, Math.min(offset, snapshot.text.length)),
    };
    watchEditor(editor);
  }
  return session;
}

/**
 * Keeps the paint on the DOM the editor has now. An edit from elsewhere (an undo write arriving,
 * a dictation fill, a cite) moves the cursor through the transaction's mapping, so the painted
 * ranges are never built on nodes the edit replaced.
 */
function onEditorTransaction({ transaction }: { transaction: Transaction }): void {
  if (applyingEdit || mode === "insert" || !session) return;
  // A selection change alone can redraw the editor's decorations and detach the painted ranges.
  if (!transaction.docChanged) {
    paint(false);
    return;
  }
  const editor = session.editor;
  const before = session.snapshot;
  const snapshot = snapshotComposerDoc(editor.state.doc);
  let offset = offsetAtPmPosition(
    snapshot,
    transaction.mapping.map(pmPositionAt(before, currentOffset())),
  );
  if (pendingWrite !== null && promptOf(snapshot) === pendingWrite.prompt) {
    offset = offsetOfCollapsedCursor(snapshot, pendingWrite.cursor);
    pendingWrite = null;
  }
  session = { editor, snapshot, buffer: new ComposerTextBuffer(snapshot.text) };
  context = { ...context, cursor: positionOf(snapshot.text, clampToCharacter(snapshot, offset)) };
  // The editor is mid-dispatch: paint now, move its selection with the next key.
  paint(false);
}

function watchEditor(editor: Editor | null): void {
  if (watchedEditor === editor) return;
  watchedEditor?.off("transaction", onEditorTransaction);
  watchedEditor = editor;
  watchedEditor?.on("transaction", onEditorTransaction);
}

/** A normal-mode cursor sits on a character: never past a non-empty line's last one. */
function clampToCharacter(snapshot: ComposerDocSnapshot, offset: number): number {
  const bounded = Math.max(0, Math.min(offset, snapshot.text.length));
  const line = snapshot.lines[lineIndexAt(snapshot, bounded)]!;
  return line.length > 0 ? Math.min(bounded, line.start + line.length - 1) : line.start;
}

/** A DOM range over `[from, to)` in ProseMirror positions, which never crosses a line. */
function domRange(editor: Editor, from: number, to: number): Range | null {
  const { view } = editor;
  const node = editor.state.doc.nodeAt(from);
  const range = document.createRange();
  if (node && !node.isText && to - from === 1) {
    const element = view.nodeDOM(from);
    if (!element) return null;
    range.selectNode(element);
    return range;
  }
  try {
    const start = view.domAtPos(from, 1);
    const end = view.domAtPos(to, -1);
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } catch {
    return null;
  }
  return range;
}

function ruleBox(editor: Editor, position: number): DOMRect | null {
  const element = editor.view.nodeDOM(position);
  return element instanceof HTMLElement ? element.getBoundingClientRect() : null;
}

/**
 * `syncCaret` is false while the editor is dispatching: its selection follows
 * the cursor on the next key instead.
 */
function paint(syncCaret = true): void {
  const current = session;
  if (!current || composerEditorElement() === null) return;
  const { editor, snapshot } = current;
  const text = current.buffer.getContent();
  const offset = offsetOf(text, context.cursor.line, context.cursor.col);
  const line = snapshot.lines[lineIndexAt(snapshot, offset)]!;
  const position = pmPositionAt(snapshot, offset);
  // First: a selection change redraws the editor's mark decorations, which would detach ranges.
  if (syncCaret) placeCaret(editor, position);
  const char = text[offset];
  if (line.kind === "rule" || char === undefined || char === "\n") {
    // Nothing to highlight under the cursor: draw the block as an element.
    const box = caretBox(editor, line, position);
    paintEmptyLineCursor(
      "mesura-composer-cursor",
      box ? { left: box.left, top: box.top, height: box.height } : null,
    );
  } else {
    // Drawn in the editor's host: the editor owns everything inside its content.
    paintBlockCursor(
      "mesura-composer-cursor",
      domRange(editor, position, position + 1),
      editor.view.dom.parentElement,
    );
  }
  paintHighlight("mesura-composer-visual", isVisual() ? visualRanges(current, offset) : []);
  bumpComposerLayout();
}

/**
 * Where a caret at `position` on `line` is drawn. An empty line that is its own block has no glyph
 * to measure, so its block's box is the line's box; a rule's box is its node's.
 */
function caretBox(
  editor: Editor,
  line: ComposerDocLine,
  position: number,
): { left: number; top: number; height: number } | null {
  if (line.kind === "rule") return ruleBox(editor, line.pmStart);
  if (line.length === 0 && line.wholeBlock) {
    const block = editor.view.nodeDOM(line.blockPos);
    if (block instanceof HTMLElement) return block.getBoundingClientRect();
  }
  try {
    const coords = editor.view.coordsAtPos(position);
    return { left: coords.left, top: coords.top, height: coords.bottom - coords.top };
  } catch {
    return null;
  }
}

function visualRanges(current: Session, offset: number): Range[] {
  if (!context.visualAnchor) return [];
  const text = current.buffer.getContent();
  const anchor = offsetOf(text, context.visualAnchor.line, context.visualAnchor.col);
  let [from, to] = anchor <= offset ? [anchor, offset + 1] : [offset, anchor + 1];
  if (context.mode === "visual-line") {
    from = text.lastIndexOf("\n", from - 1) + 1;
    const end = text.indexOf("\n", to - 1);
    to = end === -1 ? text.length : end;
  }
  return pmRangesBetween(current.snapshot, from, Math.min(text.length, to)).flatMap((span) => {
    const range = domRange(current.editor, span.from, span.to);
    return range ? [range] : [];
  });
}

/** Moves the editor's selection to the cursor, so `i` and a focus return start typing there. */
function placeCaret(editor: Editor, position: number): void {
  const { state } = editor;
  if (state.selection.empty && state.selection.from === position) return;
  const bounded = Math.max(0, Math.min(position, state.doc.content.size));
  editor.view.dispatch(
    state.tr
      .setSelection(TextSelection.near(state.doc.resolve(bounded)))
      .setMeta("addToHistory", false)
      .scrollIntoView(),
  );
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

/** Whether `token` completes a linewise delete: `dd`, `dj`, `dG`, or a delete in visual-line mode. */
function deletesWholeLines(token: string): boolean {
  if (context.mode === "visual-line") return LINE_DELETE_KEYS.has(token);
  return context.operator === "d" && ["d", "j", "k", "G"].includes(token);
}

/** The yank as Markdown, with each atom as its own source text: what a paste elsewhere expects. */
function clipboardText(editor: Editor, yanked: string): string {
  const { schema } = editor.state;
  const paragraphs = yanked
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => schema.nodes.paragraph!.create(null, inlineNodesFor(line, schema, [])));
  return serializeEditorDoc(schema.nodes.doc!.create(null, paragraphs)).value;
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

  const { editor } = current;
  const before = current.buffer.getContent();
  const beforeOffset = offsetOf(before, context.cursor.line, context.cursor.col);
  const selectionStart = visualSelectionStart(before);
  const linewise = deletesWholeLines(token);
  forgetStaleRegisters();
  const result = processKeystroke(key.key, context, current.buffer, key.ctrl, false);
  context = result.newCtx;
  const text = current.buffer.getContent();
  let offset = offsetOf(text, context.cursor.line, context.cursor.col);
  // Compared, not read from the actions: vimee does not report every edit
  // (`ciw`, a visual `d`) as a `content-change`.
  const changed = text !== before;
  if (changed) {
    const previousPrompt = promptOf(current.snapshot);
    recordUndoState(previousPrompt, collapsedCursorOf(current.snapshot, beforeOffset));
    applyingEdit = true;
    let snapshot: ComposerDocSnapshot;
    try {
      const start = Math.min(beforeOffset, selectionStart ?? beforeOffset);
      snapshot = applyComposerTextChange(editor, current.snapshot, text, {
        start: linewise ? before.lastIndexOf("\n", start - 1) + 1 : start,
        cursorAfter: offset,
        linewise,
      });
    } finally {
      applyingEdit = false;
    }
    // A structural edit (a deleted list item, a split block) can read back differently from
    // vimee's text; the document is the truth.
    if (snapshot.text !== text) offset = clampToCharacter(snapshot, offset);
    session = { editor, snapshot, buffer: new ComposerTextBuffer(snapshot.text) };
    context = { ...context, cursor: positionOf(snapshot.text, offset) };
    // An edit starts at the leftmost of the cursor before the key, the cursor
    // after it (a backward `dh`, `db`) and a visual selection's start. A
    // change that enters insert mode (`cw`) becomes one step with that insert
    // session.
    const changeStart = Math.min(beforeOffset, offset, selectionStart ?? beforeOffset);
    const changeHint = collapsedCursorOf(snapshot, Math.min(changeStart, snapshot.text.length));
    if (context.mode === "insert") insertStartOffset = changeHint;
    else recordUndoState(promptOf(snapshot), changeHint);
  } else {
    // Vim fills its register on deletes too; only a pure yank is a copy.
    const yank = result.actions.find((action) => action.type === "yank");
    if (yank?.type === "yank") {
      copyToClipboard(clipboardText(editor, yank.text));
      updateKeyEngineSnapshot({ notice: `yanked ${yank.text.length} characters` });
    }
  }

  if (context.mode === "insert") {
    mode = "insert";
    watchEditor(null);
    paintBlockCursor("mesura-composer-cursor", null, null);
    paintHighlight("mesura-composer-visual", []);
    markComposerVimMode(null);
    const snapshot = session!.snapshot;
    placeCaret(editor, pmPositionAt(snapshot, offset));
    if (!changed) insertStartOffset = collapsedCursorOf(snapshot, offset);
    session = null;
    return true;
  }
  markComposerVimMode(isVisual() ? "visual" : "normal");
  paint();
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
 * prompt is written through the composer, as a restored draft is; the cursor
 * lands at the start of the changed text once the editor holds it.
 */
function stepUndoHistory(
  current: Session,
  step: (draftKey: string, prompt: string, cursor: number) => ComposerUndoStep | null,
): void {
  let prompt = promptOf(current.snapshot);
  let cursor = collapsedCursorOf(current.snapshot, currentOffset());
  let moved = false;
  for (let repeat = Math.max(1, context.count); repeat > 0; repeat -= 1) {
    const next = step(undoDraftKey(), prompt, cursor);
    if (next === null) break;
    ({ prompt, cursor } = next);
    moved = true;
  }
  context = { ...context, count: 0 };
  if (!moved || !adapter) return;
  pendingWrite = { prompt, cursor };
  adapter.write(prompt, cursor);
}

/** A flash match never crosses a line or lands on a chip: neither has a letter to type. */
function spansLineOrObject(span: string): boolean {
  for (const char of span) if (char === "\n" || isObjectCharacter(char)) return true;
  return false;
}

/** Flash targets in the composer: matches of the shown text inside the editor's visible box. */
const composerFlashProvider: FlashProvider = {
  scope: "composer",
  backdrop() {
    const current = currentSession();
    if (!current) return [];
    return pmRangesBetween(current.snapshot, 0, current.snapshot.text.length).flatMap((span) => {
      const range = domRange(current.editor, span.from, span.to);
      return range ? [range] : [];
    });
  },
  collect(pattern, caseSensitive) {
    const editor = composerEditorElement();
    const current = currentSession();
    if (!editor || !current) return [];
    const { snapshot } = current;
    const text = snapshot.text;
    const bounds = editor.getBoundingClientRect();
    const from = currentOffset();
    const targets: FlashTarget[] = [];
    for (const offset of findOccurrences(text, pattern, caseSensitive)) {
      const end = offset + pattern.length;
      if (spansLineOrObject(text.slice(offset, end))) continue;
      const range = domRange(
        current.editor,
        pmPositionAt(snapshot, offset),
        pmPositionAt(snapshot, end),
      );
      if (!range) continue;
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 || rect.top < bounds.top || rect.bottom > bounds.bottom) continue;
      targets.push({
        id: String(offset),
        range,
        nextChar: text[end],
        distance: Math.abs(offset - from),
      });
    }
    return targets;
  },
  jump(target) {
    const current = currentSession();
    if (!current) return;
    context = { ...context, cursor: positionOf(current.buffer.getContent(), Number(target.id)) };
    paint();
  },
};

/**
 * Where each logical line starts on screen, for the expanded composer's
 * gutter: one entry per line Vim moves by, never a fence or a marker.
 */
export function composerGutterLines(): Array<{
  readonly index: number;
  readonly top: number;
}> | null {
  const editor = activeEditor();
  if (!editor) return null;
  const snapshot =
    mode === "normal" && session ? session.snapshot : snapshotComposerDoc(editor.state.doc);
  return snapshot.lines.flatMap((line, index) => {
    const box = caretBox(editor, line, line.pmStart);
    return box ? [{ index, top: box.top }] : [];
  });
}

/** The composer cursor's line, while in normal mode; null in insert mode. */
export function composerCursorLine(): number | null {
  return mode === "normal" ? context.cursor.line : null;
}

/** The normal-mode cursor as the composer's collapsed cursor; null in insert mode. */
export function composerNormalOffset(): number | null {
  if (mode !== "normal" || session === null) return null;
  return collapsedCursorOf(session.snapshot, currentOffset());
}

/**
 * Holds until the next key or pointer press, not for one focus: a closing surface such as the
 * command palette hands focus back more than once (React restores it, then the editor takes it
 * for its selection), so a one-shot resume would be undone by the second arrival.
 */
export function resumeComposerNormalOnFocus(offset: number): void {
  pendingNormalOffset = offset;
}

/** Restores NORMAL through the mounted composer, which owns visibility and caret placement. */
export function restoreComposerNormalFocus(offset: number): boolean {
  if (adapter === null || composerEditorElement() === null) return false;
  resumeComposerNormalOnFocus(offset);
  adapter.setCursor(offset);
  return true;
}

/**
 * Captures a modal's composer origin before blur clears its NORMAL session.
 * `focusAt` defaults to the active composer's own focus path, which writes the
 * caret as it focuses; a bare DOM focus leaves it at the start for a moment.
 */
export function captureComposerFocusReturn(
  origin: Element | null,
  focusAt: (cursor: number) => void = (cursor) => adapter?.setCursor(cursor),
): (() => boolean) | null {
  const editor = composerEditorElement();
  if (adapter === null || editor === null || !editor.contains(origin)) return null;
  const { prompt, cursor } = adapter.read();
  const draftKey = adapter.draftKey?.();
  const normalOffset = composerSurface.label() === "NORMAL" ? composerNormalOffset() : null;
  return () => {
    // The same editor can render another thread. Do not restore a stale caret
    // or NORMAL receipt into that draft, or into a draft changed while away.
    if (
      adapter === null ||
      !editor.isConnected ||
      composerEditorElement() !== editor ||
      adapter.draftKey?.() !== draftKey ||
      adapter.read().prompt !== prompt
    )
      return false;
    if (normalOffset !== null) resumeComposerNormalOnFocus(normalOffset);
    else cancelComposerNormalResume();
    focusAt(cursor);
    return true;
  };
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
    if (isFlashActive("composer")) return handleFlashKey(token);
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
