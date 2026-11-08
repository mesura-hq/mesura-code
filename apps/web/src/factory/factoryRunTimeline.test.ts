/**
 * Entry point: ChatView's v2 derivation chain and MessagesTimeline's stable row
 * projection. The coordinator tool items remain in the same public row list.
 */
/// <reference types="vite-plus/client" />
import { factoryRunActivityId, MessageId, ThreadId } from "@t3tools/contracts";
import { deriveLatestFactoryRunItemFromTurnItems } from "@t3tools/client-runtime/factory/run-activities";
import {
  makeFactoryCardTurnItem,
  makeFactoryRunSummary,
  type FactoryRunFixturePoint,
} from "@t3tools/client-runtime/factory/testing";
import { describe, expect, it } from "vite-plus/test";
import eventsJsonl from "../../../../packages/shared/src/fixtures/factory-events.v1.jsonl?raw";
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRowsWithState,
  type MessagesTimelineRow,
  type MessagesTimelineRowsProjection,
  type StableMessagesTimelineRowsState,
} from "../components/chat/MessagesTimeline.logic";
import {
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  type TimelineEntriesProjection,
} from "../session-logic";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import {
  factoryCoordinatorRunId,
  makeFactoryMessageItem,
  makeFactoryToolItem,
  projectFactoryTurnItems,
} from "./factoryTestFixtures";

const runRowId = factoryRunActivityId("factory-thread", "invoice-csv-export");
const at = (clock: string) => `2026-09-28T${clock}.000Z`;
const message = (id: string, role: "user" | "assistant", clock: string) =>
  makeFactoryMessageItem({ id, role, createdAt: at(clock) });
const runCard = (point: FactoryRunFixturePoint) =>
  makeFactoryCardTurnItem({
    id: runRowId,
    createdAt: at("09:00:00"),
    card: {
      kind: "run",
      payload: {
        threadId: ThreadId.make("factory-thread"),
        ...makeFactoryRunSummary(eventsJsonl, point),
      },
    },
  });
const user = message("approve", "user", "08:58:00");
const reply = message("reply", "assistant", "09:50:00");
const tools = [
  makeFactoryToolItem("tool-before-run", at("08:59:00")),
  makeFactoryToolItem("tool-after-run", at("09:30:00")),
  makeFactoryToolItem("tool-latest", at("09:40:00")),
];
const sequence = (point: FactoryRunFixturePoint) => [
  user,
  tools[0]!,
  runCard(point),
  ...tools.slice(1),
  reply,
];
interface Projection {
  timeline: TimelineEntriesProjection | null;
  rows: MessagesTimelineRowsProjection | null;
  stable: StableMessagesTimelineRowsState;
}
const empty = (): Projection => ({
  timeline: null,
  rows: null,
  stable: { byId: new Map(), result: [] },
});
function project(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  live: boolean,
  previous = empty(),
  withRun = true,
) {
  const visibleTurnItems = projectFactoryTurnItems(items);
  const timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(
    { visibleTurnItems, optimisticMessages: [] },
    previous.timeline,
  );
  const rows = deriveMessagesTimelineRowsWithState(
    {
      timelineEntries: timeline.entries,
      isWorking: live,
      activeTurnStartedAt: live ? at("08:58:01") : null,
      latestRun: {
        runId: factoryCoordinatorRunId,
        status: live ? "running" : "completed",
        startedAt: at("08:58:01"),
        completedAt: live ? null : at("09:55:00"),
      },
      runningRunId: live ? factoryCoordinatorRunId : null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
      factoryRun: withRun ? deriveLatestFactoryRunItemFromTurnItems(visibleTurnItems) : null,
    },
    previous.rows,
  );
  const stable = computeStableMessagesTimelineRows(rows.rows, previous.stable);
  return { timeline, rows, stable, result: stable.result };
}
const runRows = (rows: ReadonlyArray<MessagesTimelineRow>) =>
  rows.filter((row) => row.kind === "factory-run");
const withoutRun = (rows: ReadonlyArray<MessagesTimelineRow>) =>
  rows.filter((row) => row.kind !== "factory-run");

describe("Factory v2 run timeline port", () => {
  it("Factory v2 live run follows the newest coordinator tool rows", () => {
    for (const point of ["verify", "waiting"] as const) {
      const { result } = project(sequence(point), true);
      expect(result.at(-1), point).toMatchObject({ kind: "factory-run", id: runRowId });
      expect(runRows(result), point).toHaveLength(1);
    }
  });

  it("Factory v2 queued turn stays outside the live Factory timeline", () => {
    // Queued runs use QueuedRunsControl, rather than the retired queued-message row.
    const visibleTurnItems = projectFactoryTurnItems(sequence("verify"));
    const queued = {
      id: MessageId.make("queued-1"),
      role: "user" as const,
      text: "Also export the credit notes",
      runId: null,
      inputIntent: "queued_turn" as const,
      streaming: false,
      createdAt: at("09:45:00"),
      updatedAt: at("09:45:00"),
    };
    const timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState({
      visibleTurnItems,
      optimisticMessages: [queued],
    });
    expect(
      timeline.entries.some((entry) => entry.kind === "message" && entry.message.id === queued.id),
    ).toBe(false);
    expect(project(sequence("verify"), true).result.at(-1)?.kind).toBe("factory-run");
  });

  it("Factory v2 finished run returns to its time position", () => {
    for (const point of ["done", "degraded", "stopped"] as const) {
      const items = sequence(point);
      const { result } = project(items, false);
      const baseline = project(items, false, empty(), false).result;
      const index = baseline.findIndex(
        (row) => row.createdAt !== null && row.createdAt > at("09:00:00"),
      );
      expect(runRows(result), point).toHaveLength(1);
      expect(
        result.findIndex((row) => row.kind === "factory-run"),
        point,
      ).toBe(index === -1 ? baseline.length : index);
      expect(result.at(-1)?.kind, point).not.toBe("factory-run");
    }
  });

  it.each([
    ["offset", "2026-09-28T11:00:00+02:00"],
    ["whole second", "2026-09-28T09:00:00Z"],
    ["invalid", "not-a-timestamp"],
  ])(
    "Factory v2 finished run with a %s start stays before the next fractional-second message",
    (_format, startedAt) => {
      const before = message("boundary-before", "user", "08:59:59");
      const equal = message("boundary-equal", "user", "09:00:00");
      const after = makeFactoryMessageItem({
        id: "boundary-after",
        role: "user",
        createdAt: "2026-09-28T09:00:00.500Z",
      });
      const card = makeFactoryCardTurnItem({
        id: runRowId,
        createdAt: at("09:00:00"),
        updatedAt: at("12:00:00"),
        card: {
          kind: "run",
          payload: {
            threadId: ThreadId.make("factory-thread"),
            ...makeFactoryRunSummary(eventsJsonl, "done"),
            startedAt,
          },
        },
      });
      const items = [before, equal, after, card];
      const baseline = project(items, false, empty(), false).result;
      const { result } = project(items, false);
      expect(result.map((row) => row.id)).toEqual([
        baseline[0]!.id,
        baseline[1]!.id,
        runRowId,
        baseline[2]!.id,
      ]);
      expect(withoutRun(result)).toEqual(baseline);
      expect(runRows(result)[0]?.createdAt).toBe(at("09:00:00"));
    },
  );

  it("Factory v2 run card preserves the coordinator tool rows and their grouping", () => {
    for (const live of [true, false]) {
      const items = sequence(live ? "review" : "done");
      const withCard = project(items, live).result;
      const baseline = project(items, live, empty(), false).result;
      expect(runRows(withCard)).toHaveLength(1);
      expect(withoutRun(withCard)).toEqual(baseline);
    }
    expect(project(sequence("review"), true).result.some((row) => row.kind === "work-toggle")).toBe(
      true,
    );
  });

  it("Factory v2 run content changes in one row while the other rows retain identity", () => {
    const first = project(sequence("verify"), true);
    const reviewItems = sequence("review");
    const next = project(reviewItems, true, first);
    expect(next.result.map((row) => row.id)).toEqual(first.result.map((row) => row.id));
    const run = runRows(next.result)[0]!;
    expect(run.id).toBe(runRowId);
    expect(run).not.toBe(runRows(first.result)[0]);
    expect(run.kind === "factory-run" && run.factoryRun.run.node).toBe("review");
    next.result.forEach((row, index) => {
      if (row.kind !== "factory-run") expect(row, row.id).toBe(first.result[index]);
    });
    expect(project(reviewItems, true, next).stable).toBe(next.stable);
  });

  it("Factory v2 run retains its row id when it finishes and moves", () => {
    const live = project(sequence("answered"), true);
    const finished = project(sequence("done"), false, live);
    expect(runRows(live.result).map((row) => row.id)).toEqual([runRowId]);
    expect(runRows(finished.result).map((row) => row.id)).toEqual([runRowId]);
  });

  it("Factory v2 latest run selection ignores an older run attached later", () => {
    const older = makeFactoryCardTurnItem({
      id: "factory-run:earlier-run",
      createdAt: at("10:00:00"),
      card: {
        kind: "run",
        payload: {
          threadId: ThreadId.make("factory-thread"),
          ...makeFactoryRunSummary(eventsJsonl, "done"),
          runId: "earlier-run",
          startedAt: at("07:00:00"),
        },
      },
    });
    const { result } = project([...sequence("verify"), older], true);
    expect(runRows(result).map((row) => row.id)).toEqual([runRowId]);
  });
});
