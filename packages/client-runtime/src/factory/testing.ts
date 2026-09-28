/**
 * Test data for the Factory plan specs on every client: `factory.plan`
 * activities as the server's `present_plan` handler writes them. Each test
 * reads the plan fixture itself, since web, mobile and this package load a
 * file differently.
 */
import {
  EventId,
  FACTORY_PLAN_ACTIVITY_KIND,
  type FactoryPlanActivityPayload,
  type OrchestrationThreadActivity,
  type TurnId,
} from "@t3tools/contracts";

export const FACTORY_PLAN_DIGEST = "a".repeat(64);
export const FACTORY_INTENT_DIGEST = "b".repeat(64);
export const FACTORY_REVISED_PLAN_DIGEST = "c".repeat(64);
export const FACTORY_OTHER_PLAN_DIGEST = "d".repeat(64);

export function makeFactoryPlanPayload(
  overrides: Partial<FactoryPlanActivityPayload> = {},
): FactoryPlanActivityPayload {
  return {
    digest: FACTORY_PLAN_DIGEST,
    intentDigest: FACTORY_INTENT_DIGEST,
    planPath: "/home/dev/plans/factory-in-chat/plan.md",
    intentPath: "/home/dev/plans/factory-in-chat/intent.md",
    title: "Plan: the Software Factory inside Mesura Code",
    phases: [
      { title: "Snapshot a plan and present it to the thread", acceptanceCount: 7 },
      { title: "Render the plan card and the Factory pane on the web", acceptanceCount: 6 },
    ],
    headings: ["Context", "The phases", "Architecture", "Decisions"],
    presentedAt: "2026-09-28T10:00:05.000Z",
    ...overrides,
  };
}

/** One activity per plan file: the server derives the id from the path, never the bytes. */
export function makeFactoryPlanActivity(input: {
  readonly id?: string;
  readonly createdAt: string;
  readonly turnId?: TurnId | null;
  readonly payload?: unknown;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(input.id ?? "factory-plan:plan-md"),
    tone: "info",
    kind: FACTORY_PLAN_ACTIVITY_KIND,
    summary: "Presented a plan",
    payload: input.payload ?? makeFactoryPlanPayload({ presentedAt: input.createdAt }),
    turnId: input.turnId ?? null,
    createdAt: input.createdAt,
  };
}
