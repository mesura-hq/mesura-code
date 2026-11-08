import type { ProviderReplayTranscript } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

import { buildCodexInitializeParams } from "../../provider/CodexProvider.ts";

/** Materializes current application metadata in expectations without changing replay matching. */
export function materializeCodexReplayClientMetadata(
  transcript: ProviderReplayTranscript,
): ProviderReplayTranscript {
  if (transcript.provider !== "codex" || transcript.protocol !== "codex.app-server") {
    return transcript;
  }
  const currentClientInfo = buildCodexInitializeParams().clientInfo;
  return {
    ...transcript,
    entries: transcript.entries.map((entry) => {
      if (entry.type !== "expect_outbound") return entry;
      const frame = entry.frame;
      if (!Predicate.isObject(frame) || frame.method !== "initialize") return entry;
      const params = frame.params;
      if (!Predicate.isObject(params) || !Predicate.isObject(params.clientInfo)) return entry;
      const clientInfo = params.clientInfo;
      if (typeof clientInfo.title !== "string" || typeof clientInfo.version !== "string") {
        return entry;
      }
      // Keep the recorded client identifier and capabilities so protocol changes still fail.
      return {
        ...entry,
        frame: {
          ...frame,
          params: {
            ...params,
            clientInfo: {
              ...clientInfo,
              title: currentClientInfo.title,
              version: currentClientInfo.version,
            },
          },
        },
      };
    }),
  };
}
