/**
 * Phase 2 fence, acceptance criteria 1 and 2: the plan card's place in the
 * web timeline, including a turn that folds around it.
 *
 * Entry point: the derivation chain `ChatView` runs for every thread, from
 * the thread detail reducer (`applyThreadDetailEvent`) through
 * `deriveWorkLogEntries`, `deriveFactoryPlanTimelineItems`,
 * `deriveTimelineEntriesWithState` to `deriveMessagesTimelineRows`, whose rows
 * `MessagesTimeline` renders one to one. Only a browser shows the card's
 * pixels; which rows exist, in which order, with which payload, is decided
 * here.
 */
import {
  EventId,
  FACTORY_REPORT_ACTIVITY_KIND,
  FACTORY_RUN_ACTIVITY_KIND,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { applyThreadDetailEvent } from "@t3tools/client-runtime/state/threads";
import { describe, expect, it } from "vite-plus/test";

import { deriveMessagesTimelineRows } from "../components/chat/MessagesTimeline.logic";
import {
  deriveTimelineEntriesWithState,
  deriveWorkLogEntries,
  type TimelineEntriesProjection,
} from "../session-logic";
import type { ChatMessage } from "../types";
import {
  FACTORY_REVISED_PLAN_DIGEST,
  makeFactoryPlanActivity,
  makeFactoryPlanPayload,
} from "./factoryPlan.fixtures";
import { deriveFactoryPlanTimelineItems } from "./factoryPlanTimeline";

const time = (second: number) => new Date(Date.UTC(2026, 8, 28, 10, 0, second)).toISOString();

function message(
  id: string,
  role: "user" | "assistant",
  second: number,
  turnId: string | null = null,
): ChatMessage {
  return {
    id: MessageId.make(id),
    role,
    text: role === "user" ? "Plan the factory" : "Presented",
    turnId: turnId === null ? null : TurnId.make(turnId),
    createdAt: time(second),
    updatedAt: time(second),
    streaming: false,
  };
}

function makeThread(messages: ReadonlyArray<ChatMessage>): OrchestrationThread {
  return {
    id: ThreadId.make("factory-thread"),
    projectId: ProjectId.make("project"),
    title: "Bring Software Factory into chat",
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    pullRequests: [],
    worktreePath: null,
    latestTurn: null,
    createdAt: time(0),
    updatedAt: time(0),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: messages.map((entry) => ({ ...entry, attachments: [] })) as never,
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

let nextEventSequence = 1;

/** Delivers an activity the way the server's event stream does. */
function appendActivity(
  thread: OrchestrationThread,
  activity: OrchestrationThreadActivity,
): OrchestrationThread {
  const sequence = nextEventSequence++;
  const result = applyThreadDetailEvent(thread, {
    eventId: EventId.make(`event-${sequence}`),
    sequence,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    occurredAt: activity.createdAt,
    aggregateKind: "thread",
    aggregateId: thread.id,
    type: "thread.activity-appended",
    payload: { threadId: thread.id, activity },
  });
  if (result.kind !== "updated") throw new Error(`Activity ${activity.id} was not applied`);
  return result.thread;
}

/** What `ChatView` feeds `MessagesTimeline` for one thread snapshot. */
function project(
  thread: OrchestrationThread,
  messages: ReadonlyArray<ChatMessage>,
  previous: TimelineEntriesProjection | null = null,
) {
  const timeline = deriveTimelineEntriesWithState(
    messages,
    [],
    deriveWorkLogEntries(thread.activities),
    previous,
    deriveFactoryPlanTimelineItems(thread.activities),
  );
  const rows = deriveMessagesTimelineRows({
    timelineEntries: timeline.entries,
    isWorking: false,
    activeTurnStartedAt: null,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
  });
  return { timeline, rows };
}

const factoryPlanRows = (rows: ReturnType<typeof project>["rows"]) =>
  rows.flatMap((row) => (row.kind === "factory-plan" ? [row] : []));

describe("factory plan card in the web timeline (phase 2 fence)", () => {
  it("renders a presented factory plan as one card at its place in time, never as a tool row", () => {
    const messages = [
      message("user-1", "user", 0),
      message("assistant-1", "assistant", 10, "turn-1"),
      message("user-2", "user", 20),
    ];
    const payload = makeFactoryPlanPayload({ presentedAt: time(5) });
    const thread = appendActivity(
      makeThread(messages),
      makeFactoryPlanActivity({ createdAt: time(5), payload }),
    );

    const { rows } = project(thread, messages);

    expect(rows.map((row) => row.kind)).toEqual(["message", "factory-plan", "message", "message"]);
    expect(factoryPlanRows(rows)[0]?.factoryPlan.plan).toEqual(payload);
    // No work-log entry, so no tool row, for any activity the Factory writes.
    expect(
      deriveWorkLogEntries([
        makeFactoryPlanActivity({ createdAt: time(5) }),
        {
          ...makeFactoryPlanActivity({ id: "run", createdAt: time(6) }),
          kind: FACTORY_RUN_ACTIVITY_KIND,
        },
        {
          ...makeFactoryPlanActivity({ id: "report", createdAt: time(7) }),
          kind: FACTORY_REPORT_ACTIVITY_KIND,
        },
      ]),
    ).toEqual([]);
  });

  it("keeps a factory plan card visible when the turn that presented it folds", () => {
    const messages = [
      message("user-1", "user", 0),
      message("assistant-first", "assistant", 5, "turn-1"),
      message("assistant-final", "assistant", 20, "turn-1"),
    ];
    const toolRun: OrchestrationThreadActivity = {
      id: EventId.make("tool-1"),
      tone: "tool",
      kind: "tool.completed",
      summary: "Ran command",
      payload: {},
      turnId: TurnId.make("turn-1"),
      createdAt: time(8),
    };
    const payload = makeFactoryPlanPayload({ presentedAt: time(9) });
    const activities = [toolRun, makeFactoryPlanActivity({ createdAt: time(9), payload })];
    const entries = deriveTimelineEntriesWithState(
      messages,
      [],
      deriveWorkLogEntries(activities),
      null,
      deriveFactoryPlanTimelineItems(activities),
    ).entries;
    const rowsFor = (expanded: boolean) =>
      deriveMessagesTimelineRows({
        timelineEntries: entries,
        ...(expanded ? { expandedTurnIds: new Set([TurnId.make("turn-1")]) } : {}),
        isWorking: false,
        activeTurnStartedAt: null,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });

    const collapsed = rowsFor(false);
    expect(collapsed.map((row) => row.kind)).toEqual([
      "message",
      "turn-fold",
      "factory-plan",
      "message",
    ]);
    expect(factoryPlanRows(collapsed)[0]?.factoryPlan.plan).toEqual(payload);
    expect(rowsFor(true).map((row) => row.kind)).toEqual([
      "message",
      "turn-fold",
      "message",
      "work",
      "factory-plan",
      "message",
    ]);
  });

  it("drops a factory plan activity whose payload does not decode, without a tool row", () => {
    const messages = [message("user-1", "user", 0)];
    const thread = appendActivity(
      makeThread(messages),
      makeFactoryPlanActivity({
        createdAt: time(5),
        payload: { digest: "not-a-digest", title: "Broken" },
      }),
    );

    const { rows } = project(thread, messages);

    expect(rows.map((row) => row.kind)).toEqual(["message"]);
  });

  it("moves a revised plan's card to the end with the new content, one card per plan file", () => {
    const messages = [
      message("user-1", "user", 0),
      message("assistant-1", "assistant", 10, "turn-1"),
      message("user-2", "user", 20),
      message("assistant-2", "assistant", 30, "turn-2"),
    ];
    const first = appendActivity(
      makeThread(messages),
      makeFactoryPlanActivity({ createdAt: time(5) }),
    );
    const firstProjection = project(first, messages);
    expect(firstProjection.rows.map((row) => row.kind)).toEqual([
      "message",
      "factory-plan",
      "message",
      "message",
      "message",
    ]);

    const revisedPayload = makeFactoryPlanPayload({
      digest: FACTORY_REVISED_PLAN_DIGEST,
      title: "Plan: the Software Factory inside Mesura Code, revised",
      phases: [
        { title: "Snapshot a plan and present it to the thread", acceptanceCount: 7 },
        { title: "Render the plan card and the Factory pane on the web", acceptanceCount: 6 },
        { title: "Render the plan card and the Factory screen on Android", acceptanceCount: 5 },
      ],
      presentedAt: time(40),
    });
    const revised = appendActivity(
      first,
      makeFactoryPlanActivity({ createdAt: time(40), payload: revisedPayload }),
    );

    // The incremental projection ChatView keeps must agree with a fresh one.
    for (const { rows } of [
      project(revised, messages, firstProjection.timeline),
      project(revised, messages),
    ]) {
      expect(rows.map((row) => row.kind)).toEqual([
        "message",
        "message",
        "message",
        "message",
        "factory-plan",
      ]);
      expect(factoryPlanRows(rows).map((row) => row.factoryPlan.plan)).toEqual([revisedPayload]);
    }

    // A second plan file is a second card; each file keeps exactly one.
    const otherPlanPayload = makeFactoryPlanPayload({
      planPath: "/home/dev/plans/other/plan.md",
      title: "Plan: another change",
      presentedAt: time(45),
    });
    const twoFiles = appendActivity(
      revised,
      makeFactoryPlanActivity({
        id: "factory-plan:other-plan-md",
        createdAt: time(45),
        payload: otherPlanPayload,
      }),
    );
    expect(
      factoryPlanRows(project(twoFiles, messages).rows).map((row) => row.factoryPlan.plan.title),
    ).toEqual([revisedPayload.title, otherPlanPayload.title]);
  });

  it("keeps the latest activity per id when a stale copy of the same plan is still listed", () => {
    const stale = makeFactoryPlanActivity({ createdAt: time(5) });
    const latestPayload = makeFactoryPlanPayload({
      digest: FACTORY_REVISED_PLAN_DIGEST,
      presentedAt: time(40),
    });
    const latest = makeFactoryPlanActivity({ createdAt: time(40), payload: latestPayload });

    const items = deriveFactoryPlanTimelineItems([stale, latest]);

    expect(items.map((item) => item.plan)).toEqual([latestPayload]);
    expect(items[0]?.createdAt).toBe(time(40));
  });

  it("reuses the decoded plan and its timeline entry while unrelated rows stream", () => {
    const activities = [makeFactoryPlanActivity({ createdAt: time(5) })];
    const firstItems = deriveFactoryPlanTimelineItems(activities);
    const secondItems = deriveFactoryPlanTimelineItems([...activities]);
    // Same activity object, same decoded item: row memoisation compares by reference.
    expect(secondItems[0]).toBe(firstItems[0]);

    const streaming = { ...message("assistant-1", "assistant", 10, "turn-1"), streaming: true };
    const messages = [message("user-1", "user", 0), streaming];
    const first = deriveTimelineEntriesWithState(messages, [], [], null, firstItems);
    const grown = deriveTimelineEntriesWithState(
      [messages[0]!, { ...streaming, text: "Presented the plan" }],
      [],
      [],
      first,
      secondItems,
    );

    const planEntry = (projection: TimelineEntriesProjection) =>
      projection.entries.find((entry) => entry.kind === "factory-plan");
    expect(planEntry(grown)).toBeDefined();
    expect(planEntry(grown)).toBe(planEntry(first));
  });
});
