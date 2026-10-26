/**
 * What a Software Factory run used of the developer's subscriptions.
 *
 * The provider is the only source of a plan's size: Claude and Codex report
 * the account's used percent per window, and that percent already counts
 * against whatever the plan is today. Nothing here knows a plan budget, a
 * dollar allowance or a conversion rate. The run's share is the account's
 * movement during the run, split by the run's part of the spend this machine
 * saw in the same window. Spend on other machines is invisible here, so the
 * share is an upper bound of the run's true share.
 */
import type {
  FactoryRunQuotaProvider,
  FactoryRunState,
  FactoryRunUsageProvider,
  FactoryRunUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** One provider reading of an account window. */
export interface FactoryQuotaSample {
  readonly provider: FactoryRunQuotaProvider;
  /** `five_hour`, `seven_day`, or `<minutes>m` for a window the provider names by length. */
  readonly window: string;
  /** 0 to 100. */
  readonly usedPercent: number;
  /** Epoch milliseconds, or null when the provider gave none. */
  readonly resetsAtMs: number | null;
  readonly observedAtMs: number;
}

/** A window named by its length, as Codex reports it. */
export function factoryQuotaWindowName(windowMinutes: number): string {
  if (windowMinutes === 300) return "five_hour";
  if (windowMinutes === 10_080) return "seven_day";
  return `${windowMinutes}m`;
}

const finitePercent = (value: unknown, scale: number): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value * scale : null;

const epochSecondsToMs = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value * 1000 : null;

/**
 * The windows of one `claude -p --output-format stream-json` line, when it is a
 * `rate_limit_event`. `unifiedWindows` carries every window as a 0–1 fraction;
 * an older CLI carries only the event's own window in `utilization`.
 */
export function readClaudeQuotaLine(
  line: string,
  observedAtMs: number,
): ReadonlyArray<FactoryQuotaSample> {
  if (!line.includes('"rate_limit_event"')) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  const info = (parsed as { rate_limit_info?: Record<string, unknown> } | null)?.rate_limit_info;
  if (info === undefined || info === null || typeof info !== "object") return [];
  const unified = info.unifiedWindows;
  const windows: Array<[string, unknown]> =
    unified !== null && typeof unified === "object"
      ? Object.entries(unified as Record<string, unknown>)
      : typeof info.rateLimitType === "string"
        ? [[info.rateLimitType, { utilization: info.utilization, resetsAt: info.resetsAt }]]
        : [];
  return windows.flatMap(([window, value]) => {
    const entry = (value ?? {}) as { utilization?: unknown; resetsAt?: unknown };
    const usedPercent = finitePercent(entry.utilization, 100);
    if (usedPercent === null) return [];
    return [
      {
        provider: "claude" as const,
        window,
        usedPercent,
        resetsAtMs: epochSecondsToMs(entry.resetsAt),
        observedAtMs,
      },
    ];
  });
}

/**
 * The windows of one Codex session rollout line that carries `rate_limits`,
 * timed by the line's own `timestamp`.
 */
export function readCodexQuotaLine(line: string): ReadonlyArray<FactoryQuotaSample> {
  if (!line.includes('"rate_limits"')) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  const record = parsed as {
    timestamp?: unknown;
    payload?: { rate_limits?: Record<string, unknown> | null };
  } | null;
  const observedAtMs =
    typeof record?.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
  const limits = record?.payload?.rate_limits;
  if (Number.isNaN(observedAtMs) || limits === null || typeof limits !== "object") return [];
  return (["primary", "secondary"] as const).flatMap((slot) => {
    const entry = limits[slot] as
      | { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown }
      | null
      | undefined;
    if (entry === null || entry === undefined || typeof entry.window_minutes !== "number")
      return [];
    const usedPercent = finitePercent(entry.used_percent, 1);
    if (usedPercent === null) return [];
    return [
      {
        provider: "codex" as const,
        window: factoryQuotaWindowName(entry.window_minutes),
        usedPercent,
        resetsAtMs: epochSecondsToMs(entry.resets_at),
        observedAtMs,
      },
    ];
  });
}

/**
 * How far one account window moved across the samples, in time order. A
 * reading lower than the one before, or a changed reset time, starts a new
 * baseline: the usage before the reset is kept, the drop is not subtracted,
 * and the climb after it counts from the first reading after the reset.
 */
export function factoryQuotaMovement(
  samples: ReadonlyArray<FactoryQuotaSample>,
): Omit<FactoryRunUsageWindow, "window"> | null {
  const ordered = samples.toSorted((left, right) => left.observedAtMs - right.observedAtMs);
  const first = ordered[0];
  const last = ordered.at(-1);
  if (first === undefined || last === undefined) return null;
  let movedPercent = 0;
  let resets = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    const resetChanged =
      previous.resetsAtMs !== null &&
      current.resetsAtMs !== null &&
      current.resetsAtMs !== previous.resetsAtMs;
    if (resetChanged || current.usedPercent < previous.usedPercent) {
      resets += 1;
      continue;
    }
    movedPercent += current.usedPercent - previous.usedPercent;
  }
  return {
    firstPercent: first.usedPercent,
    lastPercent: last.usedPercent,
    movedPercent: Math.round(movedPercent * 100) / 100,
    samples: ordered.length,
    resets,
    firstAt: isoOf(first.observedAtMs),
    lastAt: isoOf(last.observedAtMs),
  };
}

/** The window an estimate is stated against: the weekly one when the provider reports it. */
const ESTIMATE_WINDOW_PREFERENCE = ["seven_day", "five_hour"];

function preferredWindow(windows: ReadonlyArray<FactoryRunUsageWindow>) {
  for (const name of ESTIMATE_WINDOW_PREFERENCE) {
    const match = windows.find((window) => window.window === name);
    if (match !== undefined) return match;
  }
  return windows.toSorted((left, right) => right.movedPercent - left.movedPercent)[0];
}

/**
 * One provider's line of the run's usage: the account windows' movement, the
 * run's and the machine's spend over the run, and the run's estimated share
 * of the preferred window when both spends are known.
 */
export function factoryRunUsageProvider(input: {
  readonly provider: FactoryRunQuotaProvider;
  readonly samples: ReadonlyArray<FactoryQuotaSample>;
  readonly runSpendUsd: number | null;
  readonly machineSpendUsd: number | null;
}): FactoryRunUsageProvider {
  const byWindow = new Map<string, FactoryQuotaSample[]>();
  for (const sample of input.samples) {
    if (sample.provider !== input.provider) continue;
    const list = byWindow.get(sample.window) ?? [];
    list.push(sample);
    byWindow.set(sample.window, list);
  }
  const windows = [...byWindow.entries()].flatMap(([window, samples]) => {
    const movement = factoryQuotaMovement(samples);
    return movement === null ? [] : [{ window, ...movement }];
  });
  const target = preferredWindow(windows);
  const { runSpendUsd, machineSpendUsd } = input;
  const estimate =
    target === undefined ||
    target.samples < 2 ||
    runSpendUsd === null ||
    machineSpendUsd === null ||
    machineSpendUsd <= 0
      ? null
      : {
          window: target.window,
          // The run cannot have used more than the account moved.
          percent:
            Math.round(target.movedPercent * Math.min(1, runSpendUsd / machineSpendUsd) * 100) /
            100,
          runShareOfSpend: Math.min(1, runSpendUsd / machineSpendUsd),
        };
  return { provider: input.provider, windows, runSpendUsd, machineSpendUsd, estimate };
}

/** The harness a provider's role turns run on. */
export const FACTORY_QUOTA_HARNESS: Record<FactoryRunQuotaProvider, string> = {
  claude: "claude",
  codex: "codex",
};

/** The run's role turns on one provider, with their own spend. */
export function factoryRunTurnsOf(state: FactoryRunState, provider: FactoryRunQuotaProvider) {
  return state.phases.flatMap((phase) =>
    phase.dispatches.filter((dispatch) => dispatch.harness === FACTORY_QUOTA_HARNESS[provider]),
  );
}
