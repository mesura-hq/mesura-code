/**
 * Mesura: the one table of host stats warning levels and the stale threshold,
 * shared by the web dock and the mobile Hosts screen. The server sends raw
 * numbers only, so changing a level here changes it on every client at once.
 */

export type HostStatsLevel = "ok" | "warn" | "crit";

/** The metrics that colour a row. Network, agents and servers never do. */
export type HostStatsLevelMetric =
  | "cpuPercent"
  | "memoryPercent"
  | "swapPercent"
  | "diskPercent"
  | "loadPerCore"
  | "gpuMemoryPercent"
  | "cpuTemperatureC";

/** A value at or above `warn` is amber, at or above `crit` is red. */
const HOST_STATS_LEVELS: Readonly<
  Record<HostStatsLevelMetric, { readonly warn: number; readonly crit: number }>
> = {
  cpuPercent: { warn: 85, crit: 95 },
  memoryPercent: { warn: 85, crit: 95 },
  swapPercent: { warn: 60, crit: 85 },
  diskPercent: { warn: 85, crit: 95 },
  /** `load1 / cpuCount`. */
  loadPerCore: { warn: 1.0, crit: 1.5 },
  /** GPU memory, never GPU busy: a busy GPU is working, a full one is in trouble. */
  gpuMemoryPercent: { warn: 85, crit: 95 },
  cpuTemperatureC: { warn: 85, crit: 95 },
};

/** A host whose latest sample is older than this, in host time, is stale: 2.5 sample intervals. */
export const HOST_STATS_STALE_AFTER_MS = 150_000;

export function hostStatsLevel(metric: HostStatsLevelMetric, value: number): HostStatsLevel {
  const { warn, crit } = HOST_STATS_LEVELS[metric];
  if (value >= crit) return "crit";
  return value >= warn ? "warn" : "ok";
}
