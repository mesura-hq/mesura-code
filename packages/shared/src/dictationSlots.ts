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

/** Deletes a copied slot and one neighbouring space, keeping the words around it apart. */
function removeDictationSlotAt(text: string, slot: DictationSlotOccurrence): string {
  let { start, end } = slot;
  if (text[end] === " ") end += 1;
  else if (text[start - 1] === " ") start -= 1;
  const separator = isWordBoundary(text[start - 1], text[end]) ? "" : " ";
  return `${text.slice(0, start)}${separator}${text.slice(end)}`;
}

/**
 * Replaces the slot for `jobId` with its transcript, adding a space only where a neighbouring
 * word would otherwise join it. A copied slot for the same job is removed, so the filled job
 * no longer counts as pending. `missing` means the user deleted the slot.
 */
export function fillDictationSlot(
  text: string,
  jobId: string,
  transcript: string,
): { text: string } | { missing: true } {
  const [slot, ...copies] = findDictationSlots(text).filter(
    (candidate) => candidate.jobId === jobId,
  );
  if (!slot) return { missing: true };
  // Copies sit after the first slot; removing them from the end keeps every offset valid.
  const withoutCopies = copies.reduceRight(removeDictationSlotAt, text);
  const previous = withoutCopies[slot.start - 1];
  const next = withoutCopies[slot.end];
  const leading = previous !== undefined && !WHITESPACE.test(previous) ? " " : "";
  const trailing = next !== undefined && !NO_SPACE_BEFORE.test(next) ? " " : "";
  return {
    text: `${withoutCopies.slice(0, slot.start)}${leading}${transcript}${trailing}${withoutCopies.slice(slot.end)}`,
  };
}

export function countPendingDictationSlots(text: string): number {
  return findDictationSlots(text).length;
}

/** One `[voiced] ` tag per sent message, however many slots were filled into it. */
export function withVoicedPrefix(text: string, voiced: boolean): string {
  if (!voiced || text.startsWith(VOICED_PREFIX)) return text;
  return `${VOICED_PREFIX}${text}`;
}
