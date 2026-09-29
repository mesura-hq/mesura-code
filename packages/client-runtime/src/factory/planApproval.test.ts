/**
 * Phase 4 fence, acceptance criterion 6 (the Approve message) and the reading
 * side of criterion 7 (which approvals a thread holds).
 *
 * Entry point: `./planApproval.ts`. The message is what the planning skill
 * reads in the thread, so its text is written out here literally rather than
 * rebuilt from the module under test.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  findPlanApprovals,
  formatPlanApprovalMessage,
  resolvePlanApprovalState,
} from "./planApproval.ts";
import {
  FACTORY_DEFAULT_TEST_ROUTES,
  FACTORY_PLAN_DIGEST,
  FACTORY_REVISED_PLAN_DIGEST,
  writeFactoryApprovalMessage,
} from "./testing.ts";

const PLAN_PATH = "/home/dev/plans/factory-in-chat/plan.md";
const INTENT_PATH = "/home/dev/plans/factory-in-chat/intent.md";
const ROUTES = FACTORY_DEFAULT_TEST_ROUTES;

function readJsonFence(text: string): unknown {
  const match = /```json\n([\s\S]*?)\n```/.exec(text);
  expect(match, `Expected a fenced json block in: ${text}`).not.toBeNull();
  return JSON.parse(match![1]!);
}

const userMessage = (text: string) => ({ role: "user" as const, text });

describe("plan approval message (phase 4 fence, criterion 6)", () => {
  it("phase4 AC6 writes the digest line, the paths, the instruction and the routes block", () => {
    const text = formatPlanApprovalMessage({
      digest: FACTORY_PLAN_DIGEST,
      planPath: PLAN_PATH,
      intentPath: INTENT_PATH,
      routes: ROUTES,
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe(`Approve plan sha256:${FACTORY_PLAN_DIGEST}`);
    const nonEmpty = lines.filter((line) => line.trim() !== "");
    expect(nonEmpty.slice(1, 4)).toEqual([
      `Plan: ${PLAN_PATH}`,
      `Intent: ${INTENT_PATH}`,
      "Build it with sf-team in this thread, with these routes:",
    ]);
    expect(nonEmpty[4]).toBe("```json");
    expect(nonEmpty.at(-1)).toBe("```");
    // Exactly sf-team's `--routes` shape: no key beyond harness, model,
    // effort, and a budget for the Claude implementer only.
    expect(readJsonFence(text)).toEqual(ROUTES);
  });

  it("phase4 AC6 reads back the digest, the plan path and the routes it wrote", () => {
    const text = formatPlanApprovalMessage({
      digest: FACTORY_PLAN_DIGEST,
      planPath: PLAN_PATH,
      intentPath: INTENT_PATH,
      routes: ROUTES,
    });
    expect(findPlanApprovals([userMessage(text)])).toEqual([
      expect.objectContaining({ digest: FACTORY_PLAN_DIGEST, planPath: PLAN_PATH, routes: ROUTES }),
    ]);
  });
});

describe("finding approvals in a thread (phase 4 fence, criterion 7)", () => {
  const approval = (digest: string) =>
    formatPlanApprovalMessage({
      digest,
      planPath: PLAN_PATH,
      intentPath: INTENT_PATH,
      routes: ROUTES,
    });

  it("phase4 AC7 keeps every user approval in message order and ignores other roles", () => {
    const found = findPlanApprovals([
      { role: "assistant", text: approval(FACTORY_PLAN_DIGEST) },
      userMessage(approval(FACTORY_PLAN_DIGEST)),
      { role: "system", text: approval(FACTORY_REVISED_PLAN_DIGEST) },
      userMessage("Looks good, but wait."),
      userMessage(approval(FACTORY_REVISED_PLAN_DIGEST)),
    ]);
    expect(found.map((entry) => entry.digest)).toEqual([
      FACTORY_PLAN_DIGEST,
      FACTORY_REVISED_PLAN_DIGEST,
    ]);
  });

  it("phase4 AC7 reads an approval written to the plan's format, not only its own output", () => {
    const routes = {
      ...ROUTES,
      reviewer: { harness: "codex" as const, model: "gpt-6-astra", effort: "xhigh" },
    };
    const text = writeFactoryApprovalMessage({
      digest: FACTORY_REVISED_PLAN_DIGEST,
      planPath: PLAN_PATH,
      intentPath: INTENT_PATH,
      routes,
    });
    expect(findPlanApprovals([userMessage(text)])).toEqual([
      expect.objectContaining({ digest: FACTORY_REVISED_PLAN_DIGEST, planPath: PLAN_PATH, routes }),
    ]);
  });

  it("phase4 AC7 counts only a first line that is exactly the approval line", () => {
    const rest = approval(FACTORY_PLAN_DIGEST).split("\n").slice(1).join("\n");
    const firstLines = [
      `Approve plan sha256:${"A".repeat(64)}`,
      `Approve plan sha256:${"a".repeat(63)}`,
      `Approve plan sha256:${"a".repeat(65)}`,
      `Please Approve plan sha256:${FACTORY_PLAN_DIGEST}`,
      `Approve plan sha256:${FACTORY_PLAN_DIGEST} now`,
      `approve plan sha256:${FACTORY_PLAN_DIGEST}`,
    ];
    expect(findPlanApprovals(firstLines.map((line) => userMessage(`${line}\n${rest}`)))).toEqual(
      [],
    );
    expect(
      findPlanApprovals([userMessage(`Some preamble\nApprove plan sha256:${FACTORY_PLAN_DIGEST}`)]),
    ).toEqual([]);
  });
});

describe("approval state of a plan card (phase 4 coordinator decision 4)", () => {
  const plan = { digest: FACTORY_PLAN_DIGEST, planPath: PLAN_PATH };
  const approvalOf = (digest: string, planPath = PLAN_PATH) =>
    formatPlanApprovalMessage({ digest, planPath, intentPath: INTENT_PATH, routes: ROUTES });

  it("phase4 decision 4 counts an approval without a routes block, with no routes", () => {
    const text = `Approve plan sha256:${FACTORY_PLAN_DIGEST}\nPlan: ${PLAN_PATH}\nBuild it.`;
    const approvals = findPlanApprovals([userMessage(text)]);
    expect(approvals).toEqual([
      { digest: FACTORY_PLAN_DIGEST, planPath: PLAN_PATH, routes: null, routesBlock: "absent" },
    ]);
    expect(resolvePlanApprovalState(approvals, plan)).toEqual({
      kind: "approved",
      routes: null,
      routesBlock: "absent",
    });
    const broken = `${text}\n\`\`\`json\n{ "implementer": 1 }\n\`\`\``;
    expect(findPlanApprovals([userMessage(broken)])[0]?.routes).toBeNull();
  });

  it("phase4 decision 4 reads a plan card as approved, changed or open", () => {
    const approvals = (texts: ReadonlyArray<string>) =>
      findPlanApprovals(texts.map((text) => userMessage(text)));
    expect(resolvePlanApprovalState(approvals([approvalOf(FACTORY_PLAN_DIGEST)]), plan)).toEqual({
      kind: "approved",
      routes: ROUTES,
      routesBlock: "present",
    });
    expect(
      resolvePlanApprovalState(approvals([approvalOf(FACTORY_REVISED_PLAN_DIGEST)]), plan),
    ).toEqual({ kind: "changed" });
    expect(
      resolvePlanApprovalState(
        approvals([approvalOf(FACTORY_REVISED_PLAN_DIGEST, "/home/dev/plans/other/plan.md")]),
        plan,
      ),
    ).toEqual({ kind: "open" });
    // Approving the revised bytes after an older approval reads approved.
    expect(
      resolvePlanApprovalState(
        approvals([approvalOf(FACTORY_REVISED_PLAN_DIGEST), approvalOf(FACTORY_PLAN_DIGEST)]),
        plan,
      ),
    ).toEqual({ kind: "approved", routes: ROUTES, routesBlock: "present" });
  });
});

describe("approval identity and edited messages (phase 4 review P1-3, P1-4)", () => {
  const plan = { digest: FACTORY_PLAN_DIGEST, planPath: PLAN_PATH };
  const instruction = "Build it with sf-team in this thread, with these routes:";
  const routesFence = ["```json", JSON.stringify(ROUTES, null, 2), "```"].join("\n");
  const header = [
    `Approve plan sha256:${FACTORY_PLAN_DIGEST}`,
    `Plan: ${PLAN_PATH}`,
    `Intent: ${INTENT_PATH}`,
  ].join("\n");

  it("phase4 P1-3 does not let a digest approve another plan file with the same bytes", () => {
    const otherFile = findPlanApprovals([
      userMessage(
        formatPlanApprovalMessage({
          digest: FACTORY_PLAN_DIGEST,
          planPath: "/home/dev/plans/copy/plan.md",
          intentPath: "/home/dev/plans/copy/intent.md",
          routes: ROUTES,
        }),
      ),
    ]);
    expect(resolvePlanApprovalState(otherFile, plan)).toEqual({ kind: "open" });
  });

  it("phase4 P1-3 matches an approval without a Plan line on the digest alone", () => {
    const pathless = findPlanApprovals([userMessage(`Approve plan sha256:${FACTORY_PLAN_DIGEST}`)]);
    expect(pathless).toEqual([
      { digest: FACTORY_PLAN_DIGEST, planPath: null, routes: null, routesBlock: "absent" },
    ]);
    expect(resolvePlanApprovalState(pathless, plan)).toMatchObject({ kind: "approved" });
  });

  it("phase4 P1-4 reads the routes from the fence after the instruction, not a quoted example before it", () => {
    const example = ["```json", '{ "example": true }', "```"].join("\n");
    const text = [header, "For example:", example, instruction, routesFence].join("\n");
    expect(findPlanApprovals([userMessage(text)])).toEqual([
      { digest: FACTORY_PLAN_DIGEST, planPath: PLAN_PATH, routes: ROUTES, routesBlock: "present" },
    ]);
  });

  it("phase4 P1-4 reads Plan only from the lines before the instruction", () => {
    const text = [
      `Approve plan sha256:${FACTORY_PLAN_DIGEST}`,
      `Intent: ${INTENT_PATH}`,
      instruction,
      routesFence,
      `Plan: /home/dev/plans/quoted/plan.md`,
    ].join("\n");
    expect(findPlanApprovals([userMessage(text)])[0]?.planPath).toBeNull();
  });

  it("phase4 P1-4 tells an absent routes block from an invalid or ambiguous one", () => {
    const read = (text: string) => findPlanApprovals([userMessage(text)])[0];
    expect(read(header)).toMatchObject({ routes: null, routesBlock: "absent" });
    // A json fence without the instruction is text, not routes.
    expect(read([header, routesFence].join("\n"))).toMatchObject({ routesBlock: "absent" });
    expect(read([header, instruction].join("\n"))).toMatchObject({
      routes: null,
      routesBlock: "invalid",
    });
    expect(read([header, instruction, routesFence, routesFence].join("\n"))).toMatchObject({
      routes: null,
      routesBlock: "invalid",
    });
    expect(
      read([header, instruction, "```json", '{ "implementer": 1 }', "```"].join("\n")),
    ).toMatchObject({ routes: null, routesBlock: "invalid" });
    expect(read([header, instruction, "```json", "{ not json", "```"].join("\n"))).toMatchObject({
      routesBlock: "invalid",
    });
    expect(read([header, instruction, "```json", JSON.stringify(ROUTES)].join("\n"))).toMatchObject(
      { routesBlock: "invalid" },
    );
    expect(read([header, instruction, routesFence].join("\r\n"))).toMatchObject({
      routes: ROUTES,
      routesBlock: "present",
    });
  });
});
