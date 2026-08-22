/**
 * Where a dictation lands once it has crossed into the window.
 *
 * A pure function rather than a hook, for two reasons. This repository has no
 * `renderHook` anywhere, so a hook would not be testable in its own idiom. And
 * AGENTS.md's taste rule puts complexity at the boundary and keeps the UI dumb:
 * the hook that calls this supplies a writer and decides nothing.
 *
 * The writer is supplied rather than imported so the caller — which is mounted
 * where the conversation on screen is already known — resolves the target. That
 * is deliberate: resolving a target inside an asynchronous pipeline is what sent
 * transcripts to the wrong conversation three times in the shell's own history.
 */

/** The composer of one conversation, as much of it as delivery needs. */
export type ComposerWriter = {
  readonly placePrompt: (text: string) => void;
  readonly submit: () => void;
};

export type SttDeliveryRequest = {
  readonly text: string;
  readonly submit: boolean;
};

export type SttDeliveryOutcome = { readonly kind: "placed" } | { readonly kind: "no-conversation" };

/**
 * `writer` is null when no conversation is on screen. Submitting is not wired
 * yet — the request's flag is read but has no effect, which is the boundary of
 * this phase.
 */
export function deliverDictation(
  writer: ComposerWriter | null,
  request: SttDeliveryRequest,
): SttDeliveryOutcome {
  if (writer === null) {
    return { kind: "no-conversation" };
  }

  writer.placePrompt(request.text);
  return { kind: "placed" };
}
