import { formatPlanApprovalMessage } from "@t3tools/client-runtime/factory/plan-approval";
import {
  FACTORY_DEFAULT_TEST_ROUTES,
  FACTORY_OTHER_PLAN_DIGEST,
  FACTORY_REVISED_PLAN_DIGEST,
  makeFactoryCardTurnItem,
  makeFactoryPlanPayload,
  makeFactoryRunSummary,
} from "@t3tools/client-runtime/factory/testing";
import { EnvironmentId, ThreadId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { makeFactoryMessageItem, projectFactoryTurnItems } from "../../factory/factoryTestFixtures";
import { makeFenceUserInput } from "../../test/fenceThreadShell";
import {
  deriveTimelineEntriesFromVisibleTurnItems,
  type PendingUserInput,
} from "../../session-logic";
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  type MessagesTimelineRowsInput,
} from "./MessagesTimeline.logic";

const environmentId = EnvironmentId.make("pending-cards-environment");
const threadId = ThreadId.make("pending-cards-thread");
const at = (second: number) => `2026-10-24T10:00:${String(second).padStart(2, "0")}.000Z`;
const plan = (id = "plan", second = 1, overrides = {}) =>
  makeFactoryCardTurnItem({
    id,
    threadId,
    createdAt: at(second),
    card: {
      kind: "plan",
      payload: makeFactoryPlanPayload({ presentedAt: at(second), ...overrides }),
    },
  });
const message = (id: string, second: number, text = id, role: "user" | "assistant" = "assistant") =>
  makeFactoryMessageItem({ id, threadId, createdAt: at(second), text, role });
const question = (id: string, second: number) => {
  const fixture = makeFenceUserInput({
    threadId,
    requestId: id,
    createdAt: at(second),
    questions: [{ id: "scope", header: "Scope", question: "Which scope?", options: [] }],
  });
  const pending: PendingUserInput = {
    requestId: fixture.request.id,
    createdAt: at(second),
    dismissible: false,
    responseCapability: "live",
    questions: fixture.item.questions.map((question) => ({
      ...question,
      multiSelect: question.multiSelect ?? false,
    })),
  };
  return { ...fixture, pending };
};
const approval = (second: number, payload = makeFactoryPlanPayload()) =>
  message(
    "approval",
    second,
    formatPlanApprovalMessage({ ...payload, routes: FACTORY_DEFAULT_TEST_ROUTES }),
    "user",
  );
function inputFor(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  requests: PendingUserInput[] = [],
): MessagesTimelineRowsInput {
  return {
    timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: projectFactoryTurnItems(items),
      optimisticMessages: [],
    }),
    environmentId,
    threadId,
    pendingUserInputs: requests,
    expandedRunIds: new Set(items.flatMap((item) => (item.runId ? [item.runId] : []))),
    isWorking: false,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
  };
}

it("keeps the full pending plan after replies, sent messages and working rows, then restores its anchor on approval", () => {
  const card = plan();
  const reply = message("reply", 2);
  const initialRows = deriveMessagesTimelineRows(inputFor([card, reply]));
  const planRow = initialRows.find((row) => row.kind === "factory-plan")!;
  expect(initialRows.at(-1)).toBe(planRow);
  const working = {
    ...inputFor([card, reply, message("sent", 3, "Continue", "user")]),
    isWorking: true,
    activeTurnStartedAt: at(3),
  };
  const next = deriveMessagesTimelineRows(working);
  expect(next.at(-1)?.id).toBe(planRow.id);
  expect(next.some((row) => row.kind === "working")).toBe(true);
  const approved = deriveMessagesTimelineRows(inputFor([card, message("reply", 2), approval(4)]));
  expect(approved[0]?.id).toBe(planRow.id);
  expect(approved.at(-1)?.id).not.toBe(planRow.id);
  const previous = computeStableMessagesTimelineRows(initialRows, { byId: new Map(), result: [] });
  const moved = computeStableMessagesTimelineRows(next, previous);
  expect(moved.byId.get(planRow.id)).toBe(planRow);
  const reordered = computeStableMessagesTimelineRows([...initialRows].reverse(), previous);
  expect(reordered.byId.get(initialRows[0]!.id)).toBe(initialRows[0]);
});

it("moves only the newest presentation and never revives an older plan after the newest approval", () => {
  const newerPayload = makeFactoryPlanPayload({
    digest: FACTORY_OTHER_PLAN_DIGEST,
    planPath: "/other/plan.md",
    presentedAt: at(3),
  });
  const entries = [
    plan(),
    message("between", 2),
    plan("newer", 3, newerPayload),
    message("after", 4),
  ];
  const rows = deriveMessagesTimelineRows(inputFor(entries));
  expect(rows[0]?.kind).toBe("factory-plan");
  expect(rows.at(-1)).toMatchObject({ kind: "factory-plan", factoryPlan: { id: "newer" } });
  const approved = deriveMessagesTimelineRows(inputFor([...entries, approval(5, newerPayload)]));
  expect(approved[0]?.id).toBe(rows[0]!.id);
  expect(approved.at(-1)?.kind).toBe("message");
});

it("uses presentation time for revisions of an earlier anchor", () => {
  const revised = plan("revised", 1, { digest: FACTORY_REVISED_PLAN_DIGEST, presentedAt: at(5) });
  const other = plan("other", 3, { digest: FACTORY_OTHER_PLAN_DIGEST, planPath: "/other/plan.md" });
  const rows = deriveMessagesTimelineRows(
    inputFor([revised, message("between", 2), other, message("last", 4)]),
  );
  expect(rows.at(-1)).toMatchObject({ kind: "factory-plan", factoryPlan: { id: "revised" } });
});

it("does not treat another path's approval of identical bytes as approval of this plan", () => {
  const rows = deriveMessagesTimelineRows(
    inputFor([plan(), approval(2, makeFactoryPlanPayload({ planPath: "/other/plan.md" }))]),
  );
  expect(rows.at(-1)?.kind).toBe("factory-plan");
});

it("keeps all pending questions after the pending plan and every new work or message row in timeline order", () => {
  const first = question("first", 2);
  const second = question("second", 4);
  const entries = [plan(), first.item, message("middle", 3), second.item, message("tail", 5)];
  const rows = deriveMessagesTimelineRows({
    ...inputFor(entries, [second.pending, first.pending]),
    isWorking: true,
    activeTurnStartedAt: at(5),
  });
  expect(rows.slice(-3).map((row) => row.kind)).toEqual([
    "factory-plan",
    "pending-user-input",
    "pending-user-input",
  ]);
  expect(
    rows.slice(-2).map((row) => (row.kind === "pending-user-input" ? row.request.requestId : null)),
  ).toEqual(["first", "second"]);
  const appended = deriveMessagesTimelineRows(
    inputFor([...entries, message("sent", 6, "Continue", "user")], [first.pending, second.pending]),
  );
  expect(appended.slice(-2).map((row) => row.id)).toEqual(rows.slice(-2).map((row) => row.id));
});

it.each(["answered", "dismissed"])(
  "returns a %s question to its chronological work row while another question stays last",
  (status) => {
    const first = question("first", 2);
    const second = question("second", 4);
    const answered = {
      ...first.item,
      questionAnswer: {
        requestId: "first",
        questionTextById: { scope: "Which scope?" },
        answers: { scope: status },
        attachmentsByQuestionId: {},
      },
    };
    const rows = deriveMessagesTimelineRows(
      inputFor(
        [
          message("start", 1, "Begin", "user"),
          answered,
          message("middle", 3),
          second.item,
          message("last", 5),
        ],
        [second.pending],
      ),
    );
    expect(rows.at(-1)).toMatchObject({
      kind: "pending-user-input",
      request: { requestId: "second" },
    });
    const workIndex = rows.findIndex((row) => row.kind === "work");
    expect(workIndex).toBeGreaterThan(0);
    expect(workIndex).toBeLessThan(
      rows.findIndex((row) => row.kind === "message" && row.message.text === "middle"),
    );
  },
);

it("keeps a question without a loaded request item at the end", () => {
  const pending = question("unloaded", 1);
  const rows = deriveMessagesTimelineRows(inputFor([message("tail", 3)], [pending.pending]));
  expect(rows.at(-1)).toMatchObject({
    kind: "pending-user-input",
    request: { requestId: "unloaded" },
  });
});

it("moves a changed plan back to the end after approval of its previous digest", () => {
  const changed = plan("plan", 1, { digest: FACTORY_REVISED_PLAN_DIGEST });
  const rows = deriveMessagesTimelineRows(inputFor([changed, approval(2), message("latest", 3)]));
  expect(rows.at(-1)).toMatchObject({
    kind: "factory-plan",
    factoryPlan: { plan: { digest: FACTORY_REVISED_PLAN_DIGEST } },
  });
});

it("returns a dismissed request without an answer payload to its original work position", () => {
  const dismissed = question("dismissed", 2);
  const rows = deriveMessagesTimelineRows(
    inputFor([message("start", 1, "Begin", "user"), dismissed.item, message("after", 3)]),
  );
  expect(rows.some((row) => row.kind === "pending-user-input")).toBe(false);
  const workIndex = rows.findIndex((row) => row.kind === "work");
  expect(workIndex).toBeGreaterThan(0);
  expect(workIndex).toBeLessThan(
    rows.findIndex((row) => row.kind === "message" && row.message.text === "after"),
  );
});

it("places pending cards after a live Factory run card", () => {
  const pending = question("question", 2);
  const rows = deriveMessagesTimelineRows({
    ...inputFor([plan(), pending.item, message("tail", 3)], [pending.pending]),
    factoryRun: {
      id: "live-factory-run",
      createdAt: at(0),
      run: { threadId, ...makeFactoryRunSummary("", "attached") },
    },
  });
  expect(rows.slice(-3).map((row) => row.kind)).toEqual([
    "factory-run",
    "factory-plan",
    "pending-user-input",
  ]);
});
