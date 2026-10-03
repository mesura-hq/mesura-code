import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  deletePendingAttachmentUpload,
  runAttachmentUploadCycle,
} from "@t3tools/client-runtime/state/attachments";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DictationJobId,
  type DictationJob,
  type DictationKeybindingCommand,
  type DictationMode,
  type DictationTarget,
  type EnvironmentId,
  type KeybindingCommand,
} from "@t3tools/contracts";
import { findDictationSlots, formatDictationSlot } from "@t3tools/shared/dictationSlots";

import { toastManager } from "~/components/ui/toast";
import { openTranscriptionsList } from "~/components/dictation/TranscriptionsList";
import {
  appendDictationSlotToDraft,
  COMPOSER_DRAFT_STORAGE_KEY,
  type ComposerThreadTarget,
  DraftId,
  fillDictationSlotInDraft,
  persistComposerDrafts,
  readStoredDraftPrompt,
  removeDictationSlotFromDraft,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { randomUUID } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { attachmentEnvironment } from "~/state/attachments";
import { dictationEnvironment } from "~/state/dictation";
import { readPreparedConnection } from "~/state/session";
import { nextDictationMode } from "~/symmetria/dictationPresentation";
import {
  DICTATION_MAX_RECORDING_MS,
  openDictationRecording,
  type DictationAudio,
  type DictationRecording,
} from "./recorder";
import {
  forgetOwnDictationJob,
  type OwnDictationJob,
  recordedDictationMs,
  recordOwnDictationJob,
  updateOwnDictationJob,
  useDictationSessionStore,
  useOwnDictationJobsStore,
} from "./dictationSessionStore";

/**
 * Mesura's own dictation, end to end in the window: record, drop a marker where the caret was
 * when the recording stopped, upload, start the server job, and fill the marker when the job
 * completes. Plain functions over module state, so the strip, the keybindings and (later) the
 * desktop command line all drive the same session.
 */

const LEVEL_POLL_INTERVAL_MS = 100;
const DEFAULT_MODE: DictationMode = "submit";

/** The composer a stopped recording drops its marker into: the one on screen, else the last shown. */
export interface DictationComposer {
  readonly environmentId: EnvironmentId;
  readonly target: Exclude<DictationTarget, null>;
  readonly draftTarget: ComposerThreadTarget;
  /** Inserts at the editor's caret; `null` once the composer is no longer mounted. */
  readonly insertSlot: ((slot: string) => boolean) | null;
}

let lastComposer: DictationComposer | null = null;
let activeRecording: DictationRecording | null = null;
let opening = false;
let levelTimer: ReturnType<typeof setInterval> | null = null;
/**
 * Bumped by every start, stop, cancel and restart. A microphone that opens after the session it
 * was opened for has moved on (cancelled during a restart, say) is discarded, not installed.
 */
let sessionGeneration = 0;
/** Jobs the server knows, so a mode change goes to the server instead of into the start. */
const startedJobIds = new Set<string>();
/** Failures of save-only jobs already reported; a failed marker shows its own Retry. */
const reportedFailures = new Set<string>();
/** Jobs this tab has finished delivering, so a repeated job list does no work. */
const settledInTab = new Set<string>();
/** Jobs whose fill reached the draft but not storage; the next delivery retries the write. */
const filledAwaitingWrite = new Set<string>();
const delivering = new Set<string>();
/** After a reload the mode keys pick the newest job back up, once, if it still transcribes. */
let lastJobRestored = false;
/**
 * Transcripts this tab placed, watched until the user's own draft no longer holds them.
 *
 * Tabs persist the whole draft store and the last writer wins (upstream behaviour this feature
 * does not redesign), so another tab's write can erase a transcript from storage while this tab
 * still shows it. When that happens the user is told it is kept in Transcriptions, once per job,
 * instead of losing it silently at the next reload.
 */
const placedTranscripts = new Map<
  string,
  {
    readonly environmentId: EnvironmentId;
    readonly target: ComposerThreadTarget;
    readonly text: string;
  }
>();
let survivalCheck: ReturnType<typeof setTimeout> | null = null;
/**
 * Markers this tab's own copy of the draft has held. Each tab keeps its own copy and never sees
 * another tab's edits, so a marker this tab never held is not missing here for anything the user
 * did here: it lives in another tab's copy, or another tab's save replaced the draft.
 */
const markersHeldInTab = new Set<string>();
/** How long the tab that holds a marker has to deliver it before another tab judges it lost. */
const UNCLAIMED_GRACE_MS = 3_000;
/** Two tabs that both write within this window settle before storage is judged. */
const SURVIVAL_CHECK_DELAY_MS = 1_000;

export function registerDictationComposer(composer: DictationComposer): () => void {
  lastComposer = composer;
  return () => {
    if (lastComposer === composer) lastComposer = { ...composer, insertSlot: null };
  };
}

export function toComposerThreadTarget(
  target: Exclude<DictationTarget, null>,
): ComposerThreadTarget {
  return target.kind === "thread"
    ? scopeThreadRef(target.environmentId, target.threadId)
    : DraftId.make(target.draftId);
}

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function reportError(title: string, cause?: unknown) {
  toastManager.add({
    type: "error",
    title,
    ...(cause === undefined ? {} : { description: errorMessage(cause) }),
  });
}

function stopLevelPolling() {
  if (levelTimer !== null) clearInterval(levelTimer);
  levelTimer = null;
}

function startLevelPolling() {
  stopLevelPolling();
  levelTimer = setInterval(() => {
    const { session } = useDictationSessionStore.getState();
    if (!session || !activeRecording) return stopLevelPolling();
    if (recordedDictationMs(session, Date.now()) >= DICTATION_MAX_RECORDING_MS) {
      void stopDictation();
      return;
    }
    const level = activeRecording.readLevel();
    useDictationSessionStore.setState({ session: { ...session, level, sampledAt: Date.now() } });
  }, LEVEL_POLL_INTERVAL_MS);
}

async function openRecording(): Promise<DictationRecording | null> {
  opening = true;
  try {
    return await openDictationRecording();
  } catch (cause) {
    reportError("Could not open the microphone", cause);
    return null;
  } finally {
    opening = false;
  }
}

export async function startDictation(): Promise<void> {
  if (useDictationSessionStore.getState().session !== null || opening) return;
  const generation = ++sessionGeneration;
  const recording = await openRecording();
  if (!recording) return;
  if (generation !== sessionGeneration) {
    recording.discard();
    return;
  }
  activeRecording = recording;
  const now = Date.now();
  useDictationSessionStore.setState({
    session: {
      sessionId: randomUUID(),
      mode: DEFAULT_MODE,
      startedAt: now,
      bankedMs: 0,
      runningSince: now,
      level: 0,
      sampledAt: now,
    },
  });
  startLevelPolling();
}

function endRecording() {
  stopLevelPolling();
  activeRecording = null;
  useDictationSessionStore.setState({ session: null });
}

export function cancelDictation(): void {
  sessionGeneration += 1;
  activeRecording?.discard();
  endRecording();
}

export function toggleDictationPause(): void {
  const { session } = useDictationSessionStore.getState();
  if (!session || !activeRecording) return;
  const now = Date.now();
  if (session.runningSince === null) {
    activeRecording.resume();
    useDictationSessionStore.setState({
      session: { ...session, runningSince: now, sampledAt: now },
    });
  } else {
    activeRecording.pause();
    useDictationSessionStore.setState({
      session: {
        ...session,
        bankedMs: recordedDictationMs(session, now),
        runningSince: null,
        sampledAt: now,
      },
    });
  }
}

export async function restartDictation(): Promise<void> {
  if (!useDictationSessionStore.getState().session || !activeRecording || opening) return;
  const generation = ++sessionGeneration;
  activeRecording.discard();
  stopLevelPolling();
  activeRecording = null;
  const recording = await openRecording();
  // Read again: a cancel during the wait ended the session, a mode key changed it.
  const session = useDictationSessionStore.getState().session;
  if (generation !== sessionGeneration || !session) {
    recording?.discard();
    return;
  }
  if (!recording) {
    useDictationSessionStore.setState({ session: null });
    return;
  }
  activeRecording = recording;
  const now = Date.now();
  useDictationSessionStore.setState({
    session: {
      ...session,
      startedAt: now,
      bankedMs: 0,
      runningSince: now,
      level: 0,
      sampledAt: now,
    },
  });
  startLevelPolling();
}

async function uploadDictationAudio(
  environmentId: EnvironmentId,
  audio: DictationAudio,
  jobId: DictationJobId,
): Promise<string> {
  const extension = audio.mimeType.startsWith("audio/mp4") ? "m4a" : "webm";
  const result = await runAttachmentUploadCycle({
    registry: appAtomRegistry,
    createUploadUrl: attachmentEnvironment.createUploadUrl,
    remove: attachmentEnvironment.remove,
    environmentId,
    upload: {
      type: "file",
      name: `dictation-${jobId}.${extension}`,
      mimeType: audio.mimeType,
      sizeBytes: audio.blob.size,
    },
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
  if (result.status === "uploaded") return result.attachmentId;
  if (result.attachmentId) {
    deletePendingAttachmentUpload({
      registry: appAtomRegistry,
      remove: attachmentEnvironment.remove,
      environmentId,
      attachmentId: result.attachmentId,
    });
  }
  throw result.status === "failed" ? result.error : new Error("The upload was cancelled.");
}

/** A job that never reached the server takes its marker with it; nothing would ever fill it. */
function abandonJob(jobId: DictationJobId, draftTarget: ComposerThreadTarget, cause: unknown) {
  forgetOwnDictationJob(jobId);
  removeDictationSlotFromDraft(draftTarget, jobId);
  const { lastJob } = useDictationSessionStore.getState();
  if (lastJob?.jobId === jobId) useDictationSessionStore.setState({ lastJob: null });
  reportError("Dictation could not be sent for transcription", cause);
}

/** Stops the recording, drops the marker at the caret, then uploads and starts the job. */
export async function stopDictation(): Promise<void> {
  const { session } = useDictationSessionStore.getState();
  const recording = activeRecording;
  if (!session || !recording) return;
  const composer = lastComposer;
  sessionGeneration += 1;
  endRecording();
  if (!composer) {
    recording.discard();
    reportError("Open a thread to dictate into");
    return;
  }

  const now = Date.now();
  const durationMs = Math.round(recordedDictationMs(session, now));
  const jobId = DictationJobId.make(randomUUID());
  const { environmentId, draftTarget } = composer;
  if (session.mode !== "clipboard") placeDictationSlot(composer, jobId);
  recordOwnDictationJob(jobId, {
    environmentId,
    target: composer.target,
    mode: session.mode,
    createdAt: now,
  });
  lastJobRestored = true;
  useDictationSessionStore.setState({ lastJob: { environmentId, jobId } });

  try {
    const audio = await recording.stop();
    const attachmentId = await uploadDictationAudio(environmentId, audio, jobId);
    // A mode key pressed during the upload changed the record, not a server job.
    const mode = useOwnDictationJobsStore.getState().jobs[jobId]?.mode ?? session.mode;
    const target = mode === "clipboard" ? null : composer.target;
    const result = await runAtomCommand(
      appAtomRegistry,
      dictationEnvironment.start,
      { environmentId, input: { jobId, attachmentId, durationMs, mode, target } },
      { reportFailure: false },
    );
    if (result._tag !== "Success") throw squashAtomCommandFailure(result);
    startedJobIds.add(jobId);
    // A mode key pressed while the start was on the wire changed only the record.
    const latest = useOwnDictationJobsStore.getState().jobs[jobId]?.mode;
    if (latest !== undefined && latest !== mode) sendModeChange(environmentId, jobId, latest);
  } catch (cause) {
    abandonJob(jobId, draftTarget, cause);
  }
}

export async function toggleDictation(): Promise<void> {
  if (useDictationSessionStore.getState().session) await stopDictation();
  else await startDictation();
}

/** Drops the marker at the composer's caret when it is the one on screen, else at the end. */
function placeDictationSlot(composer: DictationComposer, jobId: DictationJobId) {
  markersHeldInTab.add(jobId);
  const slot = formatDictationSlot(jobId);
  if (!(composer.insertSlot?.(slot) ?? false))
    appendDictationSlotToDraft(composer.draftTarget, slot);
}

function sameTarget(
  left: Exclude<DictationTarget, null>,
  right: Exclude<DictationTarget, null>,
): boolean {
  return left.kind === "thread" && right.kind === "thread"
    ? left.environmentId === right.environmentId && left.threadId === right.threadId
    : left.kind === "draft" && right.kind === "draft" && left.draftId === right.draftId;
}

function sendModeChange(environmentId: EnvironmentId, jobId: DictationJobId, mode: DictationMode) {
  void runAtomCommand(appAtomRegistry, dictationEnvironment.setMode, {
    environmentId,
    input: { jobId, mode },
  });
}

/**
 * Selects where the transcript goes: the recording's mode, or the last job's while it
 * transcribes. Turning a stopped job into save takes its marker out of the draft; turning a
 * saved job into insert or send puts one in, at the caret when its composer is on screen.
 */
export function selectDictationMode(mode: DictationMode): void {
  const { session, lastJob } = useDictationSessionStore.getState();
  if (session) {
    useDictationSessionStore.setState({ session: { ...session, mode } });
    return;
  }
  if (!lastJob) return;
  const own = useOwnDictationJobsStore.getState().jobs[lastJob.jobId];
  if (!own || own.mode === mode) return;
  updateOwnDictationJob(lastJob.jobId, { mode });
  if (own.mode === "clipboard") {
    const composer =
      lastComposer && sameTarget(lastComposer.target, own.target) ? lastComposer : null;
    placeDictationSlot(
      composer ?? {
        environmentId: own.environmentId,
        target: own.target,
        draftTarget: toComposerThreadTarget(own.target),
        insertSlot: null,
      },
      lastJob.jobId,
    );
  } else if (mode === "clipboard") {
    removeDictationSlotFromDraft(toComposerThreadTarget(own.target), lastJob.jobId);
  }
  if (startedJobIds.has(lastJob.jobId)) sendModeChange(lastJob.environmentId, lastJob.jobId, mode);
}

export function cycleDictationMode(): void {
  const { session, lastJob } = useDictationSessionStore.getState();
  const current =
    session?.mode ??
    (lastJob ? useOwnDictationJobsStore.getState().jobs[lastJob.jobId]?.mode : undefined) ??
    DEFAULT_MODE;
  selectDictationMode(nextDictationMode(current));
}

export function retryDictationJob(jobId: string): void {
  const own = useOwnDictationJobsStore.getState().jobs[jobId];
  if (!own) return;
  void runAtomCommand(appAtomRegistry, dictationEnvironment.retry, {
    environmentId: own.environmentId,
    input: { jobId: DictationJobId.make(jobId) },
  });
}

/** Drops a failed job's marker; the recording stays in the Transcriptions list for a retry. */
export function discardDictationJob(jobId: string): void {
  const own = useOwnDictationJobsStore.getState().jobs[jobId];
  if (!own) return;
  removeDictationSlotFromDraft(toComposerThreadTarget(own.target), jobId);
  updateOwnDictationJob(jobId, { handled: true });
}

const DICTATION_COMMAND_ACTIONS: Record<DictationKeybindingCommand, () => void> = {
  "dictation.toggle": () => void toggleDictation(),
  "dictation.mode.clipboard": () => selectDictationMode("clipboard"),
  "dictation.mode.inject": () => selectDictationMode("inject"),
  "dictation.mode.submit": () => selectDictationMode("submit"),
  "dictation.pause": toggleDictationPause,
  "dictation.restart": () => void restartDictation(),
  "dictation.cancel": cancelDictation,
};

export function isDictationKeybindingCommand(
  command: KeybindingCommand,
): command is DictationKeybindingCommand {
  return command in DICTATION_COMMAND_ACTIONS;
}

export function runDictationKeybindingCommand(command: DictationKeybindingCommand): void {
  DICTATION_COMMAND_ACTIONS[command]();
}

const MARKER_DELETED = "Its marker was deleted, so the text was not placed in the draft.";
const OVERWRITTEN_BY_OTHER_TAB = "Another tab saved this draft without it, so the draft lost it.";

function noticeKeptInTranscriptions(environmentId: EnvironmentId, description: string) {
  const toastId = toastManager.add({
    type: "info",
    title: "Transcription kept in Transcriptions",
    description,
    actionProps: {
      children: "Show",
      onClick: () => {
        toastManager.close(toastId);
        openTranscriptionsList(environmentId);
      },
    },
  });
}

/** `false` when the copy failed; the user is told, and the text stays in the list. */
async function copyTranscript(environmentId: EnvironmentId, text: string): Promise<boolean> {
  try {
    await writeTextToClipboard(text, "transcription");
    return true;
  } catch (cause) {
    const toastId = toastManager.add({
      type: "error",
      title: "Could not copy the transcription",
      description: errorMessage(cause),
      actionProps: {
        children: "Show",
        onClick: () => {
          toastManager.close(toastId);
          openTranscriptionsList(environmentId);
        },
      },
    });
    return false;
  }
}

/** Gives the mode keys back the newest job after a reload, while it still transcribes. */
function restoreLastJob(environmentId: EnvironmentId, jobs: ReadonlyArray<DictationJob>) {
  if (lastJobRestored) return;
  const newest = Object.entries(useOwnDictationJobsStore.getState().jobs).reduce<
    [string, OwnDictationJob] | null
  >(
    (best, entry) => (best === null || entry[1].createdAt > best[1].createdAt ? entry : best),
    null,
  );
  if (newest === null) {
    lastJobRestored = true;
    return;
  }
  const [jobId, own] = newest;
  if (own.environmentId !== environmentId) return;
  lastJobRestored = true;
  const job = jobs.find((candidate) => candidate.id === jobId);
  const { session, lastJob } = useDictationSessionStore.getState();
  if (job?.status === "transcribing" && session === null && lastJob === null) {
    useDictationSessionStore.setState({ lastJob: { environmentId, jobId: job.id } });
  }
}

function draftHoldsMarker(own: OwnDictationJob, jobId: string): boolean {
  const prompt =
    useComposerDraftStore.getState().getComposerDraft(toComposerThreadTarget(own.target))?.prompt ??
    "";
  return findDictationSlots(prompt).some((slot) => slot.jobId === jobId);
}

/** One completed job, in this tab. See `OwnDictationJob` for the cross-tab rule. */
async function deliverCompletedJob(job: DictationJob, own: OwnDictationJob): Promise<void> {
  const draftTarget = toComposerThreadTarget(own.target);
  const settle = () => {
    settledInTab.add(job.id);
    filledAwaitingWrite.delete(job.id);
    updateOwnDictationJob(job.id, { handled: true });
  };
  if (own.mode === "clipboard") {
    removeDictationSlotFromDraft(draftTarget, job.id);
    if (!own.handled) await copyTranscript(own.environmentId, job.text ?? "");
    settle();
    return;
  }
  if (filledAwaitingWrite.has(job.id)) {
    if (persistComposerDrafts()) settle();
    return;
  }
  const outcome = fillDictationSlotInDraft(draftTarget, job.id, job.text ?? "");
  if (outcome === "unsaved") {
    filledAwaitingWrite.add(job.id);
    return;
  }
  if (outcome === "missing") {
    if (markersHeldInTab.has(job.id)) {
      // The user deleted it here. Write that edit through before judging storage.
      if (!own.handled) {
        persistComposerDrafts();
        await announceIfLost(job, own, draftTarget, MARKER_DELETED);
      }
      settle();
    } else {
      settledInTab.add(job.id);
      setTimeout(() => void announceIfUnclaimed(job, draftTarget), UNCLAIMED_GRACE_MS);
    }
    return;
  }
  if (outcome === "filled" && job.text) {
    placedTranscripts.set(job.id, {
      environmentId: own.environmentId,
      target: draftTarget,
      text: job.text,
    });
  }
  settle();
}

/** Shows the "kept in Transcriptions" notice unless one was already shown for this job. */
function announceKeptOnce(jobId: string, environmentId: EnvironmentId, description: string) {
  if (useOwnDictationJobsStore.getState().jobs[jobId]?.noticed) return;
  updateOwnDictationJob(jobId, { noticed: true });
  noticeKeptInTranscriptions(environmentId, description);
}

/** Announces a job whose text and marker are both gone from storage, which is what lasts. */
async function announceIfLost(
  job: DictationJob,
  own: OwnDictationJob,
  target: ComposerThreadTarget,
  description: string,
) {
  const stored = await readStoredDraftPrompt(target);
  if (stored !== null && job.text && stored.includes(job.text)) return;
  if (stored !== null && findDictationSlots(stored).some((slot) => slot.jobId === job.id)) return;
  announceKeptOnce(job.id, own.environmentId, description);
}

/**
 * A job whose marker this tab never held belongs to the tab that holds it. If no tab delivered
 * it within the grace period and storage holds neither its text nor its marker, another tab's
 * save took the marker away, and this tab says so.
 */
async function announceIfUnclaimed(job: DictationJob, target: ComposerThreadTarget) {
  const own = useOwnDictationJobsStore.getState().jobs[job.id];
  if (!own || own.handled || own.noticed) return;
  await announceIfLost(job, own, target, OVERWRITTEN_BY_OTHER_TAB);
  if (useOwnDictationJobsStore.getState().jobs[job.id]?.noticed) {
    updateOwnDictationJob(job.id, { handled: true });
  }
}

/**
 * Judges every watched transcript against storage after another tab wrote the drafts: lost when
 * this tab's draft still holds it but storage holds neither it nor its marker.
 */
export async function checkPlacedTranscriptsSurvived(): Promise<void> {
  for (const [jobId, placed] of placedTranscripts) {
    const shown = useComposerDraftStore.getState().getComposerDraft(placed.target)?.prompt ?? "";
    if (!shown.includes(placed.text)) {
      // The user sent or edited it here; what happens to it is theirs to decide.
      placedTranscripts.delete(jobId);
      continue;
    }
    const stored = await readStoredDraftPrompt(placed.target);
    if (stored === null || stored.includes(placed.text)) continue;
    if (findDictationSlots(stored).some((slot) => slot.jobId === jobId)) continue;
    placedTranscripts.delete(jobId);
    announceKeptOnce(jobId, placed.environmentId, OVERWRITTEN_BY_OTHER_TAB);
  }
}

if (typeof window !== "undefined") {
  // Fires only for writes made by other tabs.
  window.addEventListener("storage", (event) => {
    if (event.key !== COMPOSER_DRAFT_STORAGE_KEY || placedTranscripts.size === 0) return;
    if (survivalCheck !== null) clearTimeout(survivalCheck);
    survivalCheck = setTimeout(() => {
      survivalCheck = null;
      void checkPlacedTranscriptsSurvived();
    }, SURVIVAL_CHECK_DELAY_MS);
  });
}

/**
 * Delivers this device's jobs from one environment as the server reports them: fill the marker,
 * or copy the text in save mode, or keep it in the Transcriptions list when the marker is gone.
 */
export function deliverDictationJobs(
  environmentId: EnvironmentId,
  jobs: ReadonlyArray<DictationJob>,
): void {
  restoreLastJob(environmentId, jobs);
  for (const job of jobs) {
    startedJobIds.add(job.id);
    const { lastJob } = useDictationSessionStore.getState();
    if (lastJob?.jobId === job.id && job.status !== "transcribing") {
      useDictationSessionStore.setState({ lastJob: null });
    }
    const own = useOwnDictationJobsStore.getState().jobs[job.id];
    if (!own || settledInTab.has(job.id) || delivering.has(job.id)) continue;
    if (!markersHeldInTab.has(job.id) && draftHoldsMarker(own, job.id)) {
      markersHeldInTab.add(job.id);
    }
    if (job.status === "failed") {
      if (own.mode === "clipboard" && !own.handled && !reportedFailures.has(job.id)) {
        reportedFailures.add(job.id);
        reportError("Transcription failed", job.failure);
      }
      continue;
    }
    if (job.status !== "completed") continue;
    delivering.add(job.id);
    void deliverCompletedJob(job, own).finally(() => delivering.delete(job.id));
  }
}
