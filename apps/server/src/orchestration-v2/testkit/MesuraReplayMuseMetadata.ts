import type { ProviderReplayTranscript } from "@t3tools/contracts";
import { museInitializeParams } from "@t3tools/provider-muse/testing";
import * as Predicate from "effect/Predicate";

const recordedRuntimeInfoPrefix =
  "<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness";

/** Materializes application display names while retaining recorded MSP protocol expectations. */
export function materializeMuseReplayApplicationMetadata(
  transcript: ProviderReplayTranscript,
): ProviderReplayTranscript {
  if (transcript.provider !== "muse" || transcript.protocol !== "muse.msp-jsonl") {
    return transcript;
  }
  const currentTitle = museInitializeParams().clientInfo.title;
  const currentRuntimeInfoPrefix = recordedRuntimeInfoPrefix.replace("T3 Code", currentTitle);
  return {
    ...transcript,
    entries: transcript.entries.map((entry) => {
      if (entry.type !== "expect_outbound") return entry;
      const frame = entry.frame;
      if (!Predicate.isObject(frame)) return entry;
      const params = frame.params;
      if (!Predicate.isObject(params)) return entry;
      if (frame.method === "turn/start" && Array.isArray(params.input)) {
        const firstPart: unknown = params.input[0];
        if (
          !Predicate.isObject(firstPart) ||
          firstPart.type !== "text" ||
          typeof firstPart.text !== "string" ||
          !firstPart.text.startsWith(recordedRuntimeInfoPrefix) ||
          ![",", "."].includes(firstPart.text.charAt(recordedRuntimeInfoPrefix.length))
        ) {
          return entry;
        }
        // The adapter puts its runtime context first. Keep user input and the
        // remaining instructions exact; a broader replacement would hide drift.
        return {
          ...entry,
          frame: {
            ...frame,
            params: {
              ...params,
              input: [
                {
                  ...firstPart,
                  text:
                    currentRuntimeInfoPrefix +
                    firstPart.text.slice(recordedRuntimeInfoPrefix.length),
                },
                ...params.input.slice(1),
              ],
            },
          },
        };
      }
      if (frame.method !== "initialize" || !Predicate.isObject(params.clientInfo)) return entry;
      if (typeof params.clientInfo.title !== "string") return entry;
      return {
        ...entry,
        frame: {
          ...frame,
          params: {
            ...params,
            clientInfo: { ...params.clientInfo, title: currentTitle },
          },
        },
      };
    }),
  };
}
