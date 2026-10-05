import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_DICTATION_MODE,
  nextDictationMode,
  runDictationStop,
  uploadDictationRecording,
} from "@t3tools/client-runtime/dictation";
import {
  DictationJobId,
  type DictationJob,
  type DictationKeybindingCommand,
  type DictationMode,
  type DictationTarget,
  type EnvironmentId,
  type KeybindingCommand,
} from "@t3tools/contracts";
import {
  fillDictationSlot,
  findDictationSlots,
  formatDictationSlot,
  removeDictationSlot,
} from "@t3tools/shared/dictationSlots";

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
import {
  editPendingUserInputAnswerText,
  markPendingUserInputAnswerVoiced,
  readPendingUserInputAnswerText,
} from "~/pendingUserInputDraftStore";
import { randomUUID } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { attachmentEnvironment } from "~/state/attachments";
import { dictationEnvironment } from "~/state/dictation";
import { readPreparedConnection } from "~/state/session";
import {
  DICTATION_MAX_RECORDING_MS,
  openDictationRecording,
  type DictationAudio,
  type DictationRecording,
} from "./recorder";
import { appendDictationSlot } from "./dictationSlotEdits";
import {
  armQuestionSendWhenReady,
  armSendWhenReady,
  disarmQuestionSendWhenReady,
  disarmSendWhenReady,
  markDictationFilled,
} from "./sendWhenReady";
import {
  type DictationQuestionAnswer,
  forgetOwnDictationJob,
  type OwnDictationJob,
  recordedDictationMs,
  recordOwnDictationJob,
  updateOwnDictationJob,
  useDictationSessionStore,
  useOwnDictationJobsStore,
} from "./dictationSessionStore";
import { dictationTargetLabel } from "./dictationTargetLabel";
import {
  recordDictationDelivery,
  recordDictationFailure,
  setTranscribingDictationJobs,
  useDictationWidgetActivityStore,
} from "./dictationWidgetState";

/**
 * Mesura's own dictation, end to end in the window: record, drop a marker where the caret was
 * when the recording stopped, upload, start the server job, and fill the marker when the job
 * completes. Plain functions over module state, so the strip, the keybindings and the desktop
 * command line all drive the same session.
 */

const LEVEL_POLL_INTERVAL_MS = 100;

/** The composer a stopped recording drops its marker into: the one on screen, else the last shown. */
export interface DictationComposer {
  readonly environmentId: EnvironmentId;
  readonly target: Exclude<DictationTarget, null>;
  readonly draftTarget: ComposerThreadTarget;
  /** Inserts at the editor's caret; `null` once the composer is no longer mounted. */
  readonly insertSlot: ((slot: string) => boolean) | null;
  /** Set for a focused question card: the marker goes into that answer, not into the draft. */
  readonly question?: DictationQuestionAnswer;
}

let lastComposer: DictationComposer | null = null;
/** The thread's composer, which takes over again when a focused question card lets go. */
let lastThreadComposer: DictationComposer | null = null;
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
/**
 * The failed attempt of each job this tab has already handled, by the attempt's `completedAt`.
 * A retry keeps the job id but its failure carries a new `completedAt`, and that failure may be
 * all this tab receives: the server publishes a retry only when its attempt ends, and the job
 * stream coalesces per job, so no `transcribing` need come between the two failures.
 */
const seenFailedAttempts = new Map<string, string>();
let lastFailureAt = 0;
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
  if (!composer.question) lastThreadComposer = composer;
  return () => {
    if (composer.question) {
      if (lastComposer === composer) lastComposer = lastThreadComposer;
      return;
    }
    const unmounted = { ...composer, insertSlot: null };
    if (lastThreadComposer === composer) lastThreadComposer = unmounted;
    if (lastComposer === composer) lastComposer = unmounted;
  };
}

/** Where a recording stopped now would drop its marker, for the desktop widget. */
export function currentDictationTarget(): Exclude<DictationTarget, null> | null {
  return lastComposer?.target ?? null;
}

/** The thread's composer took focus back from a question card: it takes the next marker. */
export function reclaimDictationComposer(): void {
  if (lastThreadComposer) lastComposer = lastThreadComposer;
}

/** Where a job's marker lives, and what fills, removes and sends it there. */
interface DictationSlotHost {
  readonly append: (slot: string) => void;
  readonly fill: (jobId: string, transcript: string) => "filled" | "unsaved" | "missing";
  readonly remove: (jobId: string) => void;
  readonly read: () => string;
  /** What storage holds; `null` when it cannot be judged. */
  readonly readStored: () => Promise<string | null>;
  readonly armSend: () => void;
  readonly disarmSend: () => void;
  readonly markFilled: (jobId: string) => void;
}

function questionSlotHost(question: DictationQuestionAnswer): DictationSlotHost {
  const edit = (change: (text: string) => string | null) =>
    editPendingUserInputAnswerText(question.requestKey, question.questionId, change);
  const read = () => readPendingUserInputAnswerText(question.requestKey, question.questionId);
  return {
    append: (slot) => void edit((text) => appendDictationSlot(text, slot)),
    fill: (jobId, transcript) =>
      edit((text) => {
        const result = fillDictationSlot(text, jobId, transcript);
        return "missing" in result ? null : result.text;
      })
        ? "filled"
        : "missing",
    remove: (jobId) =>
      void edit((text) => {
        const result = removeDictationSlot(text, jobId);
        return "missing" in result ? null : result.text;
      }),
    read,
    // The answers store writes through on every change; the copy in memory is what storage holds.
    readStored: async () => read(),
    armSend: () => armQuestionSendWhenReady(question.requestKey),
    disarmSend: () => disarmQuestionSendWhenReady(question.requestKey),
    markFilled: () => markPendingUserInputAnswerVoiced(question.requestKey, question.questionId),
  };
}

function draftSlotHost(draftTarget: ComposerThreadTarget): DictationSlotHost {
  return {
    append: (slot) => void appendDictationSlotToDraft(draftTarget, slot),
    fill: (jobId, transcript) => fillDictationSlotInDraft(draftTarget, jobId, transcript),
    remove: (jobId) => void removeDictationSlotFromDraft(draftTarget, jobId),
    read: () => useComposerDraftStore.getState().getComposerDraft(draftTarget)?.prompt ?? "",
    readStored: () => readStoredDraftPrompt(draftTarget),
    armSend: () => armSendWhenReady(draftTarget),
    disarmSend: () => disarmSendWhenReady(draftTarget),
    markFilled: (jobId) => markDictationFilled(draftTarget, jobId),
  };
}

function slotHostFor(owner: Pick<OwnDictationJob, "target" | "question">): DictationSlotHost {
  return owner.question
    ? questionSlotHost(owner.question)
    : draftSlotHost(toComposerThreadTarget(owner.target));
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
  // A new recording replaces the last delivery result or failure in the widget.
  recordDictationDelivery(null);
  recordDictationFailure(null);
  const now = Date.now();
  useDictationSessionStore.setState({
    session: {
      sessionId: randomUUID(),
      mode: DEFAULT_DICTATION_MODE,
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

function uploadDictationAudio(
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
 * The audio of jobs that have not reached the server yet, so a failed upload or start can be
 * retried. Only this tab holds it; after a reload such a job can only be discarded.
 */
const unstartedAudio = new Map<string, { audio: DictationAudio; durationMs: number }>();

/**
 * A job that never reached the server. A save-only job has no marker and is dropped. A marker
 * stays, shown as failed, so an armed draft does not send without its transcript.
 */
/** Tells the desktop widget that an attempt of this device's job failed. */
function announceFailed(jobId: string, own: Pick<OwnDictationJob, "target">) {
  // Strictly increasing: the desktop tells a new failure from a dismissed one by this time.
  lastFailureAt = Math.max(Date.now(), lastFailureAt + 1);
  recordDictationFailure({ jobId, at: lastFailureAt, target: dictationTargetLabel(own.target) });
}

/** A new attempt of `jobId` began: the widget's notice of its last failure is no longer true. */
function clearFailureNotice(jobId: string) {
  if (useDictationWidgetActivityStore.getState().failed?.jobId === jobId) {
    recordDictationFailure(null);
  }
}

function failToStart(jobId: DictationJobId, host: DictationSlotHost, cause: unknown) {
  const { lastJob } = useDictationSessionStore.getState();
  if (lastJob?.jobId === jobId) useDictationSessionStore.setState({ lastJob: null });
  const own = useOwnDictationJobsStore.getState().jobs[jobId];
  if (own) announceFailed(jobId, own);
  reportError("Dictation could not be sent for transcription", cause);
  if (useOwnDictationJobsStore.getState().jobs[jobId]?.mode === "clipboard") {
    forgetOwnDictationJob(jobId);
    unstartedAudio.delete(jobId);
    host.remove(jobId);
    return;
  }
  updateOwnDictationJob(jobId, { notStarted: errorMessage(cause) });
}

/** Uploads the audio and starts the server job, in whatever mode the job has by then. */
async function startDictationJob(
  jobId: DictationJobId,
  own: Pick<OwnDictationJob, "environmentId" | "target">,
  audio: DictationAudio,
  durationMs: number,
): Promise<void> {
  const attachmentId = await uploadDictationJobAudio(jobId, own, audio, durationMs);
  await startUploadedDictationJob(jobId, own, attachmentId, durationMs);
}

/** Keeps the audio for a retry, then uploads it. */
function uploadDictationJobAudio(
  jobId: DictationJobId,
  own: Pick<OwnDictationJob, "environmentId">,
  audio: DictationAudio,
  durationMs: number,
): Promise<string> {
  unstartedAudio.set(jobId, { audio, durationMs });
  return uploadDictationAudio(own.environmentId, audio, jobId);
}

async function startUploadedDictationJob(
  jobId: DictationJobId,
  own: Pick<OwnDictationJob, "environmentId" | "target">,
  attachmentId: string,
  durationMs: number,
): Promise<void> {
  const { environmentId } = own;
  // A mode key pressed during the upload changed the record, not a server job.
  const mode = useOwnDictationJobsStore.getState().jobs[jobId]?.mode ?? DEFAULT_DICTATION_MODE;
  const target = mode === "clipboard" ? null : own.target;
  const result = await runAtomCommand(
    appAtomRegistry,
    dictationEnvironment.start,
    { environmentId, input: { jobId, attachmentId, durationMs, mode, target } },
    { reportFailure: false },
  );
  if (result._tag !== "Success") throw squashAtomCommandFailure(result);
  unstartedAudio.delete(jobId);
  startedJobIds.add(jobId);
  // A mode key pressed while the start was on the wire changed only the record.
  const latest = useOwnDictationJobsStore.getState().jobs[jobId]?.mode;
  if (latest !== undefined && latest !== mode) sendModeChange(environmentId, jobId, latest);
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
  const { environmentId } = composer;
  const host = slotHostFor(composer);
  // Recorded before the marker drops: nothing below reads it, and the shared stop order owns
  // what follows (marker, arm, upload, start).
  recordOwnDictationJob(jobId, {
    environmentId,
    target: composer.target,
    mode: session.mode,
    createdAt: now,
    ...(composer.question ? { question: composer.question } : {}),
  });
  lastJobRestored = true;
  useDictationSessionStore.setState({ lastJob: { environmentId, jobId } });

  await runDictationStop({
    jobId,
    mode: session.mode,
    placeMarker: (id) => placeDictationSlot(composer, id),
    armSend: () => host.armSend(),
    finishRecording: () => recording.stop(),
    upload: (id, audio) => uploadDictationJobAudio(id, composer, audio, durationMs),
    start: (id, attachmentId) => startUploadedDictationJob(id, composer, attachmentId, durationMs),
    onFailed: (id, cause) => failToStart(id, host, cause),
  });
}

export async function toggleDictation(): Promise<void> {
  if (useDictationSessionStore.getState().session) await stopDictation();
  else await startDictation();
}

/** Drops the marker at the composer's caret when it is the one on screen, else at the end. */
function placeDictationSlot(composer: DictationComposer, jobId: DictationJobId) {
  markersHeldInTab.add(jobId);
  const slot = formatDictationSlot(jobId);
  if (!(composer.insertSlot?.(slot) ?? false)) slotHostFor(composer).append(slot);
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
  const host = slotHostFor(own);
  if (own.mode === "clipboard") {
    const composer =
      lastComposer &&
      sameTarget(lastComposer.target, own.target) &&
      lastComposer.question?.questionId === own.question?.questionId
        ? lastComposer
        : null;
    placeDictationSlot(
      composer ?? {
        environmentId: own.environmentId,
        target: own.target,
        draftTarget: toComposerThreadTarget(own.target),
        insertSlot: null,
        ...(own.question ? { question: own.question } : {}),
      },
      lastJob.jobId,
    );
  } else if (mode === "clipboard") {
    host.remove(lastJob.jobId);
  }
  if (mode === "submit") host.armSend();
  else if (own.mode === "submit") host.disarmSend();
  if (startedJobIds.has(lastJob.jobId)) sendModeChange(lastJob.environmentId, lastJob.jobId, mode);
}

export function cycleDictationMode(): void {
  const { session, lastJob } = useDictationSessionStore.getState();
  const current =
    session?.mode ??
    (lastJob ? useOwnDictationJobsStore.getState().jobs[lastJob.jobId]?.mode : undefined) ??
    DEFAULT_DICTATION_MODE;
  selectDictationMode(nextDictationMode(current));
}

export function retryDictationJob(jobId: string): void {
  const own = useOwnDictationJobsStore.getState().jobs[jobId];
  if (!own) return;
  clearFailureNotice(jobId);
  if (own.notStarted !== undefined) {
    const kept = unstartedAudio.get(jobId);
    if (!kept) {
      reportError("The recording is no longer available", "Discard the marker and dictate again.");
      return;
    }
    const id = DictationJobId.make(jobId);
    updateOwnDictationJob(jobId, { notStarted: undefined });
    void startDictationJob(id, own, kept.audio, kept.durationMs).catch((cause: unknown) =>
      failToStart(id, slotHostFor(own), cause),
    );
    return;
  }
  void runAtomCommand(appAtomRegistry, dictationEnvironment.retry, {
    environmentId: own.environmentId,
    input: { jobId: DictationJobId.make(jobId) },
  });
}

/** Drops a failed job's marker; the recording stays in the Transcriptions list for a retry. */
export function discardDictationJob(jobId: string): void {
  const own = useOwnDictationJobsStore.getState().jobs[jobId];
  if (!own) return;
  unstartedAudio.delete(jobId);
  slotHostFor(own).remove(jobId);
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
  return findDictationSlots(slotHostFor(own).read()).some((slot) => slot.jobId === jobId);
}

/** One completed job, in this tab. See `OwnDictationJob` for the cross-tab rule. */
async function deliverCompletedJob(job: DictationJob, own: OwnDictationJob): Promise<void> {
  const draftTarget = toComposerThreadTarget(own.target);
  const host = slotHostFor(own);
  const settle = () => {
    settledInTab.add(job.id);
    filledAwaitingWrite.delete(job.id);
    updateOwnDictationJob(job.id, { handled: true });
  };
  const announceDelivered = () => {
    if (own.handled) return;
    recordDictationDelivery({
      at: Date.now(),
      mode: own.mode,
      target: dictationTargetLabel(own.target),
    });
  };
  if (own.mode === "clipboard") {
    host.remove(job.id);
    if (!own.handled && (await copyTranscript(own.environmentId, job.text ?? ""))) {
      announceDelivered();
    }
    settle();
    return;
  }
  if (filledAwaitingWrite.has(job.id)) {
    if (persistComposerDrafts()) settle();
    return;
  }
  const outcome = host.fill(job.id, job.text ?? "");
  // The text is in the draft from here on, written through or not.
  if (outcome !== "missing") {
    host.markFilled(job.id);
    announceDelivered();
  }
  if (outcome === "unsaved") {
    filledAwaitingWrite.add(job.id);
    return;
  }
  if (outcome === "missing") {
    if (markersHeldInTab.has(job.id)) {
      // The user deleted it here. Write that edit through before judging storage.
      if (!own.handled) {
        persistComposerDrafts();
        await announceIfLost(job, own, host, MARKER_DELETED);
      }
      settle();
    } else {
      settledInTab.add(job.id);
      setTimeout(() => void announceIfUnclaimed(job, host), UNCLAIMED_GRACE_MS);
    }
    return;
  }
  // Only a composer draft is written whole by every tab; an answer is not watched.
  if (outcome === "filled" && job.text && !own.question) {
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
  host: DictationSlotHost,
  description: string,
) {
  const stored = await host.readStored();
  if (stored !== null && job.text && stored.includes(job.text)) return;
  if (stored !== null && findDictationSlots(stored).some((slot) => slot.jobId === job.id)) return;
  announceKeptOnce(job.id, own.environmentId, description);
}

/**
 * A job whose marker this tab never held belongs to the tab that holds it. If no tab delivered
 * it within the grace period and storage holds neither its text nor its marker, another tab's
 * save took the marker away, and this tab says so.
 */
async function announceIfUnclaimed(job: DictationJob, host: DictationSlotHost) {
  const own = useOwnDictationJobsStore.getState().jobs[job.id];
  if (!own || own.handled || own.noticed) return;
  await announceIfLost(job, own, host, OVERWRITTEN_BY_OTHER_TAB);
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
  const ownJobs = useOwnDictationJobsStore.getState().jobs;
  // The jobs this tab watched transcribe; only their failures happen now.
  const watched = new Set(useDictationWidgetActivityStore.getState().transcribing[environmentId]);
  const lastJobId = useDictationSessionStore.getState().lastJob?.jobId;
  if (lastJobId) watched.add(lastJobId);
  setTranscribingDictationJobs(
    environmentId,
    jobs.filter((job) => job.status === "transcribing" && job.id in ownJobs).map((job) => job.id),
  );
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
    // Transcribing again after a failure: a retry from here, another tab or the list.
    if (job.status === "transcribing") clearFailureNotice(job.id);
    if (job.status === "failed") {
      const attempt = job.completedAt ?? job.createdAt;
      const previous = seenFailedAttempts.get(job.id);
      const newAttempt = previous !== attempt;
      seenFailedAttempts.set(job.id, attempt);
      // News for the widget when it happened now: this tab saw the job transcribe, or saw an
      // earlier attempt fail (a retry). A failure first met after a reload is old news.
      if (newAttempt && !own.handled && (previous !== undefined || watched.has(job.id))) {
        announceFailed(job.id, own);
      }
      if (own.mode === "clipboard" && !own.handled && newAttempt) {
        reportError("Transcription failed", job.failure);
      }
      continue;
    }
    if (job.status !== "completed") continue;
    delivering.add(job.id);
    void deliverCompletedJob(job, own).finally(() => delivering.delete(job.id));
  }
}
