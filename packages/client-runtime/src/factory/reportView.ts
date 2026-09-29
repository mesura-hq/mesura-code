/**
 * What a Software Factory report shows, on the web and on Android: the web
 * Report tab and the Android Report tab render `deriveFactoryReportView`, and
 * both report cards render `deriveFactoryReportCard`, so the two clients show
 * the same numbers for the same run. The frame (clock, verification table,
 * coverage, degraded count, cost, step record) comes from the run; only the
 * prose comes from `report.md`. Hermes has no ES2023 array methods: none are
 * used here.
 */
import type { FactoryRunState, FactoryRunSummary } from "@t3tools/contracts";
import {
  splitFactoryArchitecture,
  type FactoryDocument,
  type FactoryLegendEntry,
} from "@t3tools/shared/factoryDocument";
import {
  deriveFactoryRunVerification,
  factoryRunCoverage,
  type FactoryCriterionResult,
  type FactoryPhaseVerification,
} from "@t3tools/shared/factoryRun";

import {
  factoryClockText,
  factoryCostText,
  factoryNodeDisplayName,
  factoryReturnText,
} from "./runPresentation.ts";

/**
 * The authored level-two headings of `report.md`, in order. Their source is
 * `skills/core/sf-team/REPORT.md` in the agent-env repository, section "The
 * headings": a change there lands here.
 */
export const FACTORY_REPORT_HEADINGS = [
  "Context",
  "What was built",
  "How it was built",
  "Where this differs from the plan",
  "How it was verified",
  "Architecture",
  "What is unresolved",
] as const;

const FACTORY_REPORT_VERIFIED_HEADING = "How it was verified";
const CONTEXT_HEADING = "Context";
const BUILT_HEADING = "What was built";
const ARCHITECTURE_HEADING = "Architecture";

export type FactoryReportSection =
  | { readonly kind: "authored"; readonly heading: string; readonly body: string }
  | {
      readonly kind: "architecture";
      readonly heading: string;
      readonly diagram: string | null;
      readonly body: string;
      readonly legend: ReadonlyArray<FactoryLegendEntry>;
    }
  /**
   * How it was verified: the derived table, then the author's comment. Present
   * at its contract position even when report.md left it out (`body` null).
   */
  | { readonly kind: "verification"; readonly heading: string; readonly body: string | null }
  /** A heading the contract does not name: shown as a plain section, where it stood. */
  | { readonly kind: "unknown"; readonly heading: string; readonly body: string };

export interface FactoryReportBuilt {
  readonly lead: string;
  readonly bullets: ReadonlyArray<string>;
}

export interface FactoryReportStepLine {
  readonly text: string;
  /** A red check, an unrepaired finding or a degraded close: drawn in the error tone. */
  readonly error: boolean;
}

export interface FactoryReportSteps {
  readonly phase: number;
  readonly title: string;
  readonly degraded: boolean;
  readonly lines: ReadonlyArray<FactoryReportStepLine>;
}

export interface FactoryReportView {
  readonly title: string;
  readonly clock: {
    readonly elapsedMs: number;
    readonly machineMs: number;
    readonly waitingMs: number;
    readonly elapsed: string;
    readonly machine: string;
    readonly waiting: string;
  };
  readonly cost: string;
  /** The dollar figure leaves out turns that reported only tokens. */
  readonly costIsFloor: boolean;
  readonly verification: ReadonlyArray<FactoryPhaseVerification>;
  readonly coverage: { readonly passed: number; readonly total: number };
  readonly degradedPhases: number;
  readonly steps: ReadonlyArray<FactoryReportSteps>;
  /** Authored sections in the contract's order, unknown headings where they stood. */
  readonly sections: ReadonlyArray<FactoryReportSection>;
  /** Contract headings `report.md` does not carry. */
  readonly missing: ReadonlyArray<string>;
  /** `Missing from report.md: …`, or null when nothing is missing. */
  readonly missingNotice: string | null;
  readonly context: string | null;
  readonly built: FactoryReportBuilt | null;
}

export interface FactoryReportCard {
  readonly title: string;
  readonly context: string | null;
  readonly built: FactoryReportBuilt | null;
  /** `4/5 criteria passed`; null while the run's summary does not carry it. */
  readonly coverage: string | null;
  /** `1 degraded phase`; null while the run's summary has no phase marks. */
  readonly degraded: string | null;
  readonly hasDegraded: boolean;
}

const CRITERION_RESULT_LABELS = {
  PASS: "passed",
  FAIL: "failed",
  NOT_EXERCISED: "not exercised",
} as const satisfies Record<FactoryCriterionResult, string>;

/** `passed`, `failed`, `not exercised`, or `not verified` while no verdict named it. */
export function factoryCriterionResultLabel(result: FactoryCriterionResult | null): string {
  return result === null ? "not verified" : CRITERION_RESULT_LABELS[result];
}

export const factoryCoverageText = (coverage: { passed: number; total: number }) =>
  `${coverage.passed}/${coverage.total} criteria passed`;

export const factoryDegradedText = (count: number) =>
  `${count} degraded ${count === 1 ? "phase" : "phases"}`;

const contractIndex = (heading: string) =>
  (FACTORY_REPORT_HEADINGS as ReadonlyArray<string>).indexOf(heading);

function sectionModel(heading: string, body: string): FactoryReportSection {
  if (heading === ARCHITECTURE_HEADING) {
    return { kind: "architecture", heading, ...splitFactoryArchitecture(body) };
  }
  if (heading === FACTORY_REPORT_VERIFIED_HEADING) {
    return { kind: "verification", heading, body: body.trim() };
  }
  if (contractIndex(heading) === -1) return { kind: "unknown", heading, body: body.trim() };
  return { kind: "authored", heading, body: body.trim() };
}

/**
 * The known sections by the contract's order. An unknown heading travels with
 * the section before it in the document, so it stays where the author put it.
 * How it was verified is always present, written or not.
 */
function orderSections(report: FactoryDocument): ReadonlyArray<FactoryReportSection> {
  const groups: Array<{ order: number; sections: FactoryReportSection[] }> = [];
  for (const section of report.sections) {
    const model = sectionModel(section.heading, section.body);
    const order = contractIndex(section.heading);
    const current = groups[groups.length - 1];
    if (order === -1 && current !== undefined) current.sections.push(model);
    else groups.push({ order, sections: [model] });
  }
  // The table is derived, so its section stands at its place even when unwritten.
  if (!report.sections.some((section) => section.heading === FACTORY_REPORT_VERIFIED_HEADING)) {
    groups.push({
      order: contractIndex(FACTORY_REPORT_VERIFIED_HEADING),
      sections: [{ kind: "verification", heading: FACTORY_REPORT_VERIFIED_HEADING, body: null }],
    });
  }
  // Stable: a heading written twice keeps its document order.
  return groups
    .slice()
    .sort((left, right) => left.order - right.order)
    .flatMap((group) => group.sections);
}

function sectionBody(report: FactoryDocument, heading: string): string | null {
  const section = report.sections.find((candidate) => candidate.heading === heading);
  return section === undefined ? null : section.body.trim();
}

const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;

/** The What was built lead paragraph and one bullet per capability. */
function readBuilt(body: string | null): FactoryReportBuilt | null {
  if (body === null) return null;
  const lead: string[] = [];
  const bullets: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const bullet = BULLET.exec(line);
    if (bullet !== null) {
      bullets.push(bullet[1]!.trim());
    } else if (bullets.length > 0 && /^\s+\S/.test(line)) {
      bullets[bullets.length - 1] = `${bullets[bullets.length - 1]} ${line.trim()}`;
    } else if (bullets.length === 0) {
      lead.push(line);
    }
  }
  return { lead: lead.join("\n").trim(), bullets };
}

function readProse(report: FactoryDocument) {
  return {
    title: report.title,
    context: sectionBody(report, CONTEXT_HEADING),
    built: readBuilt(sectionBody(report, BUILT_HEADING)),
  };
}

interface TimedLine extends FactoryReportStepLine {
  readonly at: string;
}

const firstLine = (text: string) => text.split(/\r?\n/)[0]!.trim();
const verdictText = (verdict: string) => verdict.split("_").join(" ");

/** One phase's recorded events as short lines, in the order they happened. */
function phaseSteps(state: FactoryRunState, index: number): ReadonlyArray<FactoryReportStepLine> {
  const phase = state.phases.find((candidate) => candidate.index === index)!;
  const lines: TimedLine[] = [];
  const add = (at: string | null, text: string, error = false) => {
    if (at !== null) lines.push({ at, text, error });
  };
  for (const entry of state.returns) {
    if (entry.phase === index) add(entry.at, factoryReturnText(entry));
  }
  for (const entry of phase.nodes) add(entry.at, factoryNodeDisplayName(entry.node));
  for (const dispatch of phase.dispatches) {
    add(dispatch.startedAt, `${dispatch.role} turn ${dispatch.turn} · ${dispatch.model}`);
    const reported = dispatch.costUsd !== null || dispatch.tokens !== null;
    const cost = reported
      ? ` · ${factoryCostText({ usd: dispatch.costUsd ?? 0, tokens: dispatch.tokens ?? {} }).text}`
      : "";
    add(dispatch.finishedAt, `${dispatch.role} turn ${dispatch.turn} finished${cost}`);
  }
  for (const check of phase.checks) {
    const results = check.results.map((result) => `${result.command} exit ${result.exit}`);
    add(
      check.at,
      `${factoryNodeDisplayName(`checks-${check.stage}`)}: ${results.join(", ")}`,
      check.results.some((result) => result.exit !== 0),
    );
  }
  for (const verdict of phase.verdicts) {
    add(
      verdict.at,
      `${factoryNodeDisplayName(`verify-${verdict.pass}`)}: ${verdictText(verdict.verdict)} — ${verdict.deciding}`,
    );
  }
  for (const finding of phase.findings) {
    const disposition = finding.disposition === null ? "" : ` — ${finding.disposition}`;
    add(
      finding.at,
      `${finding.id} (${finding.severity}) ${finding.title}${disposition}`,
      finding.disposition !== "repaired" && finding.disposition !== "rejected",
    );
  }
  for (const deviation of phase.deviations) {
    add(deviation.at, `${deviation.kind} ${deviation.path}: ${deviation.reason}`);
  }
  for (const note of state.notes) {
    if (note.phase === index) add(note.at, firstLine(note.text));
  }
  for (const stop of state.stops) {
    if (stop.phase !== index) continue;
    add(stop.raisedAt, `Question: ${stop.question}`);
    if (stop.answer !== null) add(stop.answeredAt, `Answer: ${stop.answer}`);
  }
  const degraded = phase.status === "degraded";
  const close = degraded ? `closed degraded: ${phase.degraded.join("; ")}` : "closed clean";
  add(phase.closedAt, close, degraded);
  const { commit } = phase;
  if (commit !== null) {
    add(
      phase.closedAt,
      "hash" in commit
        ? `commit ${commit.hash} ${commit.subject}`
        : `commit blocked: ${commit.blocked}`,
    );
  }
  // Stable, so lines of the same instant keep the order above.
  return lines
    .sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0))
    .map(({ text, error }) => ({ text, error }));
}

/** The whole report: its frame from the run state, its prose from `report.md`. */
export function deriveFactoryReportView(input: {
  readonly report: FactoryDocument;
  readonly state: FactoryRunState;
}): FactoryReportView {
  const { report, state } = input;
  const verification = deriveFactoryRunVerification(state);
  const present = new Set(report.sections.map((section) => section.heading));
  const missing = FACTORY_REPORT_HEADINGS.filter((heading) => !present.has(heading));
  const { elapsedMs, machineMs, waitingMs } = state.clock;
  const cost = factoryCostText(state.cost);
  return {
    ...readProse(report),
    clock: {
      elapsedMs,
      machineMs,
      waitingMs,
      elapsed: factoryClockText(elapsedMs),
      machine: factoryClockText(machineMs),
      waiting: factoryClockText(waitingMs),
    },
    cost: cost.text,
    costIsFloor: cost.floor,
    verification,
    coverage: factoryRunCoverage(verification),
    degradedPhases: state.phases.filter((phase) => phase.status === "degraded").length,
    steps: state.phases.map((phase) => ({
      phase: phase.index,
      title: phase.title,
      degraded: phase.status === "degraded",
      lines: phaseSteps(state, phase.index),
    })),
    sections: orderSections(report),
    missing,
    missingNotice: missing.length === 0 ? null : `Missing from report.md: ${missing.join(", ")}`,
  };
}

/**
 * A report card: its prose from `report.md`, its numbers from the run's
 * compact summary (the latest `factory.run` activity), never the run stream.
 */
export function deriveFactoryReportCard(input: {
  readonly report: FactoryDocument;
  readonly summary: FactoryRunSummary | null;
}): FactoryReportCard {
  const coverage = input.summary?.coverage;
  // The count survives the summary's trimming; the marks are the fallback for
  // activities stored before the count existed.
  const marks = input.summary?.phaseStatuses;
  const degradedCount =
    input.summary?.degradedPhases ??
    (marks === undefined ? null : marks.filter((status) => status === "degraded").length);
  return {
    ...readProse(input.report),
    coverage: coverage === undefined ? null : factoryCoverageText(coverage),
    degraded: degradedCount === null ? null : factoryDegradedText(degradedCount),
    hasDegraded: degradedCount !== null && degradedCount > 0,
  };
}
