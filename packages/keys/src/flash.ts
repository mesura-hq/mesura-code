/**
 * Flash label assignment, after flash.nvim's `labeler.lua`.
 *
 * The user types a search pattern; every match gets a label. Each further key
 * is either a label (jump) or more pattern (narrow). That is unambiguous
 * because a label is never a character that could continue the pattern at any
 * match: those characters are removed from the label set first.
 *
 * Labels stay stable while the user types: a match keeps the label it had on
 * the previous keystroke when that label is still allowed.
 */

const DEFAULT_FLASH_LABELS = "asdfghjklqwertyuiopzxcvbnm";

export interface FlashMatch {
  readonly id: string;
  /** The character right after the match, the one that would continue the pattern. */
  readonly nextChar: string | undefined;
  /** Distance from the cursor; nearer matches get the earlier labels. */
  readonly distance: number;
}

export function assignFlashLabels(
  matches: readonly FlashMatch[],
  previous: ReadonlyMap<string, string> = new Map(),
  labels: string = DEFAULT_FLASH_LABELS,
): Map<string, string> {
  const excluded = new Set<string>();
  for (const match of matches) {
    if (match.nextChar !== undefined) excluded.add(match.nextChar.toLowerCase());
  }
  const available = [...labels].filter((label) => !excluded.has(label));
  const free = new Set(available);
  const assigned = new Map<string, string>();
  const ordered = matches.toSorted((left, right) => left.distance - right.distance);

  for (const match of ordered) {
    const label = previous.get(match.id);
    if (label !== undefined && free.has(label)) {
      assigned.set(match.id, label);
      free.delete(label);
    }
  }
  const remaining = available.filter((label) => free.has(label));
  for (const match of ordered) {
    if (assigned.has(match.id)) continue;
    const label = remaining.shift();
    if (label === undefined) break;
    assigned.set(match.id, label);
  }
  return assigned;
}

/**
 * Labels for a jump with no search pattern, after hop.nvim: every target is
 * labelled up front, so no character is reserved for narrowing.
 *
 * Targets come nearest first. While they fit, each gets one character. Past
 * that, the last characters of the set become prefixes: the nearest targets
 * keep one-character labels and the farthest get two, the prefix then one
 * more character. Returns one label per target, in order; targets beyond
 * what two characters can label get none.
 */
export function assignJumpLabels(count: number, labels: string = DEFAULT_FLASH_LABELS): string[] {
  const alphabet = [...labels];
  if (count <= alphabet.length) return alphabet.slice(0, count);
  const prefixCount = Math.min(
    alphabet.length,
    Math.ceil((count - alphabet.length) / (alphabet.length - 1)),
  );
  const singles = alphabet.slice(0, alphabet.length - prefixCount);
  const assigned = [...singles];
  for (const prefix of alphabet.slice(alphabet.length - prefixCount)) {
    for (const second of alphabet) {
      if (assigned.length === count) return assigned;
      assigned.push(prefix + second);
    }
  }
  return assigned;
}
