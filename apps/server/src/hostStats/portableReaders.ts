import * as NodeOS from "node:os";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { CpuCounters } from "./linuxReaders.ts";
import { withNullsOnFailure } from "./readerGuard.ts";

/**
 * Readers for macOS and Windows, where Node's `os` covers CPU, load and
 * memory. Swap, GPU, temperature and network have no portable source and the
 * collector leaves them null. Each reader nulls only its own fields on failure.
 */
export type HostOsApi = Pick<typeof NodeOS, "cpus" | "loadavg" | "totalmem" | "freemem">;

export const HostOs = Context.Reference<HostOsApi>("t3/hostStats/HostOs", {
  defaultValue: () => NodeOS,
});

type PortableCpuReading = {
  readonly cpuCount: number | null;
  readonly cpuCounters: CpuCounters | null;
};

type PortableMemoryReading = {
  readonly memUsedBytes: number | null;
  readonly memTotalBytes: number | null;
};

/**
 * CPU times summed over all cores, laid out like `/proc/stat` (user, nice,
 * system, idle, iowait, irq) so one comparison serves every platform. `os`
 * has no iowait.
 */
export const readPortableCpu = Effect.gen(function* () {
  const cpus = (yield* HostOs).cpus();
  if (cpus.length === 0) return { cpuCount: null, cpuCounters: null };
  const fields = cpus.reduce(
    (sum, { times }) => [
      sum[0]! + times.user,
      sum[1]! + times.nice,
      sum[2]! + times.sys,
      sum[3]! + times.idle,
      0,
      sum[5]! + times.irq,
    ],
    [0, 0, 0, 0, 0, 0],
  );
  return { cpuCount: cpus.length, cpuCounters: { fields } };
}).pipe(withNullsOnFailure<PortableCpuReading>({ cpuCount: null, cpuCounters: null }));

/** Windows always reports a load of 0, which would read as idle, so it is null there. */
export const readPortableLoad = (platform: NodeJS.Platform) =>
  Effect.gen(function* () {
    if (platform === "win32") return { load1: null };
    const load1 = (yield* HostOs).loadavg()[0];
    return { load1: load1 !== undefined && Number.isFinite(load1) ? load1 : null };
  }).pipe(withNullsOnFailure<{ readonly load1: number | null }>({ load1: null }));

export const readPortableMemory = Effect.gen(function* () {
  const hostOs = yield* HostOs;
  const memTotalBytes = hostOs.totalmem();
  return { memUsedBytes: Math.max(0, memTotalBytes - hostOs.freemem()), memTotalBytes };
}).pipe(withNullsOnFailure<PortableMemoryReading>({ memUsedBytes: null, memTotalBytes: null }));
