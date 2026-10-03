import { createDictationEnvironmentAtoms } from "@t3tools/client-runtime/dictation";
import type { DictationJob, EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const dictationEnvironment = createDictationEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_JOBS: ReadonlyArray<DictationJob> = [];

/** The environment's dictation jobs, newest first, as the server pushes them. */
export function useDictationJobs(environmentId: EnvironmentId | null): {
  readonly jobs: ReadonlyArray<DictationJob>;
  readonly loaded: boolean;
} {
  const query = useEnvironmentQuery(
    environmentId === null ? null : dictationEnvironment.jobs({ environmentId, input: {} }),
  );
  return { jobs: query.data ?? EMPTY_JOBS, loaded: query.data !== null };
}
