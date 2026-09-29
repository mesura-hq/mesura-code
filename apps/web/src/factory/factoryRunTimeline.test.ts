/**
 * Phase 8 fence, acceptance criteria 2, 6 and 7 on the web: where the run card
 * sits in the timeline, that it keeps one row while its run moves, and that the
 * coordinator's own tool rows stay as they were.
 *
 * Entry point: the derivation chain `ChatView` runs for every thread, from the
 * thread's activities through `deriveWorkLogEntries`,
 * `deriveTimelineEntriesWithState`, the latest run
 * (`deriveLatestFactoryRunItem`), `deriveMessagesTimelineRowsWithState` and
 * `computeStableMessagesTimelineRows`, whose rows `MessagesTimeline` renders
 * one to one, keyed by row id. Only a browser shows the card's pixels; which
 * rows exist, in which order, and which row objects survive an update, is
 * decided here.
 */
/// <reference types="vite-plus/client" />
import {
  EventId,
  factoryRunActivityId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { deriveLatestFactoryRunItem } from "@t3tools/client-runtime/factory/run-activities";
import {
  makeFactoryRunActivity,
  makeFactoryRunSummary,
  type FactoryRunFixturePoint,
} from "@t3tools/client-runtime/factory/testing";
import { describe, expect, it } from "vite-plus/test";

import eventsJsonl from "../../../../packages/shared/src/fixtures/factory-events.v1.jsonl?raw";
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  deriveMessagesTimelineRowsWithState,
  type MessagesTimelineRow,
  type MessagesTimelineRowsProjection,
  type StableMessagesTimelineRowsState,
} from "../components/chat/MessagesTimeline.logic";
import {
  deriveTimelineEntriesWithState,
  deriveWorkLogEntries,
  type TimelineEntriesProjection,
} from "../session-logic";
import type { ChatMessage } from "../types";

const threadId = ThreadId.make("factory-run-thread");
const turnId = TurnId.make("coordinator-turn");
const runRowId = factoryRunActivityId(threadId, "invoice-csv-export");
const at = (clock: string) => `2026-09-28T${clock}.000Z`;

function message(id: string, role: "user" | "assistant", clock: string): ChatMessage {
  return {
    id: MessageId.make(id),
    role,
    text: role === "user" ? "Build the approved plan" : "Phase 1 is in review.",
    turnId: role === "user" ? null : turnId,
    createdAt: at(clock),
    updatedAt: at(clock),
    streaming: false,
  };
}

/** One of the coordinator's background shell commands. */
function toolActivity(id: string, clock: string): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "tool",
    kind: "tool.completed",
    summary: "Ran command",
    payload: { title: "Ran command", itemType: "command_execution", status: "completed" },
    turnId,
    createdAt: at(clock),
  };
}

const runActivity = (point: FactoryRunFixturePoint) =>
  makeFactoryRunActivity({ threadId, summary: makeFactoryRunSummary(eventsJsonl, point), turnId });

// The run starts at 09:00 (the fixture's `run.started`), after the approval
// message and the coordinator's first command, and before its later ones.
const messages = [
  message("approve", "user", "08:58:00"),
  message("reply", "assistant", "09:50:00"),
];
const tools = [
  toolActivity("tool-before-run", "08:59:00"),
  toolActivity("tool-after-run", "09:30:00"),
  toolActivity("tool-latest", "09:40:00"),
];

interface Projection {
  timeline: TimelineEntriesProjection | null;
  rows: MessagesTimelineRowsProjection | null;
  stable: StableMessagesTimelineRowsState;
}

const emptyProjection = (): Projection => ({
  timeline: null,
  rows: null,
  stable: { byId: new Map(), result: [] },
});

/** What `ChatView` hands `MessagesTimeline` for one snapshot of the thread. */
function project(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  live: boolean,
  previous: Projection = emptyProjection(),
  options: { withRun?: boolean } = {},
): Projection & { result: MessagesTimelineRow[] } {
  const timeline = deriveTimelineEntriesWithState(
    messages,
    [],
    deriveWorkLogEntries(activities),
    previous.timeline,
  );
  const rows = deriveMessagesTimelineRowsWithState(
    {
      timelineEntries: timeline.entries,
      isWorking: live,
      activeTurnStartedAt: live ? at("08:58:01") : null,
      latestTurn: {
        turnId,
        state: live ? "running" : "completed",
        startedAt: at("08:58:01"),
        completedAt: live ? null : at("09:55:00"),
      },
      turnDiffSummaries: [],
      supportsConversationRollback: false,
      factoryRun: options.withRun === false ? null : deriveLatestFactoryRunItem(activities),
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

describe("factory run card in the web timeline (phase 8 fence)", () => {
  it("phase8 web AC2 keeps a live run's card as the last row, below the newest tool rows", () => {
    for (const point of ["verify", "waiting"] as const) {
      const activities = [...tools, runActivity(point)];
      const { result } = project(activities, true);

      expect(result.at(-1), point).toMatchObject({ kind: "factory-run", id: runRowId });
      expect(runRows(result), point).toHaveLength(1);
    }
  });

  it("phase8 web AC2 keeps a live run's card above messages queued for the next turn", () => {
    const activities = [...tools, runActivity("verify")];
    const timeline = deriveTimelineEntriesWithState(
      messages,
      [],
      deriveWorkLogEntries(activities),
      null,
    );
    const rows = deriveMessagesTimelineRows({
      timelineEntries: timeline.entries,
      isWorking: true,
      activeTurnStartedAt: at("08:58:01"),
      latestTurn: { turnId, state: "running", startedAt: at("08:58:01"), completedAt: null },
      turnDiffSummaries: [],
      supportsConversationRollback: false,
      factoryRun: deriveLatestFactoryRunItem(activities),
      queuedMessages: [
        {
          id: "queued-1",
          prompt: "Also export the credit notes",
          images: [],
          files: [],
          terminalContexts: [],
          previewAnnotations: [],
          reviewComments: [],
          submissionIntent: "foreground",
          queuedAfterToolActivityId: null,
          createdAt: at("09:45:00"),
        },
      ],
    });

    expect(rows.slice(-2).map((row) => row.kind)).toEqual(["factory-run", "queued-message"]);
  });

  it("phase8 web AC2 returns a finished run's card to its time position", () => {
    for (const point of ["done", "degraded", "stopped"] as const) {
      const activities = [...tools, runActivity(point)];
      const { result } = project(activities, false);
      const baseline = project(activities, false, emptyProjection(), { withRun: false }).result;
      const runStart = at("09:00:00");
      const expectedIndex = baseline.findIndex(
        (row) => row.createdAt !== null && row.createdAt > runStart,
      );

      expect(runRows(result), point).toHaveLength(1);
      expect(
        result.findIndex((row) => row.kind === "factory-run"),
        point,
      ).toBe(expectedIndex === -1 ? baseline.length : expectedIndex);
      expect(result.at(-1)?.kind, point).not.toBe("factory-run");
    }
  });

  it("phase8 web AC7 leaves the coordinator's tool rows visible and ungrouped beside the run card", () => {
    for (const live of [true, false]) {
      const activities = [...tools, runActivity(live ? "review" : "done")];
      const withCard = project(activities, live).result;
      const baseline = project(activities, live, emptyProjection(), { withRun: false }).result;

      expect(runRows(withCard)).toHaveLength(1);
      expect(withoutRun(withCard)).toEqual(baseline);
    }
    // The comparison above is not vacuous: the live timeline has the tool rows'
    // group, which upstream collapses into one toggle row by default.
    const liveRows = project([...tools, runActivity("review")], true).result;
    expect(liveRows.some((row) => row.kind === "work-toggle")).toBe(true);
  });

  it("phase8 web AC6 replaces the run card's content in its one row while every other row is reused", () => {
    const first = project([...tools, runActivity("verify")], true);
    const firstRun = runRows(first.result)[0]!;

    const reviewActivities = [...tools, runActivity("review")];
    const next = project(reviewActivities, true, first);
    const nextRun = runRows(next.result)[0]!;

    expect(next.result.map((row) => row.id)).toEqual(first.result.map((row) => row.id));
    expect(nextRun.id).toBe(runRowId);
    expect(nextRun).not.toBe(firstRun);
    expect(nextRun.kind === "factory-run" && nextRun.factoryRun.run.node).toBe("review");
    next.result.forEach((row, index) => {
      if (row.kind !== "factory-run") expect(row, row.id).toBe(first.result[index]);
    });

    // The same activities again change nothing: the stable rows keep their identity.
    const unchanged = project(reviewActivities, true, next);
    expect(unchanged.stable).toBe(next.stable);
  });

  it("phase8 web AC6 keeps the run card's row id when the run ends and its card moves", () => {
    const live = project([...tools, runActivity("answered")], true);
    const finished = project([...tools, runActivity("done")], false, live);

    expect(runRows(live.result).map((row) => row.id)).toEqual([runRowId]);
    expect(runRows(finished.result).map((row) => row.id)).toEqual([runRowId]);
  });

  it("phase8 web AC2 shows the card of the latest run only", () => {
    const olderRun = makeFactoryRunActivity({
      threadId,
      summary: {
        ...makeFactoryRunSummary(eventsJsonl, "done"),
        runId: "earlier-run",
        startedAt: at("07:00:00"),
      },
      turnId,
    });
    const { result } = project([olderRun, ...tools, runActivity("verify")], true);

    expect(runRows(result).map((row) => row.id)).toEqual([runRowId]);
  });
});
