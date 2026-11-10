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
  five_hour: "5 h",
  seven_day: "week",
};

const windowName = (window: string) => WINDOW_NAMES[window] ?? window;

const percentText = (percent: number) =>
  `${percent < 10 ? percent.toFixed(1).replace(/\.0$/, "") : Math.round(percent)}%`;

/** The account's movement and the two spends the share divides, in one short line. */
function basisText(usage: FactoryRunUsageProvider, movedPercent: number | null): string | null {
  const parts: string[] = [];
  if (movedPercent !== null) parts.push(`account +${percentText(movedPercent)}`);
  if (usage.estimate !== null) {
    parts.push(
      `run ${factoryTraceUsdText(usage.estimate.runSpendUsd)} of ${factoryTraceUsdText(usage.estimate.machineSpendUsd)}`,
    );
  } else if (usage.runSpendUsd !== null) {
    parts.push(`run ${factoryTraceUsdText(usage.runSpendUsd)}`);
  }
  return parts.length === 0 ? null : parts.join(" · ");
}

/** Bars span 0 to this many points, so one run reads at a glance. */
const BAR_SCALE_PERCENT = 10;

const barWidth = (percent: number) => `${Math.min(100, (percent / BAR_SCALE_PERCENT) * 100)}%`;

function ProviderRow({ usage }: { usage: FactoryRunUsageProvider }) {
  const target =
    usage.windows.find((window) => window.window === usage.estimate?.window) ??
    usage.windows.find((window) => window.window === "seven_day") ??
    usage.windows[0];
  const name = PROVIDER_NAMES[usage.provider];
  const basis = basisText(usage, target?.movedPercent ?? null);
  return (
    <div className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-x-3 gap-y-0.5 text-xs">
      <span className="text-foreground">{name}</span>
      <div
        className="relative h-1.5 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={
          target === undefined
            ? `${name}: no readings`
            : `${name}: the account moved ${percentText(target.movedPercent)} of its ${windowName(target.window)} limit during the run`
        }
      >
        {target === undefined ? null : (
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-foreground/15"
            style={{ width: barWidth(target.movedPercent) }}
          />
        )}
        {usage.estimate === null ? null : (
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-foreground/70"
            style={{ width: barWidth(usage.estimate.percent) }}
          />
        )}
      </div>
      <span className="text-right text-foreground tabular-nums">
        {usage.estimate === null
          ? target === undefined
            ? "no readings"
            : "–"
          : `${percentText(usage.estimate.percent)} of ${windowName(usage.estimate.window)}`}
      </span>
      {basis === null ? null : (
        <span className="col-start-2 col-end-4 text-search-label text-muted-foreground tabular-nums">
          {basis}
        </span>
      )}
    </div>
  );
}

/**
 * What the run used of each plan. The account's movement is measured; the run's
 * share splits it by the run's part of this machine's spend, so it leans high:
 * other machines' spend on the same account is not seen here.
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
          ? "This machine's usage could not be read, so there is no estimate."
          : "Leans high: other machines on the same account are not counted."}
      </p>
    </section>
  );
});
