import { splitPromptIntoComposerSegments } from "~/composer-editor-mentions";

/**
 * The prompt in the composer's collapsed-cursor model (`composer-logic.ts`): every inline token is
 * ONE private-use character, so an offset here is a collapsed cursor. Undo locates changes in it;
 * Vim itself reads the editor's document (`composerDocument.ts`).
 */

const TOKEN_BASE = 0xe000;

export interface ComposerProjection {
  readonly text: string;
  /** The prompt source of each token, by its private-use character. */
  readonly tokens: ReadonlyMap<string, string>;
}

export function projectPrompt(prompt: string): ComposerProjection {
  const tokens = new Map<string, string>();
  let text = "";
  let expanded = 0;
  for (const segment of splitPromptIntoComposerSegments(prompt)) {
    if (segment.type === "text") {
      text += segment.text;
      expanded += segment.text.length;
      continue;
    }
    const length = segment.type === "skill" ? segment.name.length + 1 : segment.source.length;
    const marker = String.fromCharCode(TOKEN_BASE + tokens.size);
    tokens.set(marker, prompt.slice(expanded, expanded + length));
    text += marker;
    expanded += length;
  }
  return { text, tokens };
}

/** Offset into the projection for a Vim line/column. */
export function offsetOf(text: string, line: number, col: number): number {
  let offset = 0;
  for (let index = 0; index < line; index += 1) {
    const next = text.indexOf("\n", offset);
    if (next === -1) return text.length;
    offset = next + 1;
  }
  return Math.min(text.length, offset + col);
}

export function positionOf(text: string, offset: number): { line: number; col: number } {
  const before = text.slice(0, offset);
  const line = before.split("\n").length - 1;
  return { line, col: offset - (before.lastIndexOf("\n") + 1) };
}
