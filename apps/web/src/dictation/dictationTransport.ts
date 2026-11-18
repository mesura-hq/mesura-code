import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { uploadDictationRecording } from "@t3tools/client-runtime/dictation";
import type { DictationJobId, DictationStartInput, EnvironmentId } from "@t3tools/contracts";

import { getClientSettings } from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { attachmentEnvironment } from "~/state/attachments";
import { dictationEnvironment } from "~/state/dictation";
import { readPreparedConnection } from "~/state/session";
import type { DictationAudio } from "./recorder";

/** Uploads a recording through the environment's signed attachment route; returns its id. */
export function uploadDictationAudio(
  environmentId: EnvironmentId,
  audio: DictationAudio,
  jobId: DictationJobId,
): Promise<string> {
  return uploadDictationRecording({
    registry: appAtomRegistry,
    createUploadUrl: attachmentEnvironment.createUploadUrl,
    remove: attachmentEnvironment.remove,
    environmentId,
    jobId,
    mimeType: audio.mimeType,
    sizeBytes: audio.blob.size,
    resolveUploadUrl: (relativeUrl) => {
      const connection = readPreparedConnection(environmentId);
      return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
    },
    transport: (url) => {
      const controller = new AbortController();
      return {
        abort: () => controller.abort(),
        done: fetch(url, {
          method: "POST",
          headers: { "Content-Type": audio.mimeType },
          body: audio.blob,
          signal: controller.signal,
        }).then((response) => {
          if (!response.ok)
            throw new Error(`The server refused the recording (${response.status}).`);
        }),
      };
    },
  });
}

/**
 * Starts the server job for an uploaded recording, with this device's silence filtering
 * choice. Throws when the server refuses it.
 */
export async function startDictationTranscription(
  environmentId: EnvironmentId,
  input: Omit<DictationStartInput, "filterSilence">,
) {
  const result = await runAtomCommand(
    appAtomRegistry,
    dictationEnvironment.start,
    {
      environmentId,
      input: { ...input, filterSilence: getClientSettings().speechSilenceFiltering },
    },
    { reportFailure: false },
  );
  if (result._tag !== "Success") throw squashAtomCommandFailure(result);
  return result.value;
}
