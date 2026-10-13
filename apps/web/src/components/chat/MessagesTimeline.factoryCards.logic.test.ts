import { RunId, ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import { makeFactoryPlanPayload } from "@t3tools/client-runtime/factory/testing";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";

// Mesura: Software Factory cards arrive as `factory_card` turn items under orchestrator v2.
const at = DateTime.makeUnsafe("2026-09-28T10:00:05.000Z");
const planCard = {
  id: TurnItemId.make("factory-plan:thread-1:aaaaaaaaaaaaaaaa"),
  threadId: ThreadId.make("thread-1"),
  runId: RunId.make("run-1"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed" as const,
  title: "Plan: the Software Factory inside Mesura Code",
  startedAt: at,
  completedAt: at,
  updatedAt: at,
  type: "factory_card" as const,
  card: { kind: "plan" as const, payload: makeFactoryPlanPayload() },
} satisfies OrchestrationV2TurnItem;

function rowsFor(items: ReadonlyArray<OrchestrationV2TurnItem>) {
  return deriveMessagesTimelineRows({
    timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: items.map((item, position) => ({
        item,
        position,
        visibility: "local" as const,
        sourceThreadId: item.threadId,
        sourceItemId: item.id,
      })),
      optimisticMessages: [],
    }),
    isWorking: false,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
  });
}

describe("Software Factory cards in the timeline", () => {
  it("draws a plan card item as a factory-plan row with a stable item", () => {
    const first = rowsFor([planCard]);
    expect(first.map((row) => row.kind)).toEqual(["factory-plan"]);
    const second = rowsFor([planCard]);
    const [firstRow] = first;
    const [secondRow] = second;
    if (firstRow?.kind !== "factory-plan" || secondRow?.kind !== "factory-plan") {
      throw new Error("Expected factory-plan rows");
    }
    expect(firstRow.factoryPlan.plan.title).toBe(planCard.card.payload.title);
    // Rows compare their card by reference, so the same turn item keeps the same card.
    expect(secondRow.factoryPlan).toBe(firstRow.factoryPlan);
  });
});
