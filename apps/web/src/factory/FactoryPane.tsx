import type { EnvironmentId } from "@t3tools/contracts";

import { Spinner } from "../components/ui/spinner";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import type { RightPanelSurface } from "../rightPanelStore";
import type { FactoryPlanTimelineItem } from "@t3tools/client-runtime/factory/plan-activities";
import { FactoryPlanDocument } from "./FactoryPlanDocument";
import { useFactorySnapshot } from "./useFactorySnapshot";

type FactorySurface = Extract<RightPanelSurface, { kind: "factory" }>;

// Run and Report arrive with the run tracker; the tabs are here so the pane's
// shape does not move when they do.
const FACTORY_TABS = [
  { value: "plan", label: "Plan", enabled: true },
  { value: "run", label: "Run", enabled: false },
  { value: "report", label: "Report", enabled: false },
] as const;

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
  if (snapshot.status === "loading") {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }
  if (snapshot.status === "failed") {
    return <PaneMessage>The plan's text could not be loaded.</PaneMessage>;
  }
  return (
    <FactoryPlanDocument markdown={snapshot.markdown} environmentId={environmentId} cwd={cwd} />
  );
}

/**
 * The Software Factory surface of the right panel. It opens only from a card's
 * Open, never by itself, and shows the plan that card named — or, when none
 * is named, the thread's latest.
 */
export default function FactoryPane({
  surface,
  factoryPlans,
  environmentId,
  cwd,
}: {
  surface: FactorySurface;
  factoryPlans: ReadonlyArray<FactoryPlanTimelineItem>;
  environmentId: EnvironmentId;
  cwd: string | undefined;
}) {
  const plan =
    (surface.planId === null
      ? undefined
      : factoryPlans.find((item) => item.id === surface.planId)) ?? factoryPlans.at(-1);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav
        className="flex shrink-0 items-center gap-1 border-b border-border/60 px-4 py-2"
        aria-label="Factory tabs"
      >
        <ToggleGroup size="segmented" variant="segmented" value={["plan"]}>
          {FACTORY_TABS.map((tab) => (
            <Toggle key={tab.value} value={tab.value} disabled={!tab.enabled}>
              {tab.label}
            </Toggle>
          ))}
        </ToggleGroup>
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {plan ? (
          <FactoryPlanTab
            key={plan.plan.digest}
            plan={plan}
            environmentId={environmentId}
            cwd={cwd}
          />
        ) : (
          <PaneMessage>No plan has been presented in this thread.</PaneMessage>
        )}
      </div>
    </div>
  );
}
