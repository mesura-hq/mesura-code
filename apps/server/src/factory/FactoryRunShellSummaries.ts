/**
 * FactoryRunShellSummaries - the Software Factory run label of each thread, in memory.
 *
 * The run tracker writes it and the shell query reads it at mapping time, like
 * `ThreadPlanProgressService`. It has no dependencies, so the shell query can
 * look it up as an optional service without pulling the tracker, and the
 * orchestration engine behind it, below the query.
 *
 * @module FactoryRunShellSummaries
 */
import type { FactoryRunShellSummary } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class FactoryRunShellSummaries extends Context.Service<
  FactoryRunShellSummaries,
  {
    readonly get: (threadId: string) => FactoryRunShellSummary | null;
    readonly set: (threadId: string, summary: FactoryRunShellSummary) => void;
  }
>()("t3/factory/FactoryRunShellSummaries") {}

export function make(): FactoryRunShellSummaries["Service"] {
  const summaries = new Map<string, FactoryRunShellSummary>();
  return {
    get: (threadId) => summaries.get(threadId) ?? null,
    set: (threadId, summary) => {
      summaries.set(threadId, summary);
    },
  };
}

export const layer = Layer.effect(FactoryRunShellSummaries, Effect.sync(make));
