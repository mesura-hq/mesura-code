import { occurrenceKeys } from "@t3tools/client-runtime/factory/occurrence-keys";
import {
  factoryCriterionResultLabel,
  type FactoryReportSection,
  type FactoryReportView,
} from "@t3tools/client-runtime/factory/report-view";
import type { FactoryPhaseVerification } from "@t3tools/shared/factoryRun";
import { memo } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { FactoryCostFloor } from "./FactoryCostFloor";
import { ArchitectureBody, FactoryMarkdown, Fold } from "./FactoryPlanDocument";
import { FACTORY_TEXT_BY_TONE } from "./factoryTones";

const ERROR_TEXT = FACTORY_TEXT_BY_TONE.error;

function Heading(props: { readonly text: string }) {
  return (
    <Text accessibilityRole="header" className="font-t3-medium text-base text-foreground">
      {props.text}
    </Text>
  );
}

/** Elapsed, machine and waiting time, and the cost: all from the run, never from report.md. */
function ClockBand(props: { readonly view: FactoryReportView }) {
  const { view } = props;
  return (
    <View className="flex-row flex-wrap items-center gap-x-4 gap-y-1">
      <Text className="text-xs text-foreground-muted tabular-nums">{`elapsed ${view.clock.elapsed}`}</Text>
      <Text className="text-xs text-foreground-muted tabular-nums">{`machine ${view.clock.machine}`}</Text>
      <Text className="text-xs text-foreground-muted tabular-nums">{`waiting ${view.clock.waiting}`}</Text>
      <Text className="text-xs text-foreground-muted tabular-nums">{view.cost}</Text>
      {view.costIsFloor ? <FactoryCostFloor /> : null}
    </View>
  );
}

/** One block per phase: each criterion with its result and the authored-tests-only mark. */
function VerificationBlocks(props: {
  readonly verification: ReadonlyArray<FactoryPhaseVerification>;
}) {
  return (
    <View className="gap-3">
      {props.verification.map((phase) => (
        <View key={phase.phase} className="gap-1.5 rounded-2xl border border-border px-3 py-2.5">
          <Text
            className={cn("font-t3-medium text-sm text-foreground", phase.degraded && ERROR_TEXT)}
          >
            {`Phase ${phase.phase} · ${phase.title}${phase.degraded ? " · degraded" : ""}`}
          </Text>
          {phase.criteria.map((criterion) => {
            const result = factoryCriterionResultLabel(criterion.result);
            const mark = criterion.authoredTestsOnly ? ", authored tests only" : "";
            return (
              <View
                key={criterion.n}
                accessible
                accessibilityLabel={`Phase ${phase.phase}, criterion ${criterion.n}: ${result}${mark} — ${criterion.name}`}
                className="flex-row gap-2"
              >
                <Text className="min-w-5 text-xs text-foreground-muted tabular-nums">
                  {`${criterion.n}.`}
                </Text>
                <View className="min-w-0 flex-1 gap-0.5">
                  <Text className="text-xs text-foreground">{criterion.name}</Text>
                  <Text
                    className={cn(
                      "text-xs text-foreground-muted",
                      criterion.result === "FAIL" && ERROR_TEXT,
                    )}
                  >
                    {criterion.authoredTestsOnly ? `${result} · authored tests only` : result}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function SectionBody(props: {
  readonly section: FactoryReportSection;
  readonly view: FactoryReportView;
}) {
  const { section, view } = props;
  if (section.kind === "architecture") return <ArchitectureBody architecture={section} />;
  if (section.kind === "verification") {
    // The derived blocks first, then the author's comment on what they cannot show.
    return (
      <>
        <VerificationBlocks verification={view.verification} />
        {section.body === null ? null : <FactoryMarkdown text={section.body} />}
      </>
    );
  }
  return <FactoryMarkdown text={section.body} />;
}

/** The step record: one fold per phase, all closed until the reader opens one. */
function StepRecord(props: { readonly view: FactoryReportView }) {
  return (
    <View className="gap-2">
      <Heading text="The run, step by step" />
      {props.view.steps.map((phase) => {
        const lineKeys = occurrenceKeys(phase.lines.map((line) => line.text));
        return (
          <Fold
            key={phase.phase}
            summary={
              <Text
                className={cn(
                  "min-w-0 flex-1 text-sm text-foreground",
                  phase.degraded && ERROR_TEXT,
                )}
              >
                {`Phase ${phase.phase} · ${phase.title}`}
              </Text>
            }
          >
            <View className="gap-1">
              {phase.lines.map((line, index) => (
                <Text
                  key={lineKeys[index]}
                  className={cn("text-xs text-foreground", line.error && ERROR_TEXT)}
                >
                  {line.text}
                </Text>
              ))}
            </View>
          </Fold>
        );
      })}
    </View>
  );
}

/**
 * A whole report, the same model the web's Report tab renders: the clock
 * band, the authored sections in the contract's order with the verification
 * blocks inside How it was verified, and the step record folded. Only a
 * degraded phase, a failed result, a red check and an unrepaired finding take
 * the error tone.
 */
export const FactoryReportDocument = memo(function FactoryReportDocument(props: {
  readonly view: FactoryReportView;
}) {
  const { view } = props;
  const sectionKeys = occurrenceKeys(view.sections.map((section) => section.heading));
  return (
    <View className="gap-6">
      <View className="gap-1.5">
        <Text accessibilityRole="header" className="font-t3-bold text-lg text-foreground">
          {view.title || "Report"}
        </Text>
        <ClockBand view={view} />
      </View>
      {view.missingNotice === null ? null : (
        <View className="rounded-lg border border-border px-3 py-2">
          <Text className="text-xs text-foreground-muted">{view.missingNotice}</Text>
        </View>
      )}
      {view.sections.map((section, index) => (
        <View key={sectionKeys[index]} className="gap-2">
          <Heading text={section.heading} />
          <SectionBody section={section} view={view} />
        </View>
      ))}
      <StepRecord view={view} />
    </View>
  );
});
