import type {
  DictationJobId,
  DictationMode,
  DictationTarget,
  EnvironmentId,
} from "@t3tools/contracts";
import { create } from "zustand";

/**
 * Mesura's own dictation state. Kept free of heavy imports: `keybindings.ts` reads
 * `isDictationLive` on every shortcut that asks for `dictationActive`.
 */

/** The one recording in progress. Time is banked across pauses. */
export interface DictationRecordingSession {
  readonly sessionId: string;
  readonly mode: DictationMode;
  readonly startedAt: number;
  readonly bankedMs: number;
  /** `null` while paused. */
  readonly runningSince: number | null;
  /** The microphone level, 0-1. */
  readonly level: number;
  /** When `level` was read; the strip shows the time recorded up to here. */
  readonly sampledAt: number;
}

/** The last stopped job, which the mode keys keep steering until it leaves `transcribing`. */
export interface DictationLastJob {
  readonly environmentId: EnvironmentId;
  readonly jobId: DictationJobId;
}

interface DictationSessionState {
  readonly session: DictationRecordingSession | null;
  readonly lastJob: DictationLastJob | null;
}

export const useDictationSessionStore = create<DictationSessionState>(() => ({
  session: null,
  lastJob: null,
}));

export function recordedDictationMs(session: DictationRecordingSession, now: number): number {
  return session.bankedMs + (session.runningSince === null ? 0 : now - session.runningSince);
}

/** True while a recording runs or the last stopped job may still change mode. */
export function isDictationLive(): boolean {
  const { session, lastJob } = useDictationSessionStore.getState();
  return session !== null || lastJob !== null;
}

/**
 * A job this device started. Ownership is per device, not per tab, and one storage key holds one
 * job, so two tabs recording at once never overwrite each other's records.
 *
 * The rule that keeps delivery exact across tabs: every tab fills the job's marker wherever its
 * own copy of the draft still holds it (filling is idempotent, a filled marker is gone), and the
 * one-off effects (the "marker deleted" notice, the clipboard copy) run only while `handled` is
 * false. `handled` is set once the fill is written or the notice or copy has happened, never
 * before, so a failed write is retried on the next delivery or after a reload. The one race left:
 * two tabs that both lack the marker and receive the completion in the same instant may each
 * show the notice once; the text itself is never placed twice or lost.
 */
export interface OwnDictationJob {
  readonly environmentId: EnvironmentId;
  /** The draft the recording stopped in, kept whatever the mode, so save can turn into insert. */
  readonly target: Exclude<DictationTarget, null>;
  readonly mode: DictationMode;
  readonly createdAt: number;
  readonly handled: boolean;
  /** A "kept in Transcriptions" notice was shown for this job; never show a second one. */
  readonly noticed?: boolean;
  /**
   * Why the job never reached the server (finalizing, uploading or starting failed). Its marker
   * stays, shown as failed, until Retry starts it from the audio this tab kept, or Discard.
   */
  readonly notStarted?: string | undefined;
  /** Set when the recording stopped in a question card: the marker is in that answer. */
  readonly question?: DictationQuestionAnswer;
}

/** An open question card's typed answer, which takes the marker of a recording stopped in it. */
export interface DictationQuestionAnswer {
  /** `pendingUserInputRequestKey` of the request the question belongs to. */
  readonly requestKey: string;
  readonly questionId: string;
}

/** Jobs live 24 hours on the server; keep the record a little longer, then forget it. */
const OWN_JOB_RETENTION_MS = 36 * 60 * 60 * 1000;
const OWN_JOB_KEY_PREFIX = "mesura:dictation-job:v1:";

interface OwnDictationJobsState {
  readonly jobs: Readonly<Record<string, OwnDictationJob>>;
}

function parseOwnJob(raw: string | null): OwnDictationJob | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<OwnDictationJob>;
    return typeof value.environmentId === "string" &&
      typeof value.createdAt === "number" &&
      typeof value.mode === "string" &&
      typeof value.target === "object" &&
      value.target !== null
      ? (value as OwnDictationJob)
      : null;
  } catch {
    return null;
  }
}

/** The records of one device, over the storage every tab shares. Built per storage for tests. */
export function createOwnDictationJobs(storage: Storage | null, now: () => number = Date.now) {
  const readAll = (): Record<string, OwnDictationJob> => {
    const jobs: Record<string, OwnDictationJob> = {};
    if (!storage) return jobs;
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    for (const key of keys) {
      if (!key?.startsWith(OWN_JOB_KEY_PREFIX)) continue;
      const job = parseOwnJob(storage.getItem(key));
      if (job && now() - job.createdAt < OWN_JOB_RETENTION_MS) {
        jobs[key.slice(OWN_JOB_KEY_PREFIX.length)] = job;
      } else {
        storage.removeItem(key);
      }
    }
    return jobs;
  };

  const store = create<OwnDictationJobsState>(() => ({ jobs: readAll() }));

  const setJob = (jobId: string, job: OwnDictationJob | null) =>
    store.setState((state) => {
      if (job === null) {
        if (!(jobId in state.jobs)) return state;
        const { [jobId]: _forgotten, ...jobs } = state.jobs;
        return { jobs };
      }
      return { jobs: { ...state.jobs, [jobId]: job } };
    });

  /** Writes one record; `false` when the storage refused it. */
  const write = (jobId: string, job: OwnDictationJob | null): boolean => {
    setJob(jobId, job);
    if (!storage) return false;
    try {
      if (job === null) storage.removeItem(`${OWN_JOB_KEY_PREFIX}${jobId}`);
      else storage.setItem(`${OWN_JOB_KEY_PREFIX}${jobId}`, JSON.stringify(job));
      return true;
    } catch {
      return false;
    }
  };

  return {
    store,
    record: (jobId: string, job: Omit<OwnDictationJob, "handled">) =>
      write(jobId, { ...job, handled: false }),
    update: (
      jobId: string,
      change: Partial<Pick<OwnDictationJob, "mode" | "handled" | "noticed" | "notStarted">>,
    ) => {
      const current = store.getState().jobs[jobId];
      return current ? write(jobId, { ...current, ...change }) : false;
    },
    forget: (jobId: string) => write(jobId, null),
    /** Takes in a record another tab wrote, from the window's `storage` event. */
    applyStorageChange: (key: string | null, value: string | null) => {
      if (key === null) {
        store.setState({ jobs: readAll() });
        return;
      }
      if (!key.startsWith(OWN_JOB_KEY_PREFIX)) return;
      setJob(key.slice(OWN_JOB_KEY_PREFIX.length), parseOwnJob(value));
    },
  };
}

function resolveDeviceStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

const ownDictationJobs = createOwnDictationJobs(resolveDeviceStorage());
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) =>
    ownDictationJobs.applyStorageChange(event.key, event.newValue),
  );
}

export const useOwnDictationJobsStore = ownDictationJobs.store;
export const recordOwnDictationJob = ownDictationJobs.record;
export const updateOwnDictationJob = ownDictationJobs.update;
export const forgetOwnDictationJob = ownDictationJobs.forget;
