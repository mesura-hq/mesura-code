import { dictatedMessageText } from "@t3tools/client-runtime/dictation";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./atom-registry";

/**
 * Per-draft dictation state, keyed by composer draft key:
 * - armed: the draft sends itself once its last marker fills;
 * - voiced: a transcript was filled into it since its last send, which earns the message one
 *   `[voiced] ` tag;
 * - generation: bumped each time the draft is sent or emptied. A job remembers the generation
 *   it dropped its marker in, so a completion from before a clear cannot arm or send the draft
 *   that replaced it.
 * All three live in memory; the draft's text, which holds the markers, is what persists.
 */
const armedDraftsAtom = Atom.make<Readonly<Record<string, true>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:dictation-armed-drafts"),
);
const voicedDrafts = new Set<string>();
const generations = new Map<string, number>();

export function armDictationDraft(draftKey: string): void {
  if (isDictationDraftArmed(draftKey)) return;
  appAtomRegistry.set(armedDraftsAtom, {
    ...appAtomRegistry.get(armedDraftsAtom),
    [draftKey]: true,
  });
}

export function disarmDictationDraft(draftKey: string): void {
  if (!isDictationDraftArmed(draftKey)) return;
  const next = { ...appAtomRegistry.get(armedDraftsAtom) };
  delete next[draftKey];
  appAtomRegistry.set(armedDraftsAtom, next);
}

export function isDictationDraftArmed(draftKey: string): boolean {
  return appAtomRegistry.get(armedDraftsAtom)[draftKey] === true;
}

/** Whether the draft on screen sends itself when its last marker fills, for its banner. */
export function useDictationDraftArmed(draftKey: string | null): boolean {
  const armed = useAtomValue(armedDraftsAtom);
  return draftKey !== null && armed[draftKey] === true;
}

export function markDictationDraftVoiced(draftKey: string): void {
  voicedDrafts.add(draftKey);
}

export function isDictationDraftVoiced(draftKey: string): boolean {
  return voicedDrafts.has(draftKey);
}

export function dictationDraftGeneration(draftKey: string): number {
  return generations.get(draftKey) ?? 0;
}

/** Draft keys holding any dictation state, so a clear can be noticed. */
export function draftsWithDictationState(): ReadonlyArray<string> {
  return [...new Set([...Object.keys(appAtomRegistry.get(armedDraftsAtom)), ...voicedDrafts])];
}

/** The draft was sent or emptied: its next message starts a new, unarmed and unvoiced generation. */
export function forgetDictationDraft(draftKey: string): void {
  disarmDictationDraft(draftKey);
  voicedDrafts.delete(draftKey);
  generations.set(draftKey, dictationDraftGeneration(draftKey) + 1);
}

/** A message built from a draft, with one `[voiced] ` tag when a transcript was filled into it. */
export function withDictatedMessageText<T extends { readonly text: string }>(
  draftKey: string,
  message: T,
): T {
  return isDictationDraftVoiced(draftKey)
    ? { ...message, text: dictatedMessageText(message.text, true) }
    : message;
}

/** Drops all of it, as a process restart does. */
export function forgetAllDictationDrafts(): void {
  appAtomRegistry.set(armedDraftsAtom, {});
  voicedDrafts.clear();
  generations.clear();
}
