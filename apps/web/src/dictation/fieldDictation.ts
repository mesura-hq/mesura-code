import { DictationJobId, type DictationJob, type EnvironmentId } from "@t3tools/contracts";
import { insertDictationSlotAt } from "@t3tools/shared/dictationSlots";
import { create } from "zustand";

import { toastManager } from "~/components/ui/toast";
import { openTranscriptionsList } from "~/components/dictation/TranscriptionsList";
import { randomUUID } from "~/lib/utils";
import { claimMicrophone, microphoneBlocker } from "../voice/microphoneClaim";
import { startDictationTranscription, uploadDictationAudio } from "./dictationTransport";
import {
  DICTATION_MAX_RECORDING_MS,
  openDictationRecording,
  type DictationRecording,
} from "./recorder";
import { guardRecordingScreen, warnRecordingMayBeSilent } from "./recordingScreen";

/**
 * Mesura dictation for a plain comment editor: record, transcribe, insert at the caret. No marker:
 * a transcript waits in its editor's pending list and in Transcriptions, so it still lands after
 * the editor reopens. One recording at a time, shared with the composer through the claim.
 */

interface FieldRecording {
  readonly ownerKey: string;
  readonly environmentId: EnvironmentId;
  readonly startedAt: number;
}

interface FieldDictationState {
  readonly recording: FieldRecording | null;
  /** Jobs whose text an editor still has to insert, by the editor's owner key. */
  readonly pending: Readonly<Record<string, ReadonlyArray<DictationJobId>>>;
}

export const useFieldDictationStore = create<FieldDictationState>(() => ({
  recording: null,
  pending: {},
}));

let activeRecording: DictationRecording | null = null;
let releaseMicrophone: (() => void) | null = null;
let releaseScreen: (() => void) | null = null;
let limitTimer: ReturnType<typeof setTimeout> | null = null;

function reportError(title: string, cause?: unknown) {
  toastManager.add({
    type: "error",
    title,
    ...(cause === undefined
      ? {}
      : { description: cause instanceof Error ? cause.message : String(cause) }),
  });
}

function endRecording(): DictationRecording | null {
  const recording = activeRecording;
  activeRecording = null;
  if (limitTimer !== null) clearTimeout(limitTimer);
  limitTimer = null;
  releaseScreen?.();
  releaseScreen = null;
  releaseMicrophone?.();
  releaseMicrophone = null;
  useFieldDictationStore.setState({ recording: null });
  return recording;
}

export async function startFieldDictation(
  ownerKey: string,
  environmentId: EnvironmentId,
): Promise<void> {
  if (useFieldDictationStore.getState().recording !== null) return;
  const claim = claimMicrophone("field");
  if (!claim) {
    const blocker = microphoneBlocker("field");
    if (blocker !== null) reportError(blocker);
    return;
  }
  releaseMicrophone = claim;
  try {
    activeRecording = await openDictationRecording();
  } catch (cause) {
    endRecording();
    reportError("Could not open the microphone", cause);
    return;
  }
  const startedAt = Date.now();
  const recordingId = randomUUID();
  useFieldDictationStore.setState({ recording: { ownerKey, environmentId, startedAt } });
  releaseScreen = guardRecordingScreen({
    isCapturing: () => activeRecording !== null,
    onMicrophoneMayHaveStopped: (hiddenMs) => warnRecordingMayBeSilent(recordingId, hiddenMs),
  }).release;
  limitTimer = setTimeout(() => void stopFieldDictation(), DICTATION_MAX_RECORDING_MS);
}

export function cancelFieldDictation(): void {
  endRecording()?.discard();
}

/** Stops the recording, then uploads it and starts its job; the editor inserts the text. */
export async function stopFieldDictation(): Promise<void> {
  const current = useFieldDictationStore.getState().recording;
  const recording = endRecording();
  if (!current || !recording) return;
  const jobId = DictationJobId.make(randomUUID());
  const durationMs = Date.now() - current.startedAt;
  addPending(current.ownerKey, jobId);
  try {
    const audio = await recording.stop();
    const attachmentId = await uploadDictationAudio(current.environmentId, audio, jobId);
    await startDictationTranscription(current.environmentId, {
      jobId,
      attachmentId,
      durationMs,
      mode: "inject",
      target: null,
    });
  } catch (cause) {
    removePending(current.ownerKey, jobId);
    reportError("Dictation could not be sent for transcription", cause);
  }
}

function addPending(ownerKey: string, jobId: DictationJobId) {
  useFieldDictationStore.setState((state) => ({
    pending: { ...state.pending, [ownerKey]: [...(state.pending[ownerKey] ?? []), jobId] },
  }));
}

function removePending(ownerKey: string, jobId: DictationJobId) {
  useFieldDictationStore.setState((state) => {
    const rest = (state.pending[ownerKey] ?? []).filter((id) => id !== jobId);
    const { [ownerKey]: _removed, ...others } = state.pending;
    return { pending: rest.length > 0 ? { ...others, [ownerKey]: rest } : others };
  });
}

/** `transcript` at `caret`, one space from any text on either side, and the caret after it. */
export function insertTranscriptAtCaret(
  text: string,
  caret: number,
  transcript: string,
): { readonly text: string; readonly caret: number } {
  const at = Math.max(0, Math.min(text.length, caret));
  const next = insertDictationSlotAt(text, at, transcript);
  return { text: next, caret: next.indexOf(transcript, at) + transcript.length };
}

const failedNoticeShown = new Set<string>();
/** Jobs a list has shown: only those can be judged gone when a later list lacks them. */
const listedJobs = new Set<string>();

/**
 * Delivers one editor's finished jobs from the environment's job list: a completed job's text
 * goes in through `insert`; a failure is announced once and stays pending, so a retry from the
 * Transcriptions list still lands here. A job the server no longer lists is dropped.
 */
export function deliverFieldDictationJobs(input: {
  readonly ownerKey: string;
  readonly environmentId: EnvironmentId;
  readonly jobs: ReadonlyArray<DictationJob>;
  readonly insert: (transcript: string) => void;
}): void {
  for (const jobId of useFieldDictationStore.getState().pending[input.ownerKey] ?? []) {
    const job = input.jobs.find((candidate) => candidate.id === jobId);
    if (!job) {
      // Not listed yet while it uploads; gone once a list that showed it lacks it.
      if (listedJobs.delete(jobId)) removePending(input.ownerKey, jobId);
      continue;
    }
    listedJobs.add(jobId);
    if (job.status === "transcribing") {
      failedNoticeShown.delete(jobId);
      continue;
    }
    if (job.status === "failed") {
      if (failedNoticeShown.has(jobId)) continue;
      failedNoticeShown.add(jobId);
      const toastId = toastManager.add({
        type: "error",
        title: "Transcription failed",
        description: `${job.failure ?? "The transcription failed."} Retry it from Transcriptions.`,
        actionProps: {
          children: "Show",
          onClick: () => {
            toastManager.close(toastId);
            openTranscriptionsList(input.environmentId);
          },
        },
      });
      continue;
    }
    removePending(input.ownerKey, jobId);
    failedNoticeShown.delete(jobId);
    listedJobs.delete(jobId);
    if (job.text) input.insert(job.text);
  }
}
