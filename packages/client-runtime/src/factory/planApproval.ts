/**
 * Approve on a plan card is one user message in the thread. The planning skill
 * (`sf-plan`) parses it to start the build, and both clients read it back to
 * show a plan as approved, so its format is a contract. It is, line by line:
 *
 * 1. `Approve plan sha256:<digest>` — the whole first line, the digest as 64
 *    lowercase hex characters. A message whose first line is anything else is
 *    not an approval.
 * 2. `Plan: <absolute path of plan.md>`
 * 3. `Intent: <absolute path of intent.md>`
 * 4. `Build it with sf-team in this thread, with these routes:` — the routes
 *    instruction.
 * 5. The routes block: a fence opened by a line that is exactly ```` ```json ````
 *    and closed by the next line that is exactly ```` ``` ````, holding one JSON
 *    object in sf-team's `--routes` shape (`implementer`, `reviewer`,
 *    `verifier`, each `harness`, `model`, `effort`, and `budgetUsd` for a Claude
 *    implementer only).
 *
 * Reading is stricter than writing, because a person may edit the message:
 *
 * - `Plan:` and `Intent:` are read from the lines between the first line and
 *   the routes instruction (or the end of the message when it has none).
 * - The routes block is the one `json` fence after the routes instruction.
 *   Fences before the instruction are text, never routes.
 * - No routes instruction means the message carries no routes (`absent`):
 *   sf-team chooses them. An instruction followed by no `json` fence, by more
 *   than one, or by one that is not a valid routes object is `invalid`.
 */
import * as Schema from "effect/Schema";

import { FactoryRoutes, type FactoryRoute } from "./routes.ts";

const APPROVAL_LINE = /^Approve plan sha256:([0-9a-f]{64})$/;
const PLAN_LINE_PREFIX = "Plan: ";
const INTENT_LINE_PREFIX = "Intent: ";
const ROUTES_INSTRUCTION = "Build it with sf-team in this thread, with these routes:";
const ROUTES_FENCE_OPEN = "```json";
const FENCE_CLOSE = "```";

const isFactoryRoutes = Schema.is(FactoryRoutes);

/** Exactly the `--routes` keys, whatever else an object carries. */
function routeFileEntry(route: FactoryRoute): FactoryRoute {
  const entry = { harness: route.harness, model: route.model, effort: route.effort };
  return route.budgetUsd === undefined ? entry : { ...entry, budgetUsd: route.budgetUsd };
}

function routesFile(routes: FactoryRoutes): FactoryRoutes {
  return {
    implementer: routeFileEntry(routes.implementer),
    reviewer: routeFileEntry(routes.reviewer),
    verifier: routeFileEntry(routes.verifier),
  };
}

export function formatPlanApprovalMessage(input: {
  readonly digest: string;
  readonly planPath: string;
  readonly intentPath: string;
  readonly routes: FactoryRoutes;
}): string {
  return [
    `Approve plan sha256:${input.digest}`,
    `${PLAN_LINE_PREFIX}${input.planPath}`,
    `${INTENT_LINE_PREFIX}${input.intentPath}`,
    ROUTES_INSTRUCTION,
    ROUTES_FENCE_OPEN,
    JSON.stringify(routesFile(input.routes), null, 2),
    FENCE_CLOSE,
  ].join("\n");
}

/** Whether the message carries routes: see the module comment for each case. */
export type FactoryApprovalRoutesBlock = "present" | "absent" | "invalid";

/** What an approved card says when the approval carries no routes it can show. */
export function approvedWithoutRoutesText(routesBlock: FactoryApprovalRoutesBlock): string {
  return routesBlock === "invalid"
    ? "The approval's routes block could not be read."
    : "Routes chosen by sf-team.";
}

export interface FactoryPlanApproval {
  readonly digest: string;
  /** The `Plan:` line: which plan file the digest belongs to. Null when the message has none. */
  readonly planPath: string | null;
  /** The routes block, when `routesBlock` is `present`; null otherwise. */
  readonly routes: FactoryRoutes | null;
  readonly routesBlock: FactoryApprovalRoutesBlock;
}

function readRoutesBlock(lines: ReadonlyArray<string>): {
  readonly routes: FactoryRoutes | null;
  readonly routesBlock: FactoryApprovalRoutesBlock;
} {
  const instruction = lines.findIndex((line) => line.trim() === ROUTES_INSTRUCTION);
  if (instruction === -1) return { routes: null, routesBlock: "absent" };
  const blocks: string[] = [];
  let open: string[] | null = null;
  for (let index = instruction + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (open === null) {
      if (line.trim() === ROUTES_FENCE_OPEN) open = [];
    } else if (line.trim() === FENCE_CLOSE) {
      blocks.push(open.join("\n"));
      open = null;
    } else {
      open.push(line);
    }
  }
  // An unclosed fence or a second block makes the routes ambiguous.
  if (blocks.length !== 1 || open !== null) return { routes: null, routesBlock: "invalid" };
  try {
    const value: unknown = JSON.parse(blocks[0]!);
    return isFactoryRoutes(value)
      ? { routes: routesFile(value), routesBlock: "present" }
      : { routes: null, routesBlock: "invalid" };
  } catch {
    return { routes: null, routesBlock: "invalid" };
  }
}

/** Every approval a thread's user messages hold, in message order. */
export function findPlanApprovals(
  messages: ReadonlyArray<{ readonly role: string; readonly text: string }>,
): ReadonlyArray<FactoryPlanApproval> {
  const approvals: FactoryPlanApproval[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const lines = message.text.split(/\r?\n/);
    const digest = APPROVAL_LINE.exec(lines[0] ?? "")?.[1];
    if (digest === undefined) continue;
    const instruction = lines.findIndex((line) => line.trim() === ROUTES_INSTRUCTION);
    const header = lines.slice(1, instruction === -1 ? lines.length : instruction);
    const planLine = header.find((line) => line.startsWith(PLAN_LINE_PREFIX));
    const planPath = planLine?.slice(PLAN_LINE_PREFIX.length).trim();
    approvals.push({
      digest,
      planPath: planPath === undefined || planPath === "" ? null : planPath,
      ...readRoutesBlock(lines),
    });
  }
  return approvals;
}

export type FactoryPlanApprovalState =
  | { readonly kind: "open" }
  | {
      readonly kind: "approved";
      readonly routes: FactoryRoutes | null;
      readonly routesBlock: FactoryApprovalRoutesBlock;
    }
  /** An older digest of the same plan file was approved; the rows are editable again. */
  | { readonly kind: "changed" };

/**
 * Where a plan card stands.
 *
 * - Approved: an approval names these bytes and this plan file. Two plan files
 *   with identical bytes share a digest, so an approval with a `Plan:` path
 *   approves only that path. An approval without one (typed by hand) is
 *   matched on the digest alone.
 * - Changed: only an older digest of the same plan file was approved. A plan
 *   file keeps one activity whose digest moves on, so the `Plan:` path is what
 *   ties an older approval to it.
 * - Open: neither.
 */
export function resolvePlanApprovalState(
  approvals: ReadonlyArray<FactoryPlanApproval>,
  plan: { readonly digest: string; readonly planPath: string },
): FactoryPlanApprovalState {
  let changed = false;
  for (let index = approvals.length - 1; index >= 0; index -= 1) {
    const approval = approvals[index]!;
    const samePlan = approval.planPath === plan.planPath;
    if (approval.digest === plan.digest && (samePlan || approval.planPath === null)) {
      return { kind: "approved", routes: approval.routes, routesBlock: approval.routesBlock };
    }
    if (samePlan) changed = true;
  }
  return changed ? { kind: "changed" } : { kind: "open" };
}
