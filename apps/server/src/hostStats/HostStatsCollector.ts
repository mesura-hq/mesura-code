// @effect-diagnostics nodeBuiltinImport:off - Effect has no free-space query; `statfs` fills that gap.
import * as NodeFSP from "node:fs/promises";
import type { HostStatsGpu, HostStatsSample } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../config.ts";
import {
  LINUX_ROOTS,
  readCpu,
  readCpuTemperature,
  readGpus,
  readLoad,
  readMemory,
  readNetwork,
  CPU_IDLE_FIELD,
  CPU_IOWAIT_FIELD,
  type CpuCounters,
  type NetworkInterfaceCounters,
} from "./linuxReaders.ts";
import {
  HostOs,
  readPortableCpu,
  readPortableLoad,
  readPortableMemory,
} from "./portableReaders.ts";

/** Reads one sample of the server's own host; every metric it cannot read is null. */
export class HostStatsCollector extends Context.Service<
  HostStatsCollector,
  { readonly read: Effect.Effect<HostStatsSample> }
>()("t3/hostStats/HostStatsCollector") {}

export interface HostStatsCollectorOptions {
  readonly procRoot: string;
  readonly sysRoot: string;
  /** The filesystem measured for disk usage: the server's base directory in production. */
  readonly diskPath: string;
}

/**
 * Rates span two readings. Past this gap (suspend, `SIGSTOP`, a clock jump)
 * the counters no longer describe "now", so the rate is dropped.
 */
export const MAX_RATE_GAP_MS = 120_000;

interface CounterReading {
  readonly sampledAt: number;
  readonly cpu: CpuCounters | null;
  readonly network: ReadonlyArray<NetworkInterfaceCounters> | null;
}

/**
 * Busy share of CPU time between two readings. Every field is compared on its
 * own: one field going backwards (a counter reset) is null even when the sum
 * grew, because the sum's delta then mixes two unrelated baselines.
 */
function cpuPercentBetween(previous: CpuCounters, current: CpuCounters): number | null {
  if (previous.fields.length !== current.fields.length) return null;
  const deltas = current.fields.map((value, index) => value - previous.fields[index]!);
  if (deltas.some((delta) => delta < 0)) return null;
  const totalDelta = deltas.reduce((sum, delta) => sum + delta, 0);
  const idleDelta = (deltas[CPU_IDLE_FIELD] ?? 0) + (deltas[CPU_IOWAIT_FIELD] ?? 0);
  return totalDelta > 0 ? 100 * (1 - idleDelta / totalDelta) : null;
}

/**
 * Summed bytes per second in one direction, or null unless both readings
 * list the same interfaces and none of them went backwards. An interface
 * that appeared or vanished would add or drop its whole since-boot count.
 */
function networkBytesPerSecond(
  previous: ReadonlyArray<NetworkInterfaceCounters>,
  current: ReadonlyArray<NetworkInterfaceCounters>,
  direction: "rxBytes" | "txBytes",
  elapsedMs: number,
): number | null {
  if (previous.length !== current.length) return null;
  const previousByName = new Map(previous.map((counters) => [counters.name, counters]));
  let totalDelta = 0;
  for (const counters of current) {
    const before = previousByName.get(counters.name);
    if (!before) return null;
    const delta = counters[direction] - before[direction];
    if (delta < 0) return null;
    totalDelta += delta;
  }
  return totalDelta / (elapsedMs / 1000);
}

function ratesBetween(previous: CounterReading | null, current: CounterReading) {
  const elapsedMs = previous ? current.sampledAt - previous.sampledAt : 0;
  if (!previous || elapsedMs <= 0 || elapsedMs > MAX_RATE_GAP_MS) {
    return { cpuPercent: null, netRxBytesPerSec: null, netTxBytesPerSec: null };
  }
  const bytesPerSecond = (direction: "rxBytes" | "txBytes") =>
    previous.network && current.network
      ? networkBytesPerSecond(previous.network, current.network, direction, elapsedMs)
      : null;
  return {
    cpuPercent: previous.cpu && current.cpu ? cpuPercentBetween(previous.cpu, current.cpu) : null,
    netRxBytesPerSec: bytesPerSecond("rxBytes"),
    netTxBytesPerSec: bytesPerSecond("txBytes"),
  };
}

/** `statfs` is portable across Linux, macOS and Windows. */
const readDisk = (diskPath: string) =>
  Effect.tryPromise(() => NodeFSP.statfs(diskPath)).pipe(
    Effect.map((stats) => ({
      diskUsedBytes: (stats.blocks - stats.bfree) * stats.bsize,
      diskTotalBytes: stats.blocks * stats.bsize,
    })),
    Effect.catchCause(() => Effect.succeed({ diskUsedBytes: null, diskTotalBytes: null })),
  );

/** Everything the platform-specific readers provide; the collector adds rates and disk. */
interface HostReading {
  readonly cpuCount: number | null;
  readonly cpuCounters: CpuCounters | null;
  readonly netCounters: ReadonlyArray<NetworkInterfaceCounters> | null;
  readonly load1: number | null;
  readonly memUsedBytes: number | null;
  readonly memTotalBytes: number | null;
  readonly swapUsedBytes: number | null;
  readonly swapTotalBytes: number | null;
  readonly gpus: ReadonlyArray<HostStatsGpu> | null;
  readonly cpuTemperatureC: number | null;
}

/**
 * macOS and Windows: the portable readers cover CPU, load and memory. Swap,
 * GPU, temperature and network have no portable source and stay null.
 */
const readPortableHost = (platform: NodeJS.Platform): Effect.Effect<HostReading> =>
  Effect.all([readPortableCpu, readPortableLoad(platform), readPortableMemory], {
    concurrency: "unbounded",
  }).pipe(
    Effect.map(([cpu, load, memory]) => ({
      ...cpu,
      ...load,
      ...memory,
      netCounters: null,
      swapUsedBytes: null,
      swapTotalBytes: null,
      gpus: null,
      cpuTemperatureC: null,
    })),
  );

export const make = Effect.fn("makeHostStatsCollector")(function* (
  options: HostStatsCollectorOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcessPlatform;
  const hostOs = yield* HostOs;
  const roots = { procRoot: options.procRoot, sysRoot: options.sysRoot };
  const previousCounters = yield* Ref.make<CounterReading | null>(null);

  const readLinuxHost: Effect.Effect<HostReading> = Effect.all(
    [
      readCpu(roots),
      readNetwork(roots),
      readLoad(roots),
      readMemory(roots),
      readGpus(roots),
      readCpuTemperature(roots),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map((partials): HostReading => Object.assign({}, ...partials)),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );
  const readHost =
    platform === "linux"
      ? readLinuxHost
      : readPortableHost(platform).pipe(Effect.provideService(HostOs, hostOs));

  const read = Effect.gen(function* () {
    const sampledAt = yield* Clock.currentTimeMillis;
    const [host, disk] = yield* Effect.all([readHost, readDisk(options.diskPath)], {
      concurrency: "unbounded",
    });
    const counters: CounterReading = {
      sampledAt,
      cpu: host.cpuCounters,
      network: host.netCounters,
    };
    const previous = yield* Ref.getAndSet(previousCounters, counters);
    const { cpuCounters: _cpuCounters, netCounters: _netCounters, ...metrics } = host;
    return {
      sampledAt,
      ...ratesBetween(previous, counters),
      ...metrics,
      ...disk,
      agentsRunning: null,
      agentSessionsOpen: null,
      mesuraServers: null,
    } satisfies HostStatsSample;
  }).pipe(Effect.withSpan("HostStatsCollector.read"));

  return HostStatsCollector.of({ read });
});

export const layer = Layer.effect(
  HostStatsCollector,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return yield* make({ ...LINUX_ROOTS, diskPath: config.baseDir });
  }),
);
