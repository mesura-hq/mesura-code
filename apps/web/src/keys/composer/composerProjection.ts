import { splitPromptIntoComposerSegments } from "~/composer-editor-mentions";

/**
 * The prompt as Vim sees it: plain text where every inline token (mention,
 * citation, skill, context reference) is ONE private-use character.
 *
 * One character per token is the composer's own "collapsed cursor" model
 * (`composer-logic.ts`), so a collapsed offset here is a composer cursor with
 * no conversion. Each token gets its own code point, so a token deleted from
 * the middle can never hand its identity to the token after it when the text
 * is expanded back.
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

export function expandProjection(text: string, tokens: ReadonlyMap<string, string>): string {
  let prompt = "";
  for (const char of text) prompt += tokens.get(char) ?? char;
  return prompt;
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

/**
 * Lexical writes a line break as a plain `<br>`, and ends a paragraph whose
 * last line is empty with one more `<br>` that holds the line open but is not
 * a character. That trailing one is skipped.
 */
function isPlaceholderBreak(br: HTMLBRElement): boolean {
  if (br.nextSibling !== null) return false;
  const previous = br.previousSibling;
  return previous === null || previous.nodeName === "BR";
}

/**
 * The DOM point for a collapsed offset inside the Lexical editor. Text nodes
 * count their length, a non-editable chip counts one, a line-break `<br>`
 * counts one, and each paragraph after the first starts after one line break.
 */
export function domPointAt(
  editor: HTMLElement,
  offset: number,
): { node: Node; offset: number } | null {
  let remaining = offset;
  let last: { node: Node; offset: number } | null = null;
  const paragraphs = [...editor.children];
  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index]!;
    if (index > 0) {
      if (remaining === 0) return { node: paragraph, offset: 0 };
      remaining -= 1;
    }
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_ALL, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (parent && parent !== paragraph && parent.closest('[contenteditable="false"]')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) {
        const length = (node as Text).length;
        if (remaining <= length) return { node, offset: remaining };
        remaining -= length;
        last = { node, offset: length };
      } else if (node instanceof HTMLElement && node.getAttribute("contenteditable") === "false") {
        const parent = node.parentNode!;
        const at = [...parent.childNodes].indexOf(node);
        if (remaining === 0) return { node: parent, offset: at };
        remaining -= 1;
        last = { node: parent, offset: at + 1 };
      } else if (node instanceof HTMLBRElement && !isPlaceholderBreak(node)) {
        const parent = node.parentNode!;
        const at = [...parent.childNodes].indexOf(node);
        if (remaining === 0) return { node: parent, offset: at };
        remaining -= 1;
        last = { node: parent, offset: at + 1 };
      }
    }
  }
  return last;
}

/**
 * The box of the caret at an offset, for a cursor that has no character to
 * highlight (an empty line, the end of a line) and for the line gutter.
 */
export function caretRectAt(editor: HTMLElement, offset: number): DOMRect | null {
  const point = domPointAt(editor, offset);
  if (!point) return null;
  const range = document.createRange();
  range.setStart(point.node, point.offset);
  range.collapse(true);
  const rect = range.getClientRects()[0];
  if (rect && rect.height > 0) return rect;
  // A caret before a `<br>` or in an empty paragraph has no box of its own.
  const element =
    point.node.nodeType === Node.ELEMENT_NODE
      ? ((point.node.childNodes[point.offset] as Element | undefined) ?? (point.node as Element))
      : point.node.parentElement;
  const box = element?.getBoundingClientRect();
  if (!box) return null;
  const lineHeight = Number.parseFloat(getComputedStyle(editor).lineHeight) || 20;
  return new DOMRect(box.left, box.top, 0, lineHeight);
}
