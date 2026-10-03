import { applyDictationSlotEdits, fillDictationSlotEdits } from "@t3tools/shared/dictationSlots";

/** Appends a marker at the end of a draft, one space after any text already there. */
export function appendDictationSlot(prompt: string, slot: string): string {
  if (prompt.length === 0) return slot;
  return /\s$/.test(prompt) ? `${prompt}${slot}` : `${prompt} ${slot}`;
}

/**
 * Fills the marker for `jobId` and carries an expanded caret offset through every edit the fill
 * makes: an edit wholly before the caret shifts it by its change in length, an edit after it
 * leaves it alone, and a caret inside a replaced range lands at that range's end. This is what
 * keeps the caret where the user is typing when a transcript lands in the composer on screen,
 * including when a copied marker on the other side of the caret is removed at the same time.
 */
export function fillDictationSlotKeepingCaret(
  prompt: string,
  expandedCursor: number,
  jobId: string,
  transcript: string,
): { text: string; expandedCursor: number } | { missing: true } {
  const edits = fillDictationSlotEdits(prompt, jobId, transcript);
  if (edits === null) return { missing: true };
  let caret = expandedCursor;
  for (const edit of edits) {
    if (edit.end <= expandedCursor) {
      caret += edit.replacement.length - (edit.end - edit.start);
    } else if (edit.start < expandedCursor) {
      caret += edit.start + edit.replacement.length - expandedCursor;
    }
  }
  const text = applyDictationSlotEdits(prompt, edits);
  return { text, expandedCursor: Math.max(0, Math.min(text.length, caret)) };
}
