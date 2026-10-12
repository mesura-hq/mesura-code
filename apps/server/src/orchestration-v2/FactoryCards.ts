/**
 * Mesura: Software Factory cards under orchestrator v2.
 *
 * A plan, run or report card is a `factory_card` turn item recorded by the
 * internal `factory_card.record` command. The callers (the factory MCP tools
 * and the run tracker) know only the thread, so the orchestrator anchors a new
 * card to the thread's active run, else its latest run. A card is upserted by
 * its turn item id: a later record keeps the card's anchor, ordinal and
 * `startedAt`, and replaces its payload. The event sink pins every turn item's
 * ordinal on first record (`TurnItemPositionStore`), so a card never moves in
 * the timeline once it exists.
 *
 * A card is always `completed`: restart recovery cancels open items of a run,
 * and the shell counts open items as pending work. The run's own state lives
 * in the card's payload, not in the item status.
 *
 * @module FactoryCards
 */
import type {
  FactoryRunShellSummary,
  FactoryThreadCard,
  OrchestrationV2InternalCommand,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { FactoryRunShellSummaries } from "../factory/FactoryRunShellSummaries.ts";

export type FactoryCardRecordCommand = Extract<
  OrchestrationV2InternalCommand,
  { readonly type: "factory_card.record" }
>;

export type FactoryCardTurnItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "factory_card" }
>;

export type FactoryCardRecordDecision =
  | {
      readonly _tag: "record";
      /** The run the card is anchored to: the event carries its provider instance. */
      readonly run: OrchestrationV2Run;
      readonly turnItem: FactoryCardTurnItem;
    }
  | { readonly _tag: "reject"; readonly reason: string };

const isActiveRun = (run: OrchestrationV2Run) =>
  run.status === "preparing" ||
  run.status === "starting" ||
  run.status === "running" ||
  run.status === "waiting";

const byOrdinalDescending = (left: OrchestrationV2Run, right: OrchestrationV2Run) =>
  right.ordinal - left.ordinal;

/**
 * The run a new card belongs to: the newest active run, else the newest run
 * that left the queue, else the newest queued one.
 */
export function factoryCardAnchorRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2Run | undefined {
  const newestFirst = runs.toSorted(byOrdinalDescending);
  return (
    newestFirst.find(isActiveRun) ??
    newestFirst.find((run) => run.status !== "queued") ??
    newestFirst[0]
  );
}

/** The item title: what thread search and the MCP timeline read for a card. */
export function factoryCardTitle(card: FactoryThreadCard): string {
  switch (card.kind) {
    case "plan":
      // Plans are titled `# Plan: …`; the title adds its own `Plan: ` prefix once.
      return `Plan: ${card.payload.title.replace(/^plan:\s*/i, "")}`;
    case "run": {
      const { payload } = card;
      const phase =
        payload.phase === null ? "" : ` · phase ${payload.phase.index}/${payload.phaseCount}`;
      const node = payload.node === null ? "" : ` · ${payload.node}`;
      return `Factory run ${payload.runId}: ${payload.status}${phase}${node}`;
    }
    case "report":
      return `Report: ${card.payload.title.replace(/^report:\s*/i, "")}`;
  }
}

/**
 * Decides what `factory_card.record` writes. `projection` holds the thread's
 * runs and its `factory_card` items; `nextOrdinal` is the thread's next turn
 * item ordinal, used only for a new card.
 */
export function planFactoryCardRecord(input: {
  readonly command: FactoryCardRecordCommand;
  readonly projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "turnItems">;
  readonly nextOrdinal: number;
  readonly now: DateTime.Utc;
}): FactoryCardRecordDecision {
  const { command, projection, now } = input;
  if (projection.thread.deletedAt !== null) {
    return { _tag: "reject", reason: `Thread ${command.threadId} is deleted.` };
  }
  const existing = projection.turnItems.find((item) => item.id === command.turnItemId);
  if (existing !== undefined && existing.type !== "factory_card") {
    return {
      _tag: "reject",
      reason: `Turn item ${command.turnItemId} is not a Software Factory card.`,
    };
  }
  if (existing !== undefined && existing.card.kind !== command.card.kind) {
    return {
      _tag: "reject",
      reason: `Turn item ${command.turnItemId} is a ${existing.card.kind} card, not a ${command.card.kind} card.`,
    };
  }

  const run =
    existing === undefined
      ? factoryCardAnchorRun(projection.runs)
      : projection.runs.find((candidate) => candidate.id === existing.runId);
  if (run === undefined) {
    return {
      _tag: "reject",
      reason:
        existing === undefined
          ? `Thread ${command.threadId} has no run to anchor a Software Factory card to.`
          : `The run of Software Factory card ${command.turnItemId} is gone.`,
    };
  }

  const turnItem: FactoryCardTurnItem = {
    id: command.turnItemId,
    threadId: command.threadId,
    runId: run.id,
    nodeId: existing === undefined ? run.rootNodeId : existing.nodeId,
    providerThreadId: existing === undefined ? run.providerThreadId : existing.providerThreadId,
    providerTurnId: existing === undefined ? null : existing.providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: existing?.ordinal ?? input.nextOrdinal,
    status: "completed",
    title: factoryCardTitle(command.card),
    startedAt: existing?.startedAt ?? now,
    completedAt: now,
    updatedAt: now,
    type: "factory_card",
    card: command.card,
  };
  return { _tag: "record", run, turnItem };
}

/**
 * The thread shell with its Software Factory run label. A thread without a
 * followed or recorded run carries no `factoryRun` key, so a shell without a
 * factory stays byte-identical to upstream's.
 */
function withFactoryRunShellSummary(
  shell: OrchestrationV2ThreadShell,
  summary: FactoryRunShellSummary | null,
): OrchestrationV2ThreadShell {
  return summary === null ? shell : { ...shell, factoryRun: summary };
}

/**
 * Labels thread shells from `FactoryRunShellSummaries`, read once when the
 * projection store is built. Optional, so a runtime without the factory (most
 * tests) builds shells without a label. The run tracker sets a summary before
 * it records the run card, and that card's `turn-item.updated` event is what
 * makes the shell streams read the thread's shell again.
 */
export const factoryRunShellLabeler = Effect.serviceOption(FactoryRunShellSummaries).pipe(
  Effect.map(
    (summaries) =>
      (shell: OrchestrationV2ThreadShell): OrchestrationV2ThreadShell =>
        Option.isNone(summaries)
          ? shell
          : withFactoryRunShellSummary(shell, summaries.value.get(shell.id)),
  ),
);
