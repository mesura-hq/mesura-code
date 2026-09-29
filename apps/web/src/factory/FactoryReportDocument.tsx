import type { EnvironmentId } from "@t3tools/contracts";
import {
  factoryCriterionResultLabel,
  type FactoryReportSection,
  type FactoryReportView,
} from "@t3tools/client-runtime/factory/report-view";
import { occurrenceKeys } from "@t3tools/client-runtime/factory/occurrence-keys";
import type { FactoryPhaseVerification } from "@t3tools/shared/factoryRun";
import { memo, useMemo } from "react";

import { useTheme } from "../hooks/useTheme";
import { cn } from "~/lib/utils";
import { FactoryCostFloor } from "./FactoryCostFloor";
import { ArchitectureBody, Fold, Markdown, type MarkdownScope } from "./FactoryPlanDocument";

const ERROR_TEXT = "text-destructive-foreground";

/** Elapsed, machine and waiting time, and the cost: all from the run, never from report.md. */
function ClockBand({ view }: { view: FactoryReportView }) {
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
      <span>elapsed {view.clock.elapsed}</span>
      <span>machine {view.clock.machine}</span>
      <span>waiting {view.clock.waiting}</span>
      <span>
        {view.cost}
        {view.costIsFloor ? <FactoryCostFloor /> : null}
      </span>
    </p>
  );
}

/** One row per criterion, grouped by phase; the result and the authored-tests-only mark. */
function VerificationTable({
  verification,
}: {
  verification: ReadonlyArray<FactoryPhaseVerification>;
}) {
  return (
    <table className="w-full border-collapse text-left text-xs">
      <tbody>
        {verification.map((phase) => (
          <PhaseRows key={phase.phase} phase={phase} />
        ))}
      </tbody>
    </table>
  );
}

function PhaseRows({ phase }: { phase: FactoryPhaseVerification }) {
  return (
    <>
      <tr className="border-b border-border/60">
        <th
          colSpan={3}
          scope="colgroup"
          className={cn("pt-3 pb-1 font-medium text-foreground", phase.degraded && ERROR_TEXT)}
        >
          Phase {phase.phase} · {phase.title}
          {phase.degraded ? " · degraded" : null}
        </th>
      </tr>
      {phase.criteria.map((criterion) => (
        <tr key={criterion.n} className="border-b border-border/30 align-top">
          <td className="py-1 pr-2 text-muted-foreground tabular-nums">{criterion.n}</td>
          <td className="py-1 pr-2 text-foreground/90">{criterion.name}</td>
          <td
            className={cn(
              "py-1 whitespace-nowrap text-muted-foreground",
              criterion.result === "FAIL" && ERROR_TEXT,
            )}
          >
            {factoryCriterionResultLabel(criterion.result)}
            {criterion.authoredTestsOnly ? (
              <span className="ml-1.5 rounded-sm border border-border/70 px-1">
                authored tests only
              </span>
            ) : null}
          </td>
        </tr>
      ))}
    </>
  );
}

function SectionBody({
  section,
  view,
  scope,
  theme,
}: {
  section: FactoryReportSection;
  view: FactoryReportView;
  scope: MarkdownScope;
  theme: "light" | "dark";
}) {
  if (section.kind === "architecture") {
    return <ArchitectureBody architecture={section} scope={scope} theme={theme} />;
  }
  if (section.kind === "verification") {
    // The derived table first, then the author's comment on what it cannot show.
    return (
      <>
        <VerificationTable verification={view.verification} />
        {section.body === null ? null : <Markdown text={section.body} scope={scope} />}
      </>
    );
  }
  return <Markdown text={section.body} scope={scope} />;
}

/** The step record: one fold per phase, all closed until the reader opens one. */
function StepRecord({ view }: { view: FactoryReportView }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-base font-medium text-foreground">The run, step by step</h2>
      {view.steps.map((phase) => {
        const lineKeys = occurrenceKeys(phase.lines.map((line) => line.text));
        return (
          <Fold
            key={phase.phase}
            summary={
              <span className={cn(phase.degraded && ERROR_TEXT)}>
                Phase {phase.phase} · {phase.title}
              </span>
            }
          >
            <ol className="flex flex-col gap-0.5 text-xs text-foreground/80">
              {phase.lines.map((line, index) => (
                <li key={lineKeys[index]} className={cn(line.error && ERROR_TEXT)}>
                  {line.text}
                </li>
              ))}
            </ol>
          </Fold>
        );
      })}
    </section>
  );
}

/**
 * A whole report: the clock band, the authored sections in the contract's
 * order with the verification table inside How it was verified, and the step
 * record. Only a degraded phase, a failed result, a red check and an
 * unrepaired finding take the error tone.
 */
export const FactoryReportDocument = memo(function FactoryReportDocument({
  view,
  environmentId,
  cwd,
}: {
  view: FactoryReportView;
  environmentId: EnvironmentId;
  cwd: string | undefined;
}) {
  const { resolvedTheme } = useTheme();
  const scope = useMemo(() => ({ environmentId, cwd }), [environmentId, cwd]);
  const sectionKeys = occurrenceKeys(view.sections.map((section) => section.heading));

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-5">
      <header className="flex flex-col gap-1.5">
        <h2 className="text-lg font-semibold text-foreground">{view.title || "Report"}</h2>
        <ClockBand view={view} />
      </header>
      {view.missingNotice === null ? null : (
        <p className="rounded-lg border border-border/70 px-3 py-2 text-xs text-muted-foreground">
          {view.missingNotice}
        </p>
      )}
      {view.sections.map((section, index) => (
        <section key={sectionKeys[index]} className="flex flex-col gap-2">
          <h2 className="text-base font-medium text-foreground">{section.heading}</h2>
          <SectionBody section={section} view={view} scope={scope} theme={resolvedTheme} />
        </section>
      ))}
      <StepRecord view={view} />
    </div>
  );
});
