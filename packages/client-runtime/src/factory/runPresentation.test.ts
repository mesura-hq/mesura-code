/**
 * Phase 8 fence, acceptance criteria 1, 3, 4 and 5: what the run card and the
 * thread status label say, for every run status, phase mark and node.
 *
 * Entry point: the shared presentation module both clients render from
 * (`runPresentation.ts`), fed with the compact summary and the shell summary
 * the server's run tracker publishes, folded from the recorder's fixture
 * (`packages/shared/src/fixtures/factory-events.v1.jsonl`). What only a
 * browser or the emulator shows: the colours of each tone, the card frame, and
 * that the web sidebar row and the Android thread list row draw this label.
 */
/// <reference types="vite-plus/client" />
import type { FactoryRunShellSummary, FactoryRunSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import eventsJsonl from "../../../shared/src/fixtures/factory-events.v1.jsonl?raw";
import {
  factoryNodeDisplayName,
  factoryPhaseMarkTone,
  factoryRunCardModel,
  factoryRunLabel,
} from "./runPresentation.ts";
import {
  makeFactoryRunSummary,
  withoutFactoryRunMarks,
  type FactoryRunFixturePoint,
} from "./testing.ts";

const summaryAt = (point: FactoryRunFixturePoint) => makeFactoryRunSummary(eventsJsonl, point);

/** The shell summary the tracker publishes beside the same activity. */
const shellOf = (summary: FactoryRunSummary): FactoryRunShellSummary => ({
  status: summary.status,
  phaseIndex: summary.phase?.index ?? 0,
  phaseCount: summary.phaseCount,
  node: summary.node,
});

const REQUEST = "Let accountants export the invoice list as a CSV file";

describe("factory run card content (phase 8 fence)", () => {
  it("phase8 AC1 run card model carries the request, status, phase, node, marks, returns, cost and last event", () => {
    expect(factoryRunCardModel(summaryAt("verify"))).toEqual({
      request: REQUEST,
      status: { text: "phase 1/2 · Verify ①", tone: "info" },
      phase: { index: 1, count: 2, title: "Serialize the filtered invoice list as CSV" },
      node: "Verify ①",
      marks: [
        { index: 1, status: "running" },
        { index: 2, status: "pending" },
      ],
      returns: "1/5 returns",
      cost: "$10.03",
      lastEventAt: "2026-09-28T10:18:00.000Z",
      question: null,
      live: true,
    });
  });

  it("phase8 AC1 run card marks each phase clean, degraded, running or pending", () => {
    const marks = (point: FactoryRunFixturePoint) => factoryRunCardModel(summaryAt(point)).marks;
    expect(marks("framed")).toEqual([
      { index: 1, status: "pending" },
      { index: 2, status: "pending" },
    ]);
    expect(marks("answered")).toEqual([
      { index: 1, status: "clean" },
      { index: 2, status: "running" },
    ]);
    expect(marks("degraded")).toEqual([
      { index: 1, status: "clean" },
      { index: 2, status: "degraded" },
    ]);
    expect(marks("done")).toEqual([
      { index: 1, status: "clean" },
      { index: 2, status: "clean" },
    ]);
    expect(factoryPhaseMarkTone("running")).toBe("info");
    expect(factoryPhaseMarkTone("clean")).toBe("success");
    expect(factoryPhaseMarkTone("degraded")).toBe("error");
    expect(factoryPhaseMarkTone("pending")).toBe("neutral");
  });

  it("phase8 AC1 run card of a run attached before its first event names no phase and no request", () => {
    expect(factoryRunCardModel(summaryAt("attached"))).toMatchObject({
      request: null,
      status: { text: "starting", tone: "info" },
      phase: null,
      node: null,
      marks: [],
      returns: "0/0 returns",
      cost: "$0.00",
      lastEventAt: null,
      question: null,
      live: true,
    });
  });

  it("phase8 run card of a summary without phase marks shows no marks and keeps everything else", () => {
    // A run too long to carry its marks, or an activity stored before the field existed.
    const card = factoryRunCardModel(withoutFactoryRunMarks(summaryAt("verify")));

    expect(card.marks).toEqual([]);
    expect(card.status).toEqual({ text: "phase 1/2 · Verify ①", tone: "info" });
    expect(card.request).toBe(REQUEST);
    expect(card.cost).toBe("$10.03");
  });

  it("phase8 AC3 run card shows the open stop question and its label reads waiting", () => {
    const waiting = factoryRunCardModel(summaryAt("waiting"));
    expect(waiting.status).toEqual({ text: "waiting", tone: "warning" });
    expect(waiting.question).toBe("Name the file after the filter range or after the export date?");
    expect(waiting.live).toBe(true);
    expect(factoryRunLabel(shellOf(summaryAt("waiting")))).toEqual({
      text: "waiting",
      tone: "warning",
    });
    // Answered: the question leaves the card and the label shows the phase again.
    const answered = factoryRunCardModel(summaryAt("answered"));
    expect(answered.question).toBeNull();
    expect(answered.status).toEqual({ text: "phase 2/2 · Implement", tone: "info" });
  });

  it("phase8 AC4 thread label reads the phase and node while running and the outcome once finished", () => {
    const label = (point: FactoryRunFixturePoint) => factoryRunLabel(shellOf(summaryAt(point)));
    expect(label("attached")).toEqual({ text: "starting", tone: "info" });
    expect(label("framed")).toEqual({ text: "starting", tone: "info" });
    expect(label("verify")).toEqual({ text: "phase 1/2 · Verify ①", tone: "info" });
    expect(label("review")).toEqual({ text: "phase 1/2 · Review", tone: "info" });
    expect(label("waiting")).toEqual({ text: "waiting", tone: "warning" });
    expect(label("done")).toEqual({ text: "done", tone: "success" });
    expect(label("degraded")).toEqual({ text: "degraded", tone: "error" });
    expect(label("stopped")).toEqual({ text: "stopped", tone: "warning" });
    expect(
      factoryRunLabel({ status: "running", phaseIndex: 5, phaseCount: 11, node: "review" }),
    ).toEqual({ text: "phase 5/11 · Review", tone: "info" });
    expect(
      factoryRunLabel({ status: "running", phaseIndex: 5, phaseCount: 11, node: null }),
    ).toEqual({ text: "phase 5/11", tone: "info" });
  });

  it("phase8 AC4 thread label is absent for a thread whose shell carries no run", () => {
    expect(factoryRunLabel(undefined)).toBeNull();
    expect(factoryRunLabel(null)).toBeNull();
  });

  it("phase8 AC5 run card status and thread label agree at every point of the run", () => {
    const points: ReadonlyArray<FactoryRunFixturePoint> = [
      "attached",
      "framed",
      "verify",
      "review",
      "waiting",
      "answered",
      "degraded",
      "done",
      "stopped",
    ];
    for (const point of points) {
      const summary = summaryAt(point);
      expect(factoryRunCardModel(summary).status, point).toEqual(factoryRunLabel(shellOf(summary)));
    }
    expect(factoryRunCardModel(summaryAt("done")).live).toBe(false);
    expect(factoryRunCardModel(summaryAt("degraded")).live).toBe(false);
    expect(factoryRunCardModel(summaryAt("stopped")).live).toBe(false);
  });

  it("phase8 AC1 node display names capitalise the node and circle a pass number", () => {
    const names = [
      "fence",
      "implement",
      "checks-build",
      "repair",
      "verify-1",
      "review",
      "rework",
      "regression",
      "checks-harden",
      "verify-2",
      "commit",
    ].map(factoryNodeDisplayName);
    expect(names).toEqual([
      "Fence",
      "Implement",
      "Build checks",
      "Repair",
      "Verify ①",
      "Review",
      "Rework",
      "Regression",
      "Harden checks",
      "Verify ②",
      "Commit",
    ]);
    // A node the recorder may add later still reads as words.
    expect(factoryNodeDisplayName("gate")).toBe("Gate");
    expect(factoryNodeDisplayName("report-draft")).toBe("Report draft");
    expect(factoryNodeDisplayName("verify-3")).toBe("Verify ③");
  });
});
