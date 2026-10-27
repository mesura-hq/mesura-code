import { applyDictationSlotEdits, fillDictationSlotEdits } from "@t3tools/shared/dictationSlots";

// Shared with mobile; re-exported so web callers keep their import path.
export { appendDictationSlot, insertDictationSlotAt } from "@t3tools/shared/dictationSlots";

/**
 * Fills the marker for `jobId` and carries an expanded caret offset through every edit: an edit
 * before the caret shifts it, one after leaves it, and a caret inside a replaced range lands at
 * its end. This keeps the caret where the user types when a transcript lands on screen.
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
