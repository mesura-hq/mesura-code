/**
 * Phase 2 fence, acceptance criteria 1 (the card's content) and 4 (the
 * Factory pane's sections).
 *
 * Entry point: the pure models `FactoryPlanCard` and `FactoryPlanDocument`
 * render from, fed with the plan this feature was planned in
 * (`packages/shared/src/fixtures/factory-in-chat.plan.md`). What only a browser
 * shows: the card frame, the skeleton while the Context body loads over
 * `factoryReadSnapshot`, file chips, and each `Collapsible` starting closed.
 * Which sections exist, in which order, what each phase card and decision
 * holds, and which sections are folded, is decided here.
 */
/// <reference types="vite-plus/client" />
import { splitFactoryDocument } from "@t3tools/shared/factoryDocument";
import { describe, expect, it } from "vite-plus/test";

import planMarkdown from "../../../shared/src/fixtures/factory-in-chat.plan.md?raw";
import {
  deriveFactoryPlanDocumentModel,
  readFactoryPlanContext,
  summarizeFactoryPlanCard,
} from "./planModel.ts";
import { makeFactoryPlanPayload } from "./testing.ts";

describe("factory plan card content (phase 2 fence)", () => {
  it("summarizes the plan card with its title, phase count and one line per phase", () => {
    const summary = summarizeFactoryPlanCard(makeFactoryPlanPayload());

    expect(summary).toEqual({
      title: "Plan: the Software Factory inside Mesura Code",
      phaseCountLabel: "2 phases",
      phaseLines: [
        "Snapshot a plan and present it to the thread · 7 criteria",
        "Render the plan card and the Factory pane on the web · 6 criteria",
      ],
    });
    expect(
      summarizeFactoryPlanCard(
        makeFactoryPlanPayload({ phases: [{ title: "Only phase", acceptanceCount: 1 }] }),
      ),
    ).toMatchObject({ phaseCountLabel: "1 phase", phaseLines: ["Only phase · 1 criterion"] });
  });

  it("reads the Context section the plan card shows inline", () => {
    const context = readFactoryPlanContext(planMarkdown);

    expect(context).toContain("Mesura Code is the app the developer uses every day");
    expect(context).toContain("All of it works on the desktop and on the phone.");
    // Nothing heavier than the Context section renders inline.
    expect(context).not.toContain("## Current state");
    expect(readFactoryPlanContext("# A plan\n\n## The phases\n\n```json\n[]\n```\n")).toBeNull();
  });
});

describe("factory plan pane sections (phase 2 fence)", () => {
  const document = deriveFactoryPlanDocumentModel(planMarkdown);

  it("renders every plan section in document order and states the section count", () => {
    const headings = splitFactoryDocument(planMarkdown).sections.map((section) => section.heading);

    expect(document.title).toBe("Plan: the Software Factory inside Mesura Code");
    expect(document.sections.map((section) => section.heading)).toEqual(headings);
    expect(document.sectionCount).toBe(13);
  });

  it("keeps a section it does not know as plain markdown in its place", () => {
    const withUnknown = deriveFactoryPlanDocumentModel(
      planMarkdown.replace("## Risks\n", "## Rollout\n\nShip it on a Tuesday.\n\n## Risks\n"),
    );

    expect(withUnknown.sectionCount).toBe(14);
    const index = withUnknown.sections.findIndex((section) => section.heading === "Rollout");
    expect(withUnknown.sections[index + 1]?.heading).toBe("Risks");
    expect(withUnknown.sections[index]).toMatchObject({
      kind: "markdown",
      folded: false,
      body: expect.stringContaining("Ship it on a Tuesday."),
    });
  });

  it("draws each phase as a card with goal, files, numbered criteria and its detail", () => {
    const phases = document.sections.find((section) => section.kind === "phases");
    if (phases?.kind !== "phases") throw new Error("The phases section is not a phase list");

    expect(phases.heading).toBe("The phases");
    expect(phases.phases).toHaveLength(11);
    const phaseTwo = phases.phases[1]!;
    expect(phaseTwo.number).toBe(2);
    expect(phaseTwo.title).toBe("Render the plan card and the Factory pane on the web");
    expect(phaseTwo.goal).toMatch(/^A presented plan shows as a card in the web timeline/);
    expect(phaseTwo.files).toContain("apps/web/src/factory/FactoryPane.tsx");
    expect(phaseTwo.acceptance).toHaveLength(6);
    expect(phaseTwo.acceptance[0]).toMatch(/^A `factory\.plan` activity renders as a plan card/);
    // The reference level is folded behind the card, never dropped.
    expect(phaseTwo.detail).toMatch(/^\*\*Shared client pieces/);
  });

  it("falls back to the section's markdown when its phase list does not parse", () => {
    const broken = deriveFactoryPlanDocumentModel(
      "# Broken plan\n\n## Context\n\nWhy.\n\n## The phases\n\n```json\n[{\n```\n",
    );

    expect(broken.sectionCount).toBe(2);
    expect(broken.sections[1]).toMatchObject({ kind: "markdown", heading: "The phases" });
  });

  it("shows each decision's verdict line with its argument folded apart", () => {
    const decisions = document.sections.find((section) => section.kind === "decisions");
    if (decisions?.kind !== "decisions") throw new Error("Decisions is not a decision list");

    expect(decisions.decisions).toHaveLength(12);
    expect(decisions.decisions[0]).toEqual({
      verdict: "The events file is the run's only record, and `ledger.md` is generated from it.",
      argument: expect.stringMatching(/^The coordinator used to edit `ledger\.md` by hand\./),
    });
    expect(decisions.decisions[0]?.argument).not.toContain("Document bodies are fetched");
  });

  it("shows a Decisions section with no verdict line as plain markdown instead of dropping it", () => {
    const withoutVerdicts = deriveFactoryPlanDocumentModel(
      "# Plan\n\n## Decisions\n\n- a list\n- with no verdict line\n",
    );

    expect(withoutVerdicts.sections).toEqual([
      {
        kind: "markdown",
        heading: "Decisions",
        body: "- a list\n- with no verdict line",
        folded: false,
      },
    ]);
  });

  it("folds the agreed design and the reading list, and leaves the other sections open", () => {
    const foldedHeadings = document.sections.flatMap((section) =>
      section.kind === "markdown" && section.folded ? [section.heading] : [],
    );

    expect(foldedHeadings).toEqual(["The design we agreed", "What I read before planning"]);
  });

  it("splits the architecture section into its diagram, its reading and its legend", () => {
    const architecture = document.sections.find((section) => section.kind === "architecture");
    if (architecture?.kind !== "architecture") throw new Error("Architecture has no diagram");

    expect(architecture.diagram).toMatch(/^flowchart LR\n/);
    expect(architecture.diagram).toContain("classDef changed");
    expect(architecture.body).toContain("The arrows follow information from the skills");
    expect(architecture.body).toContain("Legend: highlighted boxes are new or changed");
    expect(architecture.body).not.toContain("```");
    expect(architecture.body).not.toContain("- `SP` —");
    expect(architecture.legend.map((entry) => entry.id)).toEqual([
      "SP",
      "ST",
      "RC",
      "EV",
      "MCP",
      "SNAP",
      "TR",
      "PANE",
    ]);
    expect(architecture.legend[0]).toEqual({
      id: "SP",
      text: "the planning skill, which presents the plan and accepts the Approve message",
    });
  });
});
