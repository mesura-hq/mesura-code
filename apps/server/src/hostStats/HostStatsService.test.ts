/**
 * Phase 2 fence of the hosts dock plan: acceptance criteria 1 to 8.
 *
 * Entry points:
 * - `HostStatsService.layer`, the layer `server.ts` composes, for the
 *   activation gate and the cadence (AC1). `forkParked` starts its loop.
 * - `makeHostStatsService`, the constructor that layer wraps, for everything
 *   else. `sampleOnce` is one loop iteration, so a spec can move the wall
 *   clock between samples (a suspend, a clock jump) and still await each
 *   iteration's file write; `run` is forked where the loop itself is the
 *   subject (AC8).
 *
 * The collector is a fake: it stamps `sampledAt` from the clock plus an
 * offset, reports rates on every read, and can die or hang on a chosen read.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostStatsBucket, type HostStatsMessage, type HostStatsSample } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import type * as LogLevel from "effect/LogLevel";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import { ServerActivation } from "../serverActivation.ts";
import { HostAgentCounts } from "./HostAgentCounts.ts";
import { HostStatsCollector } from "./HostStatsCollector.ts";
import * as HostStatsServiceModule from "./HostStatsService.ts";
import { BUCKET_MS } from "./hostStatsBuckets.ts";
import { MesuraServerDiscovery } from "./mesuraServerDiscovery.ts";

const at = (iso: string) => Date.parse(iso);
const NOON = at("2026-09-28T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 3_600_000;
const HISTORY_FILE_NAME = "host-stats-history.json";

const HistoryFile = Schema.Struct({
  version: Schema.Literal(1),
  buckets: Schema.Array(HostStatsBucket),
});
const decodeHistoryFile = Schema.decodeUnknownEffect(Schema.fromJsonString(HistoryFile));

// ---------------------------------------------------------------------------
// Fixtures

function sampleAt(sampledAt: number): HostStatsSample {
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

function bucketAt(start: number, overrides: Partial<HostStatsBucket> = {}): HostStatsBucket {
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
    agentsRunningMax: null,
    ...overrides,
  };
}

/** What one read of the fake collector does, by 1-based read number. */
type ReadBehaviour = "ok" | "die" | "hang";

/**
 * A collector whose reads the spec can count and await. `reads` receives each
 * read's `sampledAt` as the read starts; because the loop is sequential, taking
 * read N proves iteration N - 1 finished.
 */
const makeFakeCollector = (behaviours: Readonly<Record<number, ReadBehaviour>> = {}) =>
  Effect.gen(function* () {
    const reads = yield* Queue.unbounded<number>();
    const readCount = yield* Ref.make(0);
    const clockOffsetMs = yield* Ref.make(0);
    const readSample: Effect.Effect<HostStatsSample> = Effect.gen(function* () {
      const sampledAt = (yield* Clock.currentTimeMillis) + (yield* Ref.get(clockOffsetMs));
      const readNumber = yield* Ref.updateAndGet(readCount, (count) => count + 1);
      yield* Queue.offer(reads, sampledAt);
      const behaviour = behaviours[readNumber] ?? "ok";
      if (behaviour === "die") return yield* Effect.die(new Error("collector read exploded"));
      if (behaviour === "hang") return yield* Effect.never;
      return sampleAt(sampledAt);
    });
    return { reads, readCount, clockOffsetMs, readSample };
  });

interface CapturedLog {
  readonly logLevel: LogLevel.LogLevel;
  readonly message: unknown;
}

const makeLogCapture = () => {
  const logs: CapturedLog[] = [];
  const layer = Logger.layer(
    [Logger.make(({ logLevel, message }) => void logs.push({ logLevel, message }))],
    { mergeWithExisting: false },
  );
  const problems = () =>
    logs.filter(
      (log) => log.logLevel === "Warn" || log.logLevel === "Error" || log.logLevel === "Fatal",
    );
  return { logs, layer, problems };
};

const makeHistoryDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "host-stats-service-" });
  return { directory, historyPath: path.join(directory, HISTORY_FILE_NAME) };
});

const readHistory = (historyPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* decodeHistoryFile(yield* fs.readFileString(historyPath));
  });

const writeHistory = (historyPath: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(historyPath, contents);
  });

const historyJson = (buckets: ReadonlyArray<HostStatsBucket>) =>
  JSON.stringify({ version: 1, buckets });

/**
 * A service in a child of the test's scope, so a spec can shut it down and
 * start another one; the test's end shuts down any it did not.
 */
const startService = (historyPath: string, readSample: Effect.Effect<HostStatsSample>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.fork(yield* Effect.scope);
    const service = yield* HostStatsServiceModule.makeHostStatsService({
      historyPath,
      readSample,
    }).pipe(Scope.provide(scope));
    return { service, shutdown: Scope.close(scope, Exit.void) };
  });

/** Moves the wall clock to `time` and takes one sample there. */
const sampleAtTime = (service: HostStatsServiceModule.HostStatsServiceShape, time: number) =>
  TestClock.setTime(time).pipe(Effect.andThen(service.sampleOnce));

const bucketStarts = (buckets: ReadonlyArray<HostStatsBucket>) =>
  buckets.map((bucket) => bucket.start);

/**
 * The sample a stream message carries: an update's sample, or the snapshot's
 * latest one. Phase 3 made `subscribe` emit the wire messages.
 */
const sampledAtOf = (message: HostStatsMessage) =>
  message.type === "sample" ? message.sample.sampledAt : (message.latest?.sampledAt ?? null);

// ---------------------------------------------------------------------------

it.layer(NodeServices.layer)("HostStatsService phase 2 fence", (it) => {
  it.effect(
    "phase 2 AC1: the layer samples once per 60 seconds after activation, none before",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOON);
        const { directory } = yield* makeHistoryDir;
        const collector = yield* makeFakeCollector();
        const activation = yield* Deferred.make<void>();
        const context = yield* Layer.build(
          HostStatsServiceModule.layer.pipe(
            Layer.provide(
              Layer.succeed(
                HostStatsCollector,
                HostStatsCollector.of({ read: collector.readSample }),
              ),
            ),
            // Phase 3: each sample also reads the agent counts and the server count.
            Layer.provide(
              Layer.succeed(
                HostAgentCounts,
                HostAgentCounts.of({
                  read: Effect.succeed({ agentsRunning: 0, agentSessionsOpen: 0 }),
                }),
              ),
            ),
            Layer.provide(
              Layer.succeed(
                MesuraServerDiscovery,
                MesuraServerDiscovery.of({ discover: Effect.succeed({ installed: 1, dev: 0 }) }),
              ),
            ),
            Layer.provide(ServerConfig.layerTest(directory, directory)),
            Layer.provide(Layer.succeed(ServerActivation, Deferred.await(activation))),
          ),
        );
        const service = Context.get(context, HostStatsServiceModule.HostStatsService);

        yield* TestClock.adjust("5 minutes");
        assert.strictEqual(yield* Ref.get(collector.readCount), 0);
        assert.isNull(yield* service.latest);

        yield* Deferred.succeed(activation, undefined);
        assert.strictEqual(yield* Queue.take(collector.reads), NOON + 5 * MINUTE);

        yield* TestClock.adjust("59 seconds");
        assert.strictEqual(yield* Ref.get(collector.readCount), 1);
        yield* TestClock.adjust("1 second");
        assert.strictEqual(yield* Queue.take(collector.reads), NOON + 6 * MINUTE);

        yield* TestClock.adjust("60 seconds");
        assert.strictEqual(yield* Queue.take(collector.reads), NOON + 7 * MINUTE);
        yield* TestClock.adjust("60 seconds");
        assert.strictEqual(yield* Queue.take(collector.reads), NOON + 8 * MINUTE);
        assert.strictEqual(yield* Ref.get(collector.readCount), 4);
      }),
  );

  it.effect(
    "phase 2 AC2: the service folds samples into buckets on 5-minute wall-clock boundaries",
    () =>
      Effect.gen(function* () {
        const { historyPath } = yield* makeHistoryDir;
        const collector = yield* makeFakeCollector();
        yield* TestClock.setTime(NOON);
        const { service } = yield* startService(historyPath, collector.readSample);

        yield* sampleAtTime(service, NOON + 3 * MINUTE + 30_000);
        yield* sampleAtTime(service, NOON + 4 * MINUTE + 30_000);
        yield* sampleAtTime(service, NOON + 5 * MINUTE + 30_000);

        const buckets = yield* service.buckets;
        assert.deepStrictEqual(
          buckets.map((bucket) => [bucket.start, bucket.sampleCount]),
          [
            [NOON, 2],
            [NOON + 5 * MINUTE, 1],
          ],
        );
        assert.strictEqual((yield* service.latest)?.sampledAt, NOON + 5 * MINUTE + 30_000);
      }),
  );

  it.effect(
    "phase 2 AC3: the service drops buckets older than 12 hours on load and on append",
    () =>
      Effect.gen(function* () {
        const { historyPath } = yield* makeHistoryDir;
        const collector = yield* makeFakeCollector();
        const almostExpired = NOON - 11 * HOUR - 55 * MINUTE;
        yield* writeHistory(
          historyPath,
          historyJson([bucketAt(NOON - 13 * HOUR), bucketAt(almostExpired), bucketAt(NOON - HOUR)]),
        );
        yield* TestClock.setTime(NOON);
        const { service } = yield* startService(historyPath, collector.readSample);

        assert.deepStrictEqual(bucketStarts(yield* service.buckets), [almostExpired, NOON - HOUR]);

        yield* sampleAtTime(service, NOON + 10 * MINUTE);
        assert.deepStrictEqual(bucketStarts(yield* service.buckets), [
          NOON - HOUR,
          NOON + 10 * MINUTE,
        ]);
      }),
  );

  it.effect("phase 2 AC4: the history file is first written when a bucket closes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { directory, historyPath } = yield* makeHistoryDir;
      const collector = yield* makeFakeCollector();
      yield* TestClock.setTime(NOON);
      const { service } = yield* startService(historyPath, collector.readSample);

      for (let minute = 0; minute < 5; minute += 1) {
        yield* sampleAtTime(service, NOON + minute * MINUTE);
      }
      assert.isFalse(yield* fs.exists(historyPath));

      yield* sampleAtTime(service, NOON + 5 * MINUTE);
      const history = yield* readHistory(historyPath);
      const closed = history.buckets.find((bucket) => bucket.start === NOON);
      assert.strictEqual(closed?.sampleCount, 5);
      assert.strictEqual(closed?.cpuAvg, 25);
      // The atomic writer leaves no temporary directory behind.
      assert.deepStrictEqual(yield* fs.readDirectory(directory), [HISTORY_FILE_NAME]);
    }),
  );

  it.effect(
    "phase 2 AC4: shutting the service down writes the open bucket to the history file",
    () =>
      Effect.gen(function* () {
        const { historyPath } = yield* makeHistoryDir;
        const collector = yield* makeFakeCollector();
        yield* TestClock.setTime(NOON);
        const { service, shutdown } = yield* startService(historyPath, collector.readSample);

        yield* sampleAtTime(service, NOON);
        yield* sampleAtTime(service, NOON + MINUTE);
        yield* shutdown;

        const history = yield* readHistory(historyPath);
        assert.deepStrictEqual(
          history.buckets.map((bucket) => [bucket.start, bucket.sampleCount]),
          [[NOON, 2]],
        );
      }),
  );

  it.effect("phase 2 AC4: a restarted service restores the buckets its predecessor wrote", () =>
    Effect.gen(function* () {
      const { historyPath } = yield* makeHistoryDir;
      const collector = yield* makeFakeCollector();
      yield* TestClock.setTime(NOON);
      const first = yield* startService(historyPath, collector.readSample);
      for (let minute = 0; minute <= 6; minute += 1) {
        yield* sampleAtTime(first.service, NOON + minute * MINUTE);
      }
      const bucketsBeforeRestart = yield* first.service.buckets;
      yield* first.shutdown;

      const second = yield* startService(historyPath, collector.readSample);
      const restored = yield* second.service.buckets;
      assert.deepStrictEqual(
        restored.map((bucket) => [bucket.start, bucket.sampleCount, bucket.cpuAvg]),
        bucketsBeforeRestart.map((bucket) => [bucket.start, bucket.sampleCount, bucket.cpuAvg]),
      );
      assert.deepStrictEqual(
        restored.map((bucket) => [bucket.start, bucket.sampleCount]),
        [
          [NOON, 5],
          [NOON + 5 * MINUTE, 2],
        ],
      );

      yield* sampleAtTime(second.service, NOON + 7 * MINUTE);
      assert.deepStrictEqual(
        (yield* second.service.buckets).map((bucket) => [bucket.start, bucket.sampleCount]),
        [
          [NOON, 5],
          [NOON + 5 * MINUTE, 3],
        ],
      );
    }),
  );

  it.effect.each([
    { name: "missing", contents: null },
    { name: "empty", contents: "" },
    { name: "truncated", contents: '{"version":1,"buckets":[{"start":' },
    { name: "non-JSON", contents: "{garbage" },
    // A valid version-2 body with a bucket, so only the version can reject it.
    {
      name: "wrong-version",
      contents: JSON.stringify({ version: 2, buckets: [bucketAt(NOON - BUCKET_MS)] }),
    },
  ])(
    "phase 2 AC5: a $name history file yields empty history, one warning and a fresh file",
    ({ contents }) => {
      const capture = makeLogCapture();
      return Effect.gen(function* () {
        const { historyPath } = yield* makeHistoryDir;
        if (contents !== null) yield* writeHistory(historyPath, contents);
        const collector = yield* makeFakeCollector();
        yield* TestClock.setTime(NOON);

        const { service } = yield* startService(historyPath, collector.readSample);
        assert.deepStrictEqual(yield* service.buckets, []);
        assert.isNull(yield* service.latest);

        for (let minute = 0; minute <= 5; minute += 1) {
          yield* sampleAtTime(service, NOON + minute * MINUTE);
        }
        const history = yield* readHistory(historyPath);
        assert.strictEqual(history.version, 1);
        assert.strictEqual(history.buckets.find((bucket) => bucket.start === NOON)?.sampleCount, 5);

        assert.deepStrictEqual(
          capture.problems().map((log) => log.logLevel),
          ["Warn"],
        );
      }).pipe(Effect.provide(capture.layer));
    },
  );

  it.effect(
    "phase 2 AC6: buckets more than one bucket in the future are dropped and never re-emitted",
    () =>
      Effect.gen(function* () {
        const { historyPath } = yield* makeHistoryDir;
        const collector = yield* makeFakeCollector();
        const future = NOON + HOUR;
        yield* writeHistory(
          historyPath,
          historyJson([bucketAt(NOON - BUCKET_MS), bucketAt(future, { sampleCount: 5 })]),
        );
        yield* TestClock.setTime(NOON + 2 * MINUTE);
        const { service } = yield* startService(historyPath, collector.readSample);

        assert.deepStrictEqual(bucketStarts(yield* service.buckets), [NOON - BUCKET_MS]);

        yield* sampleAtTime(service, NOON + 2 * MINUTE);
        yield* sampleAtTime(service, NOON + 5 * MINUTE);
        const written = yield* readHistory(historyPath);
        assert.notInclude(bucketStarts(written.buckets), future);

        // When the clock reaches that hour, its bucket starts from this sample alone.
        yield* sampleAtTime(service, future + MINUTE);
        const reached = (yield* service.buckets).find((bucket) => bucket.start === future);
        assert.strictEqual(reached?.sampleCount, 1);
      }),
  );

  it.effect(
    "phase 2 AC7: a 10-minute gap creates no bucket and nulls the next sample's rates",
    () =>
      Effect.gen(function* () {
        const { historyPath } = yield* makeHistoryDir;
        const collector = yield* makeFakeCollector();
        yield* TestClock.setTime(NOON);
        const { service } = yield* startService(historyPath, collector.readSample);

        yield* sampleAtTime(service, NOON);
        yield* sampleAtTime(service, NOON + MINUTE);
        // The collector reports rates on every read; across the gap the service drops them.
        yield* sampleAtTime(service, NOON + 11 * MINUTE);
        const afterGap = yield* service.latest;
        assert.strictEqual(afterGap?.sampledAt, NOON + 11 * MINUTE);
        assert.isNull(afterGap?.cpuPercent);
        assert.isNull(afterGap?.netRxBytesPerSec);
        assert.isNull(afterGap?.netTxBytesPerSec);
        assert.strictEqual(afterGap?.memUsedBytes, 4_000);

        yield* sampleAtTime(service, NOON + 12 * MINUTE);
        assert.strictEqual((yield* service.latest)?.cpuPercent, 25);

        const buckets = yield* service.buckets;
        assert.deepStrictEqual(
          buckets.map((bucket) => [
            bucket.start,
            bucket.sampleCount,
            bucket.cpuAvg,
            bucket.netRxAvg,
          ]),
          [
            [NOON, 2, 25, 1_000],
            [NOON + 10 * MINUTE, 2, 25, 1_000],
          ],
        );
      }),
  );

  it.effect(
    "phase 2 AC7: a clock jump seen by the running loop yields null rates and no filler buckets",
    () =>
      Effect.gen(function* () {
        const { historyPath } = yield* makeHistoryDir;
        const collector = yield* makeFakeCollector();
        yield* TestClock.setTime(NOON);
        const { service } = yield* startService(historyPath, collector.readSample);
        const { changes } = yield* service.subscribe;
        yield* service.run.pipe(Effect.forkScoped);

        assert.strictEqual(yield* Queue.take(collector.reads), NOON);
        yield* TestClock.adjust("60 seconds");
        assert.strictEqual(yield* Queue.take(collector.reads), NOON + MINUTE);
        // The wall clock jumps ten minutes while the loop sleeps.
        yield* Ref.set(collector.clockOffsetMs, 10 * MINUTE);
        yield* TestClock.adjust("60 seconds");
        assert.strictEqual(yield* Queue.take(collector.reads), NOON + 12 * MINUTE);
        // The jump opens a bucket, so this iteration writes the history file
        // before it sleeps; a read-4 barrier would race that real IO against
        // `TestClock.adjust`. The published sample marks the fold as done.
        const third = yield* changes.pipe(Stream.take(3), Stream.runLast);
        assert.strictEqual(
          Option.map(third, sampledAtOf).pipe(Option.getOrNull),
          NOON + 12 * MINUTE,
        );

        const latest = yield* service.latest;
        assert.strictEqual(latest?.sampledAt, NOON + 12 * MINUTE);
        assert.isNull(latest?.cpuPercent);
        assert.isNull(latest?.netRxBytesPerSec);
        assert.deepStrictEqual(bucketStarts(yield* service.buckets), [NOON, NOON + 10 * MINUTE]);
      }),
  );

  it.effect(
    "phase 2 AC8: a failing collector read is logged and skipped, and the loop keeps running",
    () => {
      const capture = makeLogCapture();
      return Effect.gen(function* () {
        const { historyPath } = yield* makeHistoryDir;
        // A valid empty history, so the only warning left to count is the failed read.
        yield* writeHistory(historyPath, historyJson([]));
        const collector = yield* makeFakeCollector({ 2: "die", 4: "hang" });
        yield* TestClock.setTime(NOON);
        const { service } = yield* startService(historyPath, collector.readSample);
        yield* service.run.pipe(Effect.forkScoped);

        assert.strictEqual(yield* Queue.take(collector.reads), NOON);
        yield* TestClock.adjust("60 seconds");
        assert.strictEqual(yield* Queue.take(collector.reads), NOON + MINUTE);
        yield* TestClock.adjust("60 seconds");
        assert.strictEqual(yield* Queue.take(collector.reads), NOON + 2 * MINUTE);
        yield* TestClock.adjust("60 seconds");
        // Read 4 hangs, so iteration 3 has finished and nothing else runs.
        assert.strictEqual(yield* Queue.take(collector.reads), NOON + 3 * MINUTE);

        assert.strictEqual((yield* service.latest)?.sampledAt, NOON + 2 * MINUTE);
        assert.deepStrictEqual(
          (yield* service.buckets).map((bucket) => [bucket.start, bucket.sampleCount]),
          [[NOON, 2]],
        );
        assert.lengthOf(capture.problems(), 1);
      }).pipe(Effect.provide(capture.layer));
    },
  );

  it.effect(
    "phase 2 regression: a loaded bucket one interval ahead does not delay the closed bucket's write",
    () =>
      Effect.gen(function* () {
        const { historyPath } = yield* makeHistoryDir;
        const collector = yield* makeFakeCollector();
        // The clock moved back 3 minutes: the 12:05 bucket is one interval ahead and kept.
        yield* writeHistory(historyPath, historyJson([bucketAt(NOON + BUCKET_MS)]));
        yield* TestClock.setTime(NOON + 2 * MINUTE);
        const { service } = yield* startService(historyPath, collector.readSample);
        assert.deepStrictEqual(bucketStarts(yield* service.buckets), [NOON + BUCKET_MS]);

        yield* sampleAtTime(service, NOON + 2 * MINUTE);
        yield* sampleAtTime(service, NOON + 5 * MINUTE);

        const written = yield* readHistory(historyPath);
        assert.deepStrictEqual(
          written.buckets.map((bucket) => [bucket.start, bucket.sampleCount]),
          [
            [NOON, 1],
            [NOON + BUCKET_MS, 6],
          ],
        );
      }),
  );

  it.effect(
    "phase 2 regression: a missing history file logs one short warning with no stack",
    () => {
      const capture = makeLogCapture();
      return Effect.gen(function* () {
        const { historyPath } = yield* makeHistoryDir;
        const collector = yield* makeFakeCollector();
        yield* startService(historyPath, collector.readSample);

        const [warning, ...others] = capture.problems();
        assert.lengthOf(others, 0);
        // `Effect.logWarning(message, fields)` logs `[message, fields]`.
        const [message, fields] = (warning?.message ?? []) as [unknown, Record<string, unknown>];
        assert.strictEqual(message, "hostStats.history.missing-starting-empty");
        assert.notProperty(fields, "cause");
      }).pipe(Effect.provide(capture.layer));
    },
  );
});

// ---------------------------------------------------------------------------
// Regression: behaviour the phase 2 fence covered only indirectly.

/** A collector that returns `sampleAt(now)` with the next scripted override, in order. */
const makeScriptedCollector = (overrides: ReadonlyArray<Partial<HostStatsSample>>) =>
  Effect.gen(function* () {
    const remaining = yield* Ref.make(overrides);
    const readSample: Effect.Effect<HostStatsSample> = Effect.gen(function* () {
      const sampledAt = yield* Clock.currentTimeMillis;
      const [override = {}, ...rest] = yield* Ref.get(remaining);
      yield* Ref.set(remaining, rest);
      return { ...sampleAt(sampledAt), ...override };
    });
    return readSample;
  });

it.layer(NodeServices.layer)("HostStatsService phase 2 regression", (it) => {
  it.effect(
    "phase 2 regression: an open bucket restored after a restart keeps averaging over non-null samples",
    () =>
      Effect.gen(function* () {
        const { historyPath } = yield* makeHistoryDir;
        const readSample = yield* makeScriptedCollector([
          { cpuPercent: 10 },
          { cpuPercent: null },
          { cpuPercent: 40 },
        ]);
        yield* TestClock.setTime(NOON);
        const first = yield* startService(historyPath, readSample);
        yield* sampleAtTime(first.service, NOON);
        yield* sampleAtTime(first.service, NOON + MINUTE);
        yield* first.shutdown;

        const second = yield* startService(historyPath, readSample);
        yield* sampleAtTime(second.service, NOON + 2 * MINUTE);

        // Exact: (10 + 40) / 2. Averaging over `sampleCount` after the restart gives 20.
        const [bucket] = yield* second.service.buckets;
        assert.strictEqual(bucket?.sampleCount, 3);
        assert.strictEqual(bucket?.cpuAvg, 25);
        assert.strictEqual(bucket?.cpuMax, 40);
      }),
  );

  it.effect("phase 2 regression: shutdown writes nothing when no sample is unsaved", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { historyPath } = yield* makeHistoryDir;
      const collector = yield* makeFakeCollector();
      yield* writeHistory(historyPath, historyJson([bucketAt(NOON - BUCKET_MS)]));
      yield* TestClock.setTime(NOON);

      // Loaded, never sampled.
      const idle = yield* startService(historyPath, collector.readSample);
      const sentinel = "left by the test";
      yield* writeHistory(historyPath, sentinel);
      yield* idle.shutdown;
      assert.strictEqual(yield* fs.readFileString(historyPath), sentinel);

      // Sampled, but the last sample closed a bucket and was written with it.
      yield* writeHistory(historyPath, historyJson([]));
      const sampled = yield* startService(historyPath, collector.readSample);
      yield* sampleAtTime(sampled.service, NOON + 4 * MINUTE);
      yield* sampleAtTime(sampled.service, NOON + 5 * MINUTE);
      yield* writeHistory(historyPath, sentinel);
      yield* sampled.shutdown;
      assert.strictEqual(yield* fs.readFileString(historyPath), sentinel);
    }),
  );

  it.effect(
    "phase 2 regression: subscribe returns the latest sample, then one change per sample",
    () =>
      Effect.gen(function* () {
        const { historyPath } = yield* makeHistoryDir;
        const collector = yield* makeFakeCollector();
        yield* TestClock.setTime(NOON);
        const { service } = yield* startService(historyPath, collector.readSample);

        const before = yield* service.subscribe;
        assert.isNull(sampledAtOf(before.latest));
        yield* sampleAtTime(service, NOON);
        yield* sampleAtTime(service, NOON + MINUTE);
        const changes = yield* before.changes.pipe(Stream.take(2), Stream.runCollect);
        assert.deepStrictEqual(changes.map(sampledAtOf), [NOON, NOON + MINUTE]);

        const after = yield* service.subscribe;
        assert.strictEqual(sampledAtOf(after.latest), NOON + MINUTE);
        yield* sampleAtTime(service, NOON + 2 * MINUTE);
        const next = yield* after.changes.pipe(Stream.take(1), Stream.runCollect);
        assert.deepStrictEqual(next.map(sampledAtOf), [NOON + 2 * MINUTE]);
      }),
  );

  it.effect("phase 2 regression: a clock that moves backwards nulls the next sample's rates", () =>
    Effect.gen(function* () {
      const { historyPath } = yield* makeHistoryDir;
      const collector = yield* makeFakeCollector();
      yield* TestClock.setTime(NOON);
      const { service } = yield* startService(historyPath, collector.readSample);

      yield* sampleAtTime(service, NOON + 5 * MINUTE);
      yield* sampleAtTime(service, NOON + 2 * MINUTE);
      const latest = yield* service.latest;
      assert.isNull(latest?.cpuPercent);
      assert.isNull(latest?.netRxBytesPerSec);
      assert.isNull(latest?.netTxBytesPerSec);
    }),
  );
});
