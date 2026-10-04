import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { uploadDictationRecording } from "@t3tools/client-runtime/dictation";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  DictationJobId,
  DictationMode,
  DictationTarget,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

import { appAtomRegistry } from "./atom-registry";
import { attachmentEnvironment } from "./attachments";
import { dictationEnvironment } from "./dictationEnvironment";
import { environmentSession } from "./session";

/** A finished phone recording, as the recorder left it on disk. */
export interface DictationRecordingFile {
  readonly uri: string;
  readonly durationMs: number;
  readonly mimeType: string;
}

/** Uploads the recording as an attachment and returns its attachment id. */
export async function uploadDictationAudio(
  environmentId: EnvironmentId,
  jobId: DictationJobId,
  recording: DictationRecordingFile,
): Promise<string> {
  const { File, UploadType } = await import("expo-file-system");
  const file = new File(recording.uri);
  return uploadDictationRecording({
    registry: appAtomRegistry,
    createUploadUrl: attachmentEnvironment.createUploadUrl,
    remove: attachmentEnvironment.remove,
    environmentId,
    jobId,
    mimeType: recording.mimeType,
    sizeBytes: file.size,
    // Read the connection at transfer time: it may have reconnected on a new base URL.
    resolveUploadUrl: (relativeUrl) => {
      const connection = appAtomRegistry.get(
        environmentSession.preparedConnectionValueAtom(environmentId),
      );
      return Option.isNone(connection)
        ? null
        : resolveAssetUrl(connection.value.httpBaseUrl, relativeUrl);
    },
    transport: (url) => {
      const controller = new AbortController();
      return {
        abort: () => controller.abort(),
        done: file
          .upload(url, {
            httpMethod: "POST",
            uploadType: UploadType.BINARY_CONTENT,
            headers: { "Content-Type": recording.mimeType },
            signal: controller.signal,
          })
          .then((result) => {
            if (result.status < 200 || result.status >= 300) {
              throw new Error(`The server refused the recording (${result.status}).`);
            }
          }),
      };
    },
  });
}

/** Starts the server transcription job for an uploaded recording. */
export async function startDictationJob(
  environmentId: EnvironmentId,
  input: {
    readonly jobId: DictationJobId;
    readonly attachmentId: string;
    readonly durationMs: number;
    readonly mode: DictationMode;
    readonly target: DictationTarget;
  },
): Promise<void> {
  const result = await runAtomCommand(
    appAtomRegistry,
    dictationEnvironment.start,
    { environmentId, input },
    { reportFailure: false },
  );
  if (result._tag !== "Success") throw squashAtomCommandFailure(result);
}

/** Asks the server to transcribe a job it already holds once more. */
export async function retryDictationJobOnServer(
  environmentId: EnvironmentId,
  jobId: DictationJobId,
): Promise<void> {
  const result = await runAtomCommand(
    appAtomRegistry,
    dictationEnvironment.retry,
    { environmentId, input: { jobId } },
    { reportFailure: false },
  );
  if (result._tag !== "Success") throw squashAtomCommandFailure(result);
}
