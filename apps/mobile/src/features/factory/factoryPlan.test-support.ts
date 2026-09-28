/**
 * Test data for the Android Factory plan specs: the shared `factory.plan`
 * builders, and the plan document the planning skill wrote for this feature.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import type { FactoryPlanActivityPayload } from "@t3tools/contracts";
import {
  FACTORY_INTENT_DIGEST,
  FACTORY_OTHER_PLAN_DIGEST,
  FACTORY_PLAN_DIGEST,
  FACTORY_REVISED_PLAN_DIGEST,
  makeFactoryPlanActivity as makeSharedFactoryPlanActivity,
  makeFactoryPlanPayload as makeSharedFactoryPlanPayload,
} from "@t3tools/client-runtime/factory/testing";

export {
  FACTORY_INTENT_DIGEST,
  FACTORY_OTHER_PLAN_DIGEST,
  FACTORY_PLAN_DIGEST,
  FACTORY_REVISED_PLAN_DIGEST,
};

/** One plural and one singular criteria count, so the card's phase lines show both. */
export function makeFactoryPlanPayload(
  overrides: Partial<FactoryPlanActivityPayload> = {},
): FactoryPlanActivityPayload {
  return makeSharedFactoryPlanPayload({
    phases: [
      { title: "Snapshot a plan and present it to the thread", acceptanceCount: 8 },
      { title: "Render the plan card and the Factory pane on the web", acceptanceCount: 1 },
    ],
    ...overrides,
  });
}

export function makeFactoryPlanActivity(
  input: Parameters<typeof makeSharedFactoryPlanActivity>[0],
) {
  return makeSharedFactoryPlanActivity({
    ...input,
    payload: input.payload ?? makeFactoryPlanPayload({ presentedAt: input.createdAt }),
  });
}

/** The plan this feature was built from, exactly as the planning skill wrote it. */
export function readFactoryPlanFixture(): string {
  // A path, not `new URL(…, import.meta.url)`: happy-dom replaces the global URL.
  const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
  return NodeFS.readFileSync(
    NodePath.join(here, "../../../../../packages/shared/src/fixtures/factory-in-chat.plan.md"),
    "utf8",
  );
}
