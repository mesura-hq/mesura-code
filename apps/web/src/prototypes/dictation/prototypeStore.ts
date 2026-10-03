/**
 * Simulation model for the dictation prototype. Nothing here talks to a
 * server or a provider: recording, audio level, and transcription are timers.
 * The drafts themselves live in one Lexical editor per thread
 * (`draftEditors.ts`); this store owns everything around them.
 */
import { create } from "zustand";

import {
  countDictationSlots,
  fillDictationSlot,
  insertDictationSlotAtCaret,
  readDraftText,
  clearDraft,
  removeDictationSlot,
} from "./draftEditors";

/** How a finished recording is delivered. Alt+I, Alt+Enter and Alt+S pick one. */
export type DeliveryMode = "inject" | "submit" | "save";

export type JobStatus = "recording" | "transcribing" | "failed";

export interface DictationJob {
  readonly id: string;
  readonly threadId: string;
  readonly status: JobStatus;
  readonly mode: DeliveryMode | null;
  readonly recordedMs: number;
}

export interface RecordingState {
  readonly jobId: string;
  readonly threadId: string;
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
  readonly stopMode: Exclude<DeliveryMode, "save">;
  readonly failNext: boolean;
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
  stopMode: "submit",
  failNext: false,
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

/** Starts recording into a thread's draft, at its caret, or at the end when it has none. */
export function startRecording(threadId: string = get().activeThreadId) {
  if (get().recording) return;
  const jobId = nextId("job");
  insertDictationSlotAtCaret(threadId, jobId);
  setJob({ id: jobId, threadId, status: "recording", mode: null, recordedMs: 0 });
  set({ recording: { jobId, threadId, bankedMs: 0, runningSince: Date.now(), level: 0 } });
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
  removeDictationSlot(recording.threadId, recording.jobId);
  dropJob(recording.jobId);
  set({ recording: null });
  stopLevelSimulation();
  maybeSendWhenReady(recording.threadId);
}

/** Ends the recording and hands the audio to the (simulated) server. */
export function finishRecording(mode: DeliveryMode = get().stopMode) {
  const recording = get().recording;
  if (!recording) return;
  const recordedMs = recordedMsAt(recording, Date.now());
  set({ recording: null });
  stopLevelSimulation();
  if (mode === "save") removeDictationSlot(recording.threadId, recording.jobId);
  if (mode === "submit") {
    updateThread(recording.threadId, (thread) => ({ ...thread, sendWhenReady: true }));
  }
  const job: DictationJob = {
    id: recording.jobId,
    threadId: recording.threadId,
    status: "transcribing",
    mode,
    recordedMs,
  };
  setJob(job);
  scheduleTranscription(job);
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
  if (job.mode === "save") {
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
  patch: Partial<Pick<PrototypeState, "speed" | "stopMode" | "failNext">>,
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
