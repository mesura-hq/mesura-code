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
  /** `opening` while the browser asks for the microphone. */
  readonly phase: "opening" | "recording";
  readonly startedAt: number;
}

interface FieldDictationState {
  readonly recording: FieldRecording | null;
  /** Jobs whose text an editor still has to insert, by the editor's owner key. */
  readonly pending: Readonly<Record<string, ReadonlyArray<DictationJobId>>>;
  /** Pending jobs whose last attempt failed: they wait for a retry and hold no submission. */
  readonly failed: ReadonlySet<string>;
  /** Editors whose submission waits for their transcripts. */
  readonly submitQueued: ReadonlySet<string>;
}

export const useFieldDictationStore = create<FieldDictationState>(() => ({
  recording: null,
  pending: {},
  failed: new Set(),
  submitQueued: new Set(),
}));

const queuedSubmits = new Map<string, (text: string) => void>();

function setSubmitQueued(ownerKey: string, queued: boolean) {
  useFieldDictationStore.setState((state) => {
    if (state.submitQueued.has(ownerKey) === queued) return state;
    const next = new Set(state.submitQueued);
    if (queued) next.add(ownerKey);
    else next.delete(ownerKey);
    return { submitQueued: next };
  });
}

/** Holds `submit` until the editor's recording and transcripts are in its draft. */
export function queueFieldSubmit(ownerKey: string, submit: (text: string) => void): void {
  queuedSubmits.set(ownerKey, submit);
  setSubmitQueued(ownerKey, true);
}

export function cancelQueuedFieldSubmit(ownerKey: string): void {
  queuedSubmits.delete(ownerKey);
  setSubmitQueued(ownerKey, false);
}

/** The held submission, now released to its caller. */
export function takeQueuedFieldSubmit(ownerKey: string): ((text: string) => void) | undefined {
  const submit = queuedSubmits.get(ownerKey);
  cancelQueuedFieldSubmit(ownerKey);
  return submit;
}

/** True while `ownerKey` records or has a transcript on the way. */
export function isFieldDictationBusy(state: FieldDictationState, ownerKey: string): boolean {
  return (
    state.recording?.ownerKey === ownerKey ||
    (state.pending[ownerKey] ?? []).some((jobId) => !state.failed.has(jobId))
  );
}

let activeRecording: DictationRecording | null = null;
/** Bumped by every start and cancel, so a microphone granted after a cancel is discarded. */
let generation = 0;
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

/** Ends the session and hands back the recorder and the claim, which outlives it until the tracks stop. */
function endRecording() {
  const recording = activeRecording;
  const release = releaseMicrophone;
  activeRecording = null;
  releaseMicrophone = null;
  if (limitTimer !== null) clearTimeout(limitTimer);
  limitTimer = null;
  releaseScreen?.();
  releaseScreen = null;
  useFieldDictationStore.setState({ recording: null });
  return { recording, release: release ?? (() => undefined) };
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
  const opened = ++generation;
  releaseMicrophone = claim;
  // Published before the permission prompt, so an editor closed during it can cancel.
  useFieldDictationStore.setState({
    recording: { ownerKey, environmentId, phase: "opening", startedAt: Date.now() },
  });
  let recording: DictationRecording;
  try {
    recording = await openDictationRecording();
  } catch (cause) {
    if (opened !== generation) {
      claim();
      return;
    }
    endRecording().release();
    reportError("Could not open the microphone", cause);
    return;
  }
  if (opened !== generation) {
    // Cancelled while the browser asked; the claim was kept until these tracks stop.
    recording.discard();
    claim();
    return;
  }
  activeRecording = recording;
  const recordingId = randomUUID();
  useFieldDictationStore.setState({
    recording: { ownerKey, environmentId, phase: "recording", startedAt: Date.now() },
  });
  releaseScreen = guardRecordingScreen({
    isCapturing: () => activeRecording !== null,
    onMicrophoneMayHaveStopped: (hiddenMs) => warnRecordingMayBeSilent(recordingId, hiddenMs),
  }).release;
  limitTimer = setTimeout(() => void stopFieldDictation(), DICTATION_MAX_RECORDING_MS);
}

export function cancelFieldDictation(): void {
  const opening = useFieldDictationStore.getState().recording?.phase === "opening";
  generation += 1;
  const { recording, release } = endRecording();
  recording?.discard();
  // While opening, the start keeps the claim until the late stream is discarded.
  if (!opening) release();
}

/**
 * Stops the recording, then uploads it and starts its job; the editor inserts the text. An
 * editor that closes or goes inactive calls this too: opening is cancelled, a recording is kept.
 */
export async function stopFieldDictation(): Promise<void> {
  const current = useFieldDictationStore.getState().recording;
  if (!current) return;
  if (current.phase === "opening") {
    cancelFieldDictation();
    return;
  }
  generation += 1;
  const { recording, release } = endRecording();
  if (!recording) return;
  const jobId = DictationJobId.make(randomUUID());
  const durationMs = Date.now() - current.startedAt;
  addPending(current.ownerKey, jobId);
  try {
    const audio = await recording.stop().finally(release);
    const attachmentId = await uploadDictationAudio(current.environmentId, audio, jobId);
    await startDictationTranscription(current.environmentId, {
      jobId,
      attachmentId,
      durationMs,
      mode: "inject",
      target: null,
    });
  } catch (cause) {
    removePending(current.ownerKey, [jobId]);
    reportError("Dictation could not be sent for transcription", cause);
  }
}

function addPending(ownerKey: string, jobId: DictationJobId) {
  useFieldDictationStore.setState((state) => ({
    pending: { ...state.pending, [ownerKey]: [...(state.pending[ownerKey] ?? []), jobId] },
  }));
}

function removePending(ownerKey: string, jobIds: ReadonlyArray<string>) {
  if (jobIds.length === 0) return;
  useFieldDictationStore.setState((state) => {
    const rest = (state.pending[ownerKey] ?? []).filter((id) => !jobIds.includes(id));
    const { [ownerKey]: _removed, ...others } = state.pending;
    const failed = new Set(state.failed);
    for (const jobId of jobIds) failed.delete(jobId);
    return { pending: rest.length > 0 ? { ...others, [ownerKey]: rest } : others, failed };
  });
}

function setFailed(jobId: string, failed: boolean) {
  useFieldDictationStore.setState((state) => {
    if (state.failed.has(jobId) === failed) return state;
    const next = new Set(state.failed);
    if (failed) next.add(jobId);
    else next.delete(jobId);
    return { failed: next };
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

/** Jobs a list has shown: only those can be judged gone when a later list lacks them. */
const listedJobs = new Set<string>();

/**
 * Delivers one editor's finished jobs from the environment's job list. The completed ones'
 * texts go in through one `insert`, in recording order, so none overwrites another; a failure is
 * announced once and stays pending, so a retry from the Transcriptions list still lands here. A
 * job the server no longer lists is dropped.
 */
export function deliverFieldDictationJobs(input: {
  readonly ownerKey: string;
  readonly environmentId: EnvironmentId;
  readonly jobs: ReadonlyArray<DictationJob>;
  readonly insert: (transcripts: ReadonlyArray<string>) => void;
}): void {
  const state = useFieldDictationStore.getState();
  const settled: string[] = [];
  const transcripts: string[] = [];
  for (const jobId of state.pending[input.ownerKey] ?? []) {
    const job = input.jobs.find((candidate) => candidate.id === jobId);
    if (!job) {
      // Not listed yet while it uploads; gone once a list that showed it lacks it.
      if (listedJobs.delete(jobId)) settled.push(jobId);
      continue;
    }
    listedJobs.add(jobId);
    if (job.status === "transcribing") {
      setFailed(jobId, false);
      continue;
    }
    if (job.status === "failed") {
      if (state.failed.has(jobId)) continue;
      setFailed(jobId, true);
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
    settled.push(jobId);
    listedJobs.delete(jobId);
    if (job.text) transcripts.push(job.text);
  }
  if (transcripts.length > 0) input.insert(transcripts);
  removePending(input.ownerKey, settled);
}
