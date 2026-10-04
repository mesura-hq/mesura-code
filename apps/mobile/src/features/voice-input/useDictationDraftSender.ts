import { countPendingDictationSlots } from "@t3tools/shared/dictationSlots";
import { useEffect, useRef, useState } from "react";

import { registerDictationDraftSender } from "../../state/dictation";

/**
 * Lets an armed new-task draft send itself while its screen is mounted: the screen is what knows
 * the project, model and workspace to start the thread with. The send runs after the render that
 * shows the filled text, so the screen's own send reads the transcript, not the marker.
 */
export function useDictationDraftSender(
  draftKey: string | null,
  prompt: string,
  send: () => void,
): void {
  const [requested, setRequested] = useState(0);
  const handledRef = useRef(0);
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    if (!draftKey) return;
    return registerDictationDraftSender(draftKey, () => setRequested((count) => count + 1));
  }, [draftKey]);

  useEffect(() => {
    if (requested === handledRef.current || countPendingDictationSlots(prompt) > 0) return;
    handledRef.current = requested;
    sendRef.current();
  }, [prompt, requested]);
}
