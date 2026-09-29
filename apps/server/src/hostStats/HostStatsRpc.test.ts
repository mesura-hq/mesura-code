/**
 * Phase 3 fence of the hosts dock plan: acceptance criteria 1, 2, 4 and 5 as
 * wired into each sample, 6 (the stream), 7 (capability and scope) and 8
 * (shared sampling), plus the payload budget carried from phase 2's review.
 *
 * Entry points:
 * - `HostStatsService.layer`, the layer `server.ts` composes. Its `subscribe`
 *   is what the `subscribeHostStats` handler in `ws.ts` streams unchanged
 *   (`latest`, then `changes`), so the messages asserted here are the messages
 *   a client receives. The WebSocket route itself is pinned in `server.test.ts`
 *   ("streams host stats over websocket as a snapshot followed by samples").
 * - `ServerEnvironment.layer` for the advertised capability, and
 *   `requiredScopeForRpcMethod` for the scope the RPC layer enforces.
 *
 * The collector, the agent count query and server discovery are fakes; the
 * clock is `TestClock`. A payload's size is its JSON after the contract
 * schema encodes it, which is what the RPC serializer sends. 1 KB = 1024 bytes.
 */
// @effect-diagnostics nodeBuiltinImport:off - the host facts are compared with Node's own reading.
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ExecutionEnvironmentDescriptor,
  HOST_STATS_CONTRACT_VERSION,
  HostStatsBucket,
  HostStatsMessage,
  type HostStatsMesuraServers,
  type HostStatsSample,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  HostProcessArchitecture,
  HostProcessHostname,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { ServerActivation } from "../serverActivation.ts";
import { HostAgentCounts } from "./HostAgentCounts.ts";
import { HostStatsCollector } from "./HostStatsCollector.ts";
import * as HostStatsServiceModule from "./HostStatsService.ts";
import { MesuraServerDiscovery } from "./mesuraServerDiscovery.ts";

const NOON = Date.parse("2026-09-28T12:00:00.000Z");
const MINUTE = 60_000;
const BUCKET = 5 * MINUTE;
const KB = 1024;
/** The host the layer is told it runs on, so the snapshot's host facts are checkable. */
const HOST = { platform: "linux", arch: "arm64", hostname: "vigilia-home" } as const;

type Message = typeof HostStatsMessage.Type;

const encodeHistoryFile = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ version: Schema.Literal(1), buckets: Schema.Array(HostStatsBucket) }),
  ),
);
type AgentCounts = { readonly agentsRunning: number; readonly agentSessionsOpen: number };

// ---------------------------------------------------------------------------
// Fixtures

/** Whole numbers everywhere, so the wire's rounding leaves every value as it is. */
function plainSample(sampledAt: number): HostStatsSample {
  return {
    sampledAt,
    cpuPercent: 25,
    load1: 1,
    cpuCount: 8,
    memUsedBytes: 4_000,
    memTotalBytes: 16_000,
    swapUsedBytes: 0,
    swapTotalBytes: 8_000,
    diskUsedBytes: 100_000,
    diskTotalBytes: 500_000,
    gpus: null,
    cpuTemperatureC: 45,
    netRxBytesPerSec: 1_000,
    netTxBytesPerSec: 100,
    agentsRunning: null,
    agentSessionsOpen: null,
    mesuraServers: null,
  };
}

function plainBucket(start: number, overrides: Partial<HostStatsBucket> = {}): HostStatsBucket {
  return {
    start,
    sampleCount: 5,
    cpuAvg: 25,
    cpuMax: 30,
    memUsedAvg: 4_000,
    swapUsedAvg: 0,
    diskUsedAvg: 100_000,
    gpuBusyAvg: null,
    gpuBusyMax: null,
    cpuTempMax: 45,
    netRxAvg: 1_000,
    netTxAvg: 100,
    agentsRunningMax: 0,
    ...overrides,
  };
}

/** Every metric present, at full double precision and the largest magnitudes seen. */
function worstCaseBucket(start: number): HostStatsBucket {
  return {
    start,
    sampleCount: 5,
    cpuAvg: 37.28374982374982,
    cpuMax: 99.98374982374982,
    memUsedAvg: 33_421_234_567.123455,
    swapUsedAvg: 8_123_456_789.987654,
    diskUsedAvg: 3_999_123_456_789.125,
    gpuBusyAvg: 12.345678901234567,
    gpuBusyMax: 99.87654321098765,
    cpuTempMax: 87.12345678901234,
    netRxAvg: 123_456_789.12345678,
    netTxAvg: 98_765_432.10987654,
    agentsRunningMax: 12,
  };
}

/** arch-laptop's shape: two GPUs, both awake, every metric present at full precision. */
function worstCaseSample(sampledAt: number): HostStatsSample {
  return {
    sampledAt,
    cpuPercent: 37.28374982374982,
    load1: 12.345678901234567,
    cpuCount: 128,
    memUsedBytes: 33_421_234_567,
    memTotalBytes: 34_359_738_368,
    swapUsedBytes: 8_123_456_789,
    swapTotalBytes: 8_589_934_592,
    diskUsedBytes: 3_999_123_456_789,
    diskTotalBytes: 4_000_787_030_016,
    gpus: [
      {
        id: "0000:64:00.0",
        vendor: "nvidia",
        state: "active",
        busyPercent: 37.28374982374982,
        vramUsedBytes: 8_589_934_592,
        vramTotalBytes: 17_179_869_184,
      },
      {
        id: "0000:c5:00.0",
        vendor: "amd",
        state: "active",
        busyPercent: 99.87654321098765,
        vramUsedBytes: 536_870_912,
        vramTotalBytes: 536_870_912,
      },
    ],
    cpuTemperatureC: 87.12345678901234,
    netRxBytesPerSec: 123_456_789.12345678,
    netTxBytesPerSec: 98_765_432.10987654,
    agentsRunning: null,
    agentSessionsOpen: null,
    mesuraServers: null,
  };
}

interface HarnessOptions {
  readonly history?: ReadonlyArray<HostStatsBucket>;
  readonly sampleFor?: (sampledAt: number) => HostStatsSample;
  readonly agentCounts?: Effect.Effect<AgentCounts, PersistenceSqlError>;
  readonly mesuraServers?: Effect.Effect<HostStatsMesuraServers | null>;
}

/**
 * `HostStatsService.layer` as `server.ts` composes it, over fakes. The loop is
 * parked until `activate`; `reads` receives each collector read's time.
 */
const startHostStats = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "host-stats-rpc-" });
    const configContext = yield* Layer.build(ServerConfig.layerTest(directory, directory));
    const config = Context.get(configContext, ServerConfig.ServerConfig);
    if (options.history) {
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(config.stateDir, HostStatsServiceModule.HOST_STATS_HISTORY_FILE_NAME),
        encodeHistoryFile({ version: 1, buckets: options.history }),
      );
    }

    const reads = yield* Queue.unbounded<number>();
    const readCount = yield* Ref.make(0);
    const sampleFor = options.sampleFor ?? plainSample;
    const read = Effect.gen(function* () {
      const sampledAt = yield* Clock.currentTimeMillis;
      yield* Ref.update(readCount, (count) => count + 1);
      yield* Queue.offer(reads, sampledAt);
      return sampleFor(sampledAt);
    });
    const activation = yield* Deferred.make<void>();

    const context = yield* Layer.build(
      HostStatsServiceModule.layer.pipe(
        Layer.provide(Layer.succeed(HostStatsCollector, HostStatsCollector.of({ read }))),
        Layer.provide(
          Layer.succeed(
            HostAgentCounts,
            HostAgentCounts.of({
              read:
                options.agentCounts ?? Effect.succeed({ agentsRunning: 0, agentSessionsOpen: 0 }),
            }),
          ),
        ),
        Layer.provide(
          Layer.succeed(
            MesuraServerDiscovery,
            MesuraServerDiscovery.of({
              discover: options.mesuraServers ?? Effect.succeed({ installed: 1, dev: 0 }),
            }),
          ),
        ),
        Layer.provide(Layer.succeedContext(configContext)),
        Layer.provide(Layer.succeed(ServerActivation, Deferred.await(activation))),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcessPlatform, HOST.platform),
            Layer.succeed(HostProcessArchitecture, HOST.arch),
            Layer.succeed(HostProcessHostname, HOST.hostname),
          ),
        ),
      ),
    );
    return {
      service: Context.get(context, HostStatsServiceModule.HostStatsService),
      readCount,
      reads,
      activate: Deferred.succeed(activation, undefined),
    };
  });

/** Subscribes the way the `subscribeHostStats` handler does and queues every change. */
const subscribeInto = (service: HostStatsServiceModule.HostStatsServiceShape) =>
  Effect.gen(function* () {
    const { latest, changes } = yield* service.subscribe;
    const received = yield* Queue.unbounded<Message>();
    yield* changes.pipe(
      Stream.runForEach((message) => Queue.offer(received, message as Message)),
      Effect.forkScoped({ startImmediately: true }),
    );
    return { snapshot: latest as Message, received };
  });

const takeSample = (received: Queue.Queue<Message>) =>
  Effect.map(Queue.take(received), (message) => {
    assert.strictEqual(message.type, "sample");
    return message as Extract<Message, { type: "sample" }>;
  });

const asSnapshot = (message: Message) => {
  assert.strictEqual(message.type, "snapshot");
  return message as Extract<Message, { type: "snapshot" }>;
};

interface BucketColumns {
  readonly firstStart: number;
  readonly bucketMs: number;
  readonly slots: ReadonlyArray<number>;
  readonly columns: Readonly<Record<string, ReadonlyArray<number | null>>>;
}

/** Rebuilds bucket rows from the columnar encoding, independently of the server's encoder. */
function rowsOf(encoded: BucketColumns): ReadonlyArray<HostStatsBucket> {
  return encoded.slots.map(
    (slot, index) =>
      ({
        start: encoded.firstStart + slot * encoded.bucketMs,
        ...Object.fromEntries(
          Object.entries(encoded.columns).map(([name, column]) => [name, column[index]]),
        ),
      }) as HostStatsBucket,
  );
}

/** The JSON text the RPC serializer sends, and its decoder on the client. */
const encodeWireJson = Schema.encodeSync(Schema.fromJsonString(HostStatsMessage));
const decodeWireJson = Schema.decodeSync(Schema.fromJsonString(HostStatsMessage));
const toWireJson = (message: Message) => encodeWireJson(message);

const encodedBytes = (message: Message) => new TextEncoder().encode(toWireJson(message)).length;

const survivesTheWire = (message: Message) =>
  assert.deepStrictEqual(decodeWireJson(toWireJson(message)), message);

// ---------------------------------------------------------------------------

it.layer(NodeServices.layer)("HostStatsRpc phase 3 fence", (it) => {
  it.effect("phase 3 AC6: subscribeHostStats sends a snapshot, then one update per sample", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOON);
      // A gap where NOON - 10 minutes would be.
      const history = [plainBucket(NOON - 3 * BUCKET), plainBucket(NOON - BUCKET)];
      const harness = yield* startHostStats({ history });
      const first = yield* subscribeInto(harness.service);

      const snapshot = asSnapshot(first.snapshot);
      assert.strictEqual(snapshot.contractVersion, HOST_STATS_CONTRACT_VERSION);
      assert.strictEqual(snapshot.serverNow, NOON);
      assert.strictEqual(snapshot.sampleIntervalMs, 60_000);
      assert.strictEqual(snapshot.bucketMs, 300_000);
      assert.strictEqual(snapshot.windowMs, 12 * 3_600_000);
      assert.strictEqual(snapshot.host.hostname, HOST.hostname);
      assert.strictEqual(snapshot.host.platform, HOST.platform);
      assert.strictEqual(snapshot.host.arch, HOST.arch);
      assert.isAtLeast(snapshot.host.cpuCount, 1);
      // Boot time on the server's clock, so a client reads uptime as serverNow - bootedAt.
      const uptimeMs = snapshot.serverNow - snapshot.host.bootedAt;
      assert.isAtMost(Math.abs(uptimeMs - NodeOS.uptime() * 1000), MINUTE);
      assert.isNull(snapshot.latest);
      assert.deepStrictEqual(
        Object.keys(snapshot.buckets.columns).toSorted(),
        Object.keys(HostStatsBucket.fields)
          .filter((field) => field !== "start")
          .toSorted(),
      );
      assert.deepStrictEqual(snapshot.buckets.slots, [0, 2]);
      assert.deepStrictEqual(rowsOf(snapshot.buckets), history);
      survivesTheWire(snapshot);

      yield* harness.activate;
      for (let minute = 0; minute < 3; minute += 1) {
        if (minute > 0) yield* TestClock.adjust("60 seconds");
        const now = NOON + minute * MINUTE;
        const update = yield* takeSample(first.received);
        assert.strictEqual(update.serverNow, now);
        assert.strictEqual(update.sample.sampledAt, now);
        assert.strictEqual(update.bucket.start, NOON);
        assert.strictEqual(update.bucket.sampleCount, minute + 1);
        assert.deepStrictEqual(update.bucket, (yield* harness.service.buckets).at(-1));
        survivesTheWire(update);
      }
      assert.strictEqual(yield* Queue.size(first.received), 0);
      assert.strictEqual(yield* Ref.get(harness.readCount), 3);

      const later = asSnapshot((yield* subscribeInto(harness.service)).snapshot);
      assert.strictEqual(later.latest?.sampledAt, NOON + 2 * MINUTE);
      assert.deepStrictEqual(later.buckets.slots, [0, 2, 3]);
      assert.deepStrictEqual(rowsOf(later.buckets), yield* harness.service.buckets);
    }),
  );

  it.effect(
    "phase 3 AC6: snapshot bucket columns round percents and temperatures to 0.1, bytes and rates to integers",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOON);
        const harness = yield* startHostStats({
          history: [
            plainBucket(NOON - BUCKET, {
              cpuAvg: 37.26,
              cpuMax: 41.04,
              memUsedAvg: 4_000.6,
              swapUsedAvg: 0.4,
              diskUsedAvg: 100_000.7,
              gpuBusyAvg: 12.34,
              gpuBusyMax: 50.04,
              cpuTempMax: 45.57,
              netRxAvg: 1_234.4,
              netTxAvg: 99.6,
            }),
          ],
        });
        const snapshot = asSnapshot((yield* subscribeInto(harness.service)).snapshot);
        assert.deepStrictEqual(rowsOf(snapshot.buckets), [
          plainBucket(NOON - BUCKET, {
            cpuAvg: 37.3,
            cpuMax: 41,
            memUsedAvg: 4_001,
            swapUsedAvg: 0,
            diskUsedAvg: 100_001,
            gpuBusyAvg: 12.3,
            gpuBusyMax: 50,
            cpuTempMax: 45.6,
            netRxAvg: 1_234,
            netTxAvg: 100,
          }),
        ]);
      }),
  );

  it.effect(
    "phase 3 budget: a snapshot of 144 worst-case buckets encodes under 25 KB and an update under 1 KB",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOON);
        const history = Array.from({ length: 144 }, (_, index) =>
          worstCaseBucket(NOON - (143 - index) * BUCKET),
        );
        const harness = yield* startHostStats({
          history,
          sampleFor: worstCaseSample,
          agentCounts: Effect.succeed({ agentsRunning: 12, agentSessionsOpen: 40 }),
          mesuraServers: Effect.succeed({ installed: 2, dev: 12 }),
        });
        const first = yield* subscribeInto(harness.service);
        yield* harness.activate;
        const update = yield* takeSample(first.received);
        const snapshot = asSnapshot((yield* subscribeInto(harness.service)).snapshot);

        assert.lengthOf(snapshot.buckets.slots, 144);
        assert.isNotNull(snapshot.latest);
        assert.isBelow(encodedBytes(snapshot), 25 * KB);
        assert.isBelow(encodedBytes(update), KB);
      }),
  );

  it.effect(
    "phase 3 regression: an update rounds its sample and bucket as the snapshot rounds buckets",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOON);
        // No history: the update's bucket holds this one sample.
        const harness = yield* startHostStats({ sampleFor: worstCaseSample });
        const first = yield* subscribeInto(harness.service);
        yield* harness.activate;
        const update = yield* takeSample(first.received);

        const { sample, bucket } = update;
        assert.strictEqual(sample.cpuPercent, 37.3);
        assert.strictEqual(sample.load1, 12.35);
        assert.deepStrictEqual(
          sample.gpus?.map((gpu) => gpu.busyPercent),
          [37.3, 99.9],
        );
        assert.strictEqual(sample.cpuTemperatureC, 87.1);
        assert.strictEqual(sample.netRxBytesPerSec, 123_456_789);
        assert.strictEqual(sample.netTxBytesPerSec, 98_765_432);
        assert.deepStrictEqual(
          [bucket.cpuAvg, bucket.cpuMax, bucket.gpuBusyAvg, bucket.gpuBusyMax, bucket.cpuTempMax],
          [37.3, 37.3, 99.9, 99.9, 87.1],
        );
        assert.deepStrictEqual([bucket.netRxAvg, bucket.netTxAvg], [123_456_789, 98_765_432]);
        // The server keeps full precision; only what leaves it is rounded.
        assert.strictEqual((yield* harness.service.latest)?.cpuPercent, 37.28374982374982);
        assert.isBelow(encodedBytes(update), KB);
      }),
  );

  it.effect(
    "phase 3 AC1 AC2 AC4: every sample carries the agent counts and the Mesura server count",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOON);
        const harness = yield* startHostStats({
          agentCounts: Effect.succeed({ agentsRunning: 2, agentSessionsOpen: 5 }),
          mesuraServers: Effect.succeed({ installed: 1, dev: 2 }),
        });
        const first = yield* subscribeInto(harness.service);
        yield* harness.activate;
        const update = yield* takeSample(first.received);

        assert.strictEqual(update.sample.agentsRunning, 2);
        assert.strictEqual(update.sample.agentSessionsOpen, 5);
        assert.deepStrictEqual(update.sample.mesuraServers, { installed: 1, dev: 2 });
        assert.strictEqual(update.bucket.agentsRunningMax, 2);
        assert.deepStrictEqual(yield* harness.service.latest, update.sample);
      }),
  );

  it.effect(
    "phase 3 AC5: a failed agent count or a host without discovery leaves only those fields null",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOON);
        const harness = yield* startHostStats({
          agentCounts: Effect.fail(
            new PersistenceSqlError({ operation: "hostStats.test", detail: "database is locked" }),
          ),
          mesuraServers: Effect.succeed(null),
        });
        const first = yield* subscribeInto(harness.service);
        yield* harness.activate;
        const update = yield* takeSample(first.received);

        assert.isNull(update.sample.agentsRunning);
        assert.isNull(update.sample.agentSessionsOpen);
        assert.isNull(update.sample.mesuraServers);
        assert.strictEqual(update.sample.cpuPercent, 25);
        assert.isNull(update.bucket.agentsRunningMax);
      }),
  );

  it.effect(
    "phase 3 AC8: two concurrent subscribers receive the same samples from one read per minute",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOON);
        const harness = yield* startHostStats();
        const first = yield* subscribeInto(harness.service);
        const second = yield* subscribeInto(harness.service);
        assert.strictEqual(yield* Ref.get(harness.readCount), 0);

        yield* harness.activate;
        for (let minute = 0; minute < 3; minute += 1) {
          if (minute > 0) yield* TestClock.adjust("60 seconds");
          const fromFirst = yield* takeSample(first.received);
          const fromSecond = yield* takeSample(second.received);
          assert.strictEqual(fromFirst.sample.sampledAt, NOON + minute * MINUTE);
          assert.deepStrictEqual(fromSecond, fromFirst);
        }
        assert.strictEqual(yield* Ref.get(harness.readCount), 3);
        assert.deepStrictEqual(asSnapshot(first.snapshot), asSnapshot(second.snapshot));
      }),
  );

  it.effect("phase 3 AC7: the server advertises the hostStats capability", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "host-stats-capability-" });
      const descriptor = yield* Effect.gen(function* () {
        const environment = yield* ServerEnvironment.ServerEnvironment;
        return yield* environment.getDescriptor;
      }).pipe(
        Effect.provide(
          ServerEnvironment.layer.pipe(
            Layer.provide(ServerSecretStore.layer),
            Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
          ),
        ),
      );
      assert.strictEqual(descriptor.capabilities.hostStats, true);
    }),
  );
});

describe("HostStatsRpc phase 3 fence: contract and scope", () => {
  const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
  const olderServer = {
    environmentId: "environment-1",
    label: "vigilia-home",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.42",
    capabilities: { repositoryIdentity: true },
  } as const;

  it("phase 3 AC7: a descriptor that advertises hostStats keeps it through decoding", () => {
    const decoded = decodeDescriptor({
      ...olderServer,
      capabilities: { ...olderServer.capabilities, hostStats: true },
    });
    assert.strictEqual(decoded.capabilities.hostStats, true);
  });

  it("phase 3 guard: a descriptor from a server without host stats still decodes", () => {
    const decoded = decodeDescriptor(olderServer) as { capabilities: Record<string, unknown> };
    assert.isUndefined(decoded.capabilities.hostStats);
    assert.strictEqual(decoded.capabilities.repositoryIdentity, true);
  });

  it("phase 3 AC7: subscribeHostStats requires the same scope as server.getHostResources", () => {
    assert.strictEqual(
      requiredScopeForRpcMethod(WS_METHODS.subscribeHostStats),
      requiredScopeForRpcMethod(WS_METHODS.serverGetHostResources),
    );
  });
});
