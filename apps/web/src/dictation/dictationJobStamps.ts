import type { DictationJobsCursor } from "@t3tools/client-runtime/dictation";
import type { DictationJob } from "@t3tools/contracts";

/** Where an accepted job sits in the server's change history. */
export interface DictationJobStamp {
  readonly epoch: string;
  readonly revision: number;
}

export function dictationJobStamp(job: DictationJob): DictationJobStamp | undefined {
  return job.epoch === undefined || job.revision === undefined
    ? undefined
    : { epoch: job.epoch, revision: job.revision };
}

/**
 * Whether a job list that lacks the stamped job proves the server no longer has it: the list
 * comes from another server run (a restart), or already includes the job's own change.
 */
export function listProvesJobGone(
  stamp: DictationJobStamp | undefined,
  cursor: DictationJobsCursor,
): boolean {
  // A server older than the stamps: only a job seen listed can be judged.
  if (stamp === undefined || cursor.epoch === null || cursor.revision === null) return false;
  return cursor.epoch !== stamp.epoch || cursor.revision >= stamp.revision;
}
