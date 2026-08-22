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
  /**
   * Starts the turn, and resolves to whether it actually dispatched. Takes the
   * text because the submission path validates the prompt before dispatching,
   * so the writer must not have to read it back out of the store it just wrote.
   *
   * Asynchronous because sending is. An earlier version was synchronous and
   * discarded the send's promise, which reported every failed send as a
   * successful one and left the rejection unhandled.
   */
  readonly submit: (text: string) => Promise<boolean>;
};

export type SttDeliveryRequest = {
  readonly text: string;
  readonly submit: boolean;
};

export type SttDeliveryOutcome =
  | { readonly kind: "placed" }
  | { readonly kind: "placed-and-submitted" }
  | { readonly kind: "placed-not-submitted" }
  | { readonly kind: "no-conversation" };

/**
 * `writer` is null when no conversation is on screen.
 *
 * Placing and submitting fail independently, and collapsing them would lose the
 * case that matters most: text placed but not sent. The operator has to know
 * the words are sitting in the composer, because the shell keeps no clipboard
 * copy in socket mode.
 */
export async function deliverDictation(
  writer: ComposerWriter | null,
  request: SttDeliveryRequest,
): Promise<SttDeliveryOutcome> {
  if (writer === null) {
    return { kind: "no-conversation" };
  }

  // Place first, always. Submitting before the text is in the composer would
  // send an empty turn, which is worse than not sending at all.
  writer.placePrompt(request.text);
  if (!request.submit) {
    return { kind: "placed" };
  }

  // A writer that throws is breaking its own contract, and this catch is here
  // anyway: the shell keeps no clipboard copy, so a thrown send must come back
  // as "the words are in the composer" rather than as a rejection that reaches
  // nobody and leaves the operator with no receipt at all.
  try {
    return (await writer.submit(request.text))
      ? { kind: "placed-and-submitted" }
      : { kind: "placed-not-submitted" };
  } catch {
    return { kind: "placed-not-submitted" };
  }
}
