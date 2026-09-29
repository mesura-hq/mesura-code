/**
 * Test fixtures for the Hosts dock: a fleet of four hosts in the four states
 * the dock has to tell apart. Every history is built by applying a real
 * snapshot message, never by hand, so the fixtures cannot drift from the
 * shared model's shape. Imported by tests only.
 */
import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  type ConnectionCatalogEntry,
  type EnvironmentConnectionPhase,
  type EnvironmentPresentation,
} from "@t3tools/client-runtime/connection";
import {
  applyHostStatsMessage,
  projectHostStats,
  type HostStatsHistory,
  type HostStatsHostView,
  type HostStatsSubscription,
} from "@t3tools/client-runtime/host-stats";
import {
  EnvironmentId,
  HOST_STATS_CONTRACT_VERSION,
  toHostStatsBucketColumns,
  type HostStatsBucket,
  type HostStatsSample,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const BUCKET_MS = 5 * MINUTE;
export const WINDOW_MS = 12 * HOUR;
export const SLOTS = WINDOW_MS / BUCKET_MS;
const GIB = 1024 ** 3;
export const gib = (count: number) => Math.round(count * GIB);

/** The slots of the primary host's window that hold no bucket: the host was down. */
export const PRIMARY_GAP_SLOTS: readonly [number, number] = [100, 104];

/** Shaped on vigilia-home: 16 cores, 30 GiB of RAM, 7.6 GiB of swap, one AMD card. */
export function hostSample(
  sampledAt: number,
  overrides: Partial<HostStatsSample> = {},
): HostStatsSample {
  return {
    sampledAt,
    cpuPercent: 17,
    load1: 2.46,
    cpuCount: 16,
    memUsedBytes: gib(14.6),
    // A real MemTotal is never a whole number of GiB; this one reads "30.0".
    memTotalBytes: gib(29.98),
    swapUsedBytes: gib(4.2),
    swapTotalBytes: gib(7.6),
    diskUsedBytes: gib(160),
    diskTotalBytes: gib(953),
    gpus: [
      {
        id: "card0",
        vendor: "amd",
        state: "active",
        busyPercent: 12,
        vramUsedBytes: gib(1),
        vramTotalBytes: gib(8),
      },
    ],
    cpuTemperatureC: 48,
    netRxBytesPerSec: 12_000,
    netTxBytesPerSec: 3_000,
    agentsRunning: 4,
    agentSessionsOpen: 11,
    mesuraServers: { installed: 1, dev: 8 },
    ...overrides,
  };
}

export function hostBucket(
  start: number,
  overrides: Partial<HostStatsBucket> = {},
): HostStatsBucket {
  return {
    start,
    sampleCount: 5,
    cpuAvg: 20,
    cpuMax: 35,
    memUsedAvg: gib(14),
    swapUsedAvg: gib(4),
    diskUsedAvg: gib(160),
    gpuBusyAvg: 10,
    gpuBusyMax: 30,
    cpuTempMax: 50,
    netRxAvg: 10_000,
    netTxAvg: 2_000,
    agentsRunningMax: 4,
    ...overrides,
  };
}

const alignedStart = (time: number) => Math.floor(time / BUCKET_MS) * BUCKET_MS;

/** Host-clock `start` of `series[0]` for a host whose clock reads `now`. */
export function seriesStartFor(now: number): number {
  return alignedStart(now) - (SLOTS - 1) * BUCKET_MS;
}

/**
 * One host's history as the client folds it, with the host clock agreeing
 * with ours. Every slot of the window holds a bucket except `gapSlots`.
 */
export function hostHistory(input: {
  readonly now: number;
  readonly latestAgeMs: number;
  readonly gapSlots?: readonly [number, number] | null;
  readonly sample?: Partial<HostStatsSample>;
  readonly bucket?: Partial<HostStatsBucket>;
  readonly contractVersion?: number;
}): HostStatsHistory {
  const start = seriesStartFor(input.now);
  const gap = input.gapSlots ?? null;
  const buckets: HostStatsBucket[] = [];
  for (let slot = 0; slot < SLOTS; slot += 1) {
    if (gap !== null && slot >= gap[0] && slot <= gap[1]) continue;
    buckets.push(hostBucket(start + slot * BUCKET_MS, input.bucket));
  }
  const history = applyHostStatsMessage(
    null,
    {
      type: "snapshot",
      contractVersion: input.contractVersion ?? HOST_STATS_CONTRACT_VERSION,
      serverNow: input.now,
      sampleIntervalMs: MINUTE,
      bucketMs: BUCKET_MS,
      windowMs: WINDOW_MS,
      host: {
        hostname: "fixture",
        platform: "linux",
        arch: "x64",
        cpuCount: 16,
        bootedAt: input.now - (2 * HOUR + 27 * MINUTE),
      },
      buckets: toHostStatsBucketColumns(buckets, BUCKET_MS),
      latest: hostSample(input.now - input.latestAgeMs, input.sample),
    },
    input.now,
  );
  if (history === null) throw new Error("fixture snapshot was rejected");
  return history;
}

export function hostPresentation(input: {
  readonly id: string;
  readonly phase?: EnvironmentConnectionPhase;
  readonly primary?: boolean;
  readonly capability?: boolean;
}): EnvironmentPresentation {
  const environmentId = EnvironmentId.make(input.id);
  const target = input.primary
    ? new PrimaryConnectionTarget({
        environmentId,
        label: input.id,
        httpBaseUrl: "https://primary.example.test",
        wsBaseUrl: "wss://primary.example.test",
      })
    : new BearerConnectionTarget({
        environmentId,
        label: input.id,
        connectionId: `connection-${input.id}`,
      });
  const entry: ConnectionCatalogEntry = { target, profile: Option.none(), enabled: true };
  const serverConfig = {
    environment: { capabilities: { hostStats: input.capability ?? true } },
  } as unknown as ServerConfig;
  return {
    entry,
    connection: { phase: input.phase ?? "connected", error: null, traceId: null },
    serverConfig,
  };
}

export interface HostStatsFleet {
  readonly presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentation>;
  readonly subscriptions: ReadonlyMap<EnvironmentId, HostStatsSubscription>;
}

/** The last reading of the stale host, in host time: "3m ago" until 240 s. */
export const STALE_HOST_AGE_MS = 235 * SECOND;
/** The last reading of the offline host: "14m ago". */
export const OFFLINE_HOST_AGE_MS = 14 * MINUTE + 10 * SECOND;

/**
 * - vigilia-home: primary, live, with a gap in its window.
 * - arch-laptop: connected but its last reading is 235 s old, so stale.
 * - conversa: offline, holding a reading 14 minutes old.
 * - old-box: connected to a server from before the hosts dock.
 */
export function hostStatsFleet(now: number): HostStatsFleet {
  const hosts: ReadonlyArray<{
    readonly presentation: EnvironmentPresentation;
    readonly history: HostStatsHistory | null;
  }> = [
    {
      presentation: hostPresentation({ id: "vigilia-home", primary: true }),
      history: hostHistory({ now, latestAgeMs: 20 * SECOND, gapSlots: PRIMARY_GAP_SLOTS }),
    },
    {
      presentation: hostPresentation({ id: "arch-laptop" }),
      history: hostHistory({
        now,
        latestAgeMs: STALE_HOST_AGE_MS,
        sample: { agentsRunning: 1, agentSessionsOpen: 3 },
      }),
    },
    {
      presentation: hostPresentation({ id: "conversa", phase: "offline" }),
      history: hostHistory({ now, latestAgeMs: OFFLINE_HOST_AGE_MS }),
    },
    {
      presentation: hostPresentation({ id: "old-box", capability: false }),
      history: null,
    },
  ];
  return {
    presentations: new Map(
      hosts.map((host) => [host.presentation.entry.target.environmentId, host.presentation]),
    ),
    subscriptions: new Map(
      hosts.map((host) => [
        host.presentation.entry.target.environmentId,
        { history: host.history, failed: false },
      ]),
    ),
  };
}

export function projectFleet(
  fleet: HostStatsFleet,
  nowLocal: number,
): ReadonlyArray<HostStatsHostView> {
  return projectHostStats({ ...fleet, nowLocal });
}

export function hostView(views: ReadonlyArray<HostStatsHostView>, id: string): HostStatsHostView {
  const view = views.find((candidate) => candidate.environmentId === id);
  if (view === undefined) throw new Error(`no host ${id} in the fixture fleet`);
  return view;
}
