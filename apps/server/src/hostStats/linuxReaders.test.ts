/**
 * Phase 1 fence of the hosts dock plan: acceptance criterion 4, and criterion 8
 * at the level of each reader.
 *
 * Entry point: the reader functions in `linuxReaders.ts`, which
 * `HostStatsCollector.make` composes. Nothing in the server calls them during
 * phase 1, so these specs drive them directly against `./fixtures`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  normalizePciAddress,
  parseNvidiaSmi,
  parseProcStat,
  readCpu,
  readCpuTemperature,
  readGpus,
  readLoad,
  readMemory,
  readNetwork,
  type HostStatsRoots,
} from "./linuxReaders.ts";

const FIXTURES_DIRECTORY = `${import.meta.dirname}/fixtures`;

const rootsAt = (root: string): HostStatsRoots => ({
  procRoot: `${root}/proc`,
  sysRoot: `${root}/sys`,
});

/** A spawner that fails the test if any reader spawns a process. */
const refusingSpawner = ChildProcessSpawner.make((command) =>
  Effect.die(new Error(`linuxReaders test: unexpected spawn of ${JSON.stringify(command)}`)),
);

function assertSucceedsWith<A, E>(exit: Exit.Exit<A, E>, expected: A) {
  assert.isTrue(Exit.isSuccess(exit), `expected success, got ${String(exit)}`);
  if (Exit.isSuccess(exit)) assert.deepEqual(exit.value, expected);
}

const copyFixture = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-host-stats-readers-" });
    const root = path.join(directory, name);
    yield* fs.copy(`${FIXTURES_DIRECTORY}/${name}`, root);
    return root;
  });

it.layer(NodeServices.layer)("linuxReaders phase 1 fence", (it) => {
  // -------------------------------------------------------------------------
  // AC4
  it.effect.each([
    {
      host: "vigilia-home",
      physical: "enp5s0 + wlp12s0",
      counters: [
        { name: "enp5s0", rxBytes: 2_102_414_876, txBytes: 3_274_314_579 },
        { name: "wlp12s0", rxBytes: 2_145_366, txBytes: 127_778 },
      ],
    },
    {
      host: "arch-laptop",
      physical: "eno1 + wlan0",
      counters: [
        { name: "eno1", rxBytes: 0, txBytes: 0 },
        { name: "wlan0", rxBytes: 39_171_753_906, txBytes: 31_448_306_311 },
      ],
    },
    {
      host: "conversa",
      physical: "enp1s0",
      counters: [{ name: "enp1s0", rxBytes: 1_815_990_770, txBytes: 1_574_020_054 }],
    },
  ])(
    "AC4: $host network counters cover only $physical, skipping lo, tailscale0, bridges and veths",
    ({ host, counters }) =>
      Effect.gen(function* () {
        const { netCounters } = yield* readNetwork(rootsAt(`${FIXTURES_DIRECTORY}/${host}`));
        assert.deepEqual(netCounters, counters);
      }),
  );

  it.effect("AC4: an interface loses its place in the total when its device link goes away", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* copyFixture("vigilia-home");
      yield* fs.remove(`${root}/sys/class/net/wlp12s0/device`, { recursive: true });
      const { netCounters } = yield* readNetwork(rootsAt(root));
      assert.deepEqual(netCounters, [
        { name: "enp5s0", rxBytes: 2_102_414_876, txBytes: 3_274_314_579 },
      ]);
    }),
  );

  // -------------------------------------------------------------------------
  // AC8, per reader: a malformed or missing file is a null result, never a failure.
  interface ReaderCase {
    readonly reader: string;
    readonly file: string;
    readonly read: (
      roots: HostStatsRoots,
    ) => Effect.Effect<Readonly<Record<string, unknown>>, never, FileSystem.FileSystem>;
    readonly nulls: Readonly<Record<string, null>>;
  }

  const READERS: ReadonlyArray<ReaderCase> = [
    {
      reader: "readLoad",
      file: "proc/loadavg",
      read: readLoad,
      nulls: { load1: null },
    },
    {
      reader: "readMemory",
      file: "proc/meminfo",
      read: readMemory,
      nulls: { memUsedBytes: null, memTotalBytes: null, swapUsedBytes: null, swapTotalBytes: null },
    },
    {
      reader: "readCpu",
      file: "proc/stat",
      read: readCpu,
      nulls: { cpuCount: null, cpuCounters: null },
    },
    {
      reader: "readNetwork",
      file: "proc/net/dev",
      read: readNetwork,
      nulls: { netCounters: null },
    },
    {
      reader: "readCpuTemperature",
      file: "sys/class/hwmon/hwmon3/temp1_input",
      read: readCpuTemperature,
      nulls: { cpuTemperatureC: null },
    },
  ];

  it.effect.each(READERS)(
    "AC8: $reader returns nulls for a malformed $file",
    ({ file, read, nulls }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* copyFixture("vigilia-home");
        yield* fs.writeFileString(`${root}/${file}`, "garbage\n");
        const exit = yield* Effect.exit(read(rootsAt(root)));
        assertSucceedsWith(exit, nulls);
      }),
  );

  it.effect.each(READERS)(
    "AC8: $reader returns nulls for a missing $file",
    ({ file, read, nulls }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* copyFixture("vigilia-home");
        yield* fs.remove(`${root}/${file}`);
        const exit = yield* Effect.exit(read(rootsAt(root)));
        assertSucceedsWith(exit, nulls);
      }),
  );

  it.effect("AC8: readCpu rejects a cpu line with fewer than eight counted fields", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* copyFixture("vigilia-home");
      yield* fs.writeFileString(`${root}/proc/stat`, "cpu  100 0 100 800\ncpu0 100 0 100 800\n");
      const exit = yield* Effect.exit(readCpu(rootsAt(root)));
      assertSucceedsWith(exit, { cpuCount: null, cpuCounters: null });
    }),
  );

  it.effect("AC8: readGpus nulls only the busy percent of a GPU whose busy file is malformed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* copyFixture("vigilia-home");
      yield* fs.writeFileString(`${root}/sys/class/drm/card0/device/gpu_busy_percent`, "garbage\n");
      const { gpus } = yield* readGpus(rootsAt(root)).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, refusingSpawner),
      );
      assert.equal(gpus?.length, 1);
      assert.include(gpus![0], {
        vendor: "amd",
        busyPercent: null,
        vramUsedBytes: 164_368_384,
        vramTotalBytes: 536_870_912,
      });
    }),
  );

  it.effect("AC8: readGpus returns null when the DRM class directory is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* copyFixture("vigilia-home");
      yield* fs.remove(`${root}/sys/class/drm`, { recursive: true });
      const exit = yield* Effect.exit(
        readGpus(rootsAt(root)).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, refusingSpawner),
        ),
      );
      assertSucceedsWith(exit, { gpus: null });
    }),
  );
});

describe("linuxReaders regression: parsers", () => {
  const MIB = 1024 * 1024;
  const cpuLine = (count: number) =>
    `cpu  ${Array.from({ length: count }, (_, index) => index + 1).join(" ")}\ncpu0 1\n`;

  it("regression: parseProcStat accepts exactly eight cpu fields and rejects seven", () => {
    assert.deepEqual(parseProcStat(cpuLine(8)), {
      cpuCount: 1,
      cpuCounters: { fields: [1, 2, 3, 4, 5, 6, 7, 8] },
    });
    assert.deepEqual(parseProcStat(cpuLine(7)), { cpuCount: null, cpuCounters: null });
  });

  it("regression: parseProcStat keeps only the first eight of ten fields (guest time is inside user)", () => {
    assert.deepEqual(parseProcStat(cpuLine(10)).cpuCounters, {
      fields: [1, 2, 3, 4, 5, 6, 7, 8],
    });
  });

  it("regression: parseProcStat rejects a cpu field beyond the safe integer range", () => {
    const text = "cpu  1 2 3 99999999999999999999 5 6 7 8\ncpu0 1\n";
    assert.deepEqual(parseProcStat(text), { cpuCount: null, cpuCounters: null });
  });

  it("regression: normalizePciAddress equates nvidia-smi and sysfs spellings of one address", () => {
    assert.equal(normalizePciAddress("00000000:64:00.0"), normalizePciAddress("0000:64:00.0"));
    assert.equal(normalizePciAddress("00000000:0A:00.0"), normalizePciAddress("0000:0a:00.0"));
    assert.notEqual(normalizePciAddress("0001:64:00.0"), normalizePciAddress("0000:64:00.0"));
    assert.isNull(normalizePciAddress("GPU-1234"));
  });

  it("regression: parseNvidiaSmi keys lines by bus id and skips lines without one", () => {
    const readings = parseNvidiaSmi(
      "00000000:01:00.0, 90, 1000, 4000\n" +
        "0, 279, 8151\n" +
        "00000000:64:00.0, [N/A], 279, 8151\n" +
        "00000000:65:00.0, [N/A], [N/A], [N/A]\n",
    );
    assert.deepEqual(
      [...readings.entries()],
      [
        [
          normalizePciAddress("0000:01:00.0"),
          { busyPercent: 90, vramUsedBytes: 1000 * MIB, vramTotalBytes: 4000 * MIB },
        ],
        [
          normalizePciAddress("0000:64:00.0"),
          { busyPercent: null, vramUsedBytes: 279 * MIB, vramTotalBytes: 8151 * MIB },
        ],
      ],
    );
  });
});
