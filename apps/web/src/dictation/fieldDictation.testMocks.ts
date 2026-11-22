import type { DictationJob } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { vi } from "vite-plus/test";

/**
 * Module mocks for field dictation tests. A test file mocks `~/state/dictation` with
 * `mockDictationJobsModule` and `~/dictation/dictationTransport` with
 * `mockDictationTransportModule`. This module imports neither, so a mock factory can load it.
 */
interface JobsCursor {
  readonly epoch: string | null;
  readonly revision: number | null;
}

const NO_CURSOR: JobsCursor = { epoch: null, revision: null };
const jobsFixture = {
  list: { jobs: [] as DictationJob[], cursor: NO_CURSOR },
  listeners: new Set<() => void>(),
};

/** Publishes a job list; `cursor` is the server run and change it reflects. */
export function publishJobs(jobs: DictationJob[], cursor: JobsCursor = NO_CURSOR): void {
  jobsFixture.list = { jobs, cursor };
  for (const listener of jobsFixture.listeners) listener();
}

export async function mockDictationJobsModule(
  importOriginal: () => Promise<typeof import("~/state/dictation")>,
) {
  return {
    ...(await importOriginal()),
    useDictationJobs: (environmentId: string | null) => {
      const list = useSyncExternalStore(
        (listener) => {
          jobsFixture.listeners.add(listener);
          return () => jobsFixture.listeners.delete(listener);
        },
        () => jobsFixture.list,
      );
      return {
        jobs: environmentId === null ? [] : list.jobs,
        cursor: environmentId === null ? NO_CURSOR : list.cursor,
        loaded: environmentId !== null,
      };
    },
  };
}

export function mockDictationTransportModule() {
  return {
    uploadDictationAudio: vi.fn(async () => "field-audio-1"),
    startDictationTranscription: vi.fn(async () => ({})),
  };
}
