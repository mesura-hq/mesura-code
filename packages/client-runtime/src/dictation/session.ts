import type { DictationJobId, DictationMode } from "@t3tools/contracts";
import { countPendingDictationSlots, withVoicedPrefix } from "@t3tools/shared/dictationSlots";

/**
 * The platform-free dictation decisions: how a recording's mode cycles, when an armed draft
 * sends, how a dictated message is prefixed, and the order a stopped recording goes through.
 * The client keeps only its own storage and transport around these.
 */

/** A recording starts in send mode: the draft goes out once its last marker fills. */
export const DEFAULT_DICTATION_MODE: DictationMode = "submit";

/** Save, then insert, then send, then save again. */
export function nextDictationMode(mode: DictationMode): DictationMode {
  if (mode === "clipboard") return "inject";
  if (mode === "inject") return "submit";
  return "clipboard";
}

/**
 * What an armed draft does after a change: `send` once no marker remains, `wait` while one does
 * or while it is not armed, and `forget` its send state once it was emptied (sent or cleared),
 * so its next message starts unvoiced. The marker count in the text decides, not the job list,
 * so a fill, a discard and a marker the user deleted all count.
 */
export function armedDraftSendDecision(input: {
  readonly armed: boolean;
  readonly prompt: string;
  readonly hasAttachments: boolean;
}): "send" | "wait" | "forget" {
  if (input.prompt.trim() === "" && !input.hasAttachments) return "forget";
  if (!input.armed || countPendingDictationSlots(input.prompt) > 0) return "wait";
  return "send";
}

/** The text a dictated draft is sent as: trimmed, with one `[voiced] ` tag when it was voiced. */
export function dictatedMessageText(prompt: string, voiced: boolean): string {
  const trimmed = prompt.trim();
  return trimmed === "" ? "" : withVoicedPrefix(trimmed, voiced);
}

/**
 * A stopped recording, in order: the marker drops where the caret was (none in save mode), a
 * send-mode recording arms its draft, then the audio is finished, uploaded and the server job
 * started. Any failure after the marker leaves the marker in place and reports the job failed,
 * so an armed draft never sends without its transcript.
 */
export async function runDictationStop<Audio>(input: {
  readonly jobId: DictationJobId;
  readonly mode: DictationMode;
  readonly placeMarker: (jobId: DictationJobId) => void;
  readonly armSend: () => void;
  readonly finishRecording: () => Promise<Audio>;
  readonly upload: (jobId: DictationJobId, audio: Audio) => Promise<string>;
  readonly start: (jobId: DictationJobId, attachmentId: string) => Promise<void>;
  readonly onFailed: (jobId: DictationJobId, cause: unknown) => void;
}): Promise<"started" | "failed"> {
  const { jobId } = input;
  if (input.mode !== "clipboard") input.placeMarker(jobId);
  if (input.mode === "submit") input.armSend();
  try {
    const audio = await input.finishRecording();
    const attachmentId = await input.upload(jobId, audio);
    await input.start(jobId, attachmentId);
    return "started";
  } catch (cause) {
    input.onFailed(jobId, cause);
    return "failed";
  }
}
