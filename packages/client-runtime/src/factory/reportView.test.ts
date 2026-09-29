/**
 * Phase 11 fence, criteria 2, 3, 5 and 6: the one report view model the web
 * Report tab, the Android Report tab and both report cards draw from. The
 * frame (clock, verification table, coverage, degraded count, cost, step
 * record) comes from the run state; the prose comes from `report.md`.
 *
 * Entry point: `deriveFactoryReportView` in `reportView.ts`
 * (`@t3tools/client-runtime/factory/report-view`), fed the state the server's
 * run tracker folds from the recorder's fixture
 * (`packages/shared/src/fixtures/factory-events.v1.jsonl`, a two-phase run
 * whose phase 2 closed degraded) and the report that run wrote
 * (`packages/shared/src/fixtures/invoice-csv-export.report.md`), plus
 * synthetic reports with an unknown heading, a missing section and a changed
 * order, and synthetic event lines for a run with two stops. The clients that
 * render it are mounted in `apps/web/src/factory/FactoryRunCard.test.tsx`,
 * `apps/mobile/src/features/factory/FactoryRouteScreen.test.tsx` and
 * `apps/mobile/src/features/threads/mobileInlineScreen.test.tsx`.
 */
/// <reference types="vite-plus/client" />
import type { FactoryRunState } from "@t3tools/contracts";
import { splitFactoryDocument } from "@t3tools/shared/factoryDocument";
import { describe, expect, it } from "vite-plus/test";

import eventsJsonl from "../../../shared/src/fixtures/factory-events.v1.jsonl?raw";
import reportMarkdown from "../../../shared/src/fixtures/invoice-csv-export.report.md?raw";
import {
  deriveFactoryReportCard,
  deriveFactoryReportView,
  FACTORY_REPORT_HEADINGS,
} from "./reportView.ts";
import {
  foldFactoryRunTestLines,
  makeFactoryRunState,
  makeFactoryRunSummary,
  withoutFactoryRunMarks,
} from "./testing.ts";

const PHASE_1_TITLE = "Serialize the filtered invoice list as CSV";
const PHASE_2_TITLE = "Add the Export button to the invoices page";

const fixtureLines = eventsJsonl.split("\n").filter((line) => line.trim().length > 0);

/** One record-version-1 event line. */
const event = (at: string, type: string, fields: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, at, type, ...fields });

const reportView = (markdown: string, state: FactoryRunState) =>
  deriveFactoryReportView({ report: splitFactoryDocument(markdown), state });

/** The fixture report with one level-two section removed. */
function withoutSection(markdown: string, heading: string): string {
  const start = markdown.indexOf(`## ${heading}\n`);
  expect(start, `Fixture report has "## ${heading}"`).toBeGreaterThan(-1);
  const next = markdown.indexOf("\n## ", start + 1);
  return markdown.slice(0, start) + (next === -1 ? "" : markdown.slice(next + 1));
}

/** The fixture report with a section inserted before the named heading. */
function withSectionBefore(markdown: string, before: string, section: string): string {
  const at = markdown.indexOf(`## ${before}\n`);
  expect(at, `Fixture report has "## ${before}"`).toBeGreaterThan(-1);
  return `${markdown.slice(0, at)}${section}\n\n${markdown.slice(at)}`;
}

/** The body of one section of the fixture report, as the file holds it. */
function sectionOf(markdown: string, heading: string): string {
  const section = splitFactoryDocument(markdown).sections.find(
    (candidate) => candidate.heading === heading,
  );
  expect(section, `Fixture report has "## ${heading}"`).toBeDefined();
  return section!.body;
}

describe("phase11 report view headings", () => {
  it("phase11 report view keeps the seven authored headings of sf-team REPORT.md in the contract's order", () => {
    // Written out from `skills/core/sf-team/REPORT.md`, section "The headings".
    expect(FACTORY_REPORT_HEADINGS).toEqual([
      "Context",
      "What was built",
      "How it was built",
      "Where this differs from the plan",
      "How it was verified",
      "Architecture",
      "What is unresolved",
    ]);
  });
});

describe("phase11 report view AC2 sections", () => {
  it("phase11 report view AC2 lists a complete report's authored sections in the contract's order with nothing missing", () => {
    const view = reportView(reportMarkdown, makeFactoryRunState(eventsJsonl, "degraded"));

    expect(view.title).toBe("Report: Export the invoice list as CSV");
    expect(view.sections.map((section) => section.heading)).toEqual([...FACTORY_REPORT_HEADINGS]);
    expect(view.sections.every((section) => section.kind !== "unknown")).toBe(true);
    expect(view.missing).toEqual([]);
  });

  it("phase11 report view AC2 orders authored sections by the contract even when report.md does not", () => {
    const unresolved = `## What is unresolved\n\n${sectionOf(reportMarkdown, "What is unresolved").trim()}\n`;
    const reordered = withSectionBefore(
      withoutSection(reportMarkdown, "What is unresolved"),
      "Architecture",
      unresolved,
    );
    expect(splitFactoryDocument(reordered).sections.map((section) => section.heading)).toEqual([
      "Context",
      "What was built",
      "How it was built",
      "Where this differs from the plan",
      "How it was verified",
      "What is unresolved",
      "Architecture",
    ]);

    const view = reportView(reordered, makeFactoryRunState(eventsJsonl, "degraded"));

    expect(view.sections.map((section) => section.heading)).toEqual([...FACTORY_REPORT_HEADINGS]);
    expect(view.missing).toEqual([]);
  });

  it("phase11 report view AC1 reads the Context section and the What was built lead and bullets for the card", () => {
    const view = reportView(reportMarkdown, makeFactoryRunState(eventsJsonl, "degraded"));

    expect(view.context).toContain("Accountants close each month from the invoice list");
    expect(view.context).not.toContain("An accountant can now take the invoice list");
    expect(view.built?.lead).toBe(
      "An accountant can now take the invoice list out of the app as a spreadsheet file, exactly as the page shows it.",
    );
    expect(view.built?.bullets).toEqual([
      "Export the invoices the current filter shows as a CSV file.",
      "Keep every amount with two decimals and its invoice currency.",
      "Download the file from an Export button on the invoices page, named after the export date.",
    ]);
  });

  it("phase11 report view AC4 splits the Architecture section into its diagram, its reading and its legend", () => {
    const view = reportView(reportMarkdown, makeFactoryRunState(eventsJsonl, "degraded"));
    const architecture = view.sections.find((section) => section.heading === "Architecture");

    expect(architecture?.kind).toBe("architecture");
    if (architecture?.kind !== "architecture") return;
    expect(architecture.diagram).toContain("flowchart LR");
    expect(architecture.diagram).toContain("EX[Export endpoint]");
    expect(architecture.body).toContain(
      "The page asks the endpoint for the file with its own filter",
    );
    expect(architecture.body).not.toContain("```");
    expect(architecture.legend.map((entry) => entry.id)).toEqual(["IP", "TB", "EX", "DB"]);
  });
});

describe("phase11 report view AC5 unknown and missing headings", () => {
  it("phase11 report view AC5 keeps a heading the contract does not name in place as a plain section and names a missing section", () => {
    const markdown = withSectionBefore(
      withoutSection(reportMarkdown, "Where this differs from the plan"),
      "How it was built",
      "## Screenshots\n\nTwo screenshots of the Export button, before and after.",
    );

    const view = reportView(markdown, makeFactoryRunState(eventsJsonl, "degraded"));

    expect(view.sections.map((section) => section.heading)).toEqual([
      "Context",
      "What was built",
      "Screenshots",
      "How it was built",
      "How it was verified",
      "Architecture",
      "What is unresolved",
    ]);
    const screenshots = view.sections.find((section) => section.heading === "Screenshots");
    expect(screenshots).toMatchObject({ kind: "unknown", heading: "Screenshots" });
    expect(screenshots?.kind === "unknown" ? screenshots.body : "").toContain(
      "Two screenshots of the Export button",
    );
    expect(view.missing).toEqual(["Where this differs from the plan"]);
  });

  it("phase11 report view AC5 names every missing section of a report that has only its title and Context", () => {
    const markdown = "# Report: a short run\n\n## Context\n\nOnly the context was written.\n";

    const view = reportView(markdown, makeFactoryRunState(eventsJsonl, "degraded"));

    // Review P2-1: the derived table keeps its section, unwritten, at its contract place.
    expect(view.sections.map((section) => section.heading)).toEqual([
      "Context",
      "How it was verified",
    ]);
    expect(view.missing).toEqual(FACTORY_REPORT_HEADINGS.slice(1));
    expect(view.built).toBeNull();
  });
});

describe("phase11 report view AC2 AC3 verification", () => {
  it("phase11 report view AC3 builds the verification table per phase and criterion from the last verdict of each pass", () => {
    const view = reportView(reportMarkdown, makeFactoryRunState(eventsJsonl, "degraded"));

    expect(view.verification).toMatchObject([
      {
        phase: 1,
        title: PHASE_1_TITLE,
        criteria: [
          {
            n: 1,
            name: "GET /invoices/export.csv returns the rows the current filter shows",
            result: "PASS",
            authoredTestsOnly: false,
          },
          {
            n: 2,
            name: "Amounts keep two decimals and the invoice currency",
            result: "PASS",
            authoredTestsOnly: false,
          },
          {
            n: 3,
            name: "A field that contains a comma or a quote is quoted per RFC 4180",
            result: "PASS",
            authoredTestsOnly: true,
          },
        ],
      },
      {
        phase: 2,
        title: PHASE_2_TITLE,
        criteria: [
          {
            n: 1,
            name: "The Export button downloads invoices-<date>.csv",
            // Verify ② said NOT_NEEDED with no criteria: verify ①'s result stands.
            result: "NOT_EXERCISED",
            authoredTestsOnly: false,
          },
          {
            n: 2,
            name: "The button is disabled while the list is empty",
            result: "PASS",
            authoredTestsOnly: false,
          },
        ],
      },
    ]);
    expect(view.coverage).toEqual({ passed: 4, total: 5 });
    expect(view.degradedPhases).toBe(1);
  });

  it("phase11 report view AC3 reads a re-run verify from its last verdict, not the one a repair answered", () => {
    const criteria = (first: "PASS" | "FAIL") => [
      {
        n: 1,
        name: "GET /invoices/export.csv returns the rows the current filter shows",
        result: first,
      },
      { n: 2, name: "Amounts keep two decimals and the invoice currency", result: "PASS" },
      {
        n: 3,
        name: "A field that contains a comma or a quote is quoted per RFC 4180",
        result: "PASS",
      },
    ];
    const state = foldFactoryRunTestLines([
      ...fixtureLines.slice(0, 19),
      event("2026-09-28T10:32:00.000Z", "verdict.recorded", {
        phase: 1,
        pass: 1,
        verdict: "BROKEN",
        deciding: "the export returned every invoice, not the filtered ones",
        criteria: criteria("FAIL"),
      }),
      event("2026-09-28T10:33:00.000Z", "return.recorded", {
        phase: 1,
        kind: "repair",
        n: 2,
        budget: 5,
        node: "verify-1",
        change: "the handler now reads the page's filter",
      }),
      event("2026-09-28T10:50:00.000Z", "verdict.recorded", {
        phase: 1,
        pass: 1,
        verdict: "WORKS",
        deciding: "the filtered export returned 14 rows",
        criteria: criteria("PASS"),
      }),
    ]);

    const view = reportView(reportMarkdown, state);

    expect(view.verification[0]?.criteria.map((criterion) => criterion.result)).toEqual([
      "PASS",
      "PASS",
      "PASS",
    ]);
  });

  it("phase11 report view AC3 counts a criterion no verdict named yet in the total, with no result", () => {
    const view = reportView(reportMarkdown, makeFactoryRunState(eventsJsonl, "answered"));

    expect(view.verification[1]).toMatchObject({
      phase: 2,
      criteria: [
        { n: 1, name: "The Export button downloads invoices-<date>.csv", result: null },
        { n: 2, name: "The button is disabled while the list is empty", result: null },
      ],
    });
    expect(view.coverage).toEqual({ passed: 3, total: 5 });
    expect(view.degradedPhases).toBe(0);
  });
});

describe("phase11 report view AC2 AC6 clock and cost", () => {
  it("phase11 report view AC2 reads the finished fixture run's clock: elapsed, machine and waiting", () => {
    const view = reportView(reportMarkdown, makeFactoryRunState(eventsJsonl, "degraded"));

    expect(view.clock).toMatchObject({
      elapsedMs: 17_340_000,
      machineMs: 15_840_000,
      waitingMs: 1_500_000,
      elapsed: "4h 49m",
      machine: "4h 24m",
      waiting: "25m",
    });
  });

  it("phase11 report view AC6 clock arithmetic subtracts every stop's wait from the machine time", () => {
    const state = foldFactoryRunTestLines([
      fixtureLines[0]!,
      event("2026-09-28T09:05:00.000Z", "phase.started", { phase: 1 }),
      event("2026-09-28T09:10:00.000Z", "stop.raised", {
        phase: 1,
        node: "implement",
        question: "Stream rows or load them?",
        options: ["stream", "load"],
      }),
      event("2026-09-28T09:40:00.000Z", "stop.answered", { answer: "Stream them." }),
      event("2026-09-28T10:00:00.000Z", "stop.raised", {
        question: "Keep the internal column names?",
        options: ["keep", "rename"],
      }),
      event("2026-09-28T10:05:00.000Z", "stop.answered", { answer: "Keep them." }),
      event("2026-09-28T10:59:00.000Z", "report.written", {
        path: "/srv/factory-runs/invoice-csv-export/report.md",
      }),
      event("2026-09-28T11:00:00.000Z", "run.finished", { status: "done" }),
    ]);

    const view = reportView(reportMarkdown, state);

    expect(view.clock).toMatchObject({
      elapsedMs: 7_200_000,
      waitingMs: 2_100_000,
      machineMs: 5_100_000,
      elapsed: "2h",
      waiting: "35m",
      machine: "1h 25m",
    });
    expect(view.clock.machineMs + view.clock.waitingMs).toBe(view.clock.elapsedMs);
  });

  it("phase11 report view AC6 reads the cost from the run state with the floor mark for token-only turns", () => {
    const view = reportView(reportMarkdown, makeFactoryRunState(eventsJsonl, "degraded"));

    expect(view.cost).toBe("$23.94 + 8,429,560 tokens");
    expect(view.costIsFloor).toBe(true);
  });

  it("phase11 report view AC6 takes no duration, count or cost from report.md prose", () => {
    const boastful = reportMarkdown
      .replace(
        "The quoting of commas and quotes rests on authored tests only",
        "All 5 of 5 criteria passed in 12m of machine time for $1.00, 0 phases degraded, and the quoting of commas and quotes rests on authored tests only",
      )
      .replace(
        "## Context\n",
        "## Context\n\n| Elapsed | Machine | Waiting | Cost |\n| --- | --- | --- | --- |\n| 1h | 1h | 0s | $1.00 |\n",
      );
    const degraded = makeFactoryRunState(eventsJsonl, "degraded");
    const done = makeFactoryRunState(eventsJsonl, "done");

    const fromDegraded = reportView(boastful, degraded);
    const fromDone = reportView(boastful, done);

    expect(fromDegraded.clock).toMatchObject({ elapsed: "4h 49m", waiting: "25m" });
    expect(fromDegraded.coverage).toEqual({ passed: 4, total: 5 });
    expect(fromDegraded.degradedPhases).toBe(1);
    expect(fromDegraded.cost).toBe("$23.94 + 8,429,560 tokens");
    // The same prose over another state: every number follows the state.
    expect(fromDone.degradedPhases).toBe(0);
    // A run stopped at 13:00 reads its own clock, not the one the prose claims.
    const fromStopped = reportView(boastful, makeFactoryRunState(eventsJsonl, "stopped"));
    expect(fromStopped.clock).toMatchObject({ elapsedMs: 14_400_000, elapsed: "4h" });
  });
});

describe("phase11 report view AC4 step record", () => {
  /** The index of the first line holding `text`; every expected line must exist. */
  function lineIndexes(
    lines: ReadonlyArray<{ readonly text: string }>,
    texts: ReadonlyArray<string>,
  ): number[] {
    const shown = lines.map((line) => line.text).join("\n");
    return texts.map((text) => {
      const index = lines.findIndex((line) => line.text.includes(text));
      expect(index, `Expected a step line with "${text}"; lines:\n${shown}`).not.toBe(-1);
      return index;
    });
  }
  const isAscending = (indexes: ReadonlyArray<number>) =>
    indexes.every((value, index) => index === 0 || value > indexes[index - 1]!);

  it("phase11 report view AC4 renders each phase's recorded steps as short lines in the order they happened", () => {
    const view = reportView(reportMarkdown, makeFactoryRunState(eventsJsonl, "degraded"));

    expect(view.steps.map((step) => [step.phase, step.title])).toEqual([
      [1, PHASE_1_TITLE],
      [2, PHASE_2_TITLE],
    ]);
    const [phase1, phase2] = view.steps;
    const phase1Order = lineIndexes(phase1!.lines, [
      "repair 1/5",
      "WORKS",
      "The export loads every invoice into memory before it writes the first row",
      "rework 2/5",
      "4a7d1e9",
    ]);
    expect(isAscending(phase1Order), `phase 1 order ${phase1Order}`).toBe(true);
    const phase2Order = lineIndexes(phase2!.lines, [
      "src/components/Toolbar.tsx",
      "Name the file after the filter range or after the export date?",
      "b83f0c2",
    ]);
    expect(isAscending(phase2Order), `phase 2 order ${phase2Order}`).toBe(true);
    // Short lines: one step each, never a paragraph.
    for (const line of [...phase1!.lines, ...phase2!.lines]) expect(line.text).not.toContain("\n");
  });
});

describe("phase11 report view review regressions", () => {
  it("phase11 review P2-1 keeps the derived verification section at its contract place when report.md leaves it out", () => {
    const markdown = withoutSection(reportMarkdown, "How it was verified");

    const view = reportView(markdown, makeFactoryRunState(eventsJsonl, "degraded"));

    expect(view.sections.map((section) => section.heading)).toEqual([...FACTORY_REPORT_HEADINGS]);
    expect(view.sections[4]).toEqual({
      kind: "verification",
      heading: "How it was verified",
      body: null,
    });
    expect(view.missing).toEqual(["How it was verified"]);
    expect(view.missingNotice).toBe("Missing from report.md: How it was verified");
  });

  it("phase11 review P2-1 reads a written How it was verified as the verification section with its comment", () => {
    const view = reportView(reportMarkdown, makeFactoryRunState(eventsJsonl, "degraded"));
    const verified = view.sections.find((section) => section.heading === "How it was verified");

    expect(verified?.kind).toBe("verification");
    expect(verified?.kind === "verification" ? verified.body : null).toContain(
      "The quoting of commas and quotes rests on authored tests only",
    );
  });

  it("phase11 review P1-1 report card keeps the degraded count of a summary whose phase marks were trimmed", () => {
    const trimmed = withoutFactoryRunMarks(makeFactoryRunSummary(eventsJsonl, "degraded"));
    expect(trimmed.phaseStatuses).toBeUndefined();

    const card = deriveFactoryReportCard({
      report: splitFactoryDocument(reportMarkdown),
      summary: trimmed,
    });

    expect(card.degraded).toBe("1 degraded phase");
    expect(card.hasDegraded).toBe(true);
    expect(card.coverage).toBe("4/5 criteria passed");
  });

  it("phase11 review P1-1 report card falls back to the phase marks of a summary stored before the degraded count", () => {
    const { degradedPhases: _count, ...older } = makeFactoryRunSummary(eventsJsonl, "degraded");

    const card = deriveFactoryReportCard({
      report: splitFactoryDocument(reportMarkdown),
      summary: older,
    });

    expect(card.degraded).toBe("1 degraded phase");
  });
});
