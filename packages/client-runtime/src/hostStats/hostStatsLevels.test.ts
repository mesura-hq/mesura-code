/**
 * Phase 4 fence, acceptance criterion 7: the agreed warning levels. The
 * thresholds are written out here from the approved plan, never read from
 * the table under test. Entry point: `hostStatsLevel` in `hostStatsLevels.ts`,
 * the function both clients call.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  HOST_STATS_STALE_AFTER_MS,
  hostStatsLevel,
  type HostStatsLevelMetric,
} from "./hostStatsLevels.ts";

const AGREED_LEVELS: ReadonlyArray<{
  readonly metric: HostStatsLevelMetric;
  readonly warn: number;
  readonly crit: number;
}> = [
  { metric: "cpuPercent", warn: 85, crit: 95 },
  { metric: "memoryPercent", warn: 85, crit: 95 },
  { metric: "swapPercent", warn: 60, crit: 85 },
  { metric: "diskPercent", warn: 85, crit: 95 },
  { metric: "loadPerCore", warn: 1.0, crit: 1.5 },
  { metric: "gpuMemoryPercent", warn: 85, crit: 95 },
  { metric: "cpuTemperatureC", warn: 85, crit: 95 },
];

describe("host stats levels", () => {
  for (const { metric, warn, crit } of AGREED_LEVELS) {
    it(`host stats level ${metric} is ok below ${warn}, warn from ${warn}, crit from ${crit}`, () => {
      expect(hostStatsLevel(metric, 0)).toBe("ok");
      expect(hostStatsLevel(metric, warn - 0.01)).toBe("ok");
      expect(hostStatsLevel(metric, warn)).toBe("warn");
      expect(hostStatsLevel(metric, (warn + crit) / 2)).toBe("warn");
      expect(hostStatsLevel(metric, crit - 0.01)).toBe("warn");
      expect(hostStatsLevel(metric, crit)).toBe("crit");
      expect(hostStatsLevel(metric, crit * 2)).toBe("crit");
    });
  }

  it("host stats stale threshold is 150 seconds of host time", () => {
    expect(HOST_STATS_STALE_AFTER_MS).toBe(150_000);
  });
});
