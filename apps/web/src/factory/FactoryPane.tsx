import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { Spinner } from "../components/ui/spinner";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import {
  useRightPanelStore,
  type FactoryPanelTab,
  type RightPanelSurface,
} from "../rightPanelStore";
import {
  findFactoryReportItem,
  type FactoryPlanTimelineItem,
  type FactoryReportTimelineItem,
  type FactoryTimelineItem,
} from "@t3tools/client-runtime/factory/plan-activities";
import { deriveFactoryReportView } from "@t3tools/client-runtime/factory/report-view";
import { splitFactoryDocument } from "@t3tools/shared/factoryDocument";
import { useMemo } from "react";
import { FactoryPlanDocument } from "./FactoryPlanDocument";
import { FactoryReportDocument } from "./FactoryReportDocument";
import FactoryRunView from "./FactoryRunView";
import { useFactoryRun } from "./useFactoryRun";
import { useFactorySnapshot } from "./useFactorySnapshot";

type FactorySurface = Extract<RightPanelSurface, { kind: "factory" }>;

const FACTORY_TABS = [
  { value: "plan", label: "Plan" },
  { value: "run", label: "Run" },
  { value: "report", label: "Report" },
] as const satisfies ReadonlyArray<{ value: FactoryPanelTab; label: string }>;

const isFactoryPanelTab = (value: unknown): value is FactoryPanelTab =>
  FACTORY_TABS.some((tab) => tab.value === value);

function PaneMessage({ children }: { children: string }) {
  return <p className="px-4 py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

function FactoryPlanTab({
  plan,
  environmentId,
  cwd,
}: {
  plan: FactoryPlanTimelineItem;
  environmentId: EnvironmentId;
  cwd: string | undefined;
}) {
  const snapshot = useFactorySnapshot(environmentId, plan.plan.digest);
  if (snapshot.status === "loading") return <PaneSpinner />;
  if (snapshot.status === "failed") {
    return <PaneMessage>The plan's text could not be loaded.</PaneMessage>;
  }
  return (
    <FactoryPlanDocument markdown={snapshot.markdown} environmentId={environmentId} cwd={cwd} />
  );
}

function PaneSpinner() {
  return (
    <div className="flex justify-center py-8">
      <Spinner />
    </div>
  );
}

/**
 * A run's report: its prose from the snapshot by digest, its frame from the
 * run stream, which this tab holds open only while it is visible.
 */
function FactoryReportTab({
  report,
  threadRef,
  cwd,
}: {
  report: FactoryReportTimelineItem;
  threadRef: ScopedThreadRef;
  cwd: string | undefined;
}) {
  const snapshot = useFactorySnapshot(threadRef.environmentId, report.report.digest);
  const stream = useFactoryRun(threadRef, report.report.runId);
  const markdown = snapshot.status === "ready" ? snapshot.markdown : null;
  const state = stream.status === "ready" ? stream.item.state : null;
  const document = useMemo(
    () => (markdown === null ? null : splitFactoryDocument(markdown)),
    [markdown],
  );
  const view = useMemo(
    () =>
      document === null || state === null
        ? null
        : deriveFactoryReportView({ report: document, state }),
    [document, state],
  );
  if (snapshot.status === "failed") {
    return <PaneMessage>The report's text could not be loaded.</PaneMessage>;
  }
  if (stream.status === "failed" && state === null) {
    return <PaneMessage>The run's record could not be loaded.</PaneMessage>;
  }
  if (view === null) return <PaneSpinner />;
  return <FactoryReportDocument view={view} environmentId={threadRef.environmentId} cwd={cwd} />;
}

/**
 * The Software Factory surface of the right panel. It opens only from a card's
 * Open, never by itself. The Plan tab shows the plan that card named — or,
 * when none is named, the thread's latest — the Run tab the run it named,
 * or the thread's latest run, and the Report tab that run's report.
 */
export default function FactoryPane({
  surface,
  factoryItems,
  latestRunId,
  threadRef,
  visible,
  cwd,
}: {
  surface: FactorySurface;
  /** The thread's plan and report cards. */
  factoryItems: ReadonlyArray<FactoryTimelineItem>;
  /** The run of the thread's run card, for a pane opened without one. */
  latestRunId: string | null;
  threadRef: ScopedThreadRef;
  /** The right panel is open. A hidden pane keeps no run subscription. */
  visible: boolean;
  cwd: string | undefined;
}) {
  const factoryPlans = factoryItems.filter(
    (item): item is FactoryPlanTimelineItem => item.kind === "plan",
  );
  const plan =
    (surface.planId === null
      ? undefined
      : factoryPlans.find((item) => item.id === surface.planId)) ?? factoryPlans.at(-1);
  const runId = surface.runId ?? latestRunId;
  const report = findFactoryReportItem(factoryItems, runId);
  const tabEnabled = (tab: FactoryPanelTab) =>
    tab === "plan" || (tab === "run" && runId !== null) || (tab === "report" && report !== null);
  const selectTab = (tab: FactoryPanelTab) =>
    useRightPanelStore
      .getState()
      .openFactory(threadRef, { tab, planId: surface.planId, runId: surface.runId });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav
        className="flex shrink-0 items-center gap-1 border-b border-border/60 px-4 py-2"
        aria-label="Factory tabs"
      >
        <ToggleGroup
          size="segmented"
          variant="segmented"
          value={[surface.tab]}
          onValueChange={(value) => {
            const next = value[0];
            if (isFactoryPanelTab(next) && tabEnabled(next)) selectTab(next);
          }}
        >
          {FACTORY_TABS.map((tab) => (
            <Toggle key={tab.value} value={tab.value} disabled={!tabEnabled(tab.value)}>
              {tab.label}
            </Toggle>
          ))}
        </ToggleGroup>
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {surface.tab === "report" ? (
          report === null ? (
            <PaneMessage>This run has not written its report yet.</PaneMessage>
          ) : visible ? (
            <FactoryReportTab key={report.id} report={report} threadRef={threadRef} cwd={cwd} />
          ) : null
        ) : surface.tab === "run" ? (
          runId === null ? (
            <PaneMessage>No run is attached to this thread.</PaneMessage>
          ) : visible ? (
            <FactoryRunView key={runId} threadRef={threadRef} runId={runId} cwd={cwd} />
          ) : null
        ) : plan ? (
          <FactoryPlanTab
            key={plan.plan.digest}
            plan={plan}
            environmentId={threadRef.environmentId}
            cwd={cwd}
          />
        ) : (
          <PaneMessage>No plan has been presented in this thread.</PaneMessage>
        )}
      </div>
    </div>
  );
}
