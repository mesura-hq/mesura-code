/**
 * Phase 9 fence, the Run tab's view model: acceptance criteria 1 to 4 and 7
 * over `deriveFactoryRunView`, which turns the `subscribeFactoryRun` stream
 * item `{ state, roles }` into what the Factory pane's Run tab draws.
 *
 * Entry point: `deriveFactoryRunView` in `factoryRunView.logic.ts`, fed the
 * state the server's run tracker folds from the recorder's fixture
 * (`packages/shared/src/fixtures/factory-events.v1.jsonl`, a two-phase run
 * whose phase 1 has a repair and a rework) and synthetic event lines for a
 * phase with two repairs, a stopped run, a finished run and a Codex-only
 * cost. The mounted criteria (1's Open, 5, 6 and 7's floor on screen) are in
 * `FactoryRunCard.test.tsx`, which mounts AppRoot with ChatView.
 */
/// <reference types="vite-plus/client" />
import type { FactoryRoleProgress, FactoryRunState } from "@t3tools/contracts";
import {
  foldFactoryRunTestLines,
  makeFactoryRunState,
} from "@t3tools/client-runtime/factory/testing";
import { describe, expect, it } from "vite-plus/test";

import eventsJsonl from "../../../../packages/shared/src/fixtures/factory-events.v1.jsonl?raw";
import { deriveFactoryRunView } from "./factoryRunView.logic";

const PHASE_1_TITLE = "Serialize the filtered invoice list as CSV";
const PHASE_2_TITLE = "Add the Export button to the invoices page";
const RUN_DIR = "/srv/factory-runs/invoice-csv-export";

const fixtureLines = eventsJsonl.split("\n").filter((line) => line.trim().length > 0);

/** One record-version-1 event line. */
const event = (at: string, type: string, fields: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, at, type, ...fields });

const view = (
  state: FactoryRunState,
  options: {
    readonly selectedPhase?: number | null;
    readonly now?: string;
    readonly roles?: ReadonlyArray<FactoryRoleProgress>;
  } = {},
) =>
  deriveFactoryRunView({
    item: { state, roles: options.roles ?? [] },
    selectedPhase: options.selectedPhase ?? null,
    nowMs: Date.parse(options.now ?? "2026-09-28T23:00:00.000Z"),
  });

const spineStatuses = (result: ReturnType<typeof view>) =>
  Object.fromEntries(
    (result.spine?.stages ?? []).flatMap((stage) =>
      stage.nodes.map((node) => [node.node, node.status] as const),
    ),
  );

describe("phase9 run view AC1 phase rail", () => {
  it("phase9 run view AC1 lists one rail entry per phase with its state and selects the current phase", () => {
    const result = view(makeFactoryRunState(eventsJsonl, "verify"));

    expect(result.rail).toEqual([
      { index: 1, title: PHASE_1_TITLE, status: "running", selected: true },
      { index: 2, title: PHASE_2_TITLE, status: "pending", selected: false },
    ]);
    expect(result.selectedPhase).toBe(1);
  });

  it("phase9 run view AC1 shows a finished run's phases clean and degraded", () => {
    const result = view(makeFactoryRunState(eventsJsonl, "degraded"));

    expect(result.rail.map((item) => [item.index, item.status])).toEqual([
      [1, "clean"],
      [2, "degraded"],
    ]);
  });

  it("phase9 run view AC1 reads the open phase of a stopped run as stopped, never running", () => {
    const result = view(makeFactoryRunState(eventsJsonl, "stopped"));

    expect(result.rail.map((item) => [item.index, item.status])).toEqual([
      [1, "clean"],
      [2, "stopped"],
    ]);
  });

  it("phase9 run view AC1 moves the rail's selection to the phase the reader picked", () => {
    const result = view(makeFactoryRunState(eventsJsonl, "degraded"), { selectedPhase: 1 });

    expect(result.selectedPhase).toBe(1);
    expect(result.rail.map((item) => item.selected)).toEqual([true, false]);
  });
});

describe("phase9 run view AC2 node spine", () => {
  it("phase9 run view AC2 draws Build, Harden and Close from Fence to Commit with display names", () => {
    const result = view(makeFactoryRunState(eventsJsonl, "verify"));

    expect(
      result.spine?.stages.map((stage) => [stage.stage, stage.nodes.map((node) => node.label)]),
    ).toEqual([
      ["Build", ["Fence", "Implement", "Build checks", "Verify ①"]],
      ["Harden", ["Review", "Rework", "Regression", "Harden checks", "Verify ②"]],
      ["Close", ["Commit"]],
    ]);
  });

  it("phase9 run view AC2 marks the node in flight and the nodes before and after it", () => {
    const result = view(makeFactoryRunState(eventsJsonl, "verify"));

    expect(spineStatuses(result)).toEqual({
      fence: "done",
      implement: "done",
      "checks-build": "done",
      "verify-1": "current",
      review: "pending",
      rework: "pending",
      regression: "pending",
      "checks-harden": "pending",
      "verify-2": "pending",
      commit: "pending",
    });
  });

  it("phase9 run view AC2 draws each return of the fixture's phase 1 as a loop back to the node it re-entered, labelled with its signal", () => {
    const result = view(makeFactoryRunState(eventsJsonl, "degraded"), { selectedPhase: 1 });

    expect(result.spine?.returns).toEqual([
      {
        from: "checks-build",
        to: "checks-build",
        kind: "repair",
        signal:
          "pnpm lint failed on an unused import in the CSV serializer; the import was removed",
        text: "repair 1/5 — Build checks: pnpm lint failed on an unused import in the CSV serializer; the import was removed",
        pending: false,
      },
      {
        from: "review",
        to: "regression",
        kind: "rework",
        signal: "P1-1 repaired: rows stream through a cursor; P3-1 rejected",
        text: "rework 2/5 — Review: P1-1 repaired: rows stream through a cursor; P3-1 rejected",
        pending: false,
      },
    ]);
  });

  it("phase9 run view AC2 draws a return the implementer still holds as pending to the repair node", () => {
    // Line 14 enters `repair` after the phase's first return; the spine has not resumed.
    const result = view(foldFactoryRunTestLines(fixtureLines.slice(0, 14)));

    expect(result.spine?.returns).toEqual([
      expect.objectContaining({
        from: "checks-build",
        to: "repair",
        kind: "repair",
        pending: true,
      }),
    ]);
    expect(spineStatuses(result)).toMatchObject({
      fence: "done",
      implement: "done",
      "checks-build": "pending",
    });
    expect(Object.values(spineStatuses(result))).not.toContain("current");
  });

  it("phase9 run view AC2 shows a phase with two repairs as two return lines and the node it re-entered in flight", () => {
    const state = foldFactoryRunTestLines([
      fixtureLines[0]!,
      event("2026-09-28T09:08:00.000Z", "phase.started", { phase: 1 }),
      event("2026-09-28T09:08:00.000Z", "node.entered", { phase: 1, node: "fence" }),
      event("2026-09-28T09:28:00.000Z", "node.entered", { phase: 1, node: "implement" }),
      event("2026-09-28T09:48:00.000Z", "node.entered", { phase: 1, node: "checks-build" }),
      event("2026-09-28T09:53:00.000Z", "return.recorded", {
        phase: 1,
        kind: "repair",
        n: 1,
        budget: 5,
        node: "checks-build",
        change: "pnpm lint failed on an unused import",
      }),
      event("2026-09-28T09:53:00.000Z", "node.entered", { phase: 1, node: "repair" }),
      event("2026-09-28T10:13:00.000Z", "node.entered", { phase: 1, node: "checks-build" }),
      event("2026-09-28T10:18:00.000Z", "node.entered", { phase: 1, node: "verify-1" }),
      event("2026-09-28T10:32:00.000Z", "verdict.recorded", {
        phase: 1,
        pass: 1,
        verdict: "BROKEN",
        deciding: "the export returned 13 rows where the page lists 14",
        criteria: [],
      }),
      event("2026-09-28T10:33:00.000Z", "return.recorded", {
        phase: 1,
        kind: "repair",
        n: 2,
        budget: 5,
        node: "verify-1",
        change: "the export applied the page's filter after the row limit",
      }),
      event("2026-09-28T10:33:00.000Z", "node.entered", { phase: 1, node: "repair" }),
      event("2026-09-28T10:50:00.000Z", "node.entered", { phase: 1, node: "checks-build" }),
    ]);
    const result = view(state);

    expect(result.spine?.returns.map((edge) => [edge.from, edge.to, edge.kind, edge.text])).toEqual(
      [
        [
          "checks-build",
          "checks-build",
          "repair",
          "repair 1/5 — Build checks: pnpm lint failed on an unused import",
        ],
        [
          "verify-1",
          "checks-build",
          "repair",
          "repair 2/5 — Verify ①: the export applied the page's filter after the row limit",
        ],
      ],
    );
    expect(spineStatuses(result)).toMatchObject({
      fence: "done",
      implement: "done",
      "checks-build": "current",
      "verify-1": "pending",
    });
  });

  it("phase9 run view AC2 shows a closed phase with no node in flight", () => {
    const result = view(makeFactoryRunState(eventsJsonl, "done"), { selectedPhase: 1 });

    expect(Object.values(spineStatuses(result))).toEqual(Array(10).fill("done"));
  });

  it("phase9 run view AC2 marks the node a stopped run stopped at, with nothing in flight", () => {
    const result = view(makeFactoryRunState(eventsJsonl, "stopped"));

    expect(result.selectedPhase).toBe(2);
    const statuses = spineStatuses(result);
    expect(statuses).toMatchObject({
      fence: "done",
      implement: "stopped",
      "checks-build": "pending",
    });
    expect(Object.values(statuses)).not.toContain("current");
  });

  it("phase9 run view AC2 shows a phase that has not started as all pending with no returns", () => {
    const result = view(makeFactoryRunState(eventsJsonl, "verify"), { selectedPhase: 2 });

    expect(Object.values(spineStatuses(result))).toEqual(Array(10).fill("pending"));
    expect(result.spine?.returns).toEqual([]);
  });
});

describe("phase9 run view AC3 role sessions", () => {
  it("phase9 run view AC3 shows each finished role session with harness, model, session id, turn count and its cost in dollars or tokens", () => {
    const result = view(makeFactoryRunState(eventsJsonl, "degraded"), { selectedPhase: 1 });

    expect(
      result.roles.map((row) => ({
        role: row.role,
        harness: row.harness,
        model: row.model,
        sessionId: row.sessionId,
        turnCount: row.turnCount,
        status: row.status,
        cost: row.cost,
        toolCalls: row.toolCalls,
      })),
    ).toEqual([
      {
        role: "implementer",
        harness: "claude",
        model: "claude-opus-5-5",
        sessionId: "3f1c2a8e-5b7d-4e21-9c44-0a6f2d9b7e10",
        turnCount: 5,
        status: "finished",
        cost: "$16.58",
        toolCalls: null,
      },
      {
        role: "verifier",
        harness: "codex",
        model: "gpt-6-luna",
        sessionId: "01a0f1c2-7d3e-7a10-b2c4-5e6f7a8b9c01",
        turnCount: 2,
        status: "finished",
        cost: "4,381,030 tokens",
        toolCalls: null,
      },
      {
        role: "reviewer",
        harness: "codex",
        model: "gpt-6-sol",
        sessionId: "01a0f1d8-2c4b-7e55-9a13-6b7c8d9e0f12",
        turnCount: 1,
        status: "finished",
        cost: "822,220 tokens",
        toolCalls: null,
      },
    ]);
  });

  it("phase9 run view AC3 shows a running session's live tool-call count, last tool and time of last activity", () => {
    // Phase 1 at Verify ①, with the verifier's first turn dispatched and still running.
    const state = foldFactoryRunTestLines(fixtureLines.slice(0, 20));
    const roles: FactoryRoleProgress[] = [
      {
        phase: 1,
        role: "implementer",
        turn: 1,
        status: "finished",
        toolCalls: 41,
        lastTool: "Write",
        lastActivityAt: "2026-09-28T09:26:40.000Z",
      },
      {
        phase: 1,
        role: "implementer",
        turn: 2,
        status: "finished",
        toolCalls: 88,
        lastTool: "Bash",
        lastActivityAt: "2026-09-28T09:46:10.000Z",
      },
      {
        phase: 1,
        role: "implementer",
        turn: 3,
        status: "finished",
        toolCalls: 12,
        lastTool: "Edit",
        lastActivityAt: "2026-09-28T10:11:30.000Z",
      },
      {
        phase: 1,
        role: "verifier",
        turn: 1,
        status: "running",
        toolCalls: 14,
        lastTool: "exec_command",
        lastActivityAt: "2026-09-28T10:24:00.000Z",
      },
    ];
    const result = view(state, { roles, now: "2026-09-28T10:25:00.000Z" });

    const verifier = result.roles.find((row) => row.role === "verifier");
    expect(verifier).toMatchObject({
      harness: "codex",
      model: "gpt-6-luna",
      sessionId: null,
      turnCount: 1,
      status: "running",
      toolCalls: 14,
      lastTool: "exec_command",
      lastActivityAt: "2026-09-28T10:24:00.000Z",
      cost: null,
    });
    const implementer = result.roles.find((row) => row.role === "implementer");
    expect(implementer).toMatchObject({
      turnCount: 3,
      status: "finished",
      cost: "$10.03",
      toolCalls: null,
      lastTool: null,
      lastActivityAt: null,
    });
  });

  it("phase9 run view AC3 lists each turn of a session with its prompt and report files", () => {
    const result = view(makeFactoryRunState(eventsJsonl, "degraded"), { selectedPhase: 1 });

    const verifier = result.roles.find((row) => row.role === "verifier");
    expect(verifier?.turns).toEqual([
      expect.objectContaining({
        turn: 1,
        promptFile: `${RUN_DIR}/phase-1/verifier-prompt-1.md`,
        reportFile: `${RUN_DIR}/phase-1/verifier-1.md`,
      }),
      expect.objectContaining({
        turn: 2,
        promptFile: `${RUN_DIR}/phase-1/verifier-prompt-2.md`,
        reportFile: `${RUN_DIR}/phase-1/verifier-2.md`,
      }),
    ]);
  });
});

describe("phase9 run view AC4 phase record", () => {
  it("phase9 run view AC4 lists a phase's verdicts with the deciding line, findings with severity and disposition, checks with exit codes and its commit", () => {
    const detail = view(makeFactoryRunState(eventsJsonl, "degraded"), { selectedPhase: 1 }).detail;

    expect(detail?.verdicts).toEqual([
      expect.objectContaining({
        label: "Verify ①",
        verdict: "WORKS",
        deciding:
          'curl "/invoices/export.csv?status=overdue" returned 14 rows, the same 14 the page lists',
      }),
      expect.objectContaining({
        label: "Verify ②",
        verdict: "WORKS",
        deciding: "the 50,000-row export finished in 3.1 s with peak memory 41 MB",
      }),
    ]);
    expect(detail?.findings).toEqual([
      expect.objectContaining({
        id: "P1-1",
        severity: "P1",
        title: "The export loads every invoice into memory before it writes the first row",
        disposition: "repaired",
      }),
      expect.objectContaining({
        id: "P3-1",
        severity: "P3",
        title: "The CSV header row uses internal column names",
        disposition: "rejected",
      }),
    ]);
    expect(
      detail?.checks.map((check) => [check.stage, check.results.map((result) => result.exit)]),
    ).toEqual([
      ["build", [1, 0, 0]],
      ["build", [0, 0, 0]],
      ["harden", [0, 0, 0]],
    ]);
    expect(detail?.checks[0]?.results[0]).toEqual({ command: "pnpm lint", exit: 1 });
    expect(detail?.commit).toEqual({
      hash: "4a7d1e9",
      subject: "feat(invoices): export the filtered invoice list as CSV",
    });
  });

  it("phase9 run view AC4 lists a phase's deviations and a finding without a disposition yet", () => {
    const detail = view(makeFactoryRunState(eventsJsonl, "degraded"), { selectedPhase: 2 }).detail;

    expect(detail?.deviations).toEqual([
      {
        path: "src/components/Toolbar.tsx",
        kind: "widened",
        reason:
          "The Export button sits in the shared toolbar, which needed a slot for page actions",
      },
    ]);
    expect(detail?.verdicts.map((verdict) => [verdict.label, verdict.verdict])).toEqual([
      ["Verify ①", "COULD_NOT_EXERCISE"],
      ["Verify ②", "NOT_NEEDED"],
    ]);

    const review = view(makeFactoryRunState(eventsJsonl, "review"));
    expect(review.detail?.findings).toEqual([]);
    const reworking = view(foldFactoryRunTestLines(fixtureLines.slice(0, 26)));
    expect(reworking.detail?.findings.map((finding) => finding.disposition)).toEqual([null, null]);
  });

  it("phase9 run view AC4 shows no commit for a phase still running", () => {
    const detail = view(makeFactoryRunState(eventsJsonl, "verify")).detail;

    expect(detail?.commit).toBeNull();
  });
});

describe("phase9 run view AC7 totals", () => {
  it("phase9 run view AC7 closes a live run's open interval with the client clock", () => {
    const result = view(makeFactoryRunState(eventsJsonl, "verify"), {
      now: "2026-09-28T10:30:00.000Z",
    });

    expect(result.totals).toMatchObject({
      elapsedMs: 5_400_000,
      waitingMs: 0,
      elapsed: "1h 30m",
    });
  });

  it("phase9 run view AC7 adds the open question's wait up to now while the run is waiting", () => {
    const result = view(makeFactoryRunState(eventsJsonl, "waiting"), {
      now: "2026-09-28T12:43:00.000Z",
    });

    expect(result.totals).toMatchObject({
      elapsedMs: 13_380_000,
      waitingMs: 600_000,
      elapsed: "3h 43m",
      waiting: "10m",
    });
  });

  it("phase9 run view AC7 counts the wait from the question, not from the last event, when events arrive while waiting", () => {
    const state = foldFactoryRunTestLines([
      ...fixtureLines.slice(0, 53),
      event("2026-09-28T12:40:00.000Z", "note", { phase: 2, text: "Waiting for the file name." }),
    ]);
    const result = view(state, { now: "2026-09-28T12:50:00.000Z" });

    expect(result.totals).toMatchObject({ elapsedMs: 13_800_000, waitingMs: 1_020_000 });
  });

  it("phase9 run view AC7 keeps a finished run's clock and ignores the client clock", () => {
    const degraded = view(makeFactoryRunState(eventsJsonl, "degraded"), {
      now: "2026-09-29T09:00:00.000Z",
    });
    expect(degraded.totals).toMatchObject({
      elapsedMs: 17_340_000,
      waitingMs: 1_500_000,
      elapsed: "4h 49m",
      waiting: "25m",
    });

    const stopped = view(makeFactoryRunState(eventsJsonl, "stopped"), {
      now: "2026-09-29T09:00:00.000Z",
    });
    expect(stopped.totals).toMatchObject({ elapsedMs: 14_400_000, waitingMs: 1_500_000 });
  });

  it("phase9 run view AC7 reads dollars and tokens and marks the dollar figure a floor when Codex turns report only tokens", () => {
    const result = view(makeFactoryRunState(eventsJsonl, "degraded"));

    expect(result.totals).toMatchObject({ cost: "$23.94 + 8,429,560 tokens", costIsFloor: true });
  });

  it("phase9 run view AC7 reads dollars alone, not a floor, while only Claude turns have reported", () => {
    const result = view(makeFactoryRunState(eventsJsonl, "verify"));

    expect(result.totals).toMatchObject({ cost: "$10.03", costIsFloor: false });
  });

  it("phase9 run view AC7 reads tokens alone, not a floor, when only Codex turns have reported", () => {
    const state = foldFactoryRunTestLines([
      fixtureLines[0]!,
      event("2026-09-28T09:08:00.000Z", "phase.started", { phase: 1 }),
      event("2026-09-28T09:10:00.000Z", "dispatch.started", {
        phase: 1,
        role: "verifier",
        turn: 1,
        harness: "codex",
        model: "gpt-6-luna",
        promptFile: `${RUN_DIR}/phase-1/verifier-prompt-1.md`,
        outputFile: `${RUN_DIR}/phase-1/verifier-1.events.jsonl`,
      }),
      event("2026-09-28T09:20:00.000Z", "dispatch.finished", {
        phase: 1,
        role: "verifier",
        turn: 1,
        sessionId: "01a0f1c2-7d3e-7a10-b2c4-5e6f7a8b9c01",
        stopReason: "completed",
        tokens: {
          input_tokens: 1000,
          cached_input_tokens: 900,
          output_tokens: 234,
          reasoning_output_tokens: 100,
        },
        reportFile: `${RUN_DIR}/phase-1/verifier-1.md`,
      }),
    ]);

    expect(view(state).totals).toMatchObject({ cost: "1,234 tokens", costIsFloor: false });
  });
});

describe("phase9 run view review regressions", () => {
  const dispatchStarted = (at: string, turn: number, sessionId?: string) =>
    event(at, "dispatch.started", {
      phase: 1,
      role: "verifier",
      turn,
      harness: "codex",
      model: "gpt-6-luna",
      promptFile: `${RUN_DIR}/phase-1/verifier-prompt-${turn}.md`,
      outputFile: `${RUN_DIR}/phase-1/verifier-${turn}.events.jsonl`,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
  const dispatchFinished = (at: string, turn: number, sessionId: string) =>
    event(at, "dispatch.finished", {
      phase: 1,
      role: "verifier",
      turn,
      sessionId,
      stopReason: "completed",
      tokens: { input_tokens: 100, output_tokens: 10 },
      reportFile: `${RUN_DIR}/phase-1/verifier-${turn}.md`,
    });
  const started = [
    fixtureLines[0]!,
    event("2026-09-28T09:08:00.000Z", "phase.started", { phase: 1 }),
  ];

  it("phase9 run view P1-2 keeps a fresh turn without a session id out of the role's finished session", () => {
    const state = foldFactoryRunTestLines([
      ...started,
      dispatchStarted("2026-09-28T09:10:00.000Z", 1),
      dispatchFinished("2026-09-28T09:20:00.000Z", 1, "thread-a"),
      dispatchStarted("2026-09-28T09:30:00.000Z", 2),
    ]);

    expect(view(state).roles.map((row) => [row.sessionId, row.turnCount, row.status])).toEqual([
      ["thread-a", 1, "finished"],
      [null, 1, "running"],
    ]);
  });

  it("phase9 run view P1-2 shows two sessions of one role as two rows, each with its own turns", () => {
    const state = foldFactoryRunTestLines([
      ...started,
      dispatchStarted("2026-09-28T09:10:00.000Z", 1),
      dispatchFinished("2026-09-28T09:20:00.000Z", 1, "thread-a"),
      dispatchStarted("2026-09-28T09:21:00.000Z", 2, "thread-a"),
      dispatchFinished("2026-09-28T09:25:00.000Z", 2, "thread-a"),
      dispatchStarted("2026-09-28T09:30:00.000Z", 3),
      dispatchFinished("2026-09-28T09:40:00.000Z", 3, "thread-b"),
    ]);

    expect(
      view(state).roles.map((row) => [row.sessionId, row.turns.map((turn) => turn.turn)]),
    ).toEqual([
      ["thread-a", [1, 2]],
      ["thread-b", [3]],
    ]);
  });

  it("phase9 run view P2-3 keeps an unchanged role row and its turns identical across stream items", () => {
    const before = foldFactoryRunTestLines(fixtureLines.slice(0, 20));
    const first = view(before);
    // The verifier's turn finishes; the implementer's session does not change.
    const after = foldFactoryRunTestLines(fixtureLines.slice(0, 21));
    const second = deriveFactoryRunView({
      item: { state: after, roles: [] },
      selectedPhase: null,
      nowMs: 0,
      previous: first,
    });

    const implementerBefore = first.roles.find((row) => row.role === "implementer");
    const implementerAfter = second.roles.find((row) => row.role === "implementer");
    expect(implementerAfter).toBe(implementerBefore);
    const verifierBefore = first.roles.find((row) => row.role === "verifier");
    const verifierAfter = second.roles.find((row) => row.role === "verifier");
    expect(verifierAfter).not.toBe(verifierBefore);
    expect(verifierAfter?.status).toBe("finished");
  });

  it("phase9 run view P2-3 never lends a row of another phase", () => {
    const state = makeFactoryRunState(eventsJsonl, "degraded");
    const phaseOne = view(state, { selectedPhase: 1 });
    const phaseTwo = deriveFactoryRunView({
      item: { state, roles: [] },
      selectedPhase: 2,
      nowMs: 0,
      previous: phaseOne,
    });

    expect(phaseTwo.roles.find((row) => row.role === "implementer")?.turnCount).toBe(2);
    for (const row of phaseTwo.roles) expect(phaseOne.roles).not.toContain(row);
  });
});
