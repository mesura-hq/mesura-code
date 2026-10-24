/**
 * Entry point: ChatView's v2 derivation chain, from projected turn items through
 * deriveTimelineEntriesFromVisibleTurnItemsWithState to MessagesTimeline rows.
 * Factory cards stay visible outside run folds. The server owns item positions.
 */
import { type FactoryThreadCard, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import { deriveFactoryTimelineItemsFromTurnItems } from "@t3tools/client-runtime/factory/plan-activities";
import {
  FACTORY_REVISED_PLAN_DIGEST,
  makeFactoryCardTurnItem,
  makeFactoryPlanPayload,
  makeFactoryReportPayload,
} from "@t3tools/client-runtime/factory/testing";
import { describe, expect, it } from "vite-plus/test";
import { deriveMessagesTimelineRows } from "../components/chat/MessagesTimeline.logic";
import {
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  type TimelineEntriesProjection,
} from "../session-logic";
import {
  factoryCoordinatorRunId,
  makeFactoryMessageItem,
  makeFactoryToolItem,
  projectFactoryTurnItems,
} from "./factoryTestFixtures";

const time = (second: number) => new Date(Date.UTC(2026, 8, 28, 10, 0, second)).toISOString();
const message = (id: string, role: "user" | "assistant", second: number) =>
  makeFactoryMessageItem({ id, role, createdAt: time(second) });
const plan = (
  second: number,
  payload = makeFactoryPlanPayload({ presentedAt: time(second) }),
  id = "factory-plan:plan-md",
) => makeFactoryCardTurnItem({ id, createdAt: time(second), card: { kind: "plan", payload } });
const report = (second: number, payload = makeFactoryReportPayload({ writtenAt: time(second) })) =>
  makeFactoryCardTurnItem({
    id: "factory-report:factory-thread:invoice-csv-export",
    createdAt: time(second),
    card: { kind: "report", payload },
  });

function project(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  previous: TimelineEntriesProjection | null = null,
  expanded = false,
) {
  const timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(
    {
      visibleTurnItems: projectFactoryTurnItems(items),
      optimisticMessages: [],
    },
    previous,
  );
  const rows = deriveMessagesTimelineRows({
    timelineEntries: timeline.entries,
    isWorking: false,
    ...(expanded ? { expandedRunIds: new Set([factoryCoordinatorRunId]) } : {}),
    turnDiffSummaries: [],
    supportsConversationRollback: false,
  });
  return { timeline, rows };
}

const planRows = (rows: ReturnType<typeof project>["rows"]) =>
  rows.flatMap((row) => (row.kind === "factory-plan" ? [row] : []));
const reportRows = (rows: ReturnType<typeof project>["rows"]) =>
  rows.flatMap((row) => (row.kind === "factory-report" ? [row] : []));

describe("Factory v2 plan timeline port", () => {
  it("Factory v2 plan appears once at its server position without a work row", () => {
    const payload = makeFactoryPlanPayload({ presentedAt: time(5) });
    const { rows } = project([
      message("user-1", "user", 0),
      plan(5, payload),
      message("assistant-1", "assistant", 10),
      message("user-2", "user", 20),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["message", "factory-plan", "message", "message"]);
    expect(planRows(rows)[0]?.factoryPlan.plan).toEqual(payload);
    expect(rows.some((row) => row.kind === "work")).toBe(false);
  });

  it("Factory v2 plan stays visible when its coordinator run folds and expands", () => {
    const payload = makeFactoryPlanPayload({ presentedAt: time(9) });
    const items = [
      message("user-1", "user", 0),
      message("assistant-first", "assistant", 5),
      makeFactoryToolItem("tool-1", time(8)),
      plan(9, payload),
      message("assistant-final", "assistant", 20),
    ];
    expect(project(items).rows.map((row) => row.kind)).toEqual([
      "message",
      "turn-fold",
      "factory-plan",
      "message",
    ]);
    expect(planRows(project(items).rows)[0]?.factoryPlan.plan).toEqual(payload);
    expect(project(items, null, true).rows.map((row) => row.kind)).toEqual([
      "message",
      "turn-fold",
      "message",
      "work",
      "factory-plan",
      "message",
    ]);
  });

  it("Factory v2 malformed plan payload produces no card or tool row", () => {
    const invalid = {
      kind: "plan",
      payload: { digest: "not-a-digest", title: "Broken" },
    } as unknown as FactoryThreadCard;
    const { rows } = project([
      message("user-1", "user", 0),
      makeFactoryCardTurnItem({ id: "broken-plan", createdAt: time(5), card: invalid }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["message"]);
  });

  it("Factory v2 plan revision replaces content in one server slot per plan file", () => {
    const original = plan(5);
    const items = [
      message("user-1", "user", 0),
      original,
      message("assistant-1", "assistant", 10),
      message("user-2", "user", 20),
      message("assistant-2", "assistant", 30),
    ];
    const first = project(items);
    const revisedPayload = makeFactoryPlanPayload({
      digest: FACTORY_REVISED_PLAN_DIGEST,
      title: "Plan: revised",
      phases: [{ title: "Build the web client", acceptanceCount: 5 }],
      presentedAt: time(40),
    });
    const revised = makeFactoryCardTurnItem({
      id: original.id,
      createdAt: time(5),
      updatedAt: time(40),
      card: { kind: "plan", payload: revisedPayload },
    });
    const updated = items.map((item) => (item === original ? revised : item));
    for (const { rows } of [project(updated, first.timeline), project(updated)]) {
      expect(rows.map((row) => row.kind)).toEqual(first.rows.map((row) => row.kind));
      expect(planRows(rows).map((row) => row.factoryPlan.plan)).toEqual([revisedPayload]);
      expect(planRows(rows)[0]?.id).toBe(original.id);
    }
    const other = makeFactoryPlanPayload({
      title: "Plan: another change",
      planPath: "/plans/other/plan.md",
    });
    expect(
      planRows(project([...updated, plan(45, other, "factory-plan:other")]).rows).map(
        (row) => row.factoryPlan.plan.title,
      ),
    ).toEqual([revisedPayload.title, other.title]);
  });

  it("Factory v2 plan derivation reads the upserted revision with its stable identity", () => {
    const original = plan(5);
    const payload = makeFactoryPlanPayload({
      digest: FACTORY_REVISED_PLAN_DIGEST,
      presentedAt: time(40),
    });
    const revised = makeFactoryCardTurnItem({
      id: original.id,
      createdAt: time(5),
      updatedAt: time(40),
      card: { kind: "plan", payload },
    });
    const items = deriveFactoryTimelineItemsFromTurnItems(projectFactoryTurnItems([revised]));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: original.id,
      kind: "plan",
      createdAt: time(5),
      plan: payload,
    });
  });

  it("Factory v2 plan item and stable row survive an unrelated streaming message update", () => {
    const card = plan(5);
    const streaming = { ...message("assistant-stream", "assistant", 10), streaming: true };
    const items = [message("user-1", "user", 0), card, streaming];
    const before = project(items);
    const grown = project(
      [items[0]!, card, { ...streaming, text: "Presented the plan" }],
      before.timeline,
    );
    const decoded = deriveFactoryTimelineItemsFromTurnItems(projectFactoryTurnItems([card]));
    const again = deriveFactoryTimelineItemsFromTurnItems(projectFactoryTurnItems([card]));
    expect(again[0]).toBe(decoded[0]);
    expect(planRows(grown.rows)[0]?.factoryPlan).toBe(planRows(before.rows)[0]?.factoryPlan);
    expect(grown.timeline.entries.find((entry) => entry.kind === "factory-plan")).toBe(
      before.timeline.entries.find((entry) => entry.kind === "factory-plan"),
    );
  });
});

describe("Factory v2 report timeline port", () => {
  it("Factory v2 report appears once after its plan at the server position", () => {
    const payload = makeFactoryReportPayload({ writtenAt: time(15) });
    const { rows } = project([
      message("user-1", "user", 0),
      plan(5),
      message("assistant-1", "assistant", 10),
      report(15, payload),
      message("user-2", "user", 20),
    ]);
    expect(rows.map((row) => row.kind)).toEqual([
      "message",
      "factory-plan",
      "message",
      "factory-report",
      "message",
    ]);
    expect(reportRows(rows)[0]?.factoryReport.report).toEqual(payload);
    expect(reportRows(rows)[0]?.id).toBe("factory-report:factory-thread:invoice-csv-export");
    expect(rows.some((row) => row.kind === "work")).toBe(false);
  });

  it("Factory v2 report stays visible when its coordinator run folds and expands", () => {
    const payload = makeFactoryReportPayload({ writtenAt: time(9) });
    const items = [
      message("user-1", "user", 0),
      message("assistant-first", "assistant", 5),
      makeFactoryToolItem("tool-report", time(8)),
      report(9, payload),
      message("assistant-final", "assistant", 20),
    ];
    expect(project(items).rows.map((row) => row.kind)).toEqual([
      "message",
      "turn-fold",
      "factory-report",
      "message",
    ]);
    expect(reportRows(project(items).rows)[0]?.factoryReport.report).toEqual(payload);
    expect(project(items, null, true).rows.map((row) => row.kind)).toEqual([
      "message",
      "turn-fold",
      "message",
      "work",
      "factory-report",
      "message",
    ]);
  });

  it("Factory v2 malformed report payload produces no card or tool row", () => {
    const invalid = {
      kind: "report",
      payload: { runId: "invoice-csv-export", digest: "not-a-digest" },
    } as unknown as FactoryThreadCard;
    expect(
      project([
        message("user-1", "user", 0),
        makeFactoryCardTurnItem({ id: "broken-report", createdAt: time(5), card: invalid }),
      ]).rows.map((row) => row.kind),
    ).toEqual(["message"]);
  });

  it("Factory v2 report item survives an unrelated streaming message update", () => {
    const card = report(5);
    const streaming = { ...message("assistant-stream", "assistant", 10), streaming: true };
    const user = message("user-1", "user", 0);
    const first = project([user, card, streaming]);
    const grown = project([user, card, { ...streaming, text: "Wrote the report" }], first.timeline);
    const decoded = deriveFactoryTimelineItemsFromTurnItems(projectFactoryTurnItems([card]));
    expect(deriveFactoryTimelineItemsFromTurnItems(projectFactoryTurnItems([card]))[0]).toBe(
      decoded[0],
    );
    expect(reportRows(grown.rows)[0]?.factoryReport).toBe(reportRows(first.rows)[0]?.factoryReport);
    expect(grown.timeline.entries.find((entry) => entry.kind === "factory-report")).toBe(
      first.timeline.entries.find((entry) => entry.kind === "factory-report"),
    );
  });

  it("Factory v2 pane derivation preserves the server order of plan and report cards", () => {
    const items = deriveFactoryTimelineItemsFromTurnItems(
      projectFactoryTurnItems([plan(5), report(30)]),
    );
    expect(items.map((item) => [item.kind, item.id])).toEqual([
      ["plan", "factory-plan:plan-md"],
      ["report", "factory-report:factory-thread:invoice-csv-export"],
    ]);
  });
});
