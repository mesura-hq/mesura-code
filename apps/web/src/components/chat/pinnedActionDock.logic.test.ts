// Thread attention phase 6: the dock's policy, as pure functions in `pinnedActionDock.logic.ts`.
// What only a browser shows is in `PinnedActionDock.browser.test.tsx`.
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  ThreadPendingApproval,
  ThreadPendingUserInput,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  EnvironmentId,
  PlanId,
  RuntimeRequestId,
  ThreadId,
  type ThreadAgentSignal,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DISMISSED_QUESTION_ANSWER,
  PHONE_DOCK_EXPANDED_LIMIT,
  derivePinnedActionDockItems,
  dismissPlanFollowUp,
  layoutPinnedActionDock,
  parsePinnedActionDockUnpins,
  pinnedActionDockCloseAction,
  readThreadDockUnpins,
  type PinnedActionDockInput,
  type PinnedActionDockItem,
  type PinnedActionDockUnpins,
} from "./pinnedActionDock.logic";

const threadA = scopedThreadKey(
  scopeThreadRef(EnvironmentId.make("dock-environment"), ThreadId.make("dock-thread-a")),
);
const NO_UNPINS: PinnedActionDockUnpins = {};

const approval = (id: string, createdAt: string): ThreadPendingApproval => ({
  requestId: RuntimeRequestId.make(id),
  requestKind: "command",
  createdAt,
  detail: "pnpm install",
  responseCapability: "live",
});

const question = (
  id: string,
  createdAt: string,
  dismissible: boolean,
  questionIds: ReadonlyArray<string> = ["scope"],
): ThreadPendingUserInput => ({
  requestId: RuntimeRequestId.make(id),
  createdAt,
  questions: questionIds.map((questionId) => ({
    id: questionId,
    header: `Header ${questionId}`,
    question: `Which ${questionId} should the agent take?`,
    options: [{ label: "Small", description: "The small one" }],
    multiSelect: false,
  })),
  responseCapability: dismissible ? "message" : "live",
  ...(dismissible ? { responseMode: "message" as const } : {}),
  dismissible,
});

const signal = (setAt: string): ThreadAgentSignal => ({
  kind: "needs_input",
  note: "Pick the migration order",
  runId: null,
  setAt,
});

const input = (overrides: Partial<PinnedActionDockInput> = {}): PinnedActionDockInput => ({
  threadKey: threadA,
  approvals: [],
  userInputs: [],
  planFollowUp: null,
  unpins: NO_UNPINS,
  ...overrides,
});

const kinds = (items: ReadonlyArray<PinnedActionDockItem>) => items.map((item) => item.kind);

describe("persisted dock dismissals", () => {
  it("ignores obsolete plan unpins and retains follow-up dismissals on reload", () => {
    const parsed = parsePinnedActionDockUnpins({
      [threadA]: { planDigests: ["obsolete-digest"], followUpPlanIds: ["follow-up", 3] },
    });
    expect(parsed).toEqual({ [threadA]: { followUpPlanIds: ["follow-up"] } });
    expect([...readThreadDockUnpins(parsed, threadA).followUpPlanIds]).toEqual(["follow-up"]);
    for (const garbage of [null, 7, "x", [], { [threadA]: { planDigests: [3] } }]) {
      expect(readThreadDockUnpins(parsePinnedActionDockUnpins(garbage), threadA)).toEqual({
        followUpPlanIds: new Set(),
      });
    }
  });
});

describe("phase6 dock AC3: every pending question has an X with a dismissed answer", () => {
  it("phase6 dock AC3 every pending question is a dock item, dismissible or not", () => {
    const items = derivePinnedActionDockItems(
      input({
        userInputs: [
          question("question-live", "2026-10-24T10:00:00.000Z", false),
          question("question-message", "2026-10-24T10:01:00.000Z", true),
        ],
      }),
    );
    expect(kinds(items)).toEqual(["question", "question"]);
  });

  it("phase6 dock AC3 the X on a dismissible question goes through the existing dismiss", () => {
    const [item] = derivePinnedActionDockItems(
      input({ userInputs: [question("question-message", "2026-10-24T10:00:00.000Z", true)] }),
    );
    expect(pinnedActionDockCloseAction(item!)).toEqual({
      type: "dismiss-question",
      requestId: "question-message",
    });
  });

  it("phase6 dock AC3 the X on a question the provider does not mark dismissible answers every question as dismissed", () => {
    const [item] = derivePinnedActionDockItems(
      input({
        userInputs: [
          question("question-live", "2026-10-24T10:00:00.000Z", false, ["scope", "order"]),
        ],
      }),
    );
    expect(pinnedActionDockCloseAction(item!)).toEqual({
      type: "respond-question",
      requestId: "question-live",
      answers: { scope: DISMISSED_QUESTION_ANSWER, order: DISMISSED_QUESTION_ANSWER },
    });
    expect(DISMISSED_QUESTION_ANSWER).toMatch(/dismissed/i);
  });
});

describe("phase6 dock AC4: every pending approval has an X that declines it", () => {
  it("phase6 dock AC4 the X on an approval sends the decline decision, not cancel", () => {
    const [item] = derivePinnedActionDockItems(
      input({ approvals: [approval("approval-1", "2026-10-24T10:00:00.000Z")] }),
    );
    expect(item!.kind).toBe("approval");
    expect(pinnedActionDockCloseAction(item!)).toEqual({
      type: "respond-approval",
      requestId: "approval-1",
      decision: "decline",
    });
  });
});

describe("phase6 dock AC5: the plan follow-up stays in the dock and signals stay outside it", () => {
  const followUp = {
    id: PlanId.make("proposed-plan-1"),
    createdAt: "2026-10-24T10:02:00.000Z",
    title: "Ship the dock",
  };

  it.each(["needs_input", "ready_to_close"] as const)("the dock ignores a %s signal", (kind) => {
    const sources = {
      ...input({ planFollowUp: followUp }),
      agentSignal: { ...signal("2026-10-24T10:03:00.000Z"), kind },
    };
    const items = derivePinnedActionDockItems(sources);
    expect(kinds(items)).toEqual(["plan-follow-up"]);
  });

  it("phase6 dock AC5 the X on the follow-up dismisses it", () => {
    const items = derivePinnedActionDockItems(input({ planFollowUp: followUp }));
    expect(items.map(pinnedActionDockCloseAction)).toEqual([
      { type: "dismiss-plan-follow-up", planId: "proposed-plan-1" },
    ]);
  });

  it("phase6 dock AC5 a dismissed plan follow-up stays closed for that proposed plan only", () => {
    const unpins = dismissPlanFollowUp(NO_UNPINS, threadA, followUp.id);
    expect(kinds(derivePinnedActionDockItems(input({ planFollowUp: followUp, unpins })))).toEqual(
      [],
    );
    expect(
      kinds(
        derivePinnedActionDockItems(
          input({ planFollowUp: { ...followUp, id: PlanId.make("proposed-plan-2") }, unpins }),
        ),
      ),
    ).toEqual(["plan-follow-up"]);
  });
});

describe("phase6 dock AC6: newest first, at most two expanded at phone width", () => {
  const several = input({
    approvals: [approval("approval-1", "2026-10-24T10:00:00.000Z")],
    userInputs: [question("question-1", "2026-10-24T10:01:00.000Z", false)],
    planFollowUp: {
      id: PlanId.make("follow-up"),
      createdAt: "2026-10-24T10:02:00.000Z",
      title: "Ready",
    },
  });

  it("phase6 dock AC6 stacks the items newest first", () => {
    expect(kinds(derivePinnedActionDockItems(several))).toEqual([
      "plan-follow-up",
      "question",
      "approval",
    ]);
  });

  it("phase6 dock AC6 expands the two newest at phone width and collapses the rest to one line", () => {
    const layout = layoutPinnedActionDock(derivePinnedActionDockItems(several), {
      phoneWidth: true,
      expandedKeys: new Set(),
    });
    expect(PHONE_DOCK_EXPANDED_LIMIT).toBe(2);
    expect(layout.map((entry) => [entry.item.kind, entry.expanded])).toEqual([
      ["plan-follow-up", true],
      ["question", true],
      ["approval", false],
    ]);
  });

  it("phase6 dock AC6 a tapped collapsed item expands and the phone limit still holds", () => {
    const items = derivePinnedActionDockItems(several);
    const approvalKey = items.find((item) => item.kind === "approval")!.key;
    const layout = layoutPinnedActionDock(items, {
      phoneWidth: true,
      expandedKeys: new Set([approvalKey]),
    });
    expect(layout.find((entry) => entry.item.key === approvalKey)?.expanded).toBe(true);
    expect(layout.filter((entry) => entry.expanded)).toHaveLength(PHONE_DOCK_EXPANDED_LIMIT);
  });

  it("phase6 dock AC6 keeps every item expanded at desktop width", () => {
    const layout = layoutPinnedActionDock(derivePinnedActionDockItems(several), {
      phoneWidth: false,
      expandedKeys: new Set(),
    });
    expect(layout.every((entry) => entry.expanded)).toBe(true);
  });

  it("phase6 dock AC6 gives every item a key that is unique and stable across derivations", () => {
    const first = derivePinnedActionDockItems(several).map((item) => item.key);
    const second = derivePinnedActionDockItems(several).map((item) => item.key);
    expect(new Set(first).size).toBe(first.length);
    expect(second).toEqual(first);
  });
});

describe("phase6 dock AC7: every X is labelled with the item it closes", () => {
  it("phase6 dock AC7 each close label names its item", () => {
    const items = derivePinnedActionDockItems(
      input({
        approvals: [approval("approval-1", "2026-10-24T10:00:00.000Z")],
        userInputs: [question("question-1", "2026-10-24T10:01:00.000Z", false)],
        planFollowUp: {
          id: PlanId.make("proposed-plan-1"),
          createdAt: "2026-10-24T10:03:00.000Z",
          title: "Ship the dock",
        },
      }),
    );
    const labels = Object.fromEntries(items.map((item) => [item.kind, item.closeLabel]));
    expect(labels).toEqual({
      "plan-follow-up": expect.stringMatching(/^Dismiss .*Ship the dock/),
      question: expect.stringMatching(/^Dismiss .*Which scope should the agent take\?/),
      approval: expect.stringMatching(/^Decline .*command/i),
    });
  });
});

describe("phase6 dock guard: nothing pending means no dock", () => {
  it("phase6 dock guard derives no items for a thread with nothing waiting on the developer", () => {
    expect(derivePinnedActionDockItems(input())).toEqual([]);
  });
});

it("leaves Factory plan presentations outside the dock", () => {
  const sources = { ...input(), factoryPlans: [{ kind: "plan" }], messages: [] };
  expect(derivePinnedActionDockItems(sources)).toEqual([]);
});
