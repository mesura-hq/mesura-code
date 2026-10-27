// Thread attention phase 6: the dock's policy, as pure functions in `pinnedActionDock.logic.ts`.
// What only a browser shows is in `PinnedActionDock.browser.test.tsx`.
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { FactoryPlanTimelineItem } from "@t3tools/client-runtime/factory/plan-activities";
import { formatPlanApprovalMessage } from "@t3tools/client-runtime/factory/plan-approval";
import {
  FACTORY_DEFAULT_TEST_ROUTES,
  FACTORY_OTHER_PLAN_DIGEST,
  FACTORY_PLAN_DIGEST,
  FACTORY_REVISED_PLAN_DIGEST,
  makeFactoryPlanPayload,
} from "@t3tools/client-runtime/factory/testing";
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
  unpinFactoryPlan,
  type PinnedActionDockInput,
  type PinnedActionDockItem,
  type PinnedActionDockUnpins,
} from "./pinnedActionDock.logic";

const threadA = scopedThreadKey(
  scopeThreadRef(EnvironmentId.make("dock-environment"), ThreadId.make("dock-thread-a")),
);
const threadB = scopedThreadKey(
  scopeThreadRef(EnvironmentId.make("dock-environment"), ThreadId.make("dock-thread-b")),
);
const NO_UNPINS: PinnedActionDockUnpins = {};

const planItem = (
  overrides: Partial<FactoryPlanTimelineItem["plan"]> & { readonly id?: string; at?: string } = {},
): FactoryPlanTimelineItem => {
  const { id, at, ...plan } = overrides;
  const createdAt = at ?? "2026-10-24T10:00:00.000Z";
  // A first presentation anchors the card at its presentation time.
  return {
    kind: "plan",
    id: id ?? "factory-plan:plan-md",
    createdAt,
    plan: makeFactoryPlanPayload({ presentedAt: createdAt, ...plan }),
  };
};

const approvalMessage = (digest: string, planPath = makeFactoryPlanPayload().planPath) => ({
  role: "user",
  text: formatPlanApprovalMessage({
    digest,
    planPath,
    intentPath: makeFactoryPlanPayload().intentPath,
    routes: FACTORY_DEFAULT_TEST_ROUTES,
  }),
});

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
  factoryPlans: [],
  messages: [],
  planFollowUp: null,
  agentSignal: null,
  unpins: NO_UNPINS,
  ...overrides,
});

const kinds = (items: ReadonlyArray<PinnedActionDockItem>) => items.map((item) => item.kind);

describe("phase6 dock AC1: an unapproved Factory plan is a dock item", () => {
  it("phase6 dock AC1 pins a presented, unapproved plan with its title and phase count", () => {
    const items = derivePinnedActionDockItems(input({ factoryPlans: [planItem()] }));
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({
      kind: "plan",
      digest: FACTORY_PLAN_DIGEST,
      planId: "factory-plan:plan-md",
      title: "Plan: the Software Factory inside Mesura Code",
      phaseCountLabel: "2 phases",
    });
  });

  it("phase6 dock AC1 does not pin a plan whose digest an approval message names", () => {
    const items = derivePinnedActionDockItems(
      input({ factoryPlans: [planItem()], messages: [approvalMessage(FACTORY_PLAN_DIGEST)] }),
    );
    expect(kinds(items)).not.toContain("plan");
  });

  it("phase6 dock AC1 pins a plan again once its file changed after an older approval", () => {
    const items = derivePinnedActionDockItems(
      input({
        factoryPlans: [planItem({ digest: FACTORY_REVISED_PLAN_DIGEST })],
        messages: [approvalMessage(FACTORY_PLAN_DIGEST)],
      }),
    );
    expect(items.map((item) => (item.kind === "plan" ? item.digest : null))).toEqual([
      FACTORY_REVISED_PLAN_DIGEST,
    ]);
  });

  it("phase6 dock AC1 pins only the newest unapproved plan presentation of a thread", () => {
    const items = derivePinnedActionDockItems(
      input({
        factoryPlans: [
          planItem({ id: "factory-plan:old", at: "2026-10-24T09:00:00.000Z" }),
          planItem({
            id: "factory-plan:new",
            at: "2026-10-24T11:00:00.000Z",
            digest: FACTORY_OTHER_PLAN_DIGEST,
            planPath: "/home/dev/plans/other/plan.md",
            title: "Plan: the other change",
          }),
        ],
      }),
    );
    expect(items.filter((item) => item.kind === "plan")).toEqual([
      expect.objectContaining({ planId: "factory-plan:new", digest: FACTORY_OTHER_PLAN_DIGEST }),
    ]);
  });

  it("phase6 dock P1-1 pins a plan file presented again after another plan was approved", () => {
    // A plan file keeps one card, anchored where it was first presented; a revision only moves
    // its presentation time.
    const items = derivePinnedActionDockItems(
      input({
        factoryPlans: [
          planItem({
            id: "factory-plan:a",
            at: "2026-10-24T09:00:00.000Z",
            presentedAt: "2026-10-24T12:00:00.000Z",
            digest: FACTORY_REVISED_PLAN_DIGEST,
          }),
          planItem({
            id: "factory-plan:b",
            at: "2026-10-24T10:00:00.000Z",
            presentedAt: "2026-10-24T10:00:00.000Z",
            digest: FACTORY_OTHER_PLAN_DIGEST,
            planPath: "/home/dev/plans/other/plan.md",
          }),
        ],
        messages: [approvalMessage(FACTORY_OTHER_PLAN_DIGEST, "/home/dev/plans/other/plan.md")],
      }),
    );
    expect(items.filter((item) => item.kind === "plan")).toEqual([
      expect.objectContaining({
        planId: "factory-plan:a",
        digest: FACTORY_REVISED_PLAN_DIGEST,
        createdAt: "2026-10-24T12:00:00.000Z",
      }),
    ]);
  });

  it("phase6 dock AC1 never pins an older unapproved plan once a newer plan was approved", () => {
    const items = derivePinnedActionDockItems(
      input({
        factoryPlans: [
          planItem({ id: "factory-plan:old", at: "2026-10-24T09:00:00.000Z" }),
          planItem({
            id: "factory-plan:new",
            at: "2026-10-24T11:00:00.000Z",
            digest: FACTORY_OTHER_PLAN_DIGEST,
            planPath: "/home/dev/plans/other/plan.md",
            title: "Plan: the other change",
          }),
        ],
        messages: [approvalMessage(FACTORY_OTHER_PLAN_DIGEST, "/home/dev/plans/other/plan.md")],
      }),
    );
    expect(kinds(items)).not.toContain("plan");
  });
});

describe("phase6 dock AC2: unpinning a plan card is client state keyed by digest", () => {
  it("phase6 dock AC2 unpinning a digest removes the plan from that thread's dock only", () => {
    const unpins = unpinFactoryPlan(NO_UNPINS, threadA, FACTORY_PLAN_DIGEST);
    expect(
      kinds(derivePinnedActionDockItems(input({ factoryPlans: [planItem()], unpins }))),
    ).toEqual([]);
    expect(
      kinds(
        derivePinnedActionDockItems(
          input({ threadKey: threadB, factoryPlans: [planItem()], unpins }),
        ),
      ),
    ).toEqual(["plan"]);
  });

  it("phase6 dock AC2 a newly presented digest of the same plan pins again", () => {
    const unpins = unpinFactoryPlan(NO_UNPINS, threadA, FACTORY_PLAN_DIGEST);
    const items = derivePinnedActionDockItems(
      input({ factoryPlans: [planItem({ digest: FACTORY_REVISED_PLAN_DIGEST })], unpins }),
    );
    expect(kinds(items)).toEqual(["plan"]);
  });

  it("phase6 dock AC2 unpinning returns a new state and leaves the previous one untouched", () => {
    const first = unpinFactoryPlan(NO_UNPINS, threadA, FACTORY_PLAN_DIGEST);
    const second = unpinFactoryPlan(first, threadA, FACTORY_OTHER_PLAN_DIGEST);
    expect(readThreadDockUnpins(NO_UNPINS, threadA).planDigests.size).toBe(0);
    expect([...readThreadDockUnpins(first, threadA).planDigests]).toEqual([FACTORY_PLAN_DIGEST]);
    expect(new Set(readThreadDockUnpins(second, threadA).planDigests)).toEqual(
      new Set([FACTORY_PLAN_DIGEST, FACTORY_OTHER_PLAN_DIGEST]),
    );
    expect(unpinFactoryPlan(first, threadA, FACTORY_PLAN_DIGEST)).toBe(first);
  });

  it("phase6 dock AC2 the X on a plan card only unpins, it never sends a rejection", () => {
    const [item] = derivePinnedActionDockItems(input({ factoryPlans: [planItem()] }));
    expect(pinnedActionDockCloseAction(item!)).toEqual({
      type: "unpin-plan",
      digest: FACTORY_PLAN_DIGEST,
    });
  });

  it("phase6 dock AC2 persisted unpins survive a reload and garbage is dropped", () => {
    const unpins = dismissPlanFollowUp(
      unpinFactoryPlan(NO_UNPINS, threadA, FACTORY_PLAN_DIGEST),
      threadA,
      PlanId.make("proposed-plan-1"),
    );
    const reloaded = parsePinnedActionDockUnpins(JSON.parse(JSON.stringify(unpins)));
    expect([...readThreadDockUnpins(reloaded, threadA).planDigests]).toEqual([FACTORY_PLAN_DIGEST]);
    expect([...readThreadDockUnpins(reloaded, threadA).followUpPlanIds]).toEqual([
      "proposed-plan-1",
    ]);
    for (const garbage of [null, 7, "x", [], { [threadA]: { planDigests: [3] } }]) {
      expect(readThreadDockUnpins(parsePinnedActionDockUnpins(garbage), threadA)).toEqual({
        planDigests: new Set(),
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

describe("phase6 dock AC5: the plan follow-up and the agent signal live in the dock", () => {
  const followUp = {
    id: PlanId.make("proposed-plan-1"),
    createdAt: "2026-10-24T10:02:00.000Z",
    title: "Ship the dock",
  };

  it("phase6 dock AC5 the plan follow-up and the agent signal are dock items", () => {
    const items = derivePinnedActionDockItems(
      input({ planFollowUp: followUp, agentSignal: signal("2026-10-24T10:03:00.000Z") }),
    );
    expect(kinds(items)).toEqual(["agent-signal", "plan-follow-up"]);
  });

  it("phase6 dock AC5 the X on the agent signal clears it and the X on the follow-up dismisses it", () => {
    const items = derivePinnedActionDockItems(
      input({ planFollowUp: followUp, agentSignal: signal("2026-10-24T10:03:00.000Z") }),
    );
    expect(items.map(pinnedActionDockCloseAction)).toEqual([
      { type: "clear-agent-signal" },
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
    factoryPlans: [planItem({ at: "2026-10-24T10:02:00.000Z" })],
    agentSignal: signal("2026-10-24T10:03:00.000Z"),
  });

  it("phase6 dock AC6 stacks the items newest first", () => {
    expect(kinds(derivePinnedActionDockItems(several))).toEqual([
      "agent-signal",
      "plan",
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
      ["agent-signal", true],
      ["plan", true],
      ["question", false],
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
        factoryPlans: [planItem({ at: "2026-10-24T10:02:00.000Z" })],
        planFollowUp: {
          id: PlanId.make("proposed-plan-1"),
          createdAt: "2026-10-24T10:03:00.000Z",
          title: "Ship the dock",
        },
        agentSignal: signal("2026-10-24T10:04:00.000Z"),
      }),
    );
    const labels = Object.fromEntries(items.map((item) => [item.kind, item.closeLabel]));
    expect(labels).toEqual({
      "agent-signal": expect.stringMatching(/^Dismiss .*agent/i),
      "plan-follow-up": expect.stringMatching(/^Dismiss .*Ship the dock/),
      plan: "Unpin plan: Plan: the Software Factory inside Mesura Code",
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
