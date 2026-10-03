import { RotateCcwIcon, XIcon } from "lucide-react";

import { useDictationJobs } from "~/state/dictation";
import { MaterialDictationModeIcon } from "~/symmetria/MaterialDictationModeIcon";
import { discardDictationJob, retryDictationJob } from "./dictationController";
import { useOwnDictationJobsStore } from "./dictationSessionStore";
import "./dictationSlot.css";

const WAVE_BARS = [0, 1, 2, 3, 4, 5] as const;

/**
 * How a `dictation` context link draws in the composer: a caret bar, six bars running the
 * stepped wave, and the job's mode. A failed job offers Retry and Discard instead.
 */
export function DictationSlotChip(props: { readonly jobId: string }) {
  const own = useOwnDictationJobsStore((state) => state.jobs[props.jobId]);
  const { jobs } = useDictationJobs(own?.environmentId ?? null);
  const job = jobs.find((candidate) => candidate.id === props.jobId);

  // A job that never reached the server fails here too, so its marker can be retried.
  if (job?.status === "failed" || own?.notStarted !== undefined) {
    return (
      <span
        contentEditable={false}
        className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-1.5 py-px align-baseline text-[11px] text-destructive-foreground select-none"
      >
        transcription failed
        <button
          type="button"
          className="rounded p-0.5 hover:bg-destructive/20"
          aria-label="Retry transcription"
          onClick={() => retryDictationJob(props.jobId)}
        >
          <RotateCcwIcon className="size-3" />
        </button>
        <button
          type="button"
          className="rounded p-0.5 hover:bg-destructive/20"
          aria-label="Discard transcription marker"
          onClick={() => discardDictationJob(props.jobId)}
        >
          <XIcon className="size-3" />
        </button>
      </span>
    );
  }

  return (
    <span
      contentEditable={false}
      className="dictation-slot mx-0.5 inline-flex h-[1.4em] items-center gap-1 rounded-sm px-0.5 align-middle text-[11px] leading-none text-primary select-none"
    >
      <span className="dictation-slot-caret inline-block h-[1.5em] w-[2px] rounded-full bg-primary" />
      <span
        role="img"
        aria-label="Transcribing"
        className="dictation-slot-wave inline-flex h-[1em] items-center gap-[2px]"
      >
        {WAVE_BARS.map((bar) => (
          <span key={bar} className="block h-full w-[2px] rounded-full bg-primary/80" />
        ))}
      </span>
      <MaterialDictationModeIcon
        mode={job?.mode ?? own?.mode ?? "submit"}
        className="size-3 opacity-70"
      />
    </span>
  );
}
