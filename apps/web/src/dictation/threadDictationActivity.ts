import type { DictationTarget, ScopedThreadRef } from "@t3tools/contracts";

import {
  type DictationLastJob,
  type DictationRecordingSession,
  type OwnDictationJob,
  useDictationSessionStore,
  useOwnDictationJobsStore,
} from "./dictationSessionStore";
import { useDictationWidgetActivityStore } from "./dictationWidgetState";

/**
 * What a thread's sidebar row shows of this device's dictation: a recording that belongs to the
 * thread, then the transcription whose marker waits in the thread's draft. Save mode puts nothing
 * into the thread, and a job that never reached the server shows as failed in the draft instead.
 */
export type ThreadDictationActivity = "recording" | "transcribing" | null;

function isThread(target: DictationTarget, thread: ScopedThreadRef) {
  return (
    target?.kind === "thread" &&
    target.environmentId === thread.environmentId &&
    target.threadId === thread.threadId
  );
}

interface DictationActivitySources {
  readonly session: DictationRecordingSession | null;
  readonly lastJob: DictationLastJob | null;
  /** This device's jobs the server lists as transcribing in the thread's environment. */
  readonly transcribing: ReadonlyArray<string> | undefined;
  readonly jobs: Readonly<Record<string, OwnDictationJob>>;
}

function recordsInto(session: DictationRecordingSession | null, thread: ScopedThreadRef) {
  return session?.thread != null && isThread(session.thread, thread);
}

/** The jobs still on their way include the last stopped one, uploading before the server lists it. */
function threadDictationActivity(
  sources: DictationActivitySources,
  thread: ScopedThreadRef,
): ThreadDictationActivity {
  if (recordsInto(sources.session, thread)) return "recording";
  const pending = new Set(sources.transcribing);
  if (sources.lastJob?.environmentId === thread.environmentId) pending.add(sources.lastJob.jobId);
  for (const jobId of pending) {
    const own = sources.jobs[jobId];
    if (
      own &&
      !own.handled &&
      own.mode !== "clipboard" &&
      own.notStarted === undefined &&
      isThread(own.target, thread)
    ) {
      return "transcribing";
    }
  }
  return null;
}

export function readThreadDictationActivity(thread: ScopedThreadRef): ThreadDictationActivity {
  const { session, lastJob } = useDictationSessionStore.getState();
  return threadDictationActivity(
    {
      session,
      lastJob,
      transcribing: useDictationWidgetActivityStore.getState().transcribing[thread.environmentId],
      jobs: useOwnDictationJobsStore.getState().jobs,
    },
    thread,
  );
}

/**
 * Selects the recording as a boolean: the level samples a recording writes ten times a second
 * then re-render no row.
 */
export function useThreadDictationActivity(thread: ScopedThreadRef): ThreadDictationActivity {
  const recording = useDictationSessionStore((state) => recordsInto(state.session, thread));
  const lastJob = useDictationSessionStore((state) => state.lastJob);
  const transcribing = useDictationWidgetActivityStore(
    (state) => state.transcribing[thread.environmentId],
  );
  const jobs = useOwnDictationJobsStore((state) => state.jobs);
  return recording
    ? "recording"
    : threadDictationActivity({ session: null, lastJob, transcribing, jobs }, thread);
}
