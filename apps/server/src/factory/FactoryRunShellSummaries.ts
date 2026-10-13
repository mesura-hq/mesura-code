/**
 * FactoryRunShellSummaries - the Software Factory run label of each thread, in memory.
 *
 * The run tracker writes it and the V2 projection store reads it when it maps a
 * thread's shell. It has no dependencies, so the store can read it without
 * pulling the tracker, and the orchestrator behind it, below the store.
 *
 * A reference with a default rather than a required service: the projection
 * store is built in several places, and Effect caches a reference's default,
 * so the tracker and every store share one map without wiring. `layer` gives a
 * test a fresh map.
 *
 * @module FactoryRunShellSummaries
 */
import type { FactoryRunShellSummary } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

interface FactoryRunShellSummariesShape {
  readonly get: (threadId: string) => FactoryRunShellSummary | null;
  readonly set: (threadId: string, summary: FactoryRunShellSummary) => void;
}

export function make(): FactoryRunShellSummariesShape {
  const summaries = new Map<string, FactoryRunShellSummary>();
  return {
    get: (threadId) => summaries.get(threadId) ?? null,
    set: (threadId, summary) => {
      summaries.set(threadId, summary);
    },
  };
}

export class FactoryRunShellSummaries extends Context.Reference<FactoryRunShellSummariesShape>(
  "t3/factory/FactoryRunShellSummaries",
  { defaultValue: make },
) {}

export const layer = Layer.sync(FactoryRunShellSummaries, make);
