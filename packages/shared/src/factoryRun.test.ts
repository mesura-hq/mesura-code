// @effect-diagnostics nodeBuiltinImport:off - the test reads the record-version-1 fixture from disk.
// Entry point: `foldFactoryRunLine` and `summarizeFactoryRun` from `@t3tools/shared/factoryRun`,
// the pure fold the server's run tracker and both clients share.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  emptyFactoryRunState,
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
  shape: { readonly phaseCount?: number; readonly titleRepeat?: number } = {},
): ReadonlyArray<string> {
  const phaseCount = shape.phaseCount ?? 11;
  const titleRepeat = shape.titleRepeat ?? 3;
  let nextSecond = 0;
  // One event a second from 09:00; an 11-phase run stays well inside the hour.
  const at = () => {
    const second = nextSecond++;
    return `2026-09-28T09:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}.000Z`;
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
});
