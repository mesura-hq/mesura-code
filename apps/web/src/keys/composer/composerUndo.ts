import { TextBuffer, type CursorPosition } from "@vimee/core";

import { projectPrompt } from "./composerProjection";

/**
 * Vim's undo for the composer: one history of prompt states per draft.
 *
 * vimee keeps its undo stack in the buffer of one normal-mode session, and
 * typing in insert mode goes to Lexical, so neither sees the whole edit
 * history of a draft. This history does: `composerSurface.ts` records the
 * prompt when an insert session starts, when normal mode is entered (so one
 * insert session is one step), and after every normal-mode change. A state
 * is the expanded prompt, so every inline token comes back as the same
 * source text.
 *
 * The history lives in memory only, for the most recent drafts. A send starts
 * a fresh one: every send path consumes the draft through the draft store's
 * `clearComposerContent`, which calls `clearComposerUndoHistory`.
 */

const MAX_DRAFTS = 50;
const MAX_STATES_PER_DRAFT = 200;

interface UndoState {
  readonly prompt: string;
  /**
   * Where the change from the previous state into this one starts, as a
   * collapsed offset valid in both: undo and redo of that change put the
   * cursor here. Fixed when the state is recorded, so moving around, an
   * empty insert session or a focus change never moves it.
   */
  readonly changeStart: number;
}

interface DraftHistory {
  readonly states: UndoState[];
  index: number;
}

export interface ComposerUndoStep {
  readonly prompt: string;
  /** The collapsed cursor: the start of the changed text. */
  readonly cursor: number;
}

/** In insertion order, so the first key is the least recently used draft. */
const histories = new Map<string, DraftHistory>();
/** The histories of drafts a send consumed, until a failed send restores the draft. */
const consumedHistories = new Map<string, DraftHistory>();

function setBounded(map: Map<string, DraftHistory>, draftKey: string, history: DraftHistory) {
  map.delete(draftKey);
  map.set(draftKey, history);
  for (const key of map.keys()) {
    if (map.size <= MAX_DRAFTS) break;
    map.delete(key);
  }
}

function freshHistory(prompt: string): DraftHistory {
  return { states: [{ prompt, changeStart: 0 }], index: 0 };
}

function currentPrompt(history: DraftHistory): string {
  return history.states[history.index]!.prompt;
}

function isPristine(history: DraftHistory | undefined): boolean {
  return history === undefined || (history.states.length === 1 && currentPrompt(history) === "");
}

/**
 * The draft's history, most recently used. A draft that a send consumed and a
 * failed send put back, word for word, gets its history from before the send.
 */
function historyFor(draftKey: string, prompt: string): DraftHistory {
  const live = histories.get(draftKey);
  const consumed = consumedHistories.get(draftKey);
  let history = live ?? freshHistory(prompt);
  if (consumed && prompt !== "" && isPristine(live) && currentPrompt(consumed) === prompt) {
    consumedHistories.delete(draftKey);
    history = consumed;
  }
  setBounded(histories, draftKey, history);
  return history;
}

/**
 * Makes `prompt` the draft's current state. Text changed since the last state
 * becomes a new step, which drops the redo steps; `hint` is the cursor the
 * change started from. Unchanged text records nothing.
 */
export function recordComposerUndoState(draftKey: string, prompt: string, hint: number): void {
  const history = historyFor(draftKey, prompt);
  const previous = currentPrompt(history);
  if (previous === prompt) return;
  const changeStart = resolveChangeStart(previous, prompt, hint);
  history.states.splice(history.index + 1, history.states.length, { prompt, changeStart });
  if (history.states.length > MAX_STATES_PER_DRAFT) history.states.shift();
  history.index = history.states.length - 1;
}

/** Steps back one state; null at the oldest. Text changed elsewhere is recorded first. */
export function undoComposerChange(
  draftKey: string,
  prompt: string,
  cursor: number,
): ComposerUndoStep | null {
  recordComposerUndoState(draftKey, prompt, cursor);
  const history = histories.get(draftKey)!;
  if (history.index === 0) return null;
  const undone = history.states[history.index]!;
  history.index -= 1;
  return stepTo(history.states[history.index]!.prompt, undone.changeStart);
}

/** Steps forward one state; null at the newest. */
export function redoComposerChange(
  draftKey: string,
  prompt: string,
  cursor: number,
): ComposerUndoStep | null {
  recordComposerUndoState(draftKey, prompt, cursor);
  const history = histories.get(draftKey)!;
  if (history.index === history.states.length - 1) return null;
  history.index += 1;
  const redone = history.states[history.index]!;
  return stepTo(redone.prompt, redone.changeStart);
}

/** A normal-mode cursor sits on a character, so never past the last one. */
function stepTo(prompt: string, changeStart: number): ComposerUndoStep {
  const length = projectPrompt(prompt).text.length;
  return { prompt, cursor: Math.max(0, Math.min(changeStart, length - 1)) };
}

/**
 * Starts a fresh history for a draft a send consumed, holding `prompt`, the
 * text it consumed. The old history is kept aside: a failed send that puts
 * the same text back gets it again (`historyFor`).
 */
export function clearComposerUndoHistory(draftKey: string, prompt: string): void {
  const live = histories.get(draftKey);
  if (live) {
    recordComposerUndoState(draftKey, prompt, projectPrompt(prompt).text.length);
    if (!isPristine(live)) setBounded(consumedHistories, draftKey, live);
  }
  setBounded(histories, draftKey, freshHistory(""));
}

/**
 * The session buffer vimee edits in normal mode. It records no snapshots:
 * `u` and `<C-r>` use the draft's history, so vimee's own stack would only
 * grow with every change and never be read.
 */
export class ComposerTextBuffer extends TextBuffer {
  override saveUndoPoint(_cursor: CursorPosition): void {}
}

/** The projected prompt as one source string per character: a token is its whole source. */
function projectedPieces(prompt: string): string[] {
  const { text, tokens } = projectPrompt(prompt);
  return Array.from(
    { length: text.length },
    (_, index) => tokens.get(text[index]!) ?? text[index]!,
  );
}

/**
 * Where the change from `before` to `after` starts, as a collapsed offset
 * valid in both. A pure insertion or deletion can sit at several offsets with
 * the same result ("two " or "wo t" out of "one two three"); `hint`, the
 * cursor the change started from, picks among them.
 */
function resolveChangeStart(before: string, after: string, hint: number): number {
  const beforePieces = projectedPieces(before);
  const afterPieces = projectedPieces(after);
  let prefix = 0;
  while (
    prefix < beforePieces.length &&
    prefix < afterPieces.length &&
    beforePieces[prefix] === afterPieces[prefix]
  ) {
    prefix += 1;
  }
  let earliest = prefix;
  const [longer, shorter] =
    beforePieces.length >= afterPieces.length
      ? [beforePieces, afterPieces]
      : [afterPieces, beforePieces];
  const lengthDifference = longer.length - shorter.length;
  const isPureInsertOrDelete =
    lengthDifference > 0 &&
    longer
      .slice(prefix + lengthDifference)
      .every((piece, index) => piece === shorter[prefix + index]);
  if (isPureInsertOrDelete) {
    while (earliest > 0 && longer[earliest - 1] === longer[earliest - 1 + lengthDifference]) {
      earliest -= 1;
    }
  }
  return Math.min(prefix, Math.max(earliest, hint));
}
