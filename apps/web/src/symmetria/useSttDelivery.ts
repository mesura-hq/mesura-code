/**
 * Receives dictation pushed in from Symmetria Shell and hands it to a composer.
 *
 * The caller supplies the writer, which is why this resolves nothing. Resolving
 * a target inside an asynchronous pipeline is what sent transcripts to the wrong
 * conversation three separate times in the shell's own history; here the
 * component that knows which conversation is on screen builds the writer, and
 * the question cannot arise.
 *
 * Deliberately thin. Everything decidable lives in `sttDelivery.ts`, which is a
 * pure function and is where the tests are.
 */
import { useEffect } from "react";

import { deliverDictation, type ComposerWriter } from "./sttDelivery";

/** `null` means no conversation is on screen, which is a delivery outcome. */
export function useSttDelivery(writer: ComposerWriter | null): void {
  useEffect(() => {
    const bridge = window.desktopBridge;
    const subscribe = bridge?.onSttDelivery;
    const answer = bridge?.resolveSttDelivery;
    // Absent on web and on older desktop builds; dictation is simply not
    // available there and the shell falls back to its clipboard path.
    if (typeof subscribe !== "function" || typeof answer !== "function") return;

    return subscribe((delivery) => {
      const outcome = deliverDictation(writer, { text: delivery.text, submit: delivery.submit });
      answer(delivery.requestId, outcome.kind);
    });
  }, [writer]);
}
