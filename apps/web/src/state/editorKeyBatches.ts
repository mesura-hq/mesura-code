/**
 * Cutting typed keys into `editorSession.input` batches.
 *
 * Pure, beside the lane in `editorSession.ts` that uses it, so the one rule
 * that is easy to get wrong is held by a unit test: a batch is cut between
 * keys, never inside one. Neovim reads `<Es` followed by `c>` as five
 * letters, not as Escape.
 */

/** The contract's bound on `editorSession.input`'s `keys`. */
export const EDITOR_INPUT_KEYS_LIMIT = 1024;

/** One key in Neovim notation (`<C-w>`, `<lt>`), or one character. */
const KEY_PATTERN = /<[^<>]+>|[\s\S]/gu;

/**
 * Splits one `sendKeys` string into pieces no longer than `limit`.
 *
 * Most strings are one key and come back whole. Composed text from an input
 * method can run longer than the bound, and is cut at key boundaries.
 */
export function splitKeysToLimit(keys: string, limit = EDITOR_INPUT_KEYS_LIMIT): string[] {
  if (keys.length <= limit) return [keys];
  const pieces: string[] = [];
  let current = "";
  for (const key of keys.match(KEY_PATTERN) ?? []) {
    if (current.length + key.length > limit && current !== "") {
      pieces.push(current);
      current = "";
    }
    current += key;
  }
  if (current !== "") pieces.push(current);
  return pieces;
}

/**
 * How many of `units` (each no longer than `limit`) fit in one batch, from the
 * front, in order. Always at least one, so a batch is never empty.
 */
export function batchLength(units: ReadonlyArray<string>, limit = EDITOR_INPUT_KEYS_LIMIT): number {
  let length = 0;
  let count = 0;
  for (const unit of units) {
    if (count > 0 && length + unit.length > limit) break;
    length += unit.length;
    count += 1;
  }
  return count;
}
