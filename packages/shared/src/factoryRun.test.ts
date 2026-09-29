// @effect-diagnostics nodeBuiltinImport:off - the test reads the record-version-1 fixture from disk.
// Entry point: `foldFactoryRunLine` and `summarizeFactoryRun` from `@t3tools/shared/factoryRun`,
// the pure fold the server's run tracker and both clients share.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  deriveFactoryRunVerification,
  emptyFactoryRunState,
  factoryRunCoverage,
  foldFactoryRunLine,
  summarizeFactoryRun,
  toFactoryRunShellSummary,
} from "./factoryRun.ts";

// A copy of `skills/core/sf-team/tests/fixtures/events.v1.jsonl` in the agent-env repository,
// written by phase 6 against `skills/core/sf-team/bin/run-events.mjs`, the single definition of
// record version 1. Re-copy it byte for byte whenever that file changes, so the recorder's
// definition and this fold are compared at every change. JSONL carries no comments, so the
// source is named here.
const FIXTURE_LINES = NodeFS.readFileSync(
  new URL("./fixtures/factory-events.v1.jsonl", import.meta.url),
  "utf8",
)
  .split("\n")
  .filter((line) => line.length > 0);

const RUN_DIR = "/srv/factory-runs/invoice-csv-export";

const foldLines = (lines: ReadonlyArray<string>, runDir = RUN_DIR) =>
  lines.reduce((state, line) => foldFactoryRunLine(state, line), emptyFactoryRunState(runDir));

describe("factory run fold over the record-version-1 fixture", () => {
  it("phase9 fold records the spine node each return of the fixture re-entered, skipping the return's own node", () => {
    const state = foldLines(FIXTURE_LINES);

    expect(state.returns.map(({ node, kind, reentered }) => ({ node, kind, reentered }))).toEqual([
      { node: "checks-build", kind: "repair", reentered: "checks-build" },
      { node: "review", kind: "rework", reentered: "regression" },
    ]);
  });

  it("phase9 fold leaves a return without a re-entered node while the implementer still holds it", () => {
    // Line 13 is the repair's `return.recorded`, line 14 enters `repair`.
    expect(foldLines(FIXTURE_LINES.slice(0, 13)).returns[0]?.reentered).toBeUndefined();
    expect(foldLines(FIXTURE_LINES.slice(0, 14)).returns[0]?.reentered).toBeUndefined();
    expect(foldLines(FIXTURE_LINES.slice(0, 17)).returns[0]?.reentered).toBe("checks-build");
  });

  it("folds the phase 6 fixture into its phase statuses, returns, verdicts, cost, clock and warnings", () => {
    const state = foldLines(FIXTURE_LINES);

    expect(state.runId).toBe("invoice-csv-export");
    expect(state.warningCount).toBe(0);
    expect(state.warnings).toEqual([]);
    // Phase 2 closed degraded, so the finished run reads as degraded, not done.
    expect(state.status).toBe("degraded");

    expect(
      state.phases.map((phase) => ({
        index: phase.index,
        title: phase.title,
        status: phase.status,
        degraded: phase.degraded,
      })),
    ).toEqual([
      {
        index: 1,
        title: "Serialize the filtered invoice list as CSV",
        status: "clean",
        degraded: [],
      },
      {
        index: 2,
        title: "Add the Export button to the invoices page",
        status: "degraded",
        degraded: ["verify ① COULD NOT EXERCISE: the headless browser saved no download"],
      },
    ]);

    expect(state.returnsBudget).toBe(5);
    expect(state.returns.map(({ phase, kind, n, node }) => ({ phase, kind, n, node }))).toEqual([
      { phase: 1, kind: "repair", n: 1, node: "checks-build" },
      { phase: 1, kind: "rework", n: 2, node: "review" },
    ]);

    expect(
      state.phases.map((phase) =>
        phase.verdicts.map(({ pass, verdict }) => ({ phase: phase.index, pass, verdict })),
      ),
    ).toEqual([
      [
        { phase: 1, pass: 1, verdict: "WORKS" },
        { phase: 1, pass: 2, verdict: "WORKS" },
      ],
      [
        { phase: 2, pass: 1, verdict: "COULD_NOT_EXERCISE" },
        { phase: 2, pass: 2, verdict: "NOT_NEEDED" },
      ],
    ]);

    // Claude roles report dollars; Codex roles report tokens under Codex's own key names.
    expect(state.cost.usd).toBeCloseTo(23.94, 6);
    expect(state.cost.tokens).toEqual({
      input_tokens: 8_317_510,
      cached_input_tokens: 7_900_930,
      output_tokens: 112_050,
      reasoning_output_tokens: 82_532,
    });

    // 09:00 to 13:49, of which the stop raised at 12:33 waited for its answer until 12:58.
    expect(state.clock).toEqual({
      elapsedMs: 17_340_000,
      waitingMs: 1_500_000,
      machineMs: 15_840_000,
    });

    expect(state.phases[0]!.findings.map(({ id, disposition }) => ({ id, disposition }))).toEqual([
      { id: "P1-1", disposition: "repaired" },
      { id: "P3-1", disposition: "rejected" },
    ]);
    expect(state.report).toMatchObject({ path: "/srv/factory-runs/invoice-csv-export/report.md" });
    expect(toFactoryRunShellSummary(state)).toEqual({
      status: "degraded",
      phaseIndex: 2,
      phaseCount: 2,
      node: "commit",
    });
  });
});

/** An 11-phase run with long titles, every return spent and both verify passes recorded. */
function elevenPhaseRunLines(
  shape: {
    readonly phaseCount?: number;
    readonly titleRepeat?: number;
    /** Ends the run stopped at this question. */
    readonly openQuestion?: string;
  } = {},
): ReadonlyArray<string> {
  const phaseCount = shape.phaseCount ?? 11;
  const titleRepeat = shape.titleRepeat ?? 3;
  let nextSecond = 0;
  // One event a second from 09:00; a run of hundreds of phases runs past the hour.
  const at = () => {
    const second = nextSecond++;
    const pad = (value: number) => String(value).padStart(2, "0");
    const clock = [9 + Math.floor(second / 3600), Math.floor(second / 60) % 60, second % 60];
    return `2026-09-28T${clock.map(pad).join(":")}.000Z`;
  };
  const line = (type: string, fields: Record<string, unknown>) =>
    JSON.stringify({ v: 1, at: at(), type, ...fields });
  const route = { harness: "codex", model: "gpt-6-sol", effort: "high" };
  const phases = Array.from({ length: phaseCount }, (_, index) => ({
    index: index + 1,
    title: `Phase ${index + 1}: ${"a long phase title that names the whole slice of work ".repeat(titleRepeat)}`,
    acceptance: Array.from({ length: 8 }, (_, n) => `Criterion ${n + 1} of phase ${index + 1}`),
  }));
  const lines = [
    line("run.started", {
      runId: "eleven-phase-run",
      request: "A request long enough to matter. ".repeat(20),
      planPath: "/srv/plans/eleven-phase-run/plan.md",
      intentPath: null,
      planDigest: `sha256:${"a".repeat(64)}`,
      routes: {
        implementer: { harness: "claude", model: "claude-opus-5-5", effort: "high", budgetUsd: 25 },
        verifier: { harness: "codex", model: "gpt-6-luna", effort: "max" },
        reviewer: route,
      },
      returnsBudget: phaseCount,
      phases,
    }),
  ];
  for (const phase of phases) {
    lines.push(line("phase.started", { phase: phase.index }));
    for (const node of ["fence", "implement", "verify-1", "review", "verify-2", "commit"]) {
      lines.push(line("node.entered", { phase: phase.index, node }));
    }
    lines.push(
      line("dispatch.finished", {
        phase: phase.index,
        role: "verifier",
        turn: 1,
        sessionId: "session",
        stopReason: "completed",
        tokens: { input_tokens: 1_000_000, cached_input_tokens: 900_000, output_tokens: 10_000 },
        reportFile: `/srv/factory-runs/eleven-phase-run/phase-${phase.index}/verifier-1.md`,
      }),
      line("return.recorded", {
        phase: phase.index,
        kind: "rework",
        n: phase.index,
        budget: phaseCount,
        node: "review",
        change: "A change long enough to matter. ".repeat(10),
      }),
    );
    for (const pass of [1, 2]) {
      lines.push(
        line("verdict.recorded", {
          phase: phase.index,
          pass,
          verdict: "WORKS",
          deciding: "A deciding observation long enough to matter. ".repeat(10),
          criteria: phase.acceptance.map((name, n) => ({ n: n + 1, name, result: "PASS" })),
        }),
      );
    }
    lines.push(
      line("phase.closed", {
        phase: phase.index,
        close: { degraded: ["verify ② COULD NOT EXERCISE: a reason long enough to matter"] },
        commit: { hash: "4a7d1e9", subject: "feat: a commit subject" },
      }),
    );
  }
  if (shape.openQuestion !== undefined) {
    lines.push(line("stop.raised", { question: shape.openQuestion, options: [] }));
  }
  return lines;
}

describe("factory run summary budget", () => {
  it("keeps the factory.run activity summary of an 11-phase run under 4 KiB", () => {
    const state = foldLines(elevenPhaseRunLines(), "/srv/factory-runs/eleven-phase-run");
    expect(state.warningCount).toBe(0);
    expect(state.phases).toHaveLength(11);

    const summary = summarizeFactoryRun(state);
    expect(summary.phaseCount).toBe(11);
    expect(summary.verdicts).toHaveLength(22);
    // Phase 11: the report card's coverage travels in the summary, inside the bound.
    expect(summary.coverage).toEqual({ passed: 88, total: 88 });
    expect(summary.degradedPhases).toBe(11);
    expect(new TextEncoder().encode(JSON.stringify(summary)).byteLength).toBeLessThan(4 * 1024);
  });

  it("bounds the factory.run activity payload under 4 KiB whatever the titles and the phase count", () => {
    const encodedPayloadBytes = (summary: ReturnType<typeof summarizeFactoryRun>) =>
      new TextEncoder().encode(JSON.stringify({ threadId: "0".repeat(64), ...summary })).byteLength;

    const longTitles = foldLines(
      elevenPhaseRunLines({ titleRepeat: 40 }),
      "/srv/factory-runs/eleven-phase-run",
    );
    expect(encodedPayloadBytes(summarizeFactoryRun(longTitles))).toBeLessThan(4 * 1024);
    // A long request and a long open question are shortened, never dropped.
    const longQuestion = foldLines(
      elevenPhaseRunLines({
        titleRepeat: 40,
        openQuestion: "A stop question long enough to matter? ".repeat(80),
      }),
      "/srv/factory-runs/eleven-phase-run",
    );
    const questionSummary = summarizeFactoryRun(longQuestion);
    expect(encodedPayloadBytes(questionSummary)).toBeLessThan(4 * 1024);
    expect(questionSummary.request?.startsWith("A request long enough to matter.")).toBe(true);
    expect(questionSummary.question?.length).toBeLessThanOrEqual(280);
    expect(questionSummary.phaseStatuses).toHaveLength(11);
    // The full state keeps every title whole; only the summary is bounded.
    expect(longTitles.phases[10]!.title.length).toBeGreaterThan(2000);

    const manyPhases = foldLines(
      elevenPhaseRunLines({ phaseCount: 60 }),
      "/srv/factory-runs/eleven-phase-run",
    );
    const summary = summarizeFactoryRun(manyPhases);
    expect(encodedPayloadBytes(summary)).toBeLessThan(4 * 1024);
    expect(summary.phaseCount).toBe(60);
    // The newest verdicts survive the bound.
    expect(summary.verdicts.at(-1)).toEqual({ phase: 60, pass: 2, verdict: "WORKS" });
  });

  it("drops the phase marks of a run too long to carry them, and stays under 4 KiB", () => {
    const encodedPayloadBytes = (summary: ReturnType<typeof summarizeFactoryRun>) =>
      new TextEncoder().encode(JSON.stringify({ threadId: "0".repeat(64), ...summary })).byteLength;
    const hugeRun = foldLines(
      elevenPhaseRunLines({ phaseCount: 400, titleRepeat: 0 }),
      "/srv/factory-runs/eleven-phase-run",
    );
    expect(hugeRun.phases).toHaveLength(400);

    const summary = summarizeFactoryRun(hugeRun);
    expect(encodedPayloadBytes(summary)).toBeLessThan(4 * 1024);
    expect(summary.phaseStatuses).toBeUndefined();
    expect(summary.verdicts).toEqual([]);
    // Two numbers: the coverage outlives the marks and the verdicts.
    expect(summary.coverage).toEqual({ passed: 3200, total: 3200 });
    // Review P1-1: the degraded count outlives the marks it would otherwise be read from.
    expect(summary.degradedPhases).toBe(400);
    expect(summary.phaseCount).toBe(400);
    expect(summary.phase?.index).toBe(400);
    expect(summary.request?.startsWith("A request long enough to matter.")).toBe(true);
  });
});

describe("phase11 factory run summary coverage", () => {
  it("phase11 summary coverage counts the fixture run's passed criteria over every criterion, as the report view does", () => {
    const state = foldLines(FIXTURE_LINES);

    expect(summarizeFactoryRun(state).coverage).toEqual({ passed: 4, total: 5 });
    expect(factoryRunCoverage(deriveFactoryRunVerification(state))).toEqual({
      passed: 4,
      total: 5,
    });
  });
});
