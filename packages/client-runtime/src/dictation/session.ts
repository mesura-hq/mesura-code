import type { DictationJob, DictationJobId, DictationMode } from "@t3tools/contracts";
import { countPendingDictationSlots, withVoicedPrefix } from "@t3tools/shared/dictationSlots";

/**
 * The dictation decisions web and mobile share: how a recording's mode cycles, whether a host
 * can transcribe at all, when an armed draft sends, how a dictated message is prefixed, which
 * completed jobs a client still has to deliver, and the order a stopped recording goes through.
 * Each client keeps only its own storage and transport around these.
 */

/** A recording starts in send mode: the draft goes out once its last marker fills. */
export const DEFAULT_DICTATION_MODE: DictationMode = "submit";

/** Save, then insert, then send, then save again. */
export function nextDictationMode(mode: DictationMode): DictationMode {
  if (mode === "clipboard") return "inject";
  if (mode === "inject") return "submit";
  return "clipboard";
}

/** The host transcribes only with a key; a client sees the redaction marker, never the key. */
export function hostHasDictationKey(
  config: { readonly settings: { readonly dictation: { readonly openAiApiKey: string } } } | null,
): boolean {
  return (config?.settings.dictation.openAiApiKey ?? "").length > 0;
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

/** Hands out each completed job of this client once, however often the job list repeats it. */
export function createDictationDeliveryLedger(): {
  readonly take: (
    jobs: ReadonlyArray<DictationJob>,
    isOwn: (jobId: string) => boolean,
  ) => ReadonlyArray<DictationJob>;
} {
  const delivered = new Set<string>();
  return {
    take: (jobs, isOwn) => {
      const taken = jobs.filter(
        (job) => job.status === "completed" && !delivered.has(job.id) && isOwn(job.id),
      );
      for (const job of taken) delivered.add(job.id);
      return taken;
    },
  };
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
