/**
 * What a factory run used of the developer's subscriptions. Only the provider's
 * used percent sizes a plan: no budget, allowance or rate is known here. The share
 * splits the account's movement by the run's part of this machine's spend, so it
 * leans high: other machines' spend on the same account is invisible.
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
  const ordered = [...samples].sort((left, right) => left.observedAtMs - right.observedAtMs);
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

/** Every window one provider's readings describe, with how far the account moved in it. */
export function factoryQuotaWindows(
  provider: FactoryRunQuotaProvider,
  samples: ReadonlyArray<FactoryQuotaSample>,
): ReadonlyArray<FactoryRunUsageWindow> {
  const byWindow = new Map<string, FactoryQuotaSample[]>();
  for (const sample of samples) {
    if (sample.provider !== provider) continue;
    const list = byWindow.get(sample.window) ?? [];
    list.push(sample);
    byWindow.set(sample.window, list);
  }
  return [...byWindow.entries()].flatMap(([window, list]) => {
    const movement = factoryQuotaMovement(list);
    return movement === null ? [] : [{ window, ...movement }];
  });
}

/**
 * The window an estimate can be stated against: the preferred one among those
 * with two readings at different instants, which bound the span both spends
 * are measured over.
 */
export function factoryEstimateWindow(
  windows: ReadonlyArray<FactoryRunUsageWindow>,
): FactoryRunUsageWindow | undefined {
  const usable = windows.filter(
    (window) => window.samples >= 2 && Date.parse(window.lastAt) > Date.parse(window.firstAt),
  );
  for (const name of ESTIMATE_WINDOW_PREFERENCE) {
    const match = usable.find((window) => window.window === name);
    if (match !== undefined) return match;
  }
  return [...usable].sort((left, right) => right.movedPercent - left.movedPercent)[0];
}

/** One finished role turn's own spend at list price. */
export interface FactoryTurnSpend {
  readonly startMs: number;
  readonly endMs: number;
  readonly spendUsd: number;
}

/** The run's spend between two instants, each turn's spend spread evenly over the turn. */
export function factoryRunSpendBetween(
  turns: ReadonlyArray<FactoryTurnSpend>,
  fromMs: number,
  toMs: number,
): number {
  return turns.reduce((total, turn) => {
    if (turn.endMs <= turn.startMs) {
      return turn.startMs >= fromMs && turn.startMs <= toMs ? total + turn.spendUsd : total;
    }
    const overlap = Math.min(turn.endMs, toMs) - Math.max(turn.startMs, fromMs);
    return overlap <= 0 ? total : total + (turn.spendUsd * overlap) / (turn.endMs - turn.startMs);
  }, 0);
}

/**
 * One provider's usage line: the windows' movement, the run's and the machine's
 * spend, and the run's estimated share. `machineSpendInSpanUsd` must cover exactly
 * the estimate window's first-to-last reading span, the span its movement covers.
 */
export function factoryRunUsageProvider(input: {
  readonly provider: FactoryRunQuotaProvider;
  readonly windows: ReadonlyArray<FactoryRunUsageWindow>;
  readonly turns: ReadonlyArray<FactoryTurnSpend>;
  readonly machineSpendUsd: number | null;
  readonly machineSpendInSpanUsd: number | null;
}): FactoryRunUsageProvider {
  const { provider, windows, turns, machineSpendUsd, machineSpendInSpanUsd } = input;
  const runSpendUsd =
    turns.length === 0 ? null : turns.reduce((total, turn) => total + turn.spendUsd, 0);
  const target = factoryEstimateWindow(windows);
  if (
    target === undefined ||
    runSpendUsd === null ||
    machineSpendInSpanUsd === null ||
    machineSpendInSpanUsd <= 0
  ) {
    return { provider, windows, runSpendUsd, machineSpendUsd, estimate: null };
  }
  const runSpendInSpanUsd = factoryRunSpendBetween(
    turns,
    Date.parse(target.firstAt),
    Date.parse(target.lastAt),
  );
  // The run cannot have used more than the account moved.
  const runShareOfSpend = Math.min(1, runSpendInSpanUsd / machineSpendInSpanUsd);
  return {
    provider,
    windows,
    runSpendUsd,
    machineSpendUsd,
    estimate: {
      window: target.window,
      percent: Math.round(target.movedPercent * runShareOfSpend * 100) / 100,
      runShareOfSpend,
      runSpendUsd: runSpendInSpanUsd,
      machineSpendUsd: machineSpendInSpanUsd,
    },
  };
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
