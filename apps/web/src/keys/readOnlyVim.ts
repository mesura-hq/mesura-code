import { processKeystroke, type TextBuffer, type VimAction, type VimContext } from "@vimee/core";

import type { EngineModeLabel } from "./keyEngineStore";

/** A line and a column into a read-only Vim buffer. */
export interface BufferPosition {
  readonly line: number;
  readonly col: number;
}

const ARROW_TO_VIM: Readonly<Record<string, string>> = {
  "<Left>": "h",
  "<Right>": "l",
  "<Up>": "k",
  "<Down>": "j",
};

/** The `@vimee/core` key for a key engine token. */
export function vimKey(token: string): { key: string; ctrl: boolean } {
  if (ARROW_TO_VIM[token]) return { key: ARROW_TO_VIM[token]!, ctrl: false };
  if (token === "<Esc>") return { key: "Escape", ctrl: false };
  if (token === "<CR>") return { key: "Enter", ctrl: false };
  if (token === "<BS>") return { key: "Backspace", ctrl: false };
  const ctrl = /^<C-(.)>$/.exec(token);
  if (ctrl) return { key: ctrl[1]!, ctrl: true };
  return { key: token, ctrl: false };
}

export function isVisualContext(context: VimContext): boolean {
  return context.mode === "visual" || context.mode === "visual-line";
}

/** One key of a read-only Vim: a key that would enter insert mode never leaves normal. */
export function stepReadOnlyVim(
  token: string,
  context: VimContext,
  text: TextBuffer,
): { context: VimContext; actions: readonly VimAction[] } {
  const { key, ctrl } = vimKey(token);
  const result = processKeystroke(key, context, text, ctrl, true);
  let next = result.newCtx;
  if (next.mode === "insert" || next.mode === "command-line") {
    next = processKeystroke("Escape", next, text, false, true).newCtx;
  }
  return { context: next, actions: result.actions };
}

/** The text a visual selection covers, end exclusive; null outside visual mode. */
export function visualBounds(
  context: VimContext,
  lines: readonly string[],
): { from: BufferPosition; to: BufferPosition } | null {
  if (!isVisualContext(context) || context.visualAnchor === null) return null;
  const anchor = context.visualAnchor;
  const head = context.cursor;
  const forward = anchor.line < head.line || (anchor.line === head.line && anchor.col <= head.col);
  const [from, to] = forward ? [anchor, head] : [head, anchor];
  return context.mode === "visual-line"
    ? { from: { line: from.line, col: 0 }, to: { line: to.line, col: lines[to.line]?.length ?? 0 } }
    : { from, to: { line: to.line, col: to.col + 1 } };
}

export function vimModeLabel(context: VimContext): EngineModeLabel {
  if (context.mode === "visual") return "VISUAL";
  if (context.mode === "visual-line") return "V-LINE";
  return "NORMAL";
}
