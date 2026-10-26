import { useAtomValue } from "@effect/atom-react";
import type { FactoryRunUsageProvider, ScopedThreadRef } from "@t3tools/contracts";
import { readFactoryRunUsageState } from "@t3tools/client-runtime/state/factory";
import { factoryTraceUsdText } from "@t3tools/shared/factoryRunTrace";
import { memo } from "react";

import { Badge } from "../components/ui/badge";
import { Skeleton } from "../components/ui/skeleton";
import { factoryEnvironment } from "../state/factory";

const PROVIDER_NAMES: Record<FactoryRunUsageProvider["provider"], string> = {
  claude: "Claude",
  codex: "Codex",
};

const WINDOW_NAMES: Record<string, string> = {
  five_hour: "5-hour limit",
  seven_day: "weekly limit",
};

const windowName = (window: string) => WINDOW_NAMES[window] ?? `${window} limit`;

const percentText = (percent: number) =>
  `${percent < 10 ? percent.toFixed(1).replace(/\.0$/, "") : Math.round(percent)}%`;

/**
 * The spends the share compares: over the readings' span when there is an
 * estimate, otherwise over the whole run.
 */
function spendText(usage: FactoryRunUsageProvider) {
  if (usage.estimate !== null) {
    return ` · in that span the run spent ${factoryTraceUsdText(usage.estimate.runSpendUsd)} of the ${factoryTraceUsdText(usage.estimate.machineSpendUsd)} this machine spent, at list price`;
  }
  if (usage.runSpendUsd === null) return null;
  return ` · run ${factoryTraceUsdText(usage.runSpendUsd)}${usage.machineSpendUsd === null ? "" : ` of ${factoryTraceUsdText(usage.machineSpendUsd)} this machine spent`} at list price`;
}

/** Bars span 0 to this many points, so one run reads at a glance. */
const BAR_SCALE_PERCENT = 10;

function ProviderRow({ usage }: { usage: FactoryRunUsageProvider }) {
  const target =
    usage.windows.find((window) => window.window === usage.estimate?.window) ??
    usage.windows.find((window) => window.window === "seven_day") ??
    usage.windows[0];
  const name = PROVIDER_NAMES[usage.provider];
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
        <span className="text-foreground">
          {name}
          {target === undefined ? null : (
            <span className="text-muted-foreground"> · {windowName(target.window)}</span>
          )}
        </span>
        <span className="text-foreground tabular-nums">
          {usage.estimate === null
            ? target === undefined
              ? "no readings"
              : "share not estimable"
            : `this run ≈ ${percentText(usage.estimate.percent)}`}
        </span>
      </div>
      {target === undefined ? null : (
        <div
          className="relative h-1.5 overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label={`${name}: the account moved ${percentText(target.movedPercent)} of its ${windowName(target.window)} during the run`}
        >
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-foreground/20"
            style={{ width: `${Math.min(100, (target.movedPercent / BAR_SCALE_PERCENT) * 100)}%` }}
          />
          {usage.estimate === null ? null : (
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-foreground/70"
              style={{
                width: `${Math.min(100, (usage.estimate.percent / BAR_SCALE_PERCENT) * 100)}%`,
              }}
            />
          )}
        </div>
      )}
      <p className="text-search-label text-muted-foreground tabular-nums">
        {target === undefined
          ? "The run's outputs carry no reading of this plan."
          : `account moved +${percentText(target.movedPercent)} between the run's first and last reading, every session included${target.resets > 0 ? ` (${target.resets} reset)` : ""}`}
        {spendText(usage)}
      </p>
    </div>
  );
}

/**
 * What the run used of each plan, as the providers measured it. The account's
 * movement is measured; the run's share is that movement split by the run's
 * part of this machine's spend between the same two readings, so it is an
 * estimate that leans high: what other machines spent on the same account in
 * that time is not seen here.
 */
export const FactoryRunUsageBlock = memo(function FactoryRunUsageBlock({
  threadRef,
  runId,
}: {
  threadRef: ScopedThreadRef;
  runId: string;
}) {
  const state = readFactoryRunUsageState(
    useAtomValue(
      factoryEnvironment.factoryRunUsage({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, runId },
      }),
    ),
  );
  if (state.status === "failed") return null;
  if (state.status === "loading") {
    return (
      <div
        className="flex flex-col gap-2 rounded-xl border border-border/70 p-3"
        aria-label="Loading the plan share"
      >
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-1.5 w-full" />
      </div>
    );
  }
  const { usage } = state;
  if (usage.providers.length === 0) return null;
  return (
    <section
      className="flex flex-col gap-2.5 rounded-xl border border-border/70 p-3"
      aria-label="Share of your plans"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-foreground">Share of your plans</p>
        <Badge variant="outline">estimate</Badge>
      </div>
      {usage.providers.map((provider) => (
        <ProviderRow key={provider.provider} usage={provider} />
      ))}
      <p className="text-search-label text-muted-foreground">
        {usage.machineSpend === "unavailable"
          ? "This machine's usage could not be read, so the run's share is not estimated."
          : "The run's share counts its role turns, not the coordinator thread, and takes each turn's spend as even over the turn. It leans high: spend on other machines in the same time is not seen here."}{" "}
        Bars span 0–{BAR_SCALE_PERCENT}% of the window; the light part is the whole account.
      </p>
    </section>
  );
});
