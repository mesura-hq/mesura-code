/**
 * Simulation model for the dictation prototype. Nothing here talks to a
 * server or a provider: recording, audio level, and transcription are timers.
 * The drafts themselves live in one Lexical editor per thread
 * (`draftEditors.ts`); this store owns everything around them.
 */
import type { SymmetriaDictationMode } from "@symmetria/broker-contract";
import { create } from "zustand";

import { nextDictationMode } from "~/symmetria/dictationPresentation";

import {
  countDictationSlots,
  fillDictationSlot,
  insertDictationSlotAtCaret,
  readDraftText,
  clearDraft,
  removeDictationSlot,
} from "./draftEditors";

/**
 * How a transcript is delivered, with the Shell protocol's names. As in Shell,
 * Alt+S, Alt+I and Alt+Enter only select the mode; stopping is separate, and
 * the mode stays changeable while the transcript is on its way.
 */
export type DeliveryMode = SymmetriaDictationMode;

export type JobStatus = "transcribing" | "failed";

export interface DictationJob {
  readonly id: string;
  readonly threadId: string;
  readonly status: JobStatus;
  readonly mode: DeliveryMode;
  readonly recordedMs: number;
}

/** A recording has no target: the marker drops at the caret when it stops. */
export interface RecordingState {
  readonly sessionId: string;
  readonly startedAt: string;
  readonly mode: DeliveryMode;
  /** Recorded time banked before the current run of the clock. */
  readonly bankedMs: number;
  /** Start of the current run, or null while paused. */
  readonly runningSince: number | null;
  readonly level: number;
}

export interface ThreadMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface PrototypeThread {
  readonly id: string;
  readonly title: string;
  readonly project: string;
  readonly messages: ReadonlyArray<ThreadMessage>;
  /** Send this draft as soon as its last pending slot is filled. */
  readonly sendWhenReady: boolean;
  /** Dictated text landed in the draft since the last send. */
  readonly containsVoicedText: boolean;
}

export interface SavedTranscription {
  readonly id: string;
  readonly text: string;
  readonly threadTitle: string;
}

export interface Toast {
  readonly id: string;
  readonly text: string;
  readonly tone: "success" | "info" | "error";
}

/** The last delivery, shown briefly by the desktop widget. */
export interface DeliveryFlash {
  readonly id: string;
  readonly text: string;
  readonly at: number;
}

export type TranscriptionSpeed = "fast" | "realistic" | "slow";
export type Scene = "mesura" | "elsewhere";

interface PrototypeState {
  readonly threads: ReadonlyArray<PrototypeThread>;
  readonly activeThreadId: string;
  readonly recording: RecordingState | null;
  readonly jobs: Readonly<Record<string, DictationJob>>;
  readonly saved: ReadonlyArray<SavedTranscription>;
  readonly toasts: ReadonlyArray<Toast>;
  readonly flash: DeliveryFlash | null;
  readonly scene: Scene;
  readonly speed: TranscriptionSpeed;
  readonly defaultMode: DeliveryMode;
  readonly failNext: boolean;
  /** The job the mode keys reach once the recording has stopped. */
  readonly lastJobId: string | null;
}

const SEED_THREADS: ReadonlyArray<PrototypeThread> = [
  {
    id: "thread-stt",
    title: "STT redesign",
    project: "mesura-code",
    sendWhenReady: false,
    containsVoicedText: false,
    messages: [
      { id: "m1", role: "user", text: "Move speech-to-text into the Mesura server." },
      {
        id: "m2",
        role: "assistant",
        text: "The server can own transcription. Clients only record and upload the audio.",
      },
    ],
  },
  {
    id: "thread-bar",
    title: "Agent bar chips",
    project: "symmetria-shell",
    sendWhenReady: false,
    containsVoicedText: false,
    messages: [
      { id: "m3", role: "user", text: "The agent chips flicker when a turn ends." },
      { id: "m4", role: "assistant", text: "The chip re-renders on every token. I can batch it." },
    ],
  },
  {
    id: "thread-fm",
    title: "File manager finder",
    project: "mesura-code",
    sendWhenReady: false,
    containsVoicedText: false,
    messages: [
      { id: "m5", role: "user", text: "Add fuzzy search to the Miller columns." },
      { id: "m6", role: "assistant", text: "Done. Ctrl+P opens the finder in the current column." },
    ],
  },
];

const SAMPLE_TRANSCRIPTS = [
  "and make sure the shadow caret keeps its place while I keep typing around it",
  "también quiero que el widget desaparezca apenas se entrega la transcripción",
  "check how the Android client uploads the audio before it starts the job",
  "the send should wait until the last transcription in this draft lands",
  "I think we can reuse the attachment upload route for the recordings",
  "si borro el marcador, el texto tiene que ir a Transcriptions y no perderse",
  "let's keep alt I, alt enter and alt S exactly like the shell had them",
];

let idCounter = 0;
const nextId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;
let sampleCursor = 0;

function sampleTranscript(recordedMs: number): string {
  const first = SAMPLE_TRANSCRIPTS[sampleCursor++ % SAMPLE_TRANSCRIPTS.length]!;
  if (recordedMs < 12_000) return first;
  const second = SAMPLE_TRANSCRIPTS[sampleCursor++ % SAMPLE_TRANSCRIPTS.length]!;
  return `${first}, ${second}`;
}

function transcriptionDelayMs(speed: TranscriptionSpeed, recordedMs: number): number {
  if (speed === "fast") return 900;
  if (speed === "slow") return 6_000 + recordedMs * 0.3;
  return 1_500 + recordedMs * 0.15;
}

export function recordedMsAt(recording: RecordingState, now: number): number {
  return recording.bankedMs + (recording.runningSince === null ? 0 : now - recording.runningSince);
}

export const usePrototypeStore = create<PrototypeState>(() => ({
  threads: SEED_THREADS,
  activeThreadId: SEED_THREADS[0]!.id,
  recording: null,
  jobs: {},
  saved: [],
  toasts: [],
  flash: null,
  scene: "mesura",
  speed: "realistic",
  defaultMode: "submit",
  failNext: false,
  lastJobId: null,
}));

const get = usePrototypeStore.getState;
const set = usePrototypeStore.setState;

function threadTitle(threadId: string): string {
  return get().threads.find((thread) => thread.id === threadId)?.title ?? threadId;
}

function updateThread(threadId: string, patch: (thread: PrototypeThread) => PrototypeThread) {
  set((state) => ({
    threads: state.threads.map((thread) => (thread.id === threadId ? patch(thread) : thread)),
  }));
}

function setJob(job: DictationJob) {
  set((state) => ({ jobs: { ...state.jobs, [job.id]: job } }));
}

function dropJob(jobId: string) {
  set((state) => {
    const { [jobId]: _dropped, ...rest } = state.jobs;
    return { jobs: rest };
  });
}

export function pushToast(text: string, tone: Toast["tone"] = "success") {
  const toast = { id: nextId("toast"), text, tone };
  set((state) => ({ toasts: [...state.toasts, toast].slice(-4) }));
  window.setTimeout(() => {
    set((state) => ({ toasts: state.toasts.filter((entry) => entry.id !== toast.id) }));
  }, 2_600);
}

function flashDelivery(text: string) {
  set({ flash: { id: nextId("flash"), text, at: Date.now() } });
}

/** A delivery the user may not be looking at: toast in Mesura, flash on the widget. */
function announce(text: string, threadId: string) {
  const { scene, activeThreadId } = get();
  flashDelivery(text);
  if (scene === "mesura" && threadId !== activeThreadId) pushToast(text);
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // The tailnet URL is plain http on some setups, where the async clipboard
    // API is missing. The prototype only needs a best effort.
    return false;
  }
}

function saveTranscription(text: string, threadId: string, reason: string) {
  set((state) => ({
    saved: [
      { id: nextId("saved"), text, threadTitle: threadTitle(threadId) },
      ...state.saved,
    ].slice(0, 20),
  }));
  void copyToClipboard(text);
  announce(reason, threadId);
  if (get().scene === "mesura" && threadId === get().activeThreadId) pushToast(reason, "info");
}

let levelTimer: number | null = null;

function startLevelSimulation() {
  if (levelTimer !== null) return;
  let phase = 0;
  levelTimer = window.setInterval(() => {
    const recording = get().recording;
    if (!recording) return;
    phase += 1;
    // Speech-like: syllable bursts with short gaps, silence while paused.
    const burst = Math.max(0, Math.sin(phase * 0.9) + Math.sin(phase * 0.37) * 0.6);
    const level =
      recording.runningSince === null
        ? 0
        : Math.min(0.9, 0.03 + burst * 0.05 + Math.random() * 0.04);
    set({ recording: { ...recording, level } });
  }, 90);
}

function stopLevelSimulation() {
  if (levelTimer === null) return;
  window.clearInterval(levelTimer);
  levelTimer = null;
}

export function startRecording() {
  if (get().recording) return;
  set({
    recording: {
      sessionId: nextId("rec"),
      startedAt: new Date().toISOString(),
      mode: get().defaultMode,
      bankedMs: 0,
      runningSince: Date.now(),
      level: 0,
    },
    lastJobId: null,
  });
  startLevelSimulation();
}

export function togglePause() {
  const recording = get().recording;
  if (!recording) return;
  const now = Date.now();
  set({
    recording:
      recording.runningSince === null
        ? { ...recording, runningSince: now }
        : { ...recording, bankedMs: recordedMsAt(recording, now), runningSince: null, level: 0 },
  });
}

export function restartRecording() {
  const recording = get().recording;
  if (!recording) return;
  set({ recording: { ...recording, bankedMs: 0, runningSince: Date.now() } });
}

export function cancelRecording() {
  const recording = get().recording;
  if (!recording) return;
  set({ recording: null });
  stopLevelSimulation();
}

/**
 * Stops recording and hands the audio to the (simulated) server. The marker
 * drops here, at the caret of the thread on screen (or the last one shown,
 * when another app has focus), not where the recording started.
 */
export function finishRecording() {
  const recording = get().recording;
  if (!recording) return;
  const threadId = get().activeThreadId;
  const job: DictationJob = {
    id: nextId("job"),
    threadId,
    status: "transcribing",
    mode: recording.mode,
    recordedMs: recordedMsAt(recording, Date.now()),
  };
  set({ recording: null, lastJobId: job.id });
  stopLevelSimulation();
  if (job.mode !== "clipboard") insertDictationSlotAtCaret(threadId, job.id);
  if (job.mode === "submit")
    updateThread(threadId, (thread) => ({ ...thread, sendWhenReady: true }));
  setJob(job);
  scheduleTranscription(job);
}

/** Alt+S, Alt+I, Alt+Enter: the recording's mode, or the last job's while it transcribes. */
export function setDeliveryMode(mode: DeliveryMode): boolean {
  const { recording, lastJobId, jobs } = get();
  if (recording) {
    set({ recording: { ...recording, mode } });
    return true;
  }
  const job = lastJobId ? jobs[lastJobId] : undefined;
  if (!job || job.status !== "transcribing") return false;
  if (job.mode === mode) return true;
  if (mode === "clipboard") removeDictationSlot(job.threadId, job.id);
  if (job.mode === "clipboard") insertDictationSlotAtCaret(job.threadId, job.id);
  if (mode === "submit")
    updateThread(job.threadId, (thread) => ({ ...thread, sendWhenReady: true }));
  if (job.mode === "submit")
    updateThread(job.threadId, (thread) => ({ ...thread, sendWhenReady: false }));
  setJob({ ...job, mode });
  return true;
}

/** The strip's mode button: clipboard → inject → submit, like Shell. */
export function cycleDeliveryMode() {
  const { recording, lastJobId, jobs } = get();
  const current = recording?.mode ?? (lastJobId ? jobs[lastJobId]?.mode : undefined);
  if (current) setDeliveryMode(nextDictationMode(current));
}

function scheduleTranscription(job: DictationJob) {
  window.setTimeout(
    () => {
      if (!get().jobs[job.id]) return;
      if (get().failNext) {
        set({ failNext: false });
        setJob({ ...job, status: "failed" });
        announce(`Transcription failed in ${threadTitle(job.threadId)}`, job.threadId);
        return;
      }
      deliver(job, sampleTranscript(job.recordedMs));
    },
    transcriptionDelayMs(get().speed, job.recordedMs),
  );
}

function deliver(job: DictationJob, text: string) {
  dropJob(job.id);
  if (job.mode === "clipboard") {
    saveTranscription(text, job.threadId, "Saved to Transcriptions and copied");
    return;
  }
  if (!fillDictationSlot(job.threadId, job.id, text)) {
    saveTranscription(
      text,
      job.threadId,
      "Its marker was deleted, so the text went to Transcriptions",
    );
    maybeSendWhenReady(job.threadId);
    return;
  }
  updateThread(job.threadId, (thread) => ({ ...thread, containsVoicedText: true }));
  if (!maybeSendWhenReady(job.threadId)) {
    announce(`Inserted into ${threadTitle(job.threadId)}`, job.threadId);
  }
}

export function retryJob(jobId: string) {
  const job = get().jobs[jobId];
  if (!job || job.status !== "failed") return;
  const retried = { ...job, status: "transcribing" as const };
  setJob(retried);
  scheduleTranscription(retried);
}

export function discardJob(jobId: string) {
  const job = get().jobs[jobId];
  if (!job) return;
  removeDictationSlot(job.threadId, job.id);
  dropJob(job.id);
  maybeSendWhenReady(job.threadId);
}

/**
 * Sends the draft when it is armed and no slot is still waiting for text.
 * Returns true when it sent. The slot count, not the job list, decides:
 * a slot the user deleted no longer holds the message back.
 */
function maybeSendWhenReady(threadId: string): boolean {
  const thread = get().threads.find((entry) => entry.id === threadId);
  if (!thread?.sendWhenReady) return false;
  if (countDictationSlots(threadId) > 0) return false;
  return sendDraft(threadId);
}

function sendDraft(threadId: string): boolean {
  const text = readDraftText(threadId).trim();
  const thread = get().threads.find((entry) => entry.id === threadId);
  if (!thread || text.length === 0) {
    updateThread(threadId, (entry) => ({ ...entry, sendWhenReady: false }));
    return false;
  }
  clearDraft(threadId);
  const sentText = thread.containsVoicedText ? `[voiced] ${text}` : text;
  updateThread(threadId, (entry) => ({
    ...entry,
    sendWhenReady: false,
    containsVoicedText: false,
    messages: [...entry.messages, { id: nextId("msg"), role: "user", text: sentText }],
  }));
  announce(`Sent to ${thread.title}`, threadId);
  window.setTimeout(() => {
    updateThread(threadId, (entry) => ({
      ...entry,
      messages: [
        ...entry.messages,
        {
          id: nextId("msg"),
          role: "assistant",
          text: "(Simulated reply. In the prototype nothing reaches an agent.)",
        },
      ],
    }));
  }, 1_400);
  return true;
}

/** The composer's Send: sends now, or arms send-when-ready while slots are pending. */
export function requestSend(threadId: string) {
  if (countDictationSlots(threadId) > 0) {
    updateThread(threadId, (thread) => ({ ...thread, sendWhenReady: true }));
    return;
  }
  sendDraft(threadId);
}

export function cancelSendWhenReady(threadId: string) {
  updateThread(threadId, (thread) => ({ ...thread, sendWhenReady: false }));
}

export function setActiveThread(threadId: string) {
  set({ activeThreadId: threadId });
}

export function setScene(scene: Scene) {
  set({ scene });
}

export function setSimulation(
  patch: Partial<Pick<PrototypeState, "speed" | "defaultMode" | "failNext">>,
) {
  set(patch);
}

/** Jobs that belong to a thread, for the sidebar badges. */
export function jobsForThread(
  jobs: Readonly<Record<string, DictationJob>>,
  threadId: string,
): DictationJob[] {
  return Object.values(jobs).filter((job) => job.threadId === threadId);
}
