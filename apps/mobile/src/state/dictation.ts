import { useAtomValue } from "@effect/atom-react";
import {
  armedDraftSendDecision,
  createDictationDeliveryLedger,
  runDictationStop,
} from "@t3tools/client-runtime/dictation";
import {
  DictationJobId,
  type DictationJob,
  type DictationMode,
  type DictationTarget,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  appendDictationSlot,
  fillDictationSlot,
  findDictationSlots,
  formatDictationSlot,
  insertDictationSlotAt,
  removeDictationSlot,
} from "@t3tools/shared/dictationSlots";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";
import { Alert } from "react-native";

import { scopedThreadKey } from "../lib/scopedEntities";
import { uuidv4 } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { dictationEnvironment } from "./dictationEnvironment";
import {
  armDictationDraft,
  dictationDraftGeneration,
  disarmDictationDraft,
  draftsWithDictationState,
  forgetAllDictationDrafts,
  forgetDictationDraft,
  isDictationDraftArmed,
  markDictationDraftVoiced,
} from "./dictationDrafts";
import {
  loadDictationJobRecords,
  recordingFileExists,
  saveDictationJobRecords,
  type DictationJobRecord,
} from "./dictationJobStore";
import {
  retryDictationJobOnServer,
  startDictationJob,
  uploadDictationAudio,
  type DictationRecordingFile,
} from "./dictationTransport";
import {
  composerDraftsAtom,
  flushComposerDrafts,
  getComposerDraftSnapshot,
  readComposerDraftSelection,
  rememberComposerDraftSelection,
  setComposerDraftText,
} from "./use-composer-drafts";
import { sendComposerDraftToThread } from "./sendComposerDraft";
import {
  readUserInputDraftCustomAnswer,
  setUserInputDraftCustomAnswerText,
} from "./use-selected-thread-requests";

/**
 * Mobile dictation through the server, end to end once the recorder stops: the marker drops at
 * the remembered caret, the audio uploads, the server job starts, and the job stream fills the
 * marker when the transcript lands, whether or not the draft's screen is mounted. An armed draft
 * sends itself when its last marker fills. The order and the decisions are the shared ones in
 * `@t3tools/client-runtime/dictation`; this module owns only where the text lives on the phone.
 */

/** Where a stopped recording drops its marker and where its transcript goes. */
export interface DictationOwner {
  readonly environmentId: EnvironmentId;
  /** The composer draft key: `scopedThreadKey(...)` for a thread, the new-task key for a draft. */
  readonly draftKey: string;
  readonly target: Exclude<DictationTarget, null>;
  /** Set for a question card: the marker goes into that answer, not into the draft. */
  readonly question?: { readonly requestKey: string; readonly questionId: string };
}

interface OwnDictationJob {
  readonly owner: DictationOwner;
  readonly mode: DictationMode;
  readonly recording: DictationRecordingFile | null;
  /** `uploading` until the server accepted the start; a retry then uploads the recording again. */
  readonly upload: "uploading" | "started";
  /** The draft generation the marker dropped in; see `dictationDrafts`. */
  readonly generation: number;
}

/** Jobs recorded on this phone, by job id, mirrored to disk by `persistOwnJobs`. */
const ownJobs = new Map<string, OwnDictationJob>();
let ledger = createDictationDeliveryLedger();

function persistOwnJobs(): Promise<void> {
  return saveDictationJobRecords([...ownJobs].map(([jobId, own]) => ({ jobId, ...own }))).catch(
    () => undefined,
  );
}

export interface DictationFailure {
  readonly jobId: string;
  readonly draftKey: string;
  readonly message: string;
  /** Whether Retry can work: the server holds the job, or this phone still has its recording. */
  readonly retryable: boolean;
}

/** Jobs whose upload, start or transcription failed, with the reason the user is shown. */
const dictationFailuresAtom = Atom.make<Record<string, DictationFailure>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:dictation-failures"),
);

function setFailure(jobId: string, failure: DictationFailure | null) {
  const current = appAtomRegistry.get(dictationFailuresAtom);
  if (failure === null && !(jobId in current)) return;
  const next = { ...current };
  if (failure === null) delete next[jobId];
  else next[jobId] = failure;
  appAtomRegistry.set(dictationFailuresAtom, next);
}

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Reads, rewrites and arms the text a job's marker lives in. */
interface DictationTextHost {
  readonly read: () => string;
  readonly write: (text: string) => void;
  /** Puts the marker at the remembered caret, else after the text. */
  readonly place: (slot: string) => void;
}

function draftHost(draftKey: string): DictationTextHost {
  const read = () => getComposerDraftSnapshot(draftKey).text;
  return {
    read,
    write: (text) => setComposerDraftText(draftKey, text),
    place: (slot) => {
      const text = read();
      const caret = readComposerDraftSelection(draftKey, text);
      const next = caret
        ? insertDictationSlotAt(text, caret.start, slot)
        : appendDictationSlot(text, slot);
      setComposerDraftText(draftKey, next);
      // A second recording lands after this marker, not before it.
      const after = next.indexOf(slot) + slot.length;
      rememberComposerDraftSelection(draftKey, next, { start: after, end: after });
    },
  };
}

function questionHost(question: NonNullable<DictationOwner["question"]>): DictationTextHost {
  const read = () => readUserInputDraftCustomAnswer(question.requestKey, question.questionId);
  const write = (text: string) =>
    setUserInputDraftCustomAnswerText(question.requestKey, question.questionId, text);
  return {
    read,
    write,
    // The card dictates into the end of the note, as upstream's voice input did.
    place: (slot) => write(appendDictationSlot(read(), slot)),
  };
}

function hostFor(owner: DictationOwner): DictationTextHost {
  return owner.question ? questionHost(owner.question) : draftHost(owner.draftKey);
}

/** Who sends an armed new-task draft: only its mounted screen can start the thread. */
const newTaskSenders = new Map<string, () => void>();

/** Registers the mounted new-task screen as the sender of its armed draft. */
export function registerDictationDraftSender(draftKey: string, send: () => void): () => void {
  newTaskSenders.set(draftKey, send);
  return () => {
    if (newTaskSenders.get(draftKey) === send) newTaskSenders.delete(draftKey);
  };
}

/** Tells the user an armed draft did not send; the text stays in the draft. */
export function reportDictatedDraftUnsent(draftKey: string, description: string): void {
  disarmDictationDraft(draftKey);
  Alert.alert("The dictated draft was not sent", description);
}

/**
 * Sends an armed draft once its last marker filled. A job from an earlier generation of the
 * draft (sent or cleared since its marker dropped) never sends the draft that replaced it.
 */
function sendIfReady(owner: DictationOwner, generation: number) {
  const { draftKey } = owner;
  if (owner.question || !isDictationDraftArmed(draftKey)) return;
  if (generation !== dictationDraftGeneration(draftKey)) return;
  const draft = getComposerDraftSnapshot(draftKey);
  const decision = armedDraftSendDecision({
    armed: true,
    prompt: draft.text,
    hasAttachments: draft.attachments.length > 0,
  });
  if (decision === "forget") {
    forgetDictationDraft(draftKey);
    return;
  }
  if (decision === "wait") return;
  if (owner.target.kind === "thread") {
    disarmDictationDraft(draftKey);
    const { environmentId, threadId } = owner.target;
    void sendComposerDraftToThread({ environmentId, threadId })
      .then((messageId) => {
        if (messageId === null) {
          reportDictatedDraftUnsent(
            draftKey,
            "This thread cannot take it right now. The text is in the draft.",
          );
        }
      })
      .catch((cause: unknown) => reportDictatedDraftUnsent(draftKey, errorMessage(cause)));
    return;
  }
  const send = newTaskSenders.get(draftKey);
  if (send) {
    disarmDictationDraft(draftKey);
    send();
    return;
  }
  // A new task starts a thread from its screen's project and model; with the screen gone there
  // is nothing to start it from, so the text stays for the user to send.
  reportDictatedDraftUnsent(
    draftKey,
    "Its screen was closed before the transcription finished. The text is in the draft.",
  );
}

async function uploadAndStart(jobId: DictationJobId, own: OwnDictationJob): Promise<void> {
  if (!own.recording) throw new Error("The recording is no longer available.");
  const attachmentId = await uploadDictationAudio(own.owner.environmentId, jobId, own.recording);
  await startOnServer(jobId, attachmentId);
}

async function startOnServer(jobId: DictationJobId, attachmentId: string): Promise<void> {
  const own = ownJobs.get(jobId);
  if (!own) return;
  await startDictationJob(own.owner.environmentId, {
    jobId,
    attachmentId,
    durationMs: own.recording?.durationMs ?? 0,
    mode: own.mode,
    target: own.mode === "clipboard" ? null : own.owner.target,
  });
  const latest = ownJobs.get(jobId);
  if (latest) {
    ownJobs.set(jobId, { ...latest, upload: "started" });
    void persistOwnJobs();
  }
}

function failToStart(jobId: string, cause: unknown, message = errorMessage(cause)) {
  const own = ownJobs.get(jobId);
  if (!own) return;
  ownJobs.set(jobId, { ...own, upload: "uploading" });
  setFailure(jobId, {
    jobId,
    draftKey: own.owner.draftKey,
    message,
    retryable: own.recording !== null,
  });
}

/** Stop: marker at the remembered caret, upload, then start the server job. */
export async function finishDictation(input: {
  readonly owner: DictationOwner;
  readonly mode: DictationMode;
  readonly recording: DictationRecordingFile;
}): Promise<{ readonly jobId: DictationJobId; readonly status: "started" | "failed" }> {
  const { owner, mode, recording } = input;
  const jobId = DictationJobId.make(uuidv4());
  ownJobs.set(jobId, {
    owner,
    mode,
    recording,
    upload: "uploading",
    generation: dictationDraftGeneration(owner.draftKey),
  });
  const status = await runDictationStop({
    jobId,
    mode,
    placeMarker: (id) => hostFor(owner).place(formatDictationSlot(id)),
    // Question cards: send mode arms nothing; the user submits the answers with Submit.
    armSend: () => {
      if (!owner.question) armDictationDraft(owner.draftKey);
    },
    // The record and the marker reach disk before the upload, so a restart can find them.
    finishRecording: async () => {
      await persistOwnJobs();
      await flushComposerDrafts().catch(() => undefined);
      return recording;
    },
    upload: (id, file) => uploadDictationAudio(owner.environmentId, id, file),
    start: startOnServer,
    onFailed: (id, cause) => failToStart(id, cause),
  });
  return { jobId, status };
}

/** Why a job failed, or `null` while it has not. */
export function readDictationJobFailure(jobId: string): string | null {
  return appAtomRegistry.get(dictationFailuresAtom)[jobId]?.message ?? null;
}

/** Whether the failed job's Retry can work. */
export function isDictationJobRetryable(jobId: string): boolean {
  return appAtomRegistry.get(dictationFailuresAtom)[jobId]?.retryable === true;
}

/** The failed jobs whose marker is in this draft, for the banner above its composer. */
export function useDictationFailures(draftKey: string | null): ReadonlyArray<DictationFailure> {
  const failures = useAtomValue(dictationFailuresAtom);
  return useMemo(
    () =>
      draftKey === null
        ? []
        : Object.values(failures).filter((failure) => failure.draftKey === draftKey),
    [draftKey, failures],
  );
}

/** Uploads and starts a job that never reached the server, or asks the server to try again. */
export async function retryDictationJob(jobId: string): Promise<"started" | "failed"> {
  const own = ownJobs.get(jobId);
  if (!own) return "failed";
  const id = DictationJobId.make(jobId);
  setFailure(jobId, null);
  try {
    if (own.upload === "uploading") await uploadAndStart(id, own);
    else await retryDictationJobOnServer(own.owner.environmentId, id);
    return "started";
  } catch (cause) {
    failToStart(jobId, cause);
    return "failed";
  }
}

/** Drops a failed job's marker; the recording stays on the server for its own list. */
export function discardDictationJob(jobId: string): void {
  const own = ownJobs.get(jobId);
  setFailure(jobId, null);
  if (!own) return;
  const host = hostFor(own.owner);
  const removed = removeDictationSlot(host.read(), jobId);
  if (!("missing" in removed)) host.write(removed.text);
  ownJobs.delete(jobId);
  void persistOwnJobs();
  sendIfReady(own.owner, own.generation);
}

/** Draft keys a job's target can live under on this phone. */
function draftKeyForTarget(target: DictationTarget): string | null {
  if (target === null) return null;
  return target.kind === "thread"
    ? scopedThreadKey(target.environmentId, target.threadId)
    : target.draftId;
}

function holdsMarker(owner: DictationOwner, jobId: string): boolean {
  return findDictationSlots(hostFor(owner).read()).some((slot) => slot.jobId === jobId);
}

/**
 * A job the server holds whose marker is still in the draft its target names is adopted, even
 * without a record: the record write may not have landed before the app was killed.
 */
function adoptOrphanedJob(environmentId: EnvironmentId, job: DictationJob) {
  if (ownJobs.has(job.id) || !job.target) return;
  const draftKey = draftKeyForTarget(job.target);
  if (draftKey === null) return;
  const owner: DictationOwner = { environmentId, draftKey, target: job.target };
  if (!holdsMarker(owner, job.id)) return;
  ownJobs.set(job.id, {
    owner,
    mode: job.mode,
    recording: null,
    upload: "started",
    generation: dictationDraftGeneration(draftKey),
  });
  if (job.mode === "submit") armDictationDraft(draftKey);
}

/** Records the last process left on disk, until each environment's first job list settles them. */
let restoredRecords: Promise<DictationJobRecord[]> | null = null;
const reconciledEnvironments = new Set<string>();

/**
 * Settles the records a killed process left, against the environment's job list: a job the
 * server knows is this phone's again; one it never received keeps its marker as an interrupted
 * failure, which Retry uploads again while the recording file exists, and Discard removes.
 */
async function reconcileRestoredJobs(
  environmentId: EnvironmentId,
  jobs: ReadonlyArray<DictationJob>,
): Promise<void> {
  if (reconciledEnvironments.has(environmentId)) return;
  reconciledEnvironments.add(environmentId);
  restoredRecords ??= loadDictationJobRecords().then((records) => [...records]);
  const records = await restoredRecords;
  const mine = records.filter((record) => record.owner.environmentId === environmentId);
  for (const record of mine) {
    records.splice(records.indexOf(record), 1);
    if (ownJobs.has(record.jobId)) continue;
    const { jobId, owner, mode, recording } = record;
    if (!holdsMarker(owner, jobId) && mode !== "clipboard") continue;
    const known = jobs.some((job) => job.id === jobId);
    ownJobs.set(jobId, {
      owner,
      mode,
      recording,
      upload: known ? "started" : "uploading",
      generation: dictationDraftGeneration(owner.draftKey),
    });
    if (known) {
      if (mode === "submit" && !owner.question) armDictationDraft(owner.draftKey);
      continue;
    }
    const retryable = recording !== null && (await recordingFileExists(recording.uri));
    setFailure(jobId, { jobId, draftKey: owner.draftKey, message: "Interrupted", retryable });
  }
  if (mine.length > 0) await persistOwnJobs();
}

async function copyTranscript(text: string) {
  try {
    const Clipboard = await import("expo-clipboard");
    await Clipboard.setStringAsync(text);
  } catch (cause) {
    Alert.alert("Could not copy the transcription", errorMessage(cause));
  }
}

function deliver(job: DictationJob, own: OwnDictationJob) {
  ownJobs.delete(job.id);
  void persistOwnJobs();
  if (own.mode === "clipboard") {
    void copyTranscript(job.text ?? "");
    return;
  }
  const host = hostFor(own.owner);
  const filled = fillDictationSlot(host.read(), job.id, job.text ?? "");
  // A deleted marker is the user's decision; the transcript stays in the server's list.
  if ("missing" in filled) return;
  host.write(filled.text);
  if (!own.owner.question) markDictationDraftVoiced(own.owner.draftKey);
  sendIfReady(own.owner, own.generation);
}

/** Fills this device's completed jobs into their drafts, once per job id, on screen or not. */
export function deliverDictationJobs(
  environmentId: EnvironmentId,
  jobs: ReadonlyArray<DictationJob>,
): void {
  for (const job of jobs) {
    adoptOrphanedJob(environmentId, job);
    const own = ownJobs.get(job.id);
    if (!own || own.owner.environmentId !== environmentId) continue;
    if (job.status === "failed") {
      setFailure(job.id, {
        jobId: job.id,
        draftKey: own.owner.draftKey,
        message: job.failure ?? "The transcription failed.",
        retryable: true,
      });
    } else {
      // Transcribing again, or completed straight after a failure (a retry from another client
      // or a reconnect): the failure no longer holds.
      setFailure(job.id, null);
    }
  }
  const ready = ledger.take(
    jobs,
    (jobId) => ownJobs.get(jobId)?.owner.environmentId === environmentId,
  );
  for (const job of ready) {
    const own = ownJobs.get(job.id);
    if (own) deliver(job, own);
  }
}

/**
 * Subscribes to one environment's job stream and delivers every update, for as long as the
 * returned function is not called. Mounted once per connected environment, not per composer.
 */
export function watchDictationJobs(environmentId: EnvironmentId): () => void {
  const atom = dictationEnvironment.jobs({ environmentId, input: {} });
  let queue = Promise.resolve();
  const onJobs = (result: AsyncResult.AsyncResult<ReadonlyArray<DictationJob>, unknown>) => {
    if (result === undefined || !AsyncResult.isAsyncResult(result)) return;
    Option.match(AsyncResult.value(result), {
      onNone: () => undefined,
      onSome: (jobs) => {
        queue = queue
          .then(() => reconcileRestoredJobs(environmentId, jobs))
          .then(() => deliverDictationJobs(environmentId, jobs))
          .catch(() => undefined);
      },
    });
  };
  return appAtomRegistry.subscribe(atom, onJobs, { immediate: true });
}

/**
 * Drops everything a process restart loses: the jobs in memory, their failures and what was
 * delivered. Tests use it to restart against the records on disk.
 */
export function forgetDictationSessionState(): void {
  ownJobs.clear();
  ledger = createDictationDeliveryLedger();
  restoredRecords = null;
  reconciledEnvironments.clear();
  appAtomRegistry.set(dictationFailuresAtom, {});
  forgetAllDictationDrafts();
}

// A draft that was cleared or sent by any path loses its armed and voiced state at once, and
// starts a new generation, so a transcript from before cannot arm or send its replacement.
appAtomRegistry.subscribe(composerDraftsAtom, () => {
  for (const draftKey of draftsWithDictationState()) {
    const draft = getComposerDraftSnapshot(draftKey);
    if (draft.text.trim() === "" && draft.attachments.length === 0) forgetDictationDraft(draftKey);
  }
});
