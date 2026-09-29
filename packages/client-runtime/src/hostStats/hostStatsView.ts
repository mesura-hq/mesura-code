/**
 * Mesura: formatting and view logic for host stats, shared by the web Hosts
 * dock and the mobile Hosts screen so both say the same thing in the same
 * words. Every decision about whether a number can be trusted is the
 * projection's (`projectHostStats`); this module only says it in words and
 * turns series into sparkline geometry.
 */
import type { HostStatsHostView, HostStatsRow, HostStatsRowId } from "./projectHostStats.ts";

/** A duration as its two largest units: "3m", "2h 5m", "1d 3h". Shared by both sidebar docks. */
export function formatCompactDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 1) return "less than 1m";
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const remainingMinutes = minutes % 60;
  if (days > 0) return `${days}d${hours > 0 ? ` ${hours}h` : ""}`;
  if (hours > 0) return `${hours}h${remainingMinutes > 0 ? ` ${remainingMinutes}m` : ""}`;
  return `${minutes}m`;
}

/** How often an open dock or a visible Hosts screen re-projects, so the ages on screen move. */
export const HOST_STATS_AGE_REFRESH_MS = 15_000;

/** The rows drawn on the `38px 1fr 76px` grid. Servers are a chip line under them. */
export type HostsDockRowId = Exclude<HostStatsRowId, "servers">;

export const HOSTS_DOCK_ROW_IDS: ReadonlyArray<HostsDockRowId> = [
  "cpu",
  "memory",
  "swap",
  "disk",
  "gpu",
  "temperature",
  "network",
  "agents",
];

/** How a row draws its history: a line, a step line, or the current value as a bar. */
export type HostsDockRowVisual = "sparkline" | "step" | "bar";

export const HOSTS_DOCK_ROW_VISUAL: Readonly<Record<HostsDockRowId, HostsDockRowVisual>> = {
  cpu: "sparkline",
  memory: "sparkline",
  swap: "bar",
  disk: "bar",
  gpu: "sparkline",
  temperature: "sparkline",
  network: "sparkline",
  agents: "step",
};

const ROW_LABELS: Readonly<Record<HostsDockRowId, string>> = {
  cpu: "CPU",
  memory: "RAM",
  swap: "Swap",
  disk: "Disk",
  gpu: "GPU",
  temperature: "Temp",
  network: "Net",
  agents: "Agents",
};

export interface HostRowDisplay {
  readonly label: string;
  readonly value: string;
  /** Rendered muted beside the value. */
  readonly suffix: string | null;
  readonly title: string | null;
}

export interface HostServersLine {
  readonly text: string;
  readonly title: string | null;
}

export interface HostStatusLine {
  readonly text: string;
}

export interface SparklineReading {
  readonly time: string;
  readonly value: string;
}

export interface HostStatsAgeClock {
  readonly setOpen: (open: boolean) => void;
  readonly dispose: () => void;
}

const GIB = 1024 ** 3;
const KIB = 1024;
const MIB = 1024 ** 2;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * Bytes as GiB, the way prototype B's `GB()` writes them: a whole number keeps
 * no decimal, anything under 100 keeps one, 100 and up keeps none.
 */
export function formatGigabytes(bytes: number): string {
  const gigabytes = bytes / GIB;
  if (Number.isInteger(gigabytes)) return gigabytes.toFixed(0);
  const tenths = Math.round(gigabytes * 10) / 10;
  return tenths >= 100 ? Math.round(gigabytes).toFixed(0) : tenths.toFixed(1);
}

function rateParts(bytesPerSecond: number): { readonly amount: string; readonly unit: "K" | "M" } {
  if (bytesPerSecond <= 0) return { amount: "0", unit: "K" };
  if (bytesPerSecond < KIB) return { amount: "<1", unit: "K" };
  if (bytesPerSecond < MIB) {
    return { amount: Math.round(bytesPerSecond / KIB).toFixed(0), unit: "K" };
  }
  const mebibytes = bytesPerSecond / MIB;
  return { amount: mebibytes < 100 ? mebibytes.toFixed(1) : mebibytes.toFixed(0), unit: "M" };
}

export function formatRate(bytesPerSecond: number): string {
  const { amount, unit } = rateParts(bytesPerSecond);
  return `${amount} ${unit}B/s`;
}

/** The network row's narrow form: "12K", "1.5M". */
export function formatCompactRate(bytesPerSecond: number): string {
  const { amount, unit } = rateParts(bytesPerSecond);
  return `${amount}${unit}`;
}

export function formatTemperature(celsius: number): string {
  return `${Math.round(celsius)}°C`;
}

export function formatReadingAge(ageMs: number): string {
  return ageMs < 60_000 ? "just now" : `${formatCompactDuration(ageMs)} ago`;
}

export function formatUptime(uptimeMs: number): string {
  return `up ${formatCompactDuration(uptimeMs)}`;
}

const percent = (value: number) => `${Math.round(value)}%`;

function usedOverTotal(label: string, row: HostStatsRow, value: number): HostRowDisplay {
  if (row.secondary === null) return { label, value: percent(value), suffix: null, title: null };
  return {
    label,
    value: formatGigabytes(row.secondary),
    suffix: row.total === null ? null : `/${formatGigabytes(row.total)}G`,
    title: `${percent(value)} used`,
  };
}

/** One row's cells, following prototype B: the value, then a muted suffix. */
export function hostRowDisplay(rowId: HostsDockRowId, row: HostStatsRow): HostRowDisplay {
  const label = ROW_LABELS[rowId];
  if (row.availability === "sleeping") {
    return { label, value: "asleep", suffix: null, title: "The GPU is asleep" };
  }
  if (row.availability !== "available") {
    return { label, value: "n/a", suffix: null, title: "Not available on this host" };
  }
  const { secondary, value } = row;
  switch (rowId) {
    case "gpu":
      return {
        label,
        value: value === null ? "—" : percent(value),
        suffix: secondary === null ? null : `vram ${percent(secondary)}`,
        title: "Busy · video memory used",
      };
    case "network":
      return {
        label,
        value: `↓${value === null ? "—" : formatCompactRate(value)}`,
        suffix: secondary === null ? null : `↑${formatCompactRate(secondary)}`,
        title: `↓ ${value === null ? "n/a" : formatRate(value)} received · ↑ ${
          secondary === null ? "n/a" : formatRate(secondary)
        } sent`,
      };
    default:
      break;
  }
  if (value === null) return { label, value: "n/a", suffix: null, title: null };
  switch (rowId) {
    case "cpu":
      return {
        label,
        value: percent(value),
        suffix: secondary === null ? null : `ld ${secondary.toFixed(1)}`,
        title: secondary === null ? null : `Load ${secondary.toFixed(2)}`,
      };
    case "memory":
    case "swap":
      return usedOverTotal(label, row, value);
    case "disk":
      return {
        label,
        value: percent(value),
        suffix: secondary === null ? null : `${formatGigabytes(secondary)}G`,
        title:
          secondary === null
            ? null
            : `${formatGigabytes(secondary)} GB free${
                row.total === null ? "" : ` of ${formatGigabytes(row.total)} GB`
              }`,
      };
    case "temperature":
      return { label, value: formatTemperature(value), suffix: null, title: null };
    case "agents":
      return {
        label,
        value: value.toFixed(0),
        suffix: secondary === null ? null : `/${secondary}`,
        title: secondary === null ? null : `${plural(secondary, "agent session")} open`,
      };
  }
}

/** Prototype B's chip under the rows: every server, then how many are dev servers. */
export function hostServersLine(row: HostStatsRow): HostServersLine {
  if (row.availability !== "available" || row.value === null) {
    return { text: "servers n/a", title: null };
  }
  const dev = row.secondary ?? 0;
  return {
    text: `${plural(row.value + dev, "server")} · ${dev} dev`,
    title: `${plural(row.value, "installed server")}, ${plural(dev, "dev server")}`,
  };
}

/** The line under a host's header that says why its numbers are not current. */
export function hostStatusLine(host: HostStatsHostView): HostStatusLine | null {
  const age = host.lastReadingAgeMs;
  switch (host.state) {
    case "live":
      return null;
    case "pending":
      return { text: "Waiting for the first reading" };
    case "needs-update":
      return { text: "Update Mesura Code on this host" };
    case "no-access":
      return { text: "No access · pair again with full access" };
    case "updating":
      return {
        text: `Updating · last reading ${age === null ? "unknown" : formatReadingAge(age)}`,
      };
    case "stale":
      return { text: `Stale · last reading ${age === null ? "unknown" : formatReadingAge(age)}` };
    case "offline":
      return {
        text:
          age === null
            ? "Offline · no reading this session"
            : `Offline · last reading ${formatReadingAge(age)}`,
      };
  }
}

/** Updating, stale, offline and no-access hosts keep their values on screen, dimmed. */
export function hostIsDimmed(host: HostStatsHostView): boolean {
  return (
    host.state === "updating" ||
    host.state === "stale" ||
    host.state === "offline" ||
    host.state === "no-access"
  );
}

/** The header shows uptime only while the host is reachable and has a reading. */
export function hostShowsUptime(host: HostStatsHostView): boolean {
  return (
    host.uptimeMs !== null &&
    (host.state === "live" || host.state === "updating" || host.state === "stale")
  );
}

/**
 * "N of M online · K agents running". Online is the connection, so a stale or
 * outdated host that is still connected counts. Agents count only from a live
 * host, the one reading that is current.
 */
export function hostFleetSummary(hosts: ReadonlyArray<HostStatsHostView>): string {
  let online = 0;
  let agents = 0;
  for (const host of hosts) {
    if (host.connected) online += 1;
    if (host.state === "live") agents += host.rows?.agents.value ?? 0;
  }
  return `${online} of ${hosts.length} online · ${plural(agents, "agent")} running`;
}

function seriesPeak(series: ReadonlyArray<number | null>): number {
  let peak = 0;
  for (const value of series) if (value !== null && value > peak) peak = value;
  return peak;
}

/** The top of a row's vertical axis. */
export function sparklineMax(rowId: HostStatsRowId, series: ReadonlyArray<number | null>): number {
  switch (rowId) {
    case "temperature":
      return Math.max(100, seriesPeak(series));
    case "network":
      return Math.max(1, seriesPeak(series));
    case "agents":
      return Math.max(3, seriesPeak(series));
    default:
      return 100;
  }
}

/** Inclusive `[first, last]` slot ranges of consecutive readings. */
export function sparklineRuns(
  series: ReadonlyArray<number | null>,
): ReadonlyArray<readonly [number, number]> {
  const runs: Array<readonly [number, number]> = [];
  let start: number | null = null;
  series.forEach((value, index) => {
    if (value === null) {
      if (start !== null) runs.push([start, index - 1]);
      start = null;
    } else if (start === null) {
      start = index;
    }
  });
  if (start !== null) runs.push([start, series.length - 1]);
  return runs;
}

export interface SparklineGeometry {
  readonly height: number;
  readonly max: number;
  readonly step?: boolean;
}

const round2 = (value: number) => Number(value.toFixed(2));

function sparklineScale(series: ReadonlyArray<number | null>, geometry: SparklineGeometry) {
  const last = Math.max(1, series.length - 1);
  return {
    x: (index: number) => round2((index / last) * 100),
    y: (value: number) =>
      round2(
        geometry.height -
          1 -
          (Math.min(geometry.max, Math.max(0, value)) / geometry.max) * (geometry.height - 2),
      ),
    /** Half a slot: a reading between two gaps draws as a short dash, not nothing. */
    nub: round2(Math.max(0.5, 50 / last)),
  };
}

/**
 * The line of a 100-wide viewBox, one subpath per run: a gap is a break, never
 * a bridge. `step` holds each value until the next slot, for counts.
 */
export function sparklinePath(
  series: ReadonlyArray<number | null>,
  geometry: SparklineGeometry,
): string {
  const { x, y, nub } = sparklineScale(series, geometry);
  let path = "";
  for (const [first, last] of sparklineRuns(series)) {
    path += `M${x(first)},${y(series[first]!)}`;
    if (first === last) {
      path += `h${nub}`;
      continue;
    }
    for (let index = first + 1; index <= last; index += 1) {
      const point = y(series[index]!);
      path += geometry.step ? `H${x(index)}V${point}` : `L${x(index)},${point}`;
    }
  }
  return path;
}

/** The same runs closed down to the baseline, for the faint fill under a line. */
export function sparklineAreaPath(
  series: ReadonlyArray<number | null>,
  geometry: SparklineGeometry,
): string {
  const { x, nub } = sparklineScale(series, geometry);
  let path = "";
  for (const [first, last] of sparklineRuns(series)) {
    const run = sparklinePath(
      series.map((value, index) => (index >= first && index <= last ? value : null)),
      geometry,
    );
    const end = first === last ? round2(x(last) + nub) : x(last);
    path += `${run}L${end},${geometry.height}L${x(first)},${geometry.height}Z`;
  }
  return path;
}

/** The slot nearest a pointer at `fraction` of the sparkline's width. */
export function sparklineSlotAt(fraction: number, slotCount: number): number {
  const last = Math.max(0, slotCount - 1);
  return Math.min(last, Math.max(0, Math.round(fraction * last)));
}

const timeFormatters = new Map<string, Intl.DateTimeFormat>();

function formatClockTime(epochMs: number, timeZone: string | undefined): string {
  const key = timeZone ?? "";
  let formatter = timeFormatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      ...(timeZone ? { timeZone } : {}),
    });
    timeFormatters.set(key, formatter);
  }
  return formatter.format(epochMs);
}

function formatSeriesValue(rowId: HostStatsRowId, value: number): string {
  switch (rowId) {
    case "temperature":
      return formatTemperature(value);
    case "network":
      return formatRate(value);
    case "agents":
      return `${value.toFixed(0)} running`;
    default:
      return percent(value);
  }
}

/**
 * What a hovered slot says: the bucket's span on the host's clock, shown in
 * this device's time zone, and its value. Null for a row without a series.
 */
export function sparklineReading(
  host: HostStatsHostView,
  rowId: HostStatsRowId,
  slot: number,
  timeZone?: string,
): SparklineReading | null {
  const series = host.rows?.[rowId].series ?? null;
  if (series === null || host.seriesStartMs === null || host.bucketMs === null) return null;
  if (slot < 0 || slot >= series.length) return null;
  const start = host.seriesStartMs + slot * host.bucketMs;
  const value = series[slot] ?? null;
  return {
    time: `${formatClockTime(start, timeZone)}–${formatClockTime(start + host.bucketMs, timeZone)}`,
    value: value === null ? "no reading" : formatSeriesValue(rowId, value),
  };
}

/**
 * The clock the open dock projects with. It ticks when the dock opens and then
 * every `intervalMs`, never twice within `intervalMs` even across a reopen, and
 * schedules nothing while the dock is closed.
 */
export function createHostStatsAgeClock(input: {
  readonly intervalMs: number;
  readonly now: () => number;
  readonly schedule: (callback: () => void, delayMs: number) => unknown;
  readonly cancel: (handle: unknown) => void;
  readonly onTick: (nowLocal: number) => void;
}): HostStatsAgeClock {
  let open = false;
  let lastTick: number | null = null;
  let pending: unknown = null;
  const cancelPending = () => {
    if (pending === null) return;
    input.cancel(pending);
    pending = null;
  };
  const scheduleTick = (delayMs: number) => {
    pending = input.schedule(() => {
      pending = null;
      tick();
    }, delayMs);
  };
  const tick = () => {
    lastTick = input.now();
    input.onTick(lastTick);
    scheduleTick(input.intervalMs);
  };
  const setOpen = (next: boolean) => {
    if (next === open) return;
    open = next;
    if (!open) {
      cancelPending();
      return;
    }
    const since = lastTick === null ? Number.POSITIVE_INFINITY : input.now() - lastTick;
    if (since >= input.intervalMs) tick();
    else scheduleTick(input.intervalMs - since);
  };
  return { setOpen, dispose: () => setOpen(false) };
}
