/**
 * Phase 1 fence of the hosts dock plan: acceptance criteria 1, 2, 3, 5, 6, 7 and 8.
 *
 * Entry point: `HostStatsCollector.make`, the constructor phase 2 wraps into the
 * sampler. Nothing in the server calls the collector during phase 1, so these
 * specs drive it directly against the fixture trees in `./fixtures`
 * (provenance in `./fixtures/README.md`).
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostStatsSample, type HostStatsGpu } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { assert, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as HostStatsCollector from "./HostStatsCollector.ts";
import { HostOs, type HostOsApi } from "./portableReaders.ts";

const FIXTURES_DIRECTORY = `${import.meta.dirname}/fixtures`;
const KIB = 1024;
const MIB = 1024 * 1024;
/** When `fixtures/vigilia-home` was read; the collector stamps `sampledAt` from `Clock`. */
const CAPTURED_AT_MS = 1_790_635_251_724;

/** Every reading must satisfy the wire contract clients decode it with. */
const decodeHostStatsSample = Schema.decodeEffect(HostStatsSample);

const NVIDIA_SMI_ARGS = [
  "--query-gpu=pci.bus_id,utilization.gpu,memory.used,memory.total",
  "--format=csv,noheader,nounits",
];

/**
 * Expected second-reading rates between `vigilia-home` and `vigilia-home-60s-later`.
 * CPU follows proc(5): idle time is `idle + iowait`, and the total is the first eight
 * fields, because `guest` and `guest_nice` are already counted inside `user` and `nice`.
 * cpu  7957187 202 1169318 12256969 28932 58487 26810 0 153145 0   (vigilia-home)
 * cpu  8033079 202 1178122 12267617 28969 58802 26906 0 153697 0   (60 s later)
 */
const CPU_IDLE_DELTA = 12_267_617 - 12_256_969 + (28_969 - 28_932);
const CPU_TOTAL_DELTA =
  8_033_079 -
  7_957_187 +
  (202 - 202) +
  (1_178_122 - 1_169_318) +
  (12_267_617 - 12_256_969) +
  (28_969 - 28_932) +
  (58_802 - 58_487) +
  (26_906 - 26_810) +
  (0 - 0);
const EXPECTED_CPU_PERCENT = 100 * (1 - CPU_IDLE_DELTA / CPU_TOTAL_DELTA);
/** Only `enp5s0` and `wlp12s0` have a `device` link; the veths moved far more bytes. */
const NET_RX_DELTA = 2_103_605_220 - 2_102_414_876 + (2_149_679 - 2_145_366);
const NET_TX_DELTA = 3_283_662_277 - 3_274_314_579 + (128_358 - 127_778);

// ---------------------------------------------------------------------------
// nvidia-smi fakes

type NvidiaSmiBehaviour =
  | { readonly kind: "exits"; readonly exitCode: number; readonly stdout: string }
  | { readonly kind: "missing" }
  | { readonly kind: "hangs" };

interface SpawnedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const NVIDIA_SMI_OUTPUT_ON_ARCH_LAPTOP: NvidiaSmiBehaviour = {
  kind: "exits",
  exitCode: 0,
  stdout: "00000000:64:00.0, 0, 279, 8151\n",
};

function fakeProcessHandle(
  stdout: Stream.Stream<Uint8Array>,
  exitCode: Effect.Effect<ChildProcessSpawner.ExitCode>,
) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(4242),
    exitCode,
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout,
    stderr: Stream.empty,
    all: stdout,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

/** A spawner whose every derived method (`string`, `exitCode`, `lines`) goes through one fake `spawn`. */
function fakeSpawner(
  behaviour: NvidiaSmiBehaviour,
  spawned: Array<SpawnedCommand>,
  onSpawn: Deferred.Deferred<void> | undefined,
) {
  return ChildProcessSpawner.make((command) =>
    Effect.suspend(() => {
      const { command: executable, args } = command as unknown as SpawnedCommand;
      spawned.push({ command: executable, args: [...args] });
      if (onSpawn) Deferred.doneUnsafe(onSpawn, Effect.void);
      switch (behaviour.kind) {
        case "missing":
          return Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              pathOrDescriptor: executable,
              description: `spawn ${executable} ENOENT`,
            }),
          );
        case "hangs":
          return Effect.succeed(fakeProcessHandle(Stream.never, Effect.never));
        case "exits":
          return Effect.succeed(
            fakeProcessHandle(
              Stream.make(new TextEncoder().encode(behaviour.stdout)),
              Effect.succeed(ChildProcessSpawner.ExitCode(behaviour.exitCode)),
            ),
          );
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// fixture helpers

const fixtureRoot = (name: string) => `${FIXTURES_DIRECTORY}/${name}`;

const makeCollector = (
  root: string,
  options: {
    readonly nvidiaSmi?: NvidiaSmiBehaviour;
    readonly spawned?: Array<SpawnedCommand>;
    readonly onSpawn?: Deferred.Deferred<void>;
    readonly fileSystem?: FileSystem.FileSystem;
    readonly platform?: NodeJS.Platform;
    readonly hostOs?: HostOsApi;
  } = {},
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const make = HostStatsCollector.make({
      procRoot: path.join(root, "proc"),
      sysRoot: path.join(root, "sys"),
      diskPath: root,
    }).pipe(
      Effect.provideService(HostProcessPlatform, options.platform ?? "linux"),
      options.hostOs ? Effect.provideService(HostOs, options.hostOs) : (effect) => effect,
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        fakeSpawner(
          options.nvidiaSmi ?? NVIDIA_SMI_OUTPUT_ON_ARCH_LAPTOP,
          options.spawned ?? [],
          options.onSpawn,
        ),
      ),
    );
    return yield* options.fileSystem
      ? make.pipe(Effect.provideService(FileSystem.FileSystem, options.fileSystem))
      : make;
  });

/** Copies a fixture tree into a scoped temp directory so a test can rewrite its files. */
const copyFixture = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-host-stats-" });
    const root = path.join(directory, name);
    yield* fs.copy(fixtureRoot(name), root);
    return root;
  });

/** Replaces one counter file under `root/proc` with the one from another fixture. */
const copyCounterFrom = (source: string, root: string, file: "stat" | "net/dev") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const segments = ["proc", ...file.split("/")];
    yield* fs.copyFile(path.join(fixtureRoot(source), ...segments), path.join(root, ...segments));
  });

const copyCountersFrom = (source: string, root: string) =>
  Effect.all([copyCounterFrom(source, root, "stat"), copyCounterFrom(source, root, "net/dev")], {
    discard: true,
  });

const writeFixtureFile = (root: string, relativePath: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(root, ...relativePath.split("/")), contents);
  });

/**
 * A FileSystem that throws synchronously from any method called with a path
 * containing `fragment`, as a reader bug or an unexpected kernel error would.
 */
const throwingFileSystem = (fragment: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const needle = path.join(...fragment.split("/"));
    return new Proxy(fs, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== "function") return value;
        return (...args: Array<unknown>) => {
          if (args.some((arg) => typeof arg === "string" && arg.includes(needle))) {
            throw new Error(`host stats test: ${String(key)} threw for ${fragment}`);
          }
          return Reflect.apply(value, target, args);
        };
      },
    });
  });

/** Fields that depend on the live temp filesystem or the clock, not on the fixture. */
function withoutLiveFields(sample: HostStatsSample) {
  const { sampledAt: _sampledAt, diskUsedBytes: _used, diskTotalBytes: _total, ...rest } = sample;
  return rest;
}

const gpuByVendor = (sample: HostStatsSample, vendor: HostStatsGpu["vendor"]) =>
  sample.gpus?.find((gpu) => gpu.vendor === vendor);

it.layer(NodeServices.layer)("HostStatsCollector phase 1 fence", (it) => {
  // -------------------------------------------------------------------------
  // AC1
  it.effect("AC1: a vigilia-home reading reports load, memory, swap, AMD GPU and k10temp", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(CAPTURED_AT_MS);
      const collector = yield* makeCollector(fixtureRoot("vigilia-home"));
      const sample = yield* collector.read;

      yield* decodeHostStatsSample(sample);
      assert.equal(sample.sampledAt, CAPTURED_AT_MS);
      assert.equal(sample.load1, 16.39);
      assert.equal(sample.cpuCount, 16);
      assert.equal(sample.memTotalBytes, 32_013_916 * KIB);
      assert.equal(sample.memUsedBytes, (32_013_916 - 15_920_612) * KIB);
      assert.equal(sample.swapTotalBytes, 8_003_324 * KIB);
      assert.equal(sample.swapUsedBytes, (8_003_324 - 1_452_492) * KIB);
      assert.equal(sample.cpuTemperatureC, 85.625);
      expect(sample.gpus).toHaveLength(1);
      expect(gpuByVendor(sample, "amd")).toMatchObject({
        vendor: "amd",
        state: "active",
        busyPercent: 0,
        vramUsedBytes: 164_368_384,
        vramTotalBytes: 536_870_912,
      });
      // Phase 3 fills these; the collector never guesses them.
      assert.isNull(sample.agentsRunning);
      assert.isNull(sample.agentSessionsOpen);
      assert.isNull(sample.mesuraServers);
    }),
  );

  it.effect("AC1 (plan detail): disk usage comes from the filesystem holding diskPath", () =>
    Effect.gen(function* () {
      const collector = yield* makeCollector(fixtureRoot("vigilia-home"));
      const sample = yield* collector.read;
      assert.isNotNull(sample.diskTotalBytes);
      assert.isNotNull(sample.diskUsedBytes);
      assert.isAbove(sample.diskTotalBytes!, 0);
      assert.isAtMost(sample.diskUsedBytes!, sample.diskTotalBytes!);
    }),
  );

  // -------------------------------------------------------------------------
  // AC2
  it.effect(
    "AC2: CPU percent and network rates come from counter deltas, null on the first reading",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(CAPTURED_AT_MS);
        const root = yield* copyFixture("vigilia-home");
        const collector = yield* makeCollector(root);

        const first = yield* collector.read;
        assert.isNull(first.cpuPercent);
        assert.isNull(first.netRxBytesPerSec);
        assert.isNull(first.netTxBytesPerSec);

        yield* copyCountersFrom("vigilia-home-60s-later", root);
        yield* TestClock.adjust("60 seconds");
        const second = yield* collector.read;
        expect(second.cpuPercent).toBeCloseTo(EXPECTED_CPU_PERCENT, 3);
        expect(second.netRxBytesPerSec).toBeCloseTo(NET_RX_DELTA / 60, 3);
        expect(second.netTxBytesPerSec).toBeCloseTo(NET_TX_DELTA / 60, 3);
      }),
  );

  // -------------------------------------------------------------------------
  // AC3
  it.effect("AC3: counters that went backwards yield null rates, never negative ones", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(CAPTURED_AT_MS);
      const root = yield* copyFixture("vigilia-home");
      yield* copyCountersFrom("vigilia-home-60s-later", root);
      const collector = yield* makeCollector(root);
      yield* collector.read;

      yield* copyCountersFrom("vigilia-home", root);
      yield* TestClock.adjust("60 seconds");
      const second = yield* collector.read;
      assert.isNull(second.cpuPercent);
      assert.isNull(second.netRxBytesPerSec);
      assert.isNull(second.netTxBytesPerSec);
      assert.equal(second.load1, 16.39);
    }),
  );

  it.effect("AC3: only the rate whose counter went backwards is discarded", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(CAPTURED_AT_MS);
      const root = yield* copyFixture("vigilia-home");
      yield* copyCounterFrom("vigilia-home-60s-later", root, "net/dev");
      const collector = yield* makeCollector(root);
      yield* collector.read;

      yield* copyCounterFrom("vigilia-home-60s-later", root, "stat");
      yield* copyCounterFrom("vigilia-home", root, "net/dev");
      yield* TestClock.adjust("60 seconds");
      const second = yield* collector.read;
      expect(second.cpuPercent).toBeCloseTo(EXPECTED_CPU_PERCENT, 3);
      assert.isNull(second.netRxBytesPerSec);
      assert.isNull(second.netTxBytesPerSec);
    }),
  );

  it.effect.each([
    { label: "121 seconds", moveClock: TestClock.adjust("121 seconds") },
    { label: "0 seconds", moveClock: Effect.void },
    { label: "minus 60 seconds", moveClock: TestClock.setTime(CAPTURED_AT_MS - 60_000) },
  ])("AC3: an elapsed time of $label between readings yields null rates", ({ moveClock }) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(CAPTURED_AT_MS);
      const root = yield* copyFixture("vigilia-home");
      const collector = yield* makeCollector(root);
      yield* collector.read;

      yield* copyCountersFrom("vigilia-home-60s-later", root);
      yield* moveClock;
      const second = yield* collector.read;
      assert.isNull(second.cpuPercent);
      assert.isNull(second.netRxBytesPerSec);
      assert.isNull(second.netTxBytesPerSec);
      assert.equal(second.cpuCount, 16);
    }),
  );

  it.effect("AC3: an elapsed time of exactly 120 seconds still yields rates", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(CAPTURED_AT_MS);
      const root = yield* copyFixture("vigilia-home");
      const collector = yield* makeCollector(root);
      yield* collector.read;

      yield* copyCountersFrom("vigilia-home-60s-later", root);
      yield* TestClock.adjust("120 seconds");
      const second = yield* collector.read;
      expect(second.cpuPercent).toBeCloseTo(EXPECTED_CPU_PERCENT, 3);
      expect(second.netRxBytesPerSec).toBeCloseTo(NET_RX_DELTA / 120, 3);
      expect(second.netTxBytesPerSec).toBeCloseTo(NET_TX_DELTA / 120, 3);
    }),
  );

  it.effect("AC3: the reading after a discarded gap measures from that reading", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(CAPTURED_AT_MS);
      const root = yield* copyFixture("vigilia-home");
      const collector = yield* makeCollector(root);
      yield* collector.read;

      yield* TestClock.adjust("10 minutes");
      const afterGap = yield* collector.read;
      assert.isNull(afterGap.cpuPercent);
      assert.isNull(afterGap.netRxBytesPerSec);

      yield* copyCountersFrom("vigilia-home-60s-later", root);
      yield* TestClock.adjust("60 seconds");
      const next = yield* collector.read;
      expect(next.cpuPercent).toBeCloseTo(EXPECTED_CPU_PERCENT, 3);
      expect(next.netRxBytesPerSec).toBeCloseTo(NET_RX_DELTA / 60, 3);
      expect(next.netTxBytesPerSec).toBeCloseTo(NET_TX_DELTA / 60, 3);
    }),
  );

  /** Two readings 60 s apart over hand-written counter files, for resets hidden by totals. */
  const ratesAcross = (file: "stat" | "net/dev", before: string, after: string) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(CAPTURED_AT_MS);
      const root = yield* copyFixture("vigilia-home");
      const collector = yield* makeCollector(root);
      yield* writeFixtureFile(root, `proc/${file}`, before);
      yield* collector.read;
      yield* writeFixtureFile(root, `proc/${file}`, after);
      yield* TestClock.adjust("60 seconds");
      return yield* collector.read;
    });

  const procStatText = (fields: ReadonlyArray<number>) =>
    `cpu  ${fields.join(" ")} 0 0\ncpu0 ${fields.join(" ")} 0 0\n`;

  /** `/proc/net/dev` with the given rx/tx bytes; the other 14 columns are 0. */
  const procNetDevText = (rows: ReadonlyArray<readonly [string, number, number]>) =>
    [
      "Inter-|   Receive                                                |  Transmit",
      " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
      ...rows.map(([name, rx, tx]) => `${name}: ${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0`),
      "",
    ].join("\n");

  it.effect("AC3: one CPU counter going backwards nulls the CPU rate while the totals grow", () =>
    Effect.gen(function* () {
      const second = yield* ratesAcross(
        "stat",
        procStatText([100, 0, 100, 800, 0, 0, 0, 0]),
        procStatText([50, 0, 200, 850, 0, 0, 0, 0]),
      );
      assert.isNull(second.cpuPercent);
    }),
  );

  it.effect(
    "AC3: one NIC's counters going backwards nulls the network rates while the sums grow",
    () =>
      Effect.gen(function* () {
        const second = yield* ratesAcross(
          "net/dev",
          procNetDevText([
            ["enp5s0", 1_000, 2_000],
            ["wlp12s0", 3_000, 4_000],
          ]),
          procNetDevText([
            ["enp5s0", 0, 0],
            ["wlp12s0", 10_000, 10_000],
          ]),
        );
        assert.isNull(second.netRxBytesPerSec);
        assert.isNull(second.netTxBytesPerSec);
      }),
  );

  it.effect("AC3: a NIC that appears between readings nulls the network rates", () =>
    Effect.gen(function* () {
      const second = yield* ratesAcross(
        "net/dev",
        procNetDevText([["enp5s0", 1_000, 2_000]]),
        procNetDevText([
          ["enp5s0", 1_600, 2_600],
          ["wlp12s0", 5_000_000, 5_000_000],
        ]),
      );
      assert.isNull(second.netRxBytesPerSec);
      assert.isNull(second.netTxBytesPerSec);
    }),
  );

  it.effect("AC8: a /proc/stat cpu line with fewer than eight counters yields no CPU rate", () =>
    Effect.gen(function* () {
      const truncated = (fields: string) => `cpu  ${fields}\ncpu0 ${fields}\n`;
      const second = yield* ratesAcross(
        "stat",
        truncated("100 0 100 800"),
        truncated("200 0 200 900"),
      );
      assert.isNull(second.cpuPercent);
      assert.isNull(second.cpuCount);
    }),
  );

  it.effect("AC3: per-NIC comparison still yields the summed rate when every counter grew", () =>
    Effect.gen(function* () {
      const second = yield* ratesAcross(
        "net/dev",
        procNetDevText([
          ["enp5s0", 1_000, 2_000],
          ["wlp12s0", 3_000, 4_000],
        ]),
        procNetDevText([
          ["enp5s0", 1_600, 2_000],
          ["wlp12s0", 3_600, 7_000],
        ]),
      );
      expect(second.netRxBytesPerSec).toBeCloseTo(1_200 / 60, 6);
      expect(second.netTxBytesPerSec).toBeCloseTo(3_000 / 60, 6);
    }),
  );

  // -------------------------------------------------------------------------
  // AC5
  it.effect("AC5: a suspended NVIDIA GPU reads as sleeping and nvidia-smi is never spawned", () =>
    Effect.gen(function* () {
      const spawned: Array<SpawnedCommand> = [];
      const collector = yield* makeCollector(fixtureRoot("arch-laptop"), { spawned });
      const sample = yield* collector.read;

      assert.deepEqual(spawned, []);
      expect(sample.gpus).toHaveLength(2);
      expect(gpuByVendor(sample, "nvidia")).toMatchObject({
        state: "sleeping",
        busyPercent: null,
        vramUsedBytes: null,
        vramTotalBytes: null,
      });
      expect(gpuByVendor(sample, "amd")).toMatchObject({
        state: "active",
        busyPercent: 56,
        vramUsedBytes: 480_153_600,
        vramTotalBytes: 536_870_912,
      });
      assert.equal(sample.cpuTemperatureC, 60.625);
    }),
  );

  // -------------------------------------------------------------------------
  // AC6
  const copyLaptopWithActiveNvidia = Effect.gen(function* () {
    const root = yield* copyFixture("arch-laptop");
    yield* writeFixtureFile(root, "sys/class/drm/card0/device/power/runtime_status", "active\n");
    return root;
  });

  it.effect("AC6: an active NVIDIA GPU is measured with one nvidia-smi query", () =>
    Effect.gen(function* () {
      const root = yield* copyLaptopWithActiveNvidia;
      const spawned: Array<SpawnedCommand> = [];
      const collector = yield* makeCollector(root, { spawned });
      const sample = yield* collector.read;

      assert.equal(spawned.length, 1);
      assert.match(spawned[0]!.command, /(^|[\\/])nvidia-smi(\.exe)?$/);
      assert.deepEqual(spawned[0]!.args, NVIDIA_SMI_ARGS);
      expect(gpuByVendor(sample, "nvidia")).toMatchObject({
        state: "active",
        busyPercent: 0,
        vramUsedBytes: 279 * MIB,
        vramTotalBytes: 8151 * MIB,
      });
      assert.isNotNull(sample.load1);
      assert.isNotNull(sample.memTotalBytes);
    }),
  );

  it.effect.each([
    { label: "is missing", nvidiaSmi: { kind: "missing" } as const },
    {
      label: "exits non-zero",
      nvidiaSmi: {
        kind: "exits",
        exitCode: 9,
        stdout:
          "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver. " +
          "Make sure that the latest NVIDIA driver is installed and running.\n",
      } as const,
    },
    { label: "runs past its 2 second timeout", nvidiaSmi: { kind: "hangs" } as const },
  ])(
    "AC6: when nvidia-smi $label, that GPU is null and every other metric is returned",
    ({ nvidiaSmi }) =>
      Effect.gen(function* () {
        const root = yield* copyLaptopWithActiveNvidia;
        const baseline = yield* (yield* makeCollector(root)).read;

        const onSpawn = yield* Deferred.make<void>();
        const collector = yield* makeCollector(root, { nvidiaSmi, onSpawn });
        const reading = yield* collector.read.pipe(Effect.forkChild);
        // The readers do real file I/O first; move the clock only once nvidia-smi is running.
        yield* Effect.raceFirst(Deferred.await(onSpawn), Fiber.await(reading));
        yield* TestClock.adjust("2 seconds");
        const sample = yield* Fiber.join(reading);

        expect(gpuByVendor(sample, "nvidia")).toMatchObject({
          state: "unavailable",
          busyPercent: null,
          vramUsedBytes: null,
          vramTotalBytes: null,
        });
        expect(withoutLiveFields(sample)).toEqual(
          withoutLiveFields({
            ...baseline,
            gpus:
              baseline.gpus?.map((gpu) =>
                gpu.vendor === "nvidia"
                  ? {
                      ...gpu,
                      state: "unavailable" as const,
                      busyPercent: null,
                      vramUsedBytes: null,
                      vramTotalBytes: null,
                    }
                  : gpu,
              ) ?? null,
          }),
        );
      }),
  );

  /** The arch-laptop copy with its NVIDIA GPU awake and a second NVIDIA GPU at PCI 0000:01:00.0. */
  const copyLaptopWithTwoActiveNvidia = Effect.gen(function* () {
    const root = yield* copyLaptopWithActiveNvidia;
    const device = "sys/class/drm/card2/device";
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${root}/${device}/power`, { recursive: true });
    yield* writeFixtureFile(root, `${device}/vendor`, "0x10de\n");
    yield* writeFixtureFile(
      root,
      `${device}/uevent`,
      "DRIVER=nvidia\nPCI_SLOT_NAME=0000:01:00.0\n",
    );
    yield* writeFixtureFile(root, `${device}/power/runtime_status`, "active\n");
    return root;
  });

  it.effect("AC6: nvidia-smi lines attach to cards by PCI bus id, not by position", () =>
    Effect.gen(function* () {
      const root = yield* copyLaptopWithTwoActiveNvidia;
      const collector = yield* makeCollector(root, {
        nvidiaSmi: {
          kind: "exits",
          exitCode: 0,
          // Bus order lists 01:00.0 first; DRM numbers it card2, after card0 at 64:00.0.
          stdout: "00000000:01:00.0, 90, 1000, 4000\n00000000:64:00.0, 10, 279, 8151\n",
        },
      });
      const sample = yield* collector.read;
      const byId = (id: string) => sample.gpus?.find((gpu) => gpu.id === id);
      expect(byId("card0")).toMatchObject({
        state: "active",
        busyPercent: 10,
        vramUsedBytes: 279 * MIB,
      });
      expect(byId("card2")).toMatchObject({
        state: "active",
        busyPercent: 90,
        vramUsedBytes: 1000 * MIB,
      });
    }),
  );

  it.effect("AC6: an NVIDIA card with no matching nvidia-smi bus id stays unavailable", () =>
    Effect.gen(function* () {
      const root = yield* copyLaptopWithActiveNvidia;
      const collector = yield* makeCollector(root, {
        nvidiaSmi: { kind: "exits", exitCode: 0, stdout: "00000000:99:00.0, 5, 1, 2\n" },
      });
      const sample = yield* collector.read;
      expect(gpuByVendor(sample, "nvidia")).toMatchObject({
        state: "unavailable",
        busyPercent: null,
        vramUsedBytes: null,
        vramTotalBytes: null,
      });
    }),
  );

  // -------------------------------------------------------------------------
  // AC7
  it.effect("AC7: a conversa reading has null GPU and temperature, zero swap, and no error", () =>
    Effect.gen(function* () {
      const spawned: Array<SpawnedCommand> = [];
      const collector = yield* makeCollector(fixtureRoot("conversa"), { spawned });
      const exit = yield* collector.read.pipe(Effect.exit);
      assert.isTrue(Exit.isSuccess(exit), `expected success, got ${String(exit)}`);
      const sample = yield* exit;

      yield* decodeHostStatsSample(sample);
      assert.isNull(sample.gpus);
      assert.isNull(sample.cpuTemperatureC);
      assert.equal(sample.swapTotalBytes, 0);
      assert.equal(sample.swapUsedBytes, 0);
      assert.equal(sample.memTotalBytes, 4_009_996 * KIB);
      assert.equal(sample.memUsedBytes, (4_009_996 - 2_105_124) * KIB);
      assert.equal(sample.load1, 0);
      assert.equal(sample.cpuCount, 2);
      assert.deepEqual(spawned, []);
    }),
  );

  // -------------------------------------------------------------------------
  // AC8
  type ReaderCase = {
    readonly reader: string;
    /** The file the malformed variant corrupts. */
    readonly file: string;
    /** The path fragment the throwing variant refuses. */
    readonly throwsOn: string;
    /** The sample the broken reader should leave, from the healthy one. */
    readonly expectMalformed: (healthy: HostStatsSample) => HostStatsSample;
    readonly expectThrown: (healthy: HostStatsSample) => HostStatsSample;
  };

  const nulling =
    (...fields: ReadonlyArray<keyof HostStatsSample>) =>
    (healthy: HostStatsSample): HostStatsSample => ({
      ...healthy,
      ...Object.fromEntries(fields.map((field) => [field, null])),
    });

  const READER_CASES: ReadonlyArray<ReaderCase> = [
    {
      reader: "load",
      file: "proc/loadavg",
      throwsOn: "proc/loadavg",
      expectMalformed: nulling("load1"),
      expectThrown: nulling("load1"),
    },
    {
      reader: "memory",
      file: "proc/meminfo",
      throwsOn: "proc/meminfo",
      expectMalformed: nulling("memUsedBytes", "memTotalBytes", "swapUsedBytes", "swapTotalBytes"),
      expectThrown: nulling("memUsedBytes", "memTotalBytes", "swapUsedBytes", "swapTotalBytes"),
    },
    {
      reader: "cpu",
      file: "proc/stat",
      throwsOn: "proc/stat",
      expectMalformed: nulling("cpuPercent", "cpuCount"),
      expectThrown: nulling("cpuPercent", "cpuCount"),
    },
    {
      reader: "network",
      file: "proc/net/dev",
      throwsOn: "proc/net/dev",
      expectMalformed: nulling("netRxBytesPerSec", "netTxBytesPerSec"),
      expectThrown: nulling("netRxBytesPerSec", "netTxBytesPerSec"),
    },
    {
      reader: "temperature",
      file: "sys/class/hwmon/hwmon3/temp1_input",
      throwsOn: "sys/class/hwmon",
      expectMalformed: nulling("cpuTemperatureC"),
      expectThrown: nulling("cpuTemperatureC"),
    },
    {
      reader: "gpu",
      file: "sys/class/drm/card0/device/gpu_busy_percent",
      throwsOn: "sys/class/drm",
      expectMalformed: (healthy) => ({
        ...healthy,
        gpus: healthy.gpus?.map((gpu) => ({ ...gpu, busyPercent: null })) ?? null,
      }),
      expectThrown: nulling("gpus"),
    },
  ];

  /** Two readings 60 s apart, the second over the `vigilia-home-60s-later` counters. */
  const secondReading = (options: {
    readonly root: string;
    readonly fileSystem?: FileSystem.FileSystem;
    readonly breakFiles?: Effect.Effect<
      void,
      PlatformError.PlatformError,
      FileSystem.FileSystem | Path.Path
    >;
  }) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(CAPTURED_AT_MS);
      const collector = yield* makeCollector(
        options.root,
        options.fileSystem ? { fileSystem: options.fileSystem } : {},
      );
      yield* options.breakFiles ?? Effect.void;
      yield* collector.read;
      yield* copyCountersFrom("vigilia-home-60s-later", options.root);
      yield* options.breakFiles ?? Effect.void;
      yield* TestClock.adjust("60 seconds");
      return yield* collector.read;
    });

  const healthySecondReading = Effect.gen(function* () {
    const sample = yield* secondReading({ root: yield* copyFixture("vigilia-home") });
    // Guard the comparison itself: every field a case nulls is non-null when healthy.
    for (const field of [
      "load1",
      "memTotalBytes",
      "swapTotalBytes",
      "cpuPercent",
      "cpuCount",
      "netRxBytesPerSec",
      "cpuTemperatureC",
      "gpus",
    ] as const) {
      assert.isNotNull(sample[field], `healthy reading has ${field}`);
    }
    return sample;
  });

  it.effect.each(READER_CASES)(
    "AC8: a malformed file for the $reader reader nulls only that reader's metrics",
    (readerCase) =>
      Effect.gen(function* () {
        const healthy = yield* healthySecondReading;
        const root = yield* copyFixture("vigilia-home");
        const broken = yield* secondReading({
          root,
          breakFiles: writeFixtureFile(root, readerCase.file, "garbage\n"),
        });
        expect(withoutLiveFields(broken)).toEqual(
          withoutLiveFields(readerCase.expectMalformed(healthy)),
        );
      }),
  );

  it.effect.each(READER_CASES)(
    "AC8: a thrown error in the $reader reader nulls only that reader's metrics",
    (readerCase) =>
      Effect.gen(function* () {
        const healthy = yield* healthySecondReading;
        const root = yield* copyFixture("vigilia-home");
        const broken = yield* secondReading({
          root,
          fileSystem: yield* throwingFileSystem(readerCase.throwsOn),
        });
        expect(withoutLiveFields(broken)).toEqual(
          withoutLiveFields(readerCase.expectThrown(healthy)),
        );
      }),
  );

  // -------------------------------------------------------------------------
  // Non-Linux fallbacks (plan detail): Node's `os` supplies CPU, load and memory.
  const GIB = 1024 * MIB;

  /** An `os` stand-in whose two cores have mutable times, so a test can advance them. */
  const fakeHostOs = (overrides: Partial<HostOsApi> = {}) => {
    const times = { user: 1_000, nice: 0, sys: 500, idle: 8_000, irq: 0 };
    const hostOs: HostOsApi = {
      cpus: () => [0, 1].map(() => ({ model: "fake", speed: 0, times: { ...times } })),
      loadavg: () => [1.5, 1, 0.5],
      totalmem: () => 16 * GIB,
      freemem: () => 4 * GIB,
      ...overrides,
    };
    return { hostOs, times };
  };

  it.effect(
    "portable: on darwin, os supplies CPU, load and memory and the Linux metrics are null",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(CAPTURED_AT_MS);
        const { hostOs, times } = fakeHostOs();
        const spawned: Array<SpawnedCommand> = [];
        const collector = yield* makeCollector(fixtureRoot("vigilia-home"), {
          platform: "darwin",
          hostOs,
          spawned,
        });
        const first = yield* collector.read;
        yield* decodeHostStatsSample(first);
        expect(first).toMatchObject({
          cpuPercent: null,
          cpuCount: 2,
          load1: 1.5,
          memTotalBytes: 16 * GIB,
          memUsedBytes: 12 * GIB,
          swapUsedBytes: null,
          swapTotalBytes: null,
          gpus: null,
          cpuTemperatureC: null,
          netRxBytesPerSec: null,
          netTxBytesPerSec: null,
        });
        assert.isNotNull(first.diskTotalBytes);
        assert.deepEqual(spawned, []);

        // Per core: 100 busy (user) and 300 idle, so 25 % busy.
        times.user += 100;
        times.idle += 300;
        yield* TestClock.adjust("60 seconds");
        const second = yield* collector.read;
        expect(second.cpuPercent).toBeCloseTo(25, 6);
      }),
  );

  it.effect("portable: on win32 the load average is null, because Windows always reports 0", () =>
    Effect.gen(function* () {
      const { hostOs } = fakeHostOs({ loadavg: () => [0, 0, 0] });
      const collector = yield* makeCollector(fixtureRoot("vigilia-home"), {
        platform: "win32",
        hostOs,
      });
      const sample = yield* collector.read;
      assert.isNull(sample.load1);
      assert.equal(sample.memTotalBytes, 16 * GIB);
    }),
  );

  const throwing = () => {
    throw new Error("host stats test: os call threw");
  };

  it.effect.each([
    { call: "cpus", override: { cpus: throwing }, nulls: ["cpuCount", "cpuPercent"] },
    { call: "loadavg", override: { loadavg: throwing }, nulls: ["load1"] },
    {
      call: "totalmem",
      override: { totalmem: throwing },
      nulls: ["memUsedBytes", "memTotalBytes"],
    },
    { call: "freemem", override: { freemem: throwing }, nulls: ["memUsedBytes", "memTotalBytes"] },
  ] as const)(
    "portable: a throwing os.$call nulls only its own metrics and keeps disk",
    ({ override, nulls }) =>
      Effect.gen(function* () {
        const root = fixtureRoot("vigilia-home");
        const healthy = yield* (yield* makeCollector(root, {
          platform: "darwin",
          hostOs: fakeHostOs().hostOs,
        })).read;
        const exit = yield* (yield* makeCollector(root, {
          platform: "darwin",
          hostOs: fakeHostOs(override).hostOs,
        })).read.pipe(Effect.exit);
        assert.isTrue(Exit.isSuccess(exit), `expected success, got ${String(exit)}`);
        const broken = yield* exit;
        assert.isNotNull(broken.diskTotalBytes);
        expect(withoutLiveFields(broken)).toEqual(
          withoutLiveFields({
            ...healthy,
            ...Object.fromEntries(nulls.map((field) => [field, null])),
          }),
        );
      }),
  );

  // -------------------------------------------------------------------------
  // Regression: what the repair and rework turns learned, beyond the fence.

  it.effect("regression: a NIC that vanishes between readings nulls the network rates", () =>
    Effect.gen(function* () {
      const second = yield* ratesAcross(
        "net/dev",
        procNetDevText([
          ["enp5s0", 1_000, 2_000],
          ["wlp12s0", 3_000, 4_000],
        ]),
        procNetDevText([["enp5s0", 1_600, 2_600]]),
      );
      assert.isNull(second.netRxBytesPerSec);
      assert.isNull(second.netTxBytesPerSec);
    }),
  );

  it.effect(
    "regression: a NIC replaced by another at the same interface count nulls the rates",
    () =>
      Effect.gen(function* () {
        const second = yield* ratesAcross(
          "net/dev",
          procNetDevText([
            ["enp5s0", 1_000, 2_000],
            ["wlp12s0", 3_000, 4_000],
          ]),
          procNetDevText([
            ["enp5s0", 1_600, 2_600],
            ["enp6s0", 9_000, 9_000],
          ]),
        );
        assert.isNull(second.netRxBytesPerSec);
        assert.isNull(second.netTxBytesPerSec);
      }),
  );

  it.effect("regression: one NIC's tx reset nulls only the tx rate and keeps the rx rate", () =>
    Effect.gen(function* () {
      const second = yield* ratesAcross(
        "net/dev",
        procNetDevText([
          ["enp5s0", 1_000, 2_000],
          ["wlp12s0", 3_000, 4_000],
        ]),
        procNetDevText([
          ["enp5s0", 1_600, 0],
          ["wlp12s0", 3_600, 7_000],
        ]),
      );
      expect(second.netRxBytesPerSec).toBeCloseTo(1_200 / 60, 6);
      assert.isNull(second.netTxBytesPerSec);
    }),
  );

  it.effect(
    "regression: an awake NVIDIA card without a PCI address in uevent stays unavailable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* copyLaptopWithActiveNvidia;
        yield* fs.remove(`${root}/sys/class/drm/card0/device/uevent`);
        const sample = yield* (yield* makeCollector(root)).read;
        expect(gpuByVendor(sample, "nvidia")).toMatchObject({
          state: "unavailable",
          busyPercent: null,
          vramUsedBytes: null,
          vramTotalBytes: null,
        });
        expect(gpuByVendor(sample, "amd")).toMatchObject({ state: "active", busyPercent: 56 });
      }),
  );

  it.effect(
    "regression: on win32 a throwing os.freemem nulls only memory and keeps CPU and disk",
    () =>
      Effect.gen(function* () {
        const exit = yield* (yield* makeCollector(fixtureRoot("vigilia-home"), {
          platform: "win32",
          hostOs: fakeHostOs({ freemem: throwing }).hostOs,
        })).read.pipe(Effect.exit);
        assert.isTrue(Exit.isSuccess(exit), `expected success, got ${String(exit)}`);
        const sample = yield* exit;
        assert.isNull(sample.memUsedBytes);
        assert.isNull(sample.memTotalBytes);
        assert.isNull(sample.load1);
        assert.equal(sample.cpuCount, 2);
        assert.isNotNull(sample.diskTotalBytes);
      }),
  );
});
