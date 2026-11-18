import type { DictationJobsCursor } from "@t3tools/client-runtime/dictation";
import { DictationJobId, type DictationJob, type EnvironmentId } from "@t3tools/contracts";
import { insertDictationSlotAt } from "@t3tools/shared/dictationSlots";
import { create } from "zustand";

import { toastManager } from "~/components/ui/toast";
import { openTranscriptionsList } from "~/components/dictation/TranscriptionsList";
import { randomUUID } from "~/lib/utils";
import { claimMicrophone, microphoneBlocker } from "../voice/microphoneClaim";
import { dictationJobStamp, listProvesJobGone, type DictationJobStamp } from "./dictationJobStamps";
import { startDictationTranscription, uploadDictationAudio } from "./dictationTransport";
import {
  DICTATION_MAX_RECORDING_MS,
  openDictationRecording,
  type DictationRecording,
} from "./recorder";
import { guardRecordingScreen, warnRecordingMayBeSilent } from "./recordingScreen";

/**
 * Mesura dictation for a plain comment editor: record, transcribe, insert at the caret. No marker:
 * a transcript belongs to the mounted editor (its draft) that recorded it. An editor that closes,
 * is disabled or submits by hand lets go of its jobs, whose text stays in Transcriptions. One
 * recording at a time, shared with the composer through the claim.
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
  /** Accepted pending jobs by id, so a later job list can prove one gone before it was listed. */
  readonly stamps: Readonly<Record<string, DictationJobStamp>>;
}

export const useFieldDictationStore = create<FieldDictationState>(() => ({
  recording: null,
  pending: {},
  failed: new Set(),
  submitQueued: new Set(),
  stamps: {},
}));

/** A held submission and the jobs whose text has to land before it may run. */
interface QueuedSubmit {
  readonly submit: (text: string) => void;
  readonly awaiting: Set<string>;
}

const queuedSubmits = new Map<string, QueuedSubmit>();

function setSubmitQueued(ownerKey: string, queued: boolean) {
  useFieldDictationStore.setState((state) => {
    if (state.submitQueued.has(ownerKey) === queued) return state;
    const next = new Set(state.submitQueued);
    if (queued) next.add(ownerKey);
    else next.delete(ownerKey);
    return { submitQueued: next };
  });
}

/**
 * Holds `submit` until every transcript `ownerKey` waits for is in its draft. False when there is
 * nothing to wait for, such as a microphone still starting, and nothing was held.
 */
export function queueFieldSubmit(ownerKey: string, submit: (text: string) => void): boolean {
  const state = useFieldDictationStore.getState();
  const awaiting = new Set(
    (state.pending[ownerKey] ?? []).filter((jobId) => !state.failed.has(jobId)),
  );
  if (awaiting.size === 0) return false;
  queuedSubmits.set(ownerKey, { submit, awaiting });
  setSubmitQueued(ownerKey, true);
  return true;
}

export function cancelQueuedFieldSubmit(ownerKey: string): void {
  queuedSubmits.delete(ownerKey);
  setSubmitQueued(ownerKey, false);
}

/** A held submission that waits for `jobId` can no longer get its text, so it never runs. */
function cancelSubmitAwaiting(ownerKey: string, jobId: string) {
  if (queuedSubmits.get(ownerKey)?.awaiting.has(jobId)) cancelQueuedFieldSubmit(ownerKey);
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
  // A new recording means the draft is still being written: a held submission no longer applies.
  cancelQueuedFieldSubmit(ownerKey);
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
  const current = useFieldDictationStore.getState().recording;
  const opening = current?.phase === "opening";
  if (current) cancelQueuedFieldSubmit(current.ownerKey);
  generation += 1;
  const { recording, release } = endRecording();
  recording?.discard();
  // While opening, the start keeps the claim until the late stream is discarded.
  if (!opening) release();
}

/**
 * Stops the recording, then uploads it and starts its job; the editor inserts the text. A
 * `detached` stop, for an editor that let go of its draft, leaves the text in Transcriptions.
 * Opening is cancelled either way. The job is pending before the first await.
 */
export async function stopFieldDictation(options?: { readonly detached?: boolean }): Promise<void> {
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
  if (!options?.detached) addPending(current.ownerKey, jobId);
  try {
    const audio = await recording.stop().finally(release);
    const attachmentId = await uploadDictationAudio(current.environmentId, audio, jobId);
    const accepted = await startDictationTranscription(current.environmentId, {
      jobId,
      attachmentId,
      durationMs,
      mode: "inject",
      target: null,
    });
    const stamp = dictationJobStamp(accepted);
    if (stamp && !options?.detached) {
      useFieldDictationStore.setState((state) => ({
        stamps: { ...state.stamps, [jobId]: stamp },
      }));
    }
  } catch (cause) {
    cancelSubmitAwaiting(current.ownerKey, jobId);
    removePending(current.ownerKey, [jobId]);
    reportError("Dictation could not be sent for transcription", cause);
  }
}

/**
 * The editor let go of its draft: it closed, was disabled, or was submitted by hand. Its held
 * submission is dropped, a recording is still transcribed, and every job's text stays in
 * Transcriptions instead of landing in a later draft with the same owner key.
 */
export function detachFieldDictation(ownerKey: string, environmentId: EnvironmentId): void {
  cancelQueuedFieldSubmit(ownerKey);
  const state = useFieldDictationStore.getState();
  const recording = state.recording?.ownerKey === ownerKey ? state.recording : null;
  if (recording) void stopFieldDictation({ detached: true });
  const jobs = state.pending[ownerKey] ?? [];
  for (const jobId of jobs) listedJobs.delete(jobId);
  removePending(ownerKey, jobs);
  const inFlight = recording?.phase === "recording" || jobs.some((id) => !state.failed.has(id));
  if (!inFlight) return;
  const toastId = toastManager.add({
    type: "info",
    title: "The transcript will be in Transcriptions",
    actionProps: {
      children: "Show",
      onClick: () => {
        toastManager.close(toastId);
        openTranscriptionsList(environmentId);
      },
    },
  });
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
    const stamps = { ...state.stamps };
    for (const jobId of jobIds) {
      failed.delete(jobId);
      delete stamps[jobId];
    }
    return { pending: rest.length > 0 ? { ...others, [ownerKey]: rest } : others, failed, stamps };
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
 * Delivers one editor's finished jobs: completed texts go in through one `insert`, in recording
 * order; a failure is announced once and stays pending for a retry; a job no longer listed is
 * dropped. Returns the held submission once every transcript it waited for went in.
 */
export function deliverFieldDictationJobs(input: {
  readonly ownerKey: string;
  readonly environmentId: EnvironmentId;
  readonly jobs: ReadonlyArray<DictationJob>;
  readonly cursor: DictationJobsCursor;
  /** The store's `stamps`, passed in so a stamp that lands after the list re-runs delivery. */
  readonly stamps: FieldDictationState["stamps"];
  readonly insert: (transcripts: ReadonlyArray<string>) => void;
}): ((text: string) => void) | null {
  const state = useFieldDictationStore.getState();
  const settled: string[] = [];
  const inserted: string[] = [];
  const transcripts: string[] = [];
  let lost = false;
  for (const jobId of state.pending[input.ownerKey] ?? []) {
    const job = input.jobs.find((candidate) => candidate.id === jobId);
    if (!job) {
      // Not listed yet while it uploads; gone once a list that showed it lacks it, or a list
      // from a later change or another server run (a restart) lacks it.
      const gone = listedJobs.delete(jobId) || listProvesJobGone(input.stamps[jobId], input.cursor);
      if (gone) {
        settled.push(jobId);
        cancelSubmitAwaiting(input.ownerKey, jobId);
        lost = true;
      }
      continue;
    }
    listedJobs.add(jobId);
    if (job.status === "transcribing") {
      setFailed(jobId, false);
      continue;
    }
    if (job.status === "failed") {
      cancelSubmitAwaiting(input.ownerKey, jobId);
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
    if (job.text) {
      transcripts.push(job.text);
      inserted.push(jobId);
    } else {
      cancelSubmitAwaiting(input.ownerKey, jobId);
    }
  }
  if (transcripts.length > 0) input.insert(transcripts);
  removePending(input.ownerKey, settled);
  if (lost) {
    toastManager.add({
      type: "error",
      title: "A dictation was lost",
      description:
        "The environment no longer has it, so its text will not arrive. Nothing was sent.",
    });
  }
  const queued = queuedSubmits.get(input.ownerKey);
  if (!queued) return null;
  for (const jobId of inserted) queued.awaiting.delete(jobId);
  if (queued.awaiting.size > 0) return null;
  cancelQueuedFieldSubmit(input.ownerKey);
  return queued.submit;
}
