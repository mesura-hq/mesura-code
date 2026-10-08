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
