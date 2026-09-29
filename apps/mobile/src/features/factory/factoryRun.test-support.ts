/**
 * Test data for the Android Factory run specs: the shared `factory.run`
 * builders, fed with the recorder's fixture run.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import type { TurnId } from "@t3tools/contracts";
import {
  makeFactoryRunActivity,
  makeFactoryRunSummary,
  withoutFactoryRunMarks,
  type FactoryRunFixturePoint,
} from "@t3tools/client-runtime/factory/testing";

export type { FactoryRunFixturePoint };

/** The recorder's two-phase fixture run, `packages/shared/src/fixtures/factory-events.v1.jsonl`. */
export function readFactoryRunEventsFixture(): string {
  // A path, not `new URL(…, import.meta.url)`: happy-dom replaces the global URL.
  const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
  return NodeFS.readFileSync(
    NodePath.join(here, "../../../../../packages/shared/src/fixtures/factory-events.v1.jsonl"),
    "utf8",
  );
}

/** The run's `factory.run` activity at one point of the fixture run. */
export function makeFactoryRunActivityAt(input: {
  readonly threadId: string;
  readonly point: FactoryRunFixturePoint;
  readonly turnId?: TurnId | null;
  /** Publish the summary without its phase marks, as a very long run does. */
  readonly withoutMarks?: boolean;
}) {
  const summary = makeFactoryRunSummary(readFactoryRunEventsFixture(), input.point);
  return makeFactoryRunActivity({
    threadId: input.threadId,
    summary: input.withoutMarks === true ? withoutFactoryRunMarks(summary) : summary,
    turnId: input.turnId ?? null,
  });
}
