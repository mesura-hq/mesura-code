import {
  createDictationEnvironmentAtoms,
  type DictationJobsCursor,
} from "@t3tools/client-runtime/dictation";
import type { DictationJob, EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const dictationEnvironment = createDictationEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_JOBS: ReadonlyArray<DictationJob> = [];
const NO_CURSOR: DictationJobsCursor = { epoch: null, revision: null };

/** The environment's dictation jobs, newest first, as the server pushes them. */
export function useDictationJobs(environmentId: EnvironmentId | null): {
  readonly jobs: ReadonlyArray<DictationJob>;
  /** The newest server change the list includes; see `DictationJobsCursor`. */
  readonly cursor: DictationJobsCursor;
  readonly loaded: boolean;
} {
  const query = useEnvironmentQuery(
    environmentId === null ? null : dictationEnvironment.jobs({ environmentId, input: {} }),
  );
  return {
    jobs: query.data?.jobs ?? EMPTY_JOBS,
    cursor: query.data?.cursor ?? NO_CURSOR,
    loaded: query.data !== null,
  };
}
