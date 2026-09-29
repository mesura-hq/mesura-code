import type { FactoryRunState, FactoryRunStreamItem, ScopedThreadRef } from "@t3tools/contracts";
import { memo, useEffect, useState, type ReactNode } from "react";

import { Spinner } from "../components/ui/spinner";
import { cn } from "~/lib/utils";
import { FactoryCostFloor } from "./FactoryCostFloor";
import { FactoryNodeSpine } from "./FactoryNodeSpine";
import { FactoryPhaseRail } from "./FactoryPhaseRail";
import { FactoryRoleSessions } from "./FactoryRoleSessions";
import {
  deriveFactoryRunTotals,
  deriveFactoryRunView,
  type FactoryPhaseDetail,
  type FactoryRunView as FactoryRunViewModel,
} from "./factoryRunView.logic";
import { useFactoryRun } from "./useFactoryRun";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

/** The client clock, ticking once a second while `live`; frozen otherwise. */
function useSecondClock(live: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [live]);
  return nowMs;
}

/** Elapsed, waiting and cost. The only part of the tab that repaints with the clock. */
function FactoryRunTotalsLine({ state, live }: { state: FactoryRunState; live: boolean }) {
  const totals = deriveFactoryRunTotals(state, useSecondClock(live));
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
      <span>elapsed {totals.elapsed}</span>
      <span>waiting {totals.waiting}</span>
      <span>
        {totals.cost}
        {totals.costIsFloor ? <FactoryCostFloor /> : null}
      </span>
    </p>
  );
}

const exitClass = (exit: number) =>
  exit === 0 ? "text-success-foreground" : "text-destructive-foreground";

const FactoryPhaseRecord = memo(function FactoryPhaseRecord({
  detail,
}: {
  detail: FactoryPhaseDetail;
}) {
  return (
    <>
      {detail.verdicts.length === 0 ? null : (
        <Section title="Verdicts">
          <ul className="space-y-1 text-xs">
            {detail.verdicts.map((verdict) => (
              <li key={verdict.pass}>
                <span className="font-medium text-foreground">
                  {verdict.label} {verdict.verdict.replaceAll("_", " ")}
                </span>
                <span className="text-muted-foreground"> — {verdict.deciding}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {detail.findings.length === 0 ? null : (
        <Section title="Findings">
          <ul className="space-y-1 text-xs">
            {detail.findings.map((finding) => (
              <li key={finding.id}>
                <span className="font-mono text-foreground">{finding.id}</span>{" "}
                <span className="text-muted-foreground">{finding.severity}</span> {finding.title}
                <span className="text-muted-foreground">
                  {" "}
                  — {finding.disposition ?? "open"}
                  {finding.reason === null ? null : `: ${finding.reason}`}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {detail.checks.length === 0 ? null : (
        <Section title="Checks">
          <ul className="space-y-1 text-xs">
            {detail.checks.map((check) => (
              <li key={`${check.stage}:${check.at}`} className="flex flex-wrap gap-x-3">
                <span className="text-muted-foreground">{check.stage}</span>
                {check.results.map((result) => (
                  <span key={result.command} className="font-mono">
                    {result.command}{" "}
                    <span className={cn("tabular-nums", exitClass(result.exit))}>
                      exit {result.exit}
                    </span>
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {detail.deviations.length === 0 ? null : (
        <Section title="Deviations">
          <ul className="space-y-1 text-xs">
            {detail.deviations.map((deviation) => (
              <li key={`${deviation.kind}:${deviation.path}`}>
                <span className="font-mono text-foreground">{deviation.path}</span>{" "}
                <span className="text-muted-foreground">
                  {deviation.kind} — {deviation.reason}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {detail.degraded.length === 0 ? null : (
        <Section title="Degraded">
          <ul className="space-y-1 text-xs text-destructive-foreground">
            {detail.degraded.map((cause) => (
              <li key={cause}>{cause}</li>
            ))}
          </ul>
        </Section>
      )}
      {detail.commit === null ? null : (
        <Section title="Commit">
          <p className="text-xs">
            {"hash" in detail.commit ? (
              <>
                <span className="font-mono text-foreground">{detail.commit.hash}</span>{" "}
                {detail.commit.subject}
              </>
            ) : (
              <span className="text-destructive-foreground">blocked: {detail.commit.blocked}</span>
            )}
          </p>
        </Section>
      )}
    </>
  );
});

/**
 * The Run tab's model. Everything but the totals depends on the stream alone,
 * so it is derived when an item arrives or the reader picks a phase, never on
 * a clock tick. The previous model lends its unchanged rows, so a stream item
 * that moves one role re-renders only that role. React's pattern for keeping
 * a value from the previous render: compare during render, store in state.
 */
function useFactoryRunViewModel(
  item: FactoryRunStreamItem,
  selectedPhase: number | null,
): FactoryRunViewModel {
  const [derived, setDerived] = useState<{
    item: FactoryRunStreamItem;
    selectedPhase: number | null;
    view: FactoryRunViewModel;
  } | null>(null);
  if (derived !== null && derived.item === item && derived.selectedPhase === selectedPhase) {
    return derived.view;
  }
  const view = deriveFactoryRunView({
    item,
    selectedPhase,
    nowMs: 0,
    previous: derived?.view ?? null,
  });
  setDerived({ item, selectedPhase, view });
  return view;
}

function FactoryRunContent({
  item,
  threadRef,
  cwd,
}: {
  item: FactoryRunStreamItem;
  threadRef: ScopedThreadRef;
  cwd: string | undefined;
}) {
  const [selectedPhase, setSelectedPhase] = useState<number | null>(null);
  const view = useFactoryRunViewModel(item, selectedPhase);
  return (
    <div className="space-y-4 px-4 py-4">
      <FactoryRunTotalsLine state={item.state} live={view.live} />
      <FactoryPhaseRail items={view.rail} onSelect={setSelectedPhase} />
      {view.spine === null ? null : <FactoryNodeSpine spine={view.spine} />}
      <Section title="Role sessions">
        <FactoryRoleSessions rows={view.roles} threadRef={threadRef} cwd={cwd} />
      </Section>
      {view.detail === null ? null : <FactoryPhaseRecord detail={view.detail} />}
    </div>
  );
}

/**
 * The Factory pane's Run tab. Mounting it subscribes to the run's stream and
 * unmounting it ends the subscription, so the pane mounts it only while the
 * tab is the one shown and the panel is open.
 */
export default function FactoryRunView({
  threadRef,
  runId,
  cwd,
}: {
  threadRef: ScopedThreadRef;
  runId: string;
  cwd: string | undefined;
}) {
  const stream = useFactoryRun(threadRef, runId);
  if (stream.status === "loading") {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }
  if (stream.status === "failed") {
    return (
      <p className="px-4 py-6 text-center text-sm text-muted-foreground">
        The run's state could not be loaded.
      </p>
    );
  }
  return <FactoryRunContent item={stream.item} threadRef={threadRef} cwd={cwd} />;
}
