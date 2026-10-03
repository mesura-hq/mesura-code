import { WS_METHODS, type DictationJob, type DictationJobEvent } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "../state/runtime.ts";

const newestFirst = (left: DictationJob, right: DictationJob) =>
  right.createdAt.localeCompare(left.createdAt);

/**
 * Folds the job stream into the list every client renders: a `snapshot`
 * replaces it, an `upsert` replaces the job with the same id in place or adds
 * it. The list is always newest first.
 */
export function reduceDictationJobs(
  previous: ReadonlyArray<DictationJob>,
  event: DictationJobEvent,
): ReadonlyArray<DictationJob> {
  if (event.type === "snapshot") return [...event.jobs].sort(newestFirst);
  const index = previous.findIndex((job) => job.id === event.job.id);
  if (index >= 0) return previous.map((job, position) => (position === index ? event.job : job));
  return [...previous, event.job].sort(newestFirst);
}

/** Dictation jobs and commands for one environment, shared by web and mobile. */
export function createDictationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ input }: { input: { readonly jobId: string } }) => input.jobId,
  };
  return {
    /** Every job the server keeps (the last 24 hours), newest first. */
    jobs: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:dictation:jobs",
      tag: WS_METHODS.subscribeDictationJobs,
      transform: (stream) =>
        stream.pipe(
          Stream.scan([] as ReadonlyArray<DictationJob>, reduceDictationJobs),
          // `scan` emits its seed first; the list is unknown until the snapshot.
          Stream.drop(1),
        ),
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:dictation:start",
      tag: WS_METHODS.dictationStart,
      scheduler,
      concurrency,
    }),
    retry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:dictation:retry",
      tag: WS_METHODS.dictationRetry,
      scheduler,
      concurrency,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:dictation:cancel",
      tag: WS_METHODS.dictationCancel,
      scheduler,
      concurrency,
    }),
    setMode: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:dictation:set-mode",
      tag: WS_METHODS.dictationSetMode,
      scheduler,
      concurrency,
    }),
  };
}
