/**
 * What the plan card and the Factory pane render from a plan: pure, so the
 * components stay dumb. The pane never drops a section — it knows the few it
 * draws specially and renders every other one as plain markdown, in order.
 */
import type { FactoryPlanActivityPayload } from "@t3tools/contracts";
import {
  FACTORY_PHASES_HEADING,
  readFactoryPhases,
  splitFactoryArchitecture,
  splitFactoryDecisions,
  splitFactoryDocument,
  type FactoryDecision,
  type FactoryLegendEntry,
} from "@t3tools/shared/factoryDocument";

const FACTORY_CONTEXT_HEADING = "Context";
const FACTORY_DECISIONS_HEADING = "Decisions";
const FACTORY_ARCHITECTURE_HEADING = "Architecture";
/** Long and settled: shown folded, never dropped. */
const FOLDED_HEADINGS: ReadonlySet<string> = new Set([
  "The design we agreed",
  "What I read before planning",
]);

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export interface FactoryPlanCardSummary {
  readonly title: string;
  readonly phaseCountLabel: string;
  readonly phaseLines: ReadonlyArray<string>;
}

export function summarizeFactoryPlanCard(plan: FactoryPlanActivityPayload): FactoryPlanCardSummary {
  return {
    title: plan.title,
    phaseCountLabel: plural(plan.phases.length, "phase", "phases"),
    phaseLines: plan.phases.map(
      (phase) => `${phase.title} · ${plural(phase.acceptanceCount, "criterion", "criteria")}`,
    ),
  };
}

/** The Context section's body, the only section the card renders inline. */
export function readFactoryPlanContext(markdown: string): string | null {
  const section = splitFactoryDocument(markdown).sections.find(
    (entry) => entry.heading === FACTORY_CONTEXT_HEADING,
  );
  return section === undefined ? null : section.body.trim();
}

export interface FactoryPlanPhaseCard {
  readonly number: number;
  readonly title: string;
  readonly goal?: string;
  readonly files: ReadonlyArray<string>;
  readonly acceptance: ReadonlyArray<string>;
  readonly detail?: string;
}

export type FactoryPlanSectionModel =
  | {
      readonly kind: "markdown";
      readonly heading: string;
      readonly body: string;
      readonly folded: boolean;
    }
  | {
      readonly kind: "phases";
      readonly heading: string;
      readonly phases: ReadonlyArray<FactoryPlanPhaseCard>;
    }
  | {
      readonly kind: "decisions";
      readonly heading: string;
      readonly decisions: ReadonlyArray<FactoryDecision>;
    }
  | {
      readonly kind: "architecture";
      readonly heading: string;
      readonly diagram: string | null;
      readonly body: string;
      readonly legend: ReadonlyArray<FactoryLegendEntry>;
    };

export interface FactoryPlanDocumentModel {
  readonly title: string;
  readonly sectionCount: number;
  readonly sections: ReadonlyArray<FactoryPlanSectionModel>;
}

function sectionModel(heading: string, body: string): FactoryPlanSectionModel {
  const markdown: FactoryPlanSectionModel = {
    kind: "markdown",
    heading,
    body: body.trim(),
    folded: FOLDED_HEADINGS.has(heading),
  };
  switch (heading) {
    case FACTORY_PHASES_HEADING: {
      const result = readFactoryPhases([{ heading, body }]);
      if (!result.ok) return markdown;
      return {
        kind: "phases",
        heading,
        phases: result.phases.map((phase, index) => ({
          number: index + 1,
          title: phase.title,
          files: phase.files,
          acceptance: phase.acceptance,
          ...(phase.goal === undefined ? {} : { goal: phase.goal }),
          ...(phase.detail === undefined ? {} : { detail: phase.detail }),
        })),
      };
    }
    case FACTORY_DECISIONS_HEADING: {
      const decisions = splitFactoryDecisions(body);
      return decisions.length === 0 ? markdown : { kind: "decisions", heading, decisions };
    }
    case FACTORY_ARCHITECTURE_HEADING:
      return { kind: "architecture", heading, ...splitFactoryArchitecture(body) };
    default:
      return markdown;
  }
}

export function deriveFactoryPlanDocumentModel(markdown: string): FactoryPlanDocumentModel {
  const document = splitFactoryDocument(markdown);
  const sections = document.sections.map((section) => sectionModel(section.heading, section.body));
  return { title: document.title, sectionCount: sections.length, sections };
}
