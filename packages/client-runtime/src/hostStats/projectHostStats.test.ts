/**
 * Phase 4 fence: the shared host stats model, one `describe` per acceptance
 * criterion of the plan, plus the extra cases the plan lists. Entry points:
 * `applyHostStatsMessage` and `accumulateHostStatsMessages` (the stream fold
 * the `hostStats` atom in `state/server.ts` is built with) for the history,
 * and `projectHostStats` for what web and mobile render. Every history here
 * is built by applying real messages, never by hand.
 */
import {
  EnvironmentId,
  HOST_STATS_CONTRACT_VERSION,
  type HostStatsBucket,
  type HostStatsMessage,
  type HostStatsSample,
  type HostStatsSampleMessage,
  type HostStatsSnapshotMessage,
  type ServerConfig,
  fromHostStatsBucketColumns,
  toHostStatsBucketColumns,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { BearerConnectionTarget, PrimaryConnectionTarget } from "../connection/model.ts";
import type {
  EnvironmentConnectionPhase,
  EnvironmentPresentation,
} from "../connection/presentation.ts";
import {
  mountEnvironmentSubscription,
  type MountedEnvironmentSubscription,
} from "./environmentSubscriptionHarness.ts";
import {
  accumulateHostStatsMessages,
  applyHostStatsMessage,
  hasHostStatsCapability,
  hostStatsRetryDelayMs,
  projectHostStats,
  readHostStatsSubscription,
  type HostStatsHistory,
  type HostStatsHostView,
  type HostStatsRow,
  type HostStatsRowId,
  type HostStatsSubscription,
} from "./projectHostStats.ts";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const BUCKET_MS = 5 * MINUTE;
const WINDOW_MS = 12 * HOUR;
const SLOTS = WINDOW_MS / BUCKET_MS;
const GB = 1024 ** 3;
const gb = (count: number) => Math.round(count * GB);

/** Host clock when the first snapshot is built; its bucket starts at 12:00:00. */
const T0 = Date.parse("2026-09-29T12:02:30.000Z");
const alignedStart = (hostTime: number) => Math.floor(hostTime / BUCKET_MS) * BUCKET_MS;
const CURRENT_BUCKET = alignedStart(T0);
/** `series[0]` for a host whose clock reads T0: 143 buckets before the current one. */
const SERIES_START_AT_T0 = CURRENT_BUCKET - (SLOTS - 1) * BUCKET_MS;

const ROW_IDS: ReadonlyArray<HostStatsRowId> = [
  "cpu",
  "memory",
  "swap",
  "disk",
  "gpu",
  "temperature",
  "network",
  "agents",
  "servers",
];

/** Shaped on vigilia-home: 16 cores, 30 GB of RAM, 7.6 GB of swap, one AMD card. */
function sample(sampledAt: number, overrides: Partial<HostStatsSample> = {}): HostStatsSample {
  return {
    sampledAt,
    cpuPercent: 17,
    load1: 2.46,
    cpuCount: 16,
    memUsedBytes: gb(14.6),
    memTotalBytes: gb(30),
    swapUsedBytes: gb(4.2),
    swapTotalBytes: gb(7.6),
    diskUsedBytes: gb(160),
    diskTotalBytes: gb(953),
    gpus: [
      {
        id: "card0",
        vendor: "amd",
        state: "active",
        busyPercent: 12,
        vramUsedBytes: gb(1),
        vramTotalBytes: gb(8),
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

function bucket(start: number, overrides: Partial<HostStatsBucket> = {}): HostStatsBucket {
  return {
    start,
    sampleCount: 5,
    cpuAvg: 20,
    cpuMax: 35,
    memUsedAvg: gb(14),
    swapUsedAvg: gb(4),
    diskUsedAvg: gb(160),
    gpuBusyAvg: 10,
    gpuBusyMax: 30,
    cpuTempMax: 50,
    netRxAvg: 10_000,
    netTxAvg: 2_000,
    agentsRunningMax: 4,
    ...overrides,
  };
}

function snapshot(input: {
  readonly serverNow: number;
  readonly buckets: ReadonlyArray<HostStatsBucket>;
  readonly latest: HostStatsSample | null;
  readonly contractVersion?: number;
}): HostStatsSnapshotMessage {
  return {
    type: "snapshot",
    contractVersion: input.contractVersion ?? HOST_STATS_CONTRACT_VERSION,
    serverNow: input.serverNow,
    sampleIntervalMs: MINUTE,
    bucketMs: BUCKET_MS,
    windowMs: WINDOW_MS,
    host: {
      hostname: "vigilia-home",
      platform: "linux",
      arch: "x64",
      cpuCount: 16,
      bootedAt: T0 - 26 * HOUR,
    },
    buckets: toHostStatsBucketColumns(input.buckets, BUCKET_MS),
    latest: input.latest,
  };
}

function update(
  sampled: HostStatsSample,
  folded: HostStatsBucket,
  serverNow = sampled.sampledAt + 400,
): HostStatsSampleMessage {
  return { type: "sample", serverNow, sample: sampled, bucket: folded };
}

/** Applies each message as received at its own `serverNow`: a host clock that agrees with ours. */
function applyAll(
  messages: ReadonlyArray<HostStatsMessage>,
  start: HostStatsHistory | null = null,
) {
  return messages.reduce<HostStatsHistory | null>(
    (history, message) => applyHostStatsMessage(history, message, message.serverNow),
    start,
  );
}

function historyOf(history: HostStatsHistory | null) {
  expect(history).not.toBeNull();
  return { buckets: history!.buckets, latest: history!.latest };
}

function presentation(input: {
  readonly id: string;
  readonly label?: string;
  readonly phase?: EnvironmentConnectionPhase;
  readonly primary?: boolean;
  /** `absent` is a server from before the hosts dock: no `hostStats` key at all. */
  readonly capability?: boolean | "absent";
}): EnvironmentPresentation {
  const environmentId = EnvironmentId.make(input.id);
  const label = input.label ?? input.id;
  const target = input.primary
    ? new PrimaryConnectionTarget({
        environmentId,
        label,
        httpBaseUrl: "https://primary.example.test",
        wsBaseUrl: "wss://primary.example.test",
      })
    : new BearerConnectionTarget({ environmentId, label, connectionId: `connection-${input.id}` });
  const entry: ConnectionCatalogEntry = { target, profile: Option.none(), enabled: true };
  const capability = input.capability ?? true;
  const serverConfig = {
    environment: {
      capabilities: capability === "absent" ? {} : { hostStats: capability },
    },
  } as unknown as ServerConfig;
  return {
    entry,
    connection: { phase: input.phase ?? "connected", error: null, traceId: null },
    serverConfig,
  };
}

function project(
  hosts: ReadonlyArray<{
    readonly presentation: EnvironmentPresentation;
    readonly history?: HostStatsHistory | null;
    readonly failed?: boolean;
  }>,
  nowLocal: number,
  extraHistories: ReadonlyArray<readonly [EnvironmentId, HostStatsHistory | null]> = [],
): ReadonlyArray<HostStatsHostView> {
  return projectHostStats({
    presentations: new Map(
      hosts.map((host) => [host.presentation.entry.target.environmentId, host.presentation]),
    ),
    subscriptions: new Map([
      ...hosts.map(
        (host) =>
          [
            host.presentation.entry.target.environmentId,
            { history: host.history ?? null, failed: host.failed ?? false },
          ] as const,
      ),
      ...extraHistories.map(
        ([environmentId, history]) => [environmentId, { history, failed: false }] as const,
      ),
    ]),
    nowLocal,
  });
}

function onlyHost(views: ReadonlyArray<HostStatsHostView>): HostStatsHostView {
  expect(views).toHaveLength(1);
  return views[0]!;
}

function rowsOf(view: HostStatsHostView): Readonly<Record<HostStatsRowId, HostStatsRow>> {
  expect(view.rows).not.toBeNull();
  return view.rows!;
}

function permutations<T>(items: ReadonlyArray<T>): ReadonlyArray<ReadonlyArray<T>> {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}

// A snapshot built at 12:00:10 whose latest sample closed out the 11:55 bucket,
// then four updates a minute apart that cross into the 12:05 bucket.
const SNAPSHOT_AT = CURRENT_BUCKET + 10 * SECOND;
const HELD_BUCKETS = [
  bucket(CURRENT_BUCKET - 2 * BUCKET_MS, { cpuAvg: 21 }),
  bucket(CURRENT_BUCKET - BUCKET_MS, { cpuAvg: 22 }),
];
const FIRST_SNAPSHOT = snapshot({
  serverNow: SNAPSHOT_AT,
  buckets: HELD_BUCKETS,
  latest: sample(CURRENT_BUCKET - 20 * SECOND),
});
const UPDATES = [
  update(
    sample(CURRENT_BUCKET + 40 * SECOND, { cpuPercent: 31 }),
    bucket(CURRENT_BUCKET, { sampleCount: 1, cpuAvg: 31 }),
  ),
  update(
    sample(CURRENT_BUCKET + 100 * SECOND, { cpuPercent: 33 }),
    bucket(CURRENT_BUCKET, { sampleCount: 2, cpuAvg: 32 }),
  ),
  update(
    sample(CURRENT_BUCKET + BUCKET_MS + 40 * SECOND, { cpuPercent: 41 }),
    bucket(CURRENT_BUCKET + BUCKET_MS, { sampleCount: 1, cpuAvg: 41 }),
  ),
  update(
    sample(CURRENT_BUCKET + BUCKET_MS + 100 * SECOND, { cpuPercent: 43 }),
    bucket(CURRENT_BUCKET + BUCKET_MS, { sampleCount: 2, cpuAvg: 42 }),
  ),
] as const;
const HISTORY_AFTER_UPDATES = {
  buckets: [...HELD_BUCKETS, UPDATES[1].bucket, UPDATES[3].bucket],
  latest: UPDATES[3].sample,
};

const mounted: MountedEnvironmentSubscription<unknown, unknown>[] = [];
afterEach(() => {
  for (const subscription of mounted.splice(0)) subscription.dispose();
});

describe("host stats history: idempotent merge (criterion 1)", () => {
  it("host stats history after a snapshot and in-order updates holds one bucket per start", () => {
    expect(historyOf(applyAll([FIRST_SNAPSHOT, ...UPDATES]))).toEqual(HISTORY_AFTER_UPDATES);
  });

  it("host stats history is the same for every order of updates, duplicates included", () => {
    for (const order of permutations(UPDATES)) {
      const withDuplicates = [order[2]!, ...order, order[0]!, order[3]!];
      expect(historyOf(applyAll([FIRST_SNAPSHOT, ...withDuplicates]))).toEqual(
        HISTORY_AFTER_UPDATES,
      );
    }
  });

  it("host stats history ignores an update older than the latest sample", () => {
    const olderThanLatest = update(
      sample(CURRENT_BUCKET - 80 * SECOND, { cpuPercent: 99 }),
      bucket(CURRENT_BUCKET - BUCKET_MS, { sampleCount: 4, cpuAvg: 99 }),
    );
    expect(historyOf(applyAll([FIRST_SNAPSHOT, olderThanLatest]))).toEqual(
      historyOf(applyAll([FIRST_SNAPSHOT])),
    );
  });

  it("host stats history takes a reconnect snapshot that overlaps held buckets as the whole history", () => {
    const reconnect = snapshot({
      serverNow: CURRENT_BUCKET + 3 * MINUTE,
      buckets: [
        bucket(CURRENT_BUCKET - 2 * BUCKET_MS, { cpuAvg: 61 }),
        bucket(CURRENT_BUCKET - BUCKET_MS, { cpuAvg: 62 }),
        bucket(CURRENT_BUCKET, { sampleCount: 3, cpuAvg: 63 }),
      ],
      latest: sample(CURRENT_BUCKET + 160 * SECOND, { cpuPercent: 64 }),
    });
    const history = applyAll([FIRST_SNAPSHOT, UPDATES[0], UPDATES[1], reconnect]);
    expect(historyOf(history)).toEqual({
      buckets: fromHostStatsBucketColumns(reconnect.buckets),
      latest: reconnect.latest,
    });
  });

  it("host stats history drops an update whose bucket is 13 hours old", () => {
    const empty = snapshot({ serverNow: T0, buckets: [], latest: null });
    const thirteenHoursAgo = T0 - 13 * HOUR;
    const ancient = update(sample(thirteenHoursAgo), bucket(alignedStart(thirteenHoursAgo)), T0);
    expect(historyOf(applyAll([empty, ancient])).buckets).toEqual([]);
  });

  it("host stats history trims buckets that fall out of 12 hours of host time", () => {
    const oldest = bucket(SERIES_START_AT_T0, { cpuAvg: 11 });
    const kept = bucket(CURRENT_BUCKET - 100 * BUCKET_MS, { cpuAvg: 12 });
    const start = snapshot({ serverNow: T0, buckets: [oldest, kept], latest: sample(T0 - MINUTE) });
    const anHourLater = T0 + HOUR;
    const later = update(sample(anHourLater - 20 * SECOND), bucket(alignedStart(anHourLater)));
    const history = historyOf(applyAll([start, later]));
    expect(history.buckets.map((held) => held.start)).toEqual([
      kept.start,
      alignedStart(anHourLater),
    ]);
  });

  it("host stats atom keeps a snapshot and an update that land in one burst", async () => {
    const subscription = await mountEnvironmentSubscription<
      HostStatsMessage,
      HostStatsSubscription
    >(accumulateHostStatsMessages);
    mounted.push(subscription as MountedEnvironmentSubscription<unknown, unknown>);
    await subscription.offerBurst([FIRST_SNAPSHOT, UPDATES[0]]);
    expect(historyOf(subscription.current()?.history ?? null)).toEqual({
      buckets: [...HELD_BUCKETS, UPDATES[0].bucket],
      latest: UPDATES[0].sample,
    });
  });

  it("host stats atom accumulates updates that land one at a time", async () => {
    const subscription = await mountEnvironmentSubscription<
      HostStatsMessage,
      HostStatsSubscription
    >(accumulateHostStatsMessages);
    mounted.push(subscription as MountedEnvironmentSubscription<unknown, unknown>);
    for (const message of [FIRST_SNAPSHOT, ...UPDATES]) await subscription.offerBurst([message]);
    expect(historyOf(subscription.current()?.history ?? null)).toEqual(HISTORY_AFTER_UPDATES);
  });
});

describe("host stats series: a 12-hour axis on the host clock (criterion 2)", () => {
  const withGap = snapshot({
    serverNow: T0,
    buckets: [
      bucket(SERIES_START_AT_T0, { cpuAvg: 5 }),
      bucket(CURRENT_BUCKET - 2 * BUCKET_MS, { cpuAvg: 30 }),
      // CURRENT_BUCKET - BUCKET_MS is missing: the host was down for it.
      bucket(CURRENT_BUCKET, { cpuAvg: 40 }),
    ],
    latest: sample(T0 - 20 * SECOND),
  });

  it("host stats series places each bucket at its slot and leaves a missing bucket as a gap", () => {
    const view = onlyHost(
      project([{ presentation: presentation({ id: "a" }), history: applyAll([withGap]) }], T0),
    );
    expect(view.bucketMs).toBe(BUCKET_MS);
    expect(view.seriesStartMs).toBe(SERIES_START_AT_T0);
    const cpu = rowsOf(view).cpu.series;
    expect(cpu).toHaveLength(SLOTS);
    expect(cpu![0]).toBe(5);
    expect(cpu![SLOTS - 3]).toBe(30);
    expect(cpu![SLOTS - 2]).toBeNull();
    expect(cpu![SLOTS - 1]).toBe(40);
    expect(cpu!.filter((slot) => slot !== null)).toEqual([5, 30, 40]);
  });

  it("host stats series never interpolates a missing bucket in any row", () => {
    const view = onlyHost(
      project([{ presentation: presentation({ id: "a" }), history: applyAll([withGap]) }], T0),
    );
    for (const id of ROW_IDS) {
      const series = rowsOf(view)[id].series;
      if (series === null) continue;
      expect(series, id).toHaveLength(SLOTS);
      expect(series[SLOTS - 2], id).toBeNull();
    }
  });

  it("host stats series anchors the axis to the host clock, not the local one", () => {
    const receivedAtLocal = T0 - 10 * MINUTE;
    const history = applyHostStatsMessage(null, withGap, receivedAtLocal);
    const view = onlyHost(
      project([{ presentation: presentation({ id: "a" }), history }], receivedAtLocal + SECOND),
    );
    expect(view.seriesStartMs).toBe(SERIES_START_AT_T0);
    expect(rowsOf(view).cpu.series![SLOTS - 1]).toBe(40);
  });
});

describe("host stats ages: the host clock offset (criterion 3)", () => {
  const message = snapshot({
    serverNow: T0,
    buckets: [bucket(CURRENT_BUCKET)],
    latest: sample(T0 - 30 * SECOND),
  });

  for (const [direction, skew] of [
    ["ahead of", 10 * MINUTE],
    ["behind", -10 * MINUTE],
  ] as const) {
    it(`host stats age is correct for a host whose clock is 10 minutes ${direction} ours`, () => {
      const receivedAtLocal = T0 - skew;
      const history = applyHostStatsMessage(null, message, receivedAtLocal);
      expect(history!.offsetMs).toBe(skew);
      const view = onlyHost(
        project(
          [{ presentation: presentation({ id: "a" }), history }],
          receivedAtLocal + 20 * SECOND,
        ),
      );
      expect(view.state).toBe("live");
      expect(view.lastReadingAgeMs).toBe(50 * SECOND);
      expect(view.uptimeMs).toBe(26 * HOUR + 20 * SECOND);
    });
  }

  it("host stats offset follows the latest message's serverNow", () => {
    const history = applyAll([FIRST_SNAPSHOT]);
    const next = applyHostStatsMessage(history, UPDATES[0], UPDATES[0].serverNow - 7 * SECOND);
    expect(next!.offsetMs).toBe(7 * SECOND);
  });

  it("host stats age of a sample stamped after serverNow is clamped to zero", () => {
    const future = snapshot({ serverNow: T0, buckets: [], latest: sample(T0 + 5 * SECOND) });
    const view = onlyHost(
      project([{ presentation: presentation({ id: "a" }), history: applyAll([future]) }], T0),
    );
    expect(view.lastReadingAgeMs).toBe(0);
    expect(view.state).toBe("live");
  });
});

describe("host stats staleness by sample age (criterion 4)", () => {
  const message = snapshot({
    serverNow: T0,
    buckets: [bucket(CURRENT_BUCKET)],
    latest: sample(T0),
  });

  it("host stats marks a connected host stale once its sample is older than 150 seconds", () => {
    const view = onlyHost(
      project(
        [{ presentation: presentation({ id: "a" }), history: applyAll([message]) }],
        T0 + 151 * SECOND,
      ),
    );
    expect(view.state).toBe("stale");
    expect(view.lastReadingAgeMs).toBe(151 * SECOND);
    expect(rowsOf(view).cpu.value).toBe(17);
  });

  it("host stats keeps a connected host live while its sample is 149 seconds old", () => {
    const view = onlyHost(
      project(
        [{ presentation: presentation({ id: "a" }), history: applyAll([message]) }],
        T0 + 149 * SECOND,
      ),
    );
    expect(view.state).toBe("live");
  });
});

describe("host stats offline hosts (criterion 5)", () => {
  const message = snapshot({
    serverNow: T0,
    buckets: [bucket(CURRENT_BUCKET, { cpuAvg: 44 })],
    latest: sample(T0 - 10 * SECOND, { cpuPercent: 45 }),
  });

  for (const phase of ["reconnecting", "offline", "error"] as const) {
    it(`host stats keeps the last history of a host in phase ${phase} and labels it offline`, () => {
      const view = onlyHost(
        project(
          [{ presentation: presentation({ id: "a", phase }), history: applyAll([message]) }],
          T0 + 5 * MINUTE,
        ),
      );
      expect(view.state).toBe("offline");
      expect(view.lastReadingAgeMs).toBe(5 * MINUTE + 10 * SECOND);
      const rows = rowsOf(view);
      expect(rows.cpu.value).toBe(45);
      expect(rows.cpu.series).not.toBeNull();
      expect(rows.cpu.series!.filter((slot) => slot !== null)).toEqual([44]);
    });
  }

  it("host stats shows a host never read this session as offline with no values", () => {
    const view = onlyHost(
      project([{ presentation: presentation({ id: "a", phase: "offline" }) }], T0),
    );
    expect(view.state).toBe("offline");
    expect(view.lastReadingAgeMs).toBeNull();
    expect(view.rows).toBeNull();
  });
});

describe("host stats servers that need an update (criterion 6)", () => {
  it("host stats marks a connected server without the capability as needs-update", () => {
    const view = onlyHost(
      project([{ presentation: presentation({ id: "a", capability: "absent" }) }], T0),
    );
    expect(view.state).toBe("needs-update");
    expect(view.rows).toBeNull();
  });

  it("host stats marks a connected server whose capability is false as needs-update", () => {
    const view = onlyHost(
      project([{ presentation: presentation({ id: "a", capability: false }) }], T0),
    );
    expect(view.state).toBe("needs-update");
  });

  it("host stats marks a connected server on another contract version as needs-update", () => {
    const other = snapshot({
      serverNow: T0,
      buckets: [bucket(CURRENT_BUCKET)],
      latest: sample(T0),
      contractVersion: HOST_STATS_CONTRACT_VERSION + 1,
    });
    const view = onlyHost(
      project([{ presentation: presentation({ id: "a" }), history: applyAll([other]) }], T0),
    );
    expect(view.state).toBe("needs-update");
    expect(view.rows).toBeNull();
  });

  it("host stats shows a capable connected server with no snapshot yet as pending", () => {
    const view = onlyHost(project([{ presentation: presentation({ id: "a" }) }], T0));
    expect(view.state).toBe("pending");
    expect(view.rows).toBeNull();
  });
});

describe("host stats row levels (criterion 7)", () => {
  function rowsFor(latest: HostStatsSample) {
    const message = snapshot({ serverNow: T0, buckets: [bucket(CURRENT_BUCKET)], latest });
    return rowsOf(
      onlyHost(
        project([{ presentation: presentation({ id: "a" }), history: applyAll([message]) }], T0),
      ),
    );
  }

  it("host stats marks every row of a healthy host ok", () => {
    const rows = rowsFor(sample(T0));
    for (const id of ROW_IDS) expect(rows[id].level, id).toBe("ok");
    expect(rows.cpu.secondaryLevel).toBe("ok");
  });

  it("host stats colours each row of a stressed host from the agreed levels", () => {
    const rows = rowsFor(
      sample(T0, {
        cpuPercent: 96,
        load1: 16 * 1.2,
        memUsedBytes: gb(27.9),
        swapUsedBytes: gb(6.9),
        diskUsedBytes: gb(918),
        cpuTemperatureC: 88,
        netRxBytesPerSec: 1e9,
        netTxBytesPerSec: 1e9,
        agentsRunning: 40,
        mesuraServers: { installed: 3, dev: 30 },
        gpus: [
          {
            id: "card0",
            vendor: "amd",
            state: "active",
            busyPercent: 99,
            vramUsedBytes: gb(1),
            vramTotalBytes: gb(8),
          },
        ],
      }),
    );
    expect(rows.cpu.value).toBe(96);
    expect(rows.cpu.level).toBe("crit");
    expect(rows.cpu.secondaryLevel).toBe("warn");
    expect(rows.memory.level).toBe("warn");
    expect(rows.swap.level).toBe("crit");
    expect(rows.disk.level).toBe("crit");
    expect(rows.temperature.level).toBe("warn");
    // GPU busy never colours; only its memory does.
    expect(rows.gpu.level).toBe("ok");
    expect(rows.network.level).toBe("ok");
    expect(rows.agents.level).toBe("ok");
    expect(rows.servers.level).toBe("ok");
  });

  it("host stats colours the GPU row from its memory", () => {
    const rows = rowsFor(
      sample(T0, {
        gpus: [
          {
            id: "card0",
            vendor: "amd",
            state: "active",
            busyPercent: 5,
            vramUsedBytes: gb(7.8),
            vramTotalBytes: gb(8),
          },
        ],
      }),
    );
    expect(rows.gpu.level).toBe("crit");
  });

  it("host stats colours load per core on the CPU row from load1 over the core count", () => {
    expect(rowsFor(sample(T0, { load1: 16 * 1.6 })).cpu.secondaryLevel).toBe("crit");
    expect(rowsFor(sample(T0, { load1: 16 * 0.9 })).cpu.secondaryLevel).toBe("ok");
  });
});

describe("host stats rows that are not available (criterion 8)", () => {
  function rowsFor(latest: HostStatsSample, buckets: ReadonlyArray<HostStatsBucket>) {
    const message = snapshot({ serverNow: T0, buckets, latest });
    return rowsOf(
      onlyHost(
        project([{ presentation: presentation({ id: "a" }), history: applyAll([message]) }], T0),
      ),
    );
  }

  it("host stats marks only the null metric's row not-available and omits its sparkline", () => {
    const rows = rowsFor(sample(T0, { cpuTemperatureC: null }), [
      bucket(CURRENT_BUCKET - BUCKET_MS, { cpuTempMax: null }),
      bucket(CURRENT_BUCKET, { cpuTempMax: null }),
    ]);
    expect(rows.temperature.availability).toBe("not-available");
    expect(rows.temperature.value).toBeNull();
    expect(rows.temperature.level).toBeNull();
    expect(rows.temperature.series).toBeNull();
    for (const id of ROW_IDS.filter((row) => row !== "temperature")) {
      expect(rows[id].availability, id).toBe("available");
    }
    expect(rows.cpu.series).not.toBeNull();
  });

  it("host stats marks the GPU row not-available on a host without graphics", () => {
    const rows = rowsFor(sample(T0, { gpus: null }), [
      bucket(CURRENT_BUCKET, { gpuBusyAvg: null, gpuBusyMax: null }),
    ]);
    expect(rows.gpu.availability).toBe("not-available");
    expect(rows.gpu.series).toBeNull();
    expect(rows.cpu.availability).toBe("available");
  });

  it("host stats marks swap not-available, not 0 %, on a host with no swap", () => {
    const rows = rowsFor(sample(T0, { swapUsedBytes: 0, swapTotalBytes: 0 }), [
      bucket(CURRENT_BUCKET, { swapUsedAvg: 0 }),
    ]);
    expect(rows.swap.availability).toBe("not-available");
    expect(rows.swap.value).toBeNull();
    expect(rows.swap.level).toBeNull();
  });

  it("host stats leaves a null bucket value as a gap, never a zero", () => {
    const rows = rowsFor(sample(T0), [
      bucket(CURRENT_BUCKET - BUCKET_MS, { cpuAvg: null }),
      bucket(CURRENT_BUCKET, { cpuAvg: 25 }),
    ]);
    expect(rows.cpu.series![SLOTS - 2]).toBeNull();
    expect(rows.cpu.series![SLOTS - 1]).toBe(25);
  });
});

describe("host stats host list", () => {
  const message = snapshot({
    serverNow: T0,
    buckets: [bucket(CURRENT_BUCKET)],
    latest: sample(T0),
  });

  it("host stats orders the primary environment first, then by label", () => {
    const views = project(
      [
        { presentation: presentation({ id: "z", label: "zeta" }) },
        { presentation: presentation({ id: "a", label: "alpha" }) },
        { presentation: presentation({ id: "p", label: "mu", primary: true }) },
      ],
      T0,
    );
    expect(views.map((view) => [view.label, view.isPrimary])).toEqual([
      ["mu", true],
      ["alpha", false],
      ["zeta", false],
    ]);
  });

  it("host stats drops a host whose environment left the catalog", () => {
    const views = project(
      [{ presentation: presentation({ id: "kept" }), history: applyAll([message]) }],
      T0,
      [[EnvironmentId.make("removed"), applyAll([message])]],
    );
    expect(views.map((view) => view.environmentId)).toEqual([EnvironmentId.make("kept")]);
  });

  it("host stats labels a host from its catalog entry and platform from its facts", () => {
    const view = onlyHost(
      project(
        [
          {
            presentation: presentation({ id: "a", label: "vigilia-home" }),
            history: applyAll([message]),
          },
        ],
        T0,
      ),
    );
    expect(view.label).toBe("vigilia-home");
    expect(view.platform).toBe("linux");
  });
});

describe("host stats messages the client cannot read", () => {
  it("host stats keeps the previous history when a snapshot's bucket columns are malformed", () => {
    const held = applyAll([FIRST_SNAPSHOT, UPDATES[0]]);
    const malformed: HostStatsSnapshotMessage = {
      ...FIRST_SNAPSHOT,
      serverNow: SNAPSHOT_AT + MINUTE,
      buckets: { ...FIRST_SNAPSHOT.buckets, slots: [1, 0] },
    };
    expect(() => applyAll([malformed], held)).not.toThrow();
    expect(historyOf(applyAll([malformed], held))).toEqual(historyOf(held));
  });

  it("host stats never throws on a snapshot from another contract version and reads it as needs-update", async () => {
    const other: HostStatsSnapshotMessage = {
      ...FIRST_SNAPSHOT,
      contractVersion: HOST_STATS_CONTRACT_VERSION + 1,
      buckets: { ...FIRST_SNAPSHOT.buckets, slots: [0] },
    };
    const subscription = await mountEnvironmentSubscription<
      HostStatsMessage,
      HostStatsSubscription
    >(accumulateHostStatsMessages);
    mounted.push(subscription as MountedEnvironmentSubscription<unknown, unknown>);
    await subscription.offerBurst([other, UPDATES[0]]);
    const view = onlyHost(
      project(
        [
          {
            presentation: presentation({ id: "a" }),
            history: subscription.current()?.history ?? null,
          },
        ],
        T0,
      ),
    );
    expect(view.state).toBe("needs-update");
    expect(view.rows).toBeNull();
  });
});

describe("host stats subscriptions that failed", () => {
  /** Stands in for a chunk the RPC client cannot decode, which it raises as a defect. */
  const UNDECODABLE = "undecodable" as const;
  const dieOnUndecodable = (messages: Stream.Stream<HostStatsMessage | typeof UNDECODABLE>) =>
    accumulateHostStatsMessages(
      messages.pipe(
        Stream.mapEffect((message) =>
          message === UNDECODABLE
            ? Effect.die(new Error("Expected HostStatsMessage, got an unknown shape"))
            : Effect.succeed(message),
        ),
      ),
    );

  async function failedAfter(messages: ReadonlyArray<HostStatsMessage>) {
    const subscription = await mountEnvironmentSubscription<
      HostStatsMessage | typeof UNDECODABLE,
      HostStatsSubscription
    >(dieOnUndecodable);
    mounted.push(subscription as MountedEnvironmentSubscription<unknown, unknown>);
    for (const message of messages) await subscription.offerBurst([message]);
    await subscription.offerBurst([UNDECODABLE]);
    return readHostStatsSubscription(subscription.result());
  }

  it("host stats keeps the history of a subscription that failed after a snapshot and ages it", async () => {
    const read = await failedAfter([FIRST_SNAPSHOT, UPDATES[0]]);
    expect(read.failed).toBe(true);
    expect(historyOf(read.history)).toEqual({
      buckets: [...HELD_BUCKETS, UPDATES[0].bucket],
      latest: UPDATES[0].sample,
    });
    // The harness stamps receipt with the real clock, so convert host time to local time.
    const sampledAt = UPDATES[0].sample.sampledAt;
    const atHostTime = (hostTime: number) =>
      onlyHost(
        project(
          [{ presentation: presentation({ id: "a" }), history: read.history, failed: true }],
          hostTime - read.history!.offsetMs,
        ),
      );
    expect(atHostTime(sampledAt + 10 * SECOND).state).toBe("live");
    const later = atHostTime(sampledAt + 151 * SECOND);
    expect(later.state).toBe("stale");
    expect(rowsOf(later).cpu.value).toBe(31);
  });

  it("host stats marks a connected capable server whose subscription failed before any snapshot as needs-update", async () => {
    const read = await failedAfter([]);
    expect(read).toEqual({ history: null, failed: true });
    const view = onlyHost(
      project([{ presentation: presentation({ id: "a" }), history: null, failed: true }], T0),
    );
    expect(view.state).toBe("needs-update");
    expect(view.rows).toBeNull();
  });

  it("host stats reads a failed subscription with no value from the atom result alone", () => {
    const read = readHostStatsSubscription(
      AsyncResult.failure<HostStatsSubscription, never>(Cause.die(new Error("decode"))),
    );
    expect(read).toEqual({ history: null, failed: true });
    expect(
      readHostStatsSubscription(AsyncResult.initial<HostStatsSubscription, never>(true)),
    ).toEqual({
      history: null,
      failed: false,
    });
  });

  it("host stats shows a disconnected server whose subscription failed as offline", () => {
    const view = onlyHost(
      project(
        [{ presentation: presentation({ id: "a", phase: "reconnecting" }), failed: true }],
        T0,
      ),
    );
    expect(view.state).toBe("offline");
  });
});

describe("host stats sleeping GPUs", () => {
  const gpu = (
    id: string,
    state: "active" | "sleeping" | "unavailable",
    busyPercent: number | null,
  ) => ({
    id,
    vendor: "amd" as const,
    state,
    busyPercent,
    vramUsedBytes: busyPercent === null ? null : gb(1),
    vramTotalBytes: busyPercent === null ? null : gb(8),
  });
  function gpuRowFor(gpus: HostStatsSample["gpus"]) {
    const message = snapshot({
      serverNow: T0,
      buckets: [bucket(CURRENT_BUCKET)],
      latest: sample(T0, { gpus }),
    });
    return rowsOf(
      onlyHost(
        project([{ presentation: presentation({ id: "a" }), history: applyAll([message]) }], T0),
      ),
    ).gpu;
  }

  it("host stats marks the GPU row sleeping when every GPU is runtime-suspended", () => {
    const row = gpuRowFor([gpu("card0", "sleeping", null)]);
    expect(row.availability).toBe("sleeping");
    expect(row.value).toBeNull();
    expect(row.level).toBeNull();
  });

  it("host stats shows the busiest active GPU when another GPU sleeps", () => {
    const row = gpuRowFor([gpu("card0", "sleeping", null), gpu("card1", "active", 23)]);
    expect(row.availability).toBe("available");
    expect(row.value).toBe(23);
  });
});

describe("host stats updates older than the newest applied (review P1-1)", () => {
  it("host stats never refreshes the clock offset from an update older than the newest applied", () => {
    const history = applyAll([FIRST_SNAPSHOT, UPDATES[1]]);
    const delayed = applyHostStatsMessage(history, UPDATES[0], UPDATES[0].serverNow + 3 * MINUTE);
    expect(delayed).toEqual(history);
  });

  it("host stats ignores a delayed duplicate of the newest update, offset included", () => {
    const history = applyAll([FIRST_SNAPSHOT, UPDATES[0]]);
    const again = applyHostStatsMessage(history, UPDATES[0], UPDATES[0].serverNow + 3 * MINUTE);
    expect(again).toEqual(history);
  });

  it("host stats ignores an older update whose bucket carries more samples than the held one", () => {
    const olderButRicher = update(
      sample(CURRENT_BUCKET - 80 * SECOND, { cpuPercent: 99 }),
      bucket(CURRENT_BUCKET - BUCKET_MS, { sampleCount: 9, cpuAvg: 99 }),
    );
    const before = applyAll([FIRST_SNAPSHOT]);
    expect(applyAll([olderButRicher], before)).toEqual(before);
  });

  it("host stats keeps a stale host stale when a delayed older update arrives", () => {
    const start = snapshot({
      serverNow: T0,
      buckets: [bucket(CURRENT_BUCKET)],
      latest: sample(T0 - 10 * SECOND),
    });
    const late = T0 + 200 * SECOND;
    const old = update(sample(T0 - 70 * SECOND), bucket(CURRENT_BUCKET, { sampleCount: 1 }));
    const history = applyHostStatsMessage(applyAll([start]), old, late);
    const view = onlyHost(project([{ presentation: presentation({ id: "a" }), history }], late));
    expect(view.lastReadingAgeMs).toBe(210 * SECOND);
    expect(view.state).toBe("stale");
  });
});

describe("host stats subscription recovery (review P1-2)", () => {
  it("host stats retries a failed stream after a bounded delay that doubles up to five minutes", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 40].map((failures) => hostStatsRetryDelayMs(failures))).toEqual(
      [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000],
    );
  });

  it("host stats recovers a mounted subscription that failed, keeping its history while it retries", async () => {
    const UNDECODABLE = "undecodable" as const;
    const subscription = await mountEnvironmentSubscription<
      HostStatsMessage | typeof UNDECODABLE,
      HostStatsSubscription
    >((messages) =>
      accumulateHostStatsMessages(
        messages.pipe(
          Stream.mapEffect((message) =>
            message === UNDECODABLE
              ? Effect.die(new Error("Expected HostStatsMessage, got an unknown shape"))
              : Effect.succeed(message),
          ),
        ),
        { initialDelayMs: 0, maxDelayMs: 0 },
      ),
    );
    mounted.push(subscription as MountedEnvironmentSubscription<unknown, unknown>);
    for (const message of [FIRST_SNAPSHOT, UPDATES[0], UNDECODABLE]) {
      await subscription.offerBurst([message]);
    }
    const failed = readHostStatsSubscription(subscription.result());
    expect(failed.failed).toBe(true);
    expect(historyOf(failed.history).latest).toEqual(UPDATES[0].sample);

    const recovery = snapshot({
      serverNow: SNAPSHOT_AT + 5 * MINUTE,
      buckets: [bucket(CURRENT_BUCKET, { cpuAvg: 71 })],
      latest: sample(SNAPSHOT_AT + 5 * MINUTE - 5 * SECOND, { cpuPercent: 72 }),
    });
    await subscription.offerBurst([recovery]);
    const recovered = readHostStatsSubscription(subscription.result());
    expect(recovered.failed).toBe(false);
    expect(historyOf(recovered.history)).toEqual({
      buckets: fromHostStatsBucketColumns(recovery.buckets),
      latest: recovery.latest,
    });
  });
});

describe("host stats clock offset held at its least-delayed estimate", () => {
  const start = snapshot({
    serverNow: T0,
    buckets: [bucket(CURRENT_BUCKET)],
    latest: sample(T0 - 10 * SECOND),
  });
  const inOrder = update(sample(T0 + 50 * SECOND), bucket(CURRENT_BUCKET, { sampleCount: 6 }));
  const stalled = update(sample(T0 + 110 * SECOND), bucket(CURRENT_BUCKET, { sampleCount: 7 }));

  it("host stats keeps a reading's age after a message delayed 10 minutes by a stalled link", () => {
    const arrivedAt = stalled.serverNow + 10 * MINUTE;
    const history = applyHostStatsMessage(applyAll([start, inOrder]), stalled, arrivedAt);
    expect(history!.offsetMs).toBe(0);
    expect(history!.latest).toEqual(stalled.sample);
    const view = onlyHost(
      project([{ presentation: presentation({ id: "a" }), history }], arrivedAt),
    );
    expect(view.lastReadingAgeMs).toBe(arrivedAt - stalled.sample.sampledAt);
    expect(view.state).toBe("stale");
    const onSchedule = onlyHost(
      project(
        [{ presentation: presentation({ id: "a" }), history }],
        stalled.sample.sampledAt + 151 * SECOND,
      ),
    );
    expect(onSchedule.state).toBe("stale");
  });

  it("host stats resets the held offset at a snapshot so a host clock stepped back is followed", () => {
    const steppedBack = snapshot({
      serverNow: T0 + 5 * MINUTE - 10 * MINUTE,
      buckets: [bucket(CURRENT_BUCKET - 2 * BUCKET_MS)],
      latest: sample(T0 + 5 * MINUTE - 10 * MINUTE - 5 * SECOND),
    });
    const receivedAt = T0 + 5 * MINUTE;
    const history = applyHostStatsMessage(applyAll([start, inOrder]), steppedBack, receivedAt);
    expect(history!.offsetMs).toBe(-10 * MINUTE);
    const view = onlyHost(
      project([{ presentation: presentation({ id: "a" }), history }], receivedAt),
    );
    expect(view.lastReadingAgeMs).toBe(5 * SECOND);
    expect(view.state).toBe("live");
  });
});

describe("host stats phase 4 regressions", () => {
  // The as-of merge against a snapshot's buckets is also pinned by "host stats
  // history ignores an update older than the latest sample" and "host stats
  // ignores an older update whose bucket carries more samples than the held one".
  it("host stats lets a newer update replace a snapshot bucket even with fewer samples", () => {
    const refined = update(
      sample(SNAPSHOT_AT + 30 * SECOND),
      bucket(CURRENT_BUCKET - BUCKET_MS, { sampleCount: 2, cpuAvg: 57 }),
    );
    const history = applyAll([FIRST_SNAPSHOT, refined]);
    expect(historyOf(history).buckets).toEqual([HELD_BUCKETS[0], refined.bucket]);
  });

  it("host stats shows a snapshot with no sample yet as pending with every row not available", () => {
    const noSampleYet = snapshot({
      serverNow: T0,
      buckets: [bucket(CURRENT_BUCKET)],
      latest: null,
    });
    const view = onlyHost(
      project([{ presentation: presentation({ id: "a" }), history: applyAll([noSampleYet]) }], T0),
    );
    expect(view.state).toBe("pending");
    expect(view.lastReadingAgeMs).toBeNull();
    const rows = rowsOf(view);
    for (const id of ROW_IDS) expect(rows[id].availability, id).toBe("not-available");
  });

  it("host stats treats a server whose config has not arrived as capability unknown, not needs-update", () => {
    const withoutConfig = { ...presentation({ id: "a" }), serverConfig: null };
    expect(hasHostStatsCapability(withoutConfig)).toBeNull();
    expect(onlyHost(project([{ presentation: withoutConfig }], T0)).state).toBe("pending");
  });

  it("host stats keeps a sleeping GPU row's past series", () => {
    const message = snapshot({
      serverNow: T0,
      buckets: [bucket(CURRENT_BUCKET - BUCKET_MS, { gpuBusyAvg: 14 })],
      latest: sample(T0, {
        gpus: [
          {
            id: "card0",
            vendor: "amd",
            state: "sleeping",
            busyPercent: null,
            vramUsedBytes: null,
            vramTotalBytes: null,
          },
        ],
      }),
    });
    const gpuRow = rowsOf(
      onlyHost(
        project([{ presentation: presentation({ id: "a" }), history: applyAll([message]) }], T0),
      ),
    ).gpu;
    expect(gpuRow.availability).toBe("sleeping");
    expect(gpuRow.series![SLOTS - 2]).toBe(14);
  });

  it("host stats reads a host whose clock stepped back mid-session as older, never younger, until the next snapshot", () => {
    const start = snapshot({
      serverNow: T0,
      buckets: [bucket(CURRENT_BUCKET)],
      latest: sample(T0 - 10 * SECOND),
    });
    let history = applyAll([start]);
    for (const elapsed of [60, 120, 180].map((seconds) => seconds * SECOND)) {
      const steppedBackNow = T0 + elapsed - 10 * MINUTE;
      const message = update(
        sample(steppedBackNow - SECOND),
        bucket(alignedStart(steppedBackNow), { sampleCount: 9 }),
        steppedBackNow,
      );
      history = applyHostStatsMessage(history, message, T0 + elapsed);
      const view = onlyHost(
        project([{ presentation: presentation({ id: "a" }), history }], T0 + elapsed),
      );
      // Never younger than the local time since the last reading kept.
      expect(view.lastReadingAgeMs).toBeGreaterThanOrEqual(elapsed + 10 * SECOND);
    }
    expect(history!.offsetMs).toBe(0);
    const view = onlyHost(
      project([{ presentation: presentation({ id: "a" }), history }], T0 + 180 * SECOND),
    );
    expect(view.state).toBe("stale");
  });

  effectIt.effect("host stats resets the retry backoff once an attempt delivers an update", () =>
    Effect.gen(function* () {
      const attemptStarts: number[] = [];
      let attempts = 0;
      const upstream = Stream.suspend(() => {
        attempts += 1;
        const delivered: Stream.Stream<HostStatsMessage> =
          attempts === 2 ? Stream.make(FIRST_SNAPSHOT, UPDATES[0]) : Stream.empty;
        return Stream.fromEffect(
          Effect.map(Clock.currentTimeMillis, (now) => {
            attemptStarts.push(now);
          }),
        ).pipe(Stream.drain, Stream.concat(delivered), Stream.concat(Stream.die("decode")));
      });
      const fiber = yield* accumulateHostStatsMessages(upstream, {
        initialDelayMs: 1_000,
        maxDelayMs: 60_000,
      }).pipe(Stream.runDrain, Effect.forkChild);
      yield* TestClock.adjust("9 seconds");
      yield* Fiber.interrupt(fiber);
      const first = attemptStarts[0]!;
      // Attempt 2 delivered an update, so attempt 3 waits the initial delay again.
      expect(attemptStarts.slice(0, 5).map((start) => start - first)).toEqual([
        0, 1_000, 2_000, 4_000, 8_000,
      ]);
    }),
  );

  effectIt.effect(
    "host stats ends the fold on an interrupt without reporting a failure or retrying",
    () =>
      Effect.gen(function* () {
        let attempts = 0;
        const emitted: HostStatsSubscription[] = [];
        const upstream = Stream.suspend(() => {
          attempts += 1;
          const snapshotThenInterrupt: Stream.Stream<HostStatsMessage> = Stream.make(
            FIRST_SNAPSHOT,
          ).pipe(Stream.concat(Stream.fromEffect(Effect.interrupt)));
          return snapshotThenInterrupt;
        });
        const exit = yield* accumulateHostStatsMessages(upstream, {
          initialDelayMs: 0,
          maxDelayMs: 0,
        }).pipe(
          Stream.runForEach((subscription) => Effect.sync(() => emitted.push(subscription))),
          Effect.exit,
        );
        expect(Exit.hasInterrupts(exit)).toBe(true);
        expect(attempts).toBe(1);
        expect(emitted.map((subscription) => subscription.failed)).toEqual([false]);
      }),
  );
});
