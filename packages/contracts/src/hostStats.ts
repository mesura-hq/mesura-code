import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Bumped when a host stats message changes shape incompatibly. */
export const HOST_STATS_CONTRACT_VERSION = 1 as const;

const Percent = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }));
const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

export const HostStatsGpuVendor = Schema.Literals(["amd", "nvidia", "intel", "other"]);
export type HostStatsGpuVendor = typeof HostStatsGpuVendor.Type;

/** `sleeping` is a runtime-suspended GPU the server deliberately did not wake to measure. */
export const HostStatsGpuState = Schema.Literals(["active", "sleeping", "unavailable"]);
export type HostStatsGpuState = typeof HostStatsGpuState.Type;

export const HostStatsGpu = Schema.Struct({
  id: TrimmedNonEmptyString,
  vendor: HostStatsGpuVendor,
  state: HostStatsGpuState,
  busyPercent: Schema.NullOr(Percent),
  vramUsedBytes: Schema.NullOr(NonNegativeInt),
  vramTotalBytes: Schema.NullOr(NonNegativeInt),
});
export type HostStatsGpu = typeof HostStatsGpu.Type;

export const HostStatsMesuraServers = Schema.Struct({
  installed: NonNegativeInt,
  dev: NonNegativeInt,
});
export type HostStatsMesuraServers = typeof HostStatsMesuraServers.Type;

/**
 * One reading of the server's own host. Every metric is null when this host
 * cannot provide it or its reader failed; a null never means zero.
 */
export const HostStatsSample = Schema.Struct({
  /** Epoch milliseconds on the server's clock. */
  sampledAt: NonNegativeInt,
  cpuPercent: Schema.NullOr(Percent),
  load1: Schema.NullOr(NonNegativeFinite),
  cpuCount: Schema.NullOr(NonNegativeInt),
  memUsedBytes: Schema.NullOr(NonNegativeInt),
  memTotalBytes: Schema.NullOr(NonNegativeInt),
  swapUsedBytes: Schema.NullOr(NonNegativeInt),
  swapTotalBytes: Schema.NullOr(NonNegativeInt),
  diskUsedBytes: Schema.NullOr(NonNegativeInt),
  diskTotalBytes: Schema.NullOr(NonNegativeInt),
  gpus: Schema.NullOr(Schema.Array(HostStatsGpu)),
  cpuTemperatureC: Schema.NullOr(Schema.Finite),
  netRxBytesPerSec: Schema.NullOr(NonNegativeFinite),
  netTxBytesPerSec: Schema.NullOr(NonNegativeFinite),
  agentsRunning: Schema.NullOr(NonNegativeInt),
  agentSessionsOpen: Schema.NullOr(NonNegativeInt),
  mesuraServers: Schema.NullOr(HostStatsMesuraServers),
});
export type HostStatsSample = typeof HostStatsSample.Type;
