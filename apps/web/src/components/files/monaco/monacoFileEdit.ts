/** A replacement of one span of the old text, in character offsets. */
export interface MinimalTextEdit {
  readonly startOffset: number;
  /** Exclusive, and an offset into the text being replaced. */
  readonly endOffset: number;
  readonly text: string;
}

/**
 * The smallest single replacement that turns `before` into `after`, so positions outside the
 * changed span (the caret above all) keep their place; a whole-range replace moves them. One span,
 * not a real diff: two distant edits yield one span covering both.
 */
export function minimalTextEdit(before: string, after: string): MinimalTextEdit | null {
  if (before === after) return null;

  const maxPrefix = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < maxPrefix && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1;
  // Never split a surrogate pair: half of one is not a character, and writing
  // it back would corrupt an emoji into a replacement glyph.
  if (prefix > 0 && isHighSurrogate(before.charCodeAt(prefix - 1))) prefix -= 1;

  const maxSuffix = Math.min(before.length - prefix, after.length - prefix);
  let suffix = 0;
  while (
    suffix < maxSuffix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  if (suffix > 0 && isLowSurrogate(before.charCodeAt(before.length - suffix))) suffix -= 1;

  return {
    startOffset: prefix,
    endOffset: before.length - suffix,
    text: after.slice(prefix, after.length - suffix),
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
