/**
 * The run tracker writes each thread's Software Factory run label; the V2 projection store reads
 * it. A `Context.Reference` default, not a required service: Effect caches the default, so the
 * tracker and every store share one map without wiring and without pulling the tracker below
 * the store. `layer` gives a test a fresh map.
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
