// @effect-diagnostics nodeBuiltinImport:off - the test reads the record-version-1 fixture from disk.
// Entry point: `deriveFactoryRunTrace` and the strip codec from `@t3tools/shared/factoryRunTrace`,
// over the fold of the same fixture `factoryRun.test.ts` reads.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { emptyFactoryRunState, foldFactoryRunLine } from "./factoryRun.ts";
import {
  decodeFactoryTraceStrip,
  deriveFactoryRunTrace,
  encodeFactoryTraceStrip,
  factoryTraceDurationText,
  FACTORY_TRACE_STRIP_SLICES,
} from "./factoryRunTrace.ts";

const LINES = NodeFS.readFileSync(
  new URL("./fixtures/factory-events.v1.jsonl", import.meta.url),
  "utf8",
)
  .split("\n")
  .filter((line) => line.length > 0);

const fold = (lines: ReadonlyArray<string>) =>
  lines.reduce(
    (state, line) => foldFactoryRunLine(state, line),
    emptyFactoryRunState("/srv/factory-runs/invoice-csv-export"),
  );

const MINUTE = 60_000;

describe("factory run trace", () => {
  it("splits the wall clock into agents working, waiting for the developer and the coordinator", () => {
    const trace = deriveFactoryRunTrace(fold(LINES), 0)!;

    expect(trace.live).toBe(false);
    // 09:00 to 13:49; twelve role turns of 18 or 12 minutes; one stop of 25 minutes.
    expect(trace.totals.wallMs).toBe(289 * MINUTE);
    expect(trace.totals.agentMs).toBe(186 * MINUTE);
    expect(trace.totals.waitingMs).toBe(25 * MINUTE);
    expect(trace.totals.coordinatorMs).toBe(78 * MINUTE);
    expect(trace.totals.byRole.map(({ role, turns, ms }) => ({ role, turns, ms }))).toEqual([
      { role: "implementer", turns: 7, ms: 126 * MINUTE },
      { role: "verifier", turns: 3, ms: 36 * MINUTE },
      { role: "reviewer", turns: 2, ms: 24 * MINUTE },
    ]);
  });

  it("labels each role turn with the spine node it started in", () => {
    const trace = deriveFactoryRunTrace(fold(LINES), 0)!;

    expect(trace.phases[0]!.turns.map((turn) => `${turn.role} ${turn.turn} ${turn.node}`)).toEqual([
      "implementer 1 fence",
      "implementer 2 implement",
      "implementer 3 repair",
      "verifier 1 verify-1",
      "reviewer 1 review",
      "implementer 4 rework",
      "implementer 5 regression",
      "verifier 2 verify-2",
    ]);
    expect(trace.phases[0]!.costUsd).toBeCloseTo(16.58, 6);
  });

  it("draws a live run to now, a running turn to the same end, and a stop not yet answered", () => {
    // Up to the stop raised at 12:33, before its answer.
    const state = fold(LINES.filter((line) => JSON.parse(line).at < "2026-09-28T12:40:00.000Z"));
    const now = Date.parse("2026-09-28T12:45:00.000Z");
    const trace = deriveFactoryRunTrace(state, now)!;

    expect(trace.live).toBe(true);
    expect(trace.endMs).toBe(now);
    expect(trace.stops).toHaveLength(1);
    expect(trace.stops[0]!.endMs).toBeNull();
    expect(trace.totals.waitingMs).toBe(12 * MINUTE);
  });

  it("does not count as waiting the time a role was still working through a stop", () => {
    const line = (event: Record<string, unknown>) => JSON.stringify({ v: 1, ...event });
    const state = fold([
      line({
        at: "2026-10-24T07:00:00.000Z",
        type: "run.started",
        runId: "overlap",
        request: "Overlap",
        phases: [{ index: 1, title: "One", acceptance: [] }],
      }),
      line({
        at: "2026-10-24T07:00:00.000Z",
        type: "dispatch.started",
        phase: 1,
        role: "verifier",
        turn: 1,
        harness: "codex",
        model: "luna",
        promptFile: "p.md",
        outputFile: "o.jsonl",
      }),
      line({
        at: "2026-10-24T07:10:00.000Z",
        type: "stop.raised",
        question: "Go on?",
        options: [],
      }),
      line({
        at: "2026-10-24T07:20:00.000Z",
        type: "dispatch.finished",
        phase: 1,
        role: "verifier",
        turn: 1,
        sessionId: "s",
        stopReason: "completed",
        reportFile: "r.md",
      }),
      line({ at: "2026-10-24T07:30:00.000Z", type: "stop.answered", answer: "yes" }),
      line({ at: "2026-10-24T07:30:00.000Z", type: "run.finished", status: "done" }),
    ]);
    const { totals } = deriveFactoryRunTrace(state, 0)!;

    expect(totals.agentMs).toBe(20 * MINUTE);
    expect(totals.waitingMs).toBe(10 * MINUTE);
    expect(totals.coordinatorMs).toBe(0);
  });

  it("reads a phase still running when its run stopped as stopped, and its unfinished turn as interrupted", () => {
    const line = (event: Record<string, unknown>) => JSON.stringify({ v: 1, ...event });
    const state = fold([
      line({
        at: "2026-10-24T07:00:00.000Z",
        type: "run.started",
        runId: "stopped",
        request: "Stopped",
        phases: [{ index: 1, title: "One", acceptance: [] }],
      }),
      line({ at: "2026-10-24T07:00:00.000Z", type: "phase.started", phase: 1 }),
      line({
        at: "2026-10-24T07:01:00.000Z",
        type: "dispatch.started",
        phase: 1,
        role: "implementer",
        turn: 1,
        harness: "claude",
        model: "opus",
        promptFile: "p.md",
        outputFile: "o.jsonl",
      }),
      line({ at: "2026-10-24T07:30:00.000Z", type: "run.finished", status: "stopped" }),
    ]);
    const trace = deriveFactoryRunTrace(state, Date.parse("2026-10-25T07:00:00.000Z"))!;

    expect(trace.live).toBe(false);
    expect(trace.phases[0]!.status).toBe("stopped");
    expect(trace.phases[0]!.turns[0]).toMatchObject({ endMs: null, interrupted: true });
    expect(trace.endMs).toBe(Date.parse("2026-10-24T07:30:00.000Z"));
  });

  it("returns no trace for a run that has not started", () => {
    expect(deriveFactoryRunTrace(emptyFactoryRunState("/srv/runs/none"), 0)).toBeNull();
  });
});

describe("factory trace strip", () => {
  it("encodes the run in a fixed number of slices and decodes it into segments", () => {
    const strip = encodeFactoryTraceStrip(deriveFactoryRunTrace(fold(LINES), 0)!);

    expect(strip).toHaveLength(FACTORY_TRACE_STRIP_SLICES);
    expect(strip).toMatch(/^[ivrwc.]+$/);
    // 09:00 to 09:08 is before phase 1: nothing; the stop shows where no role worked.
    expect(strip[0]).toBe(".");
    expect(strip).toContain("w");
    const segments = decodeFactoryTraceStrip(strip);
    expect(segments.every((segment) => segment.kind !== "idle")).toBe(true);
    expect(segments.reduce((total, segment) => total + segment.width, 0)).toBeLessThanOrEqual(1);
  });

  it("decodes an unknown character as nothing", () => {
    expect(decodeFactoryTraceStrip("ix?")).toEqual([
      { kind: "implementer", start: 0, width: 1 / 3 },
    ]);
  });
});

describe("factory trace durations", () => {
  it.each([
    [40_000, "40s"],
    [9 * MINUTE, "9m"],
    [59.6 * MINUTE, "1h 00m"],
    [(12 * 60 + 18) * MINUTE, "12h 18m"],
  ])("writes %i ms as %s", (ms, text) => {
    expect(factoryTraceDurationText(ms)).toBe(text);
  });
});
