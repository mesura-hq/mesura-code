import type { DictationJob } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { vi } from "vite-plus/test";

/**
 * Module mocks for field dictation tests. A test file mocks `~/state/dictation` with
 * `mockDictationJobsModule` and `~/dictation/dictationTransport` with
 * `mockDictationTransportModule`. This module imports neither, so a mock factory can load it.
 */
const jobsFixture = { jobs: [] as DictationJob[], listeners: new Set<() => void>() };

export function publishJobs(jobs: DictationJob[]): void {
  jobsFixture.jobs = jobs;
  for (const listener of jobsFixture.listeners) listener();
}

export async function mockDictationJobsModule(
  importOriginal: () => Promise<typeof import("~/state/dictation")>,
) {
  return {
    ...(await importOriginal()),
    useDictationJobs: (environmentId: string | null) => {
      const jobs = useSyncExternalStore(
        (listener) => {
          jobsFixture.listeners.add(listener);
          return () => jobsFixture.listeners.delete(listener);
        },
        () => jobsFixture.jobs,
      );
      return {
        jobs: environmentId === null ? [] : jobs,
        cursor: { epoch: null, revision: null },
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
