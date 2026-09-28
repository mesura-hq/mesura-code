// @effect-diagnostics nodeBuiltinImport:off - the test reads a plan fixture from disk.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { readFactoryPhases, splitFactoryDocument } from "./factoryDocument.ts";

// A plan exactly as the planning skill wrote it; the formatter skips the fixtures directory.
const factoryInChatPlan = NodeFS.readFileSync(
  new URL("./fixtures/factory-in-chat.plan.md", import.meta.url),
  "utf8",
);

const FACTORY_IN_CHAT_HEADINGS = [
  "Context",
  "Current state",
  "What we will build",
  "What we will NOT build",
  "The design we agreed",
  "How, in outline",
  "Done when",
  "The phases",
  "Architecture",
  "Open questions",
  "Risks",
  "Decisions",
  "What I read before planning",
];

/** A small plan in the heading contract, with `## ` lines hidden inside fenced blocks. */
function syntheticPlan(options: { readonly phasesFence?: string } = {}): string {
  const phasesFence =
    options.phasesFence ??
    [
      "```json",
      JSON.stringify(
        [
          {
            title: "First phase",
            goal: "Do the first thing.",
            files: ["a.ts"],
            acceptance: ["one", "two"],
            detail: "## looks like a heading inside a JSON string",
          },
          {
            title: "Second phase",
            goal: "Do the second thing.",
            files: [],
            acceptance: ["three"],
            validationSuggested: "A person has to look at it.",
            detail: "More detail.",
          },
        ],
        null,
        2,
      ),
      "```",
    ].join("\n");
  return [
    "# Plan: a synthetic plan",
    "",
    "## Context",
    "",
    "Some context.",
    "",
    "```md",
    "## Not a heading, inside a backtick fence",
    "```",
    "",
    "## A heading no contract knows",
    "",
    "~~~",
    "## Not a heading, inside a tilde fence",
    "~~~",
    "",
    "## The phases",
    "",
    phasesFence,
    "",
    "## Decisions",
    "",
    "Decided.",
    "",
  ].join("\n");
}

describe("splitFactoryDocument", () => {
  it("reads the title and keeps every level-two section of a real plan in document order", () => {
    const document = splitFactoryDocument(factoryInChatPlan);
    expect(document.title).toBe("Plan: the Software Factory inside Mesura Code");
    expect(document.sections.map((section) => section.heading)).toEqual(FACTORY_IN_CHAT_HEADINGS);
    const context = document.sections[0];
    expect(context?.body.trim().startsWith("Mesura Code is the app the developer uses")).toBe(true);
    expect(context?.body).not.toContain("## Context");
  });

  it("keeps a heading it does not know and ignores `## ` lines inside ``` and ~~~ fences", () => {
    const document = splitFactoryDocument(syntheticPlan());
    expect(document.title).toBe("Plan: a synthetic plan");
    expect(document.sections.map((section) => section.heading)).toEqual([
      "Context",
      "A heading no contract knows",
      "The phases",
      "Decisions",
    ]);
    expect(document.sections[0]?.body).toContain("## Not a heading, inside a backtick fence");
    expect(document.sections[1]?.body).toContain("## Not a heading, inside a tilde fence");
  });

  it("does not split a plan whose phases json fence holds a `## ` line", () => {
    const document = splitFactoryDocument(
      syntheticPlan({
        phasesFence: ["```json", "## inside the json fence", "[]", "```"].join("\n"),
      }),
    );
    expect(document.sections.map((section) => section.heading)).toEqual([
      "Context",
      "A heading no contract knows",
      "The phases",
      "Decisions",
    ]);
    expect(document.sections[2]?.body).toContain("## inside the json fence");
  });
});

describe("readFactoryPhases", () => {
  it("reads the eleven phases of a real plan with their fields", () => {
    const result = readFactoryPhases(splitFactoryDocument(factoryInChatPlan).sections);
    if (!result.ok) throw new Error(`expected phases, got: ${result.reason}`);
    expect(result.phases).toHaveLength(11);
    const [first, second] = result.phases;
    expect(first?.title).toBe("Snapshot a plan and present it to the thread");
    expect(first?.acceptance).toHaveLength(8);
    expect(first?.files).toContain("packages/contracts/src/factory.ts");
    expect(first?.goal).toContain("present_plan");
    expect(first?.detail).toContain("**Contracts.**");
    expect(second?.validationSuggested).toContain("Feature parity with plan.html");
  });

  it("reads the phases of a synthetic plan and keeps validationSuggested only when present", () => {
    const result = readFactoryPhases(splitFactoryDocument(syntheticPlan()).sections);
    if (!result.ok) throw new Error(`expected phases, got: ${result.reason}`);
    expect(result.phases.map((phase) => [phase.title, phase.acceptance.length])).toEqual([
      ["First phase", 2],
      ["Second phase", 1],
    ]);
    expect(result.phases[0]?.validationSuggested).toBeUndefined();
    expect(result.phases[1]?.validationSuggested).toBe("A person has to look at it.");
  });

  it("reports why a phase block does not parse instead of throwing", () => {
    const withoutPhases = readFactoryPhases(
      splitFactoryDocument("# Plan: none\n\n## Context\n\nNo phases here.\n").sections,
    );
    expect(withoutPhases.ok).toBe(false);

    const withoutFence = readFactoryPhases(
      splitFactoryDocument(syntheticPlan({ phasesFence: "Just prose, no fence." })).sections,
    );
    expect(withoutFence.ok).toBe(false);

    const brokenJson = readFactoryPhases(
      splitFactoryDocument(
        syntheticPlan({
          phasesFence: ["```json", "## inside the json fence", "[]", "```"].join("\n"),
        }),
      ).sections,
    );
    expect(brokenJson.ok).toBe(false);

    const notAList = readFactoryPhases(
      splitFactoryDocument(
        syntheticPlan({
          phasesFence: ["```json", '{ "title": "x" }', "```"].join("\n"),
        }),
      ).sections,
    );
    expect(notAList.ok).toBe(false);

    for (const result of [withoutPhases, withoutFence, brokenJson, notAList]) {
      if (result.ok) continue;
      expect(result.reason.trim().length).toBeGreaterThan(0);
    }
  });
});
