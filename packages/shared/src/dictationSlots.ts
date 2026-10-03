import { DICTATION_CONTEXT_KIND, type DictationJobId } from "@t3tools/contracts";

import {
  collectComposerContextReferences,
  formatComposerContextReference,
} from "./composerContextReferences.ts";

/**
 * A dictation slot is a pending transcription held in the prompt text as an ordinary context
 * link, `[Transcribing](t3-context://v1/dictation/<jobId>)`, so a draft that is not mounted
 * (another thread, another device) can still be filled when its transcript arrives. The link
 * never has a context record; code that walks context links must skip this kind.
 */

const DICTATION_SLOT_LABEL = "Transcribing";
const VOICED_PREFIX = "[voiced] ";
const NO_SPACE_BEFORE = /[\s.,;:!?)]/;
const WHITESPACE = /\s/;

export interface DictationSlotOccurrence {
  jobId: string;
  source: string;
  start: number;
  end: number;
}

export function isDictationContextKind(kind: string): boolean {
  return kind === DICTATION_CONTEXT_KIND;
}

/** Takes a decoded `DictationJobId`, whose grammar guarantees the link parses back. */
export function formatDictationSlot(jobId: DictationJobId): string {
  return formatComposerContextReference({
    kind: DICTATION_CONTEXT_KIND,
    contextId: jobId,
    label: DICTATION_SLOT_LABEL,
  });
}

export function findDictationSlots(text: string): DictationSlotOccurrence[] {
  return collectComposerContextReferences(text)
    .filter((occurrence) => isDictationContextKind(occurrence.kind))
    .map(({ contextId, source, start, end }) => ({ jobId: contextId, source, start, end }));
}

function isWordBoundary(previous: string | undefined, next: string | undefined): boolean {
  return (
    previous === undefined ||
    next === undefined ||
    WHITESPACE.test(previous) ||
    NO_SPACE_BEFORE.test(next)
  );
}

/**
 * One replacement in the coordinates of the text it was computed from. A fill or a removal is
 * a list of these that never overlap, so a caret can be carried through each one.
 */
export interface DictationSlotEdit {
  start: number;
  end: number;
  replacement: string;
}

/** Applies non-overlapping edits given in the original text's coordinates. */
export function applyDictationSlotEdits(
  text: string,
  edits: ReadonlyArray<DictationSlotEdit>,
): string {
  return [...edits]
    .sort((left, right) => right.start - left.start)
    .reduce(
      (current, edit) =>
        `${current.slice(0, edit.start)}${edit.replacement}${current.slice(edit.end)}`,
      text,
    );
}

/**
 * Removes slots right to left, deleting one neighbouring space with each and keeping the words
 * around it apart. Each removal sits left of the ones already made, so its range is also a range
 * in the original text.
 */
function slotRemovalEdits(
  text: string,
  slots: ReadonlyArray<DictationSlotOccurrence>,
): { text: string; edits: DictationSlotEdit[] } {
  const edits: DictationSlotEdit[] = [];
  let current = text;
  for (let index = slots.length - 1; index >= 0; index -= 1) {
    let { start, end } = slots[index]!;
    if (current[end] === " ") end += 1;
    else if (current[start - 1] === " ") start -= 1;
    const replacement = isWordBoundary(current[start - 1], current[end]) ? "" : " ";
    edits.push({ start, end, replacement });
    current = `${current.slice(0, start)}${replacement}${current.slice(end)}`;
  }
  return { text: current, edits };
}

/**
 * The edits that replace the slot for `jobId` with its transcript, adding a space only where a
 * neighbouring word would otherwise join it. A copied slot for the same job is removed, so the
 * filled job no longer counts as pending. `null` means the user deleted the slot.
 */
export function fillDictationSlotEdits(
  text: string,
  jobId: string,
  transcript: string,
): DictationSlotEdit[] | null {
  const [slot, ...copies] = findDictationSlots(text).filter(
    (candidate) => candidate.jobId === jobId,
  );
  if (!slot) return null;
  // Copies sit after the first slot, so removing them leaves its offsets valid.
  const withoutCopies = slotRemovalEdits(text, copies);
  const previous = withoutCopies.text[slot.start - 1];
  const next = withoutCopies.text[slot.end];
  const leading = previous !== undefined && !WHITESPACE.test(previous) ? " " : "";
  const trailing = next !== undefined && !NO_SPACE_BEFORE.test(next) ? " " : "";
  return [
    { start: slot.start, end: slot.end, replacement: `${leading}${transcript}${trailing}` },
    ...withoutCopies.edits,
  ];
}

/** Replaces the slot for `jobId` with its transcript. `missing` means the user deleted it. */
export function fillDictationSlot(
  text: string,
  jobId: string,
  transcript: string,
): { text: string } | { missing: true } {
  const edits = fillDictationSlotEdits(text, jobId, transcript);
  return edits === null ? { missing: true } : { text: applyDictationSlotEdits(text, edits) };
}

/** Deletes every slot for `jobId`, with one neighbouring space. `missing` when none is left. */
export function removeDictationSlot(
  text: string,
  jobId: string,
): { text: string } | { missing: true } {
  const slots = findDictationSlots(text).filter((candidate) => candidate.jobId === jobId);
  if (slots.length === 0) return { missing: true };
  return { text: slotRemovalEdits(text, slots).text };
}

export function countPendingDictationSlots(text: string): number {
  return findDictationSlots(text).length;
}

/** One `[voiced] ` tag per sent message, however many slots were filled into it. */
export function withVoicedPrefix(text: string, voiced: boolean): string {
  if (!voiced || text.startsWith(VOICED_PREFIX)) return text;
  return `${VOICED_PREFIX}${text}`;
}
