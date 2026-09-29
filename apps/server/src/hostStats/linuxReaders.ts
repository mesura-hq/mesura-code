import type { HostStatsGpu } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { withNullsOnFailure } from "./readerGuard.ts";

/**
 * Readers for Linux `/proc` and `/sys`. Each one returns its own fields and
 * never fails: a missing file, a malformed file or a thrown error becomes
 * nulls for that reader's fields only. Roots are injectable so fixture trees
 * stand in for the real kernel interfaces in tests.
 */
export interface HostStatsRoots {
  readonly procRoot: string;
  readonly sysRoot: string;
}

export const LINUX_ROOTS: HostStatsRoots = { procRoot: "/proc", sysRoot: "/sys" };

/**
 * The eight counted `/proc/stat` fields, in kernel order: user, nice, system,
 * idle, iowait, irq, softirq, steal. The collector keeps every field, not an
 * idle/total pair, so it can see one field go backwards while the sum grows.
 */
export interface CpuCounters {
  readonly fields: ReadonlyArray<number>;
}

export const CPU_IDLE_FIELD = 3;
export const CPU_IOWAIT_FIELD = 4;

/**
 * One interface's byte counters. The collector keeps them per interface, not
 * summed, so a reset NIC is not hidden by growth on another.
 */
export interface NetworkInterfaceCounters {
  readonly name: string;
  readonly rxBytes: number;
  readonly txBytes: number;
}

const NVIDIA_SMI_ARGS = [
  "--query-gpu=pci.bus_id,utilization.gpu,memory.used,memory.total",
  "--format=csv,noheader,nounits",
];
const NVIDIA_SMI_TIMEOUT = "2 seconds";
const MIB = 1024 * 1024;

function parseNonNegativeInteger(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/** A utilisation reading, or null when it is outside 0-100. */
function percentOrNull(value: number | null): number | null {
  return value !== null && value <= 100 ? value : null;
}

function parseInteger(text: string): number | null {
  const trimmed = text.trim();
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : null;
}

/** Numeric suffix order, so `hwmon10` sorts after `hwmon9`. */
function sortedByIndex(entries: ReadonlyArray<string>, pattern: RegExp): Array<string> {
  return entries
    .filter((entry) => pattern.test(entry))
    .toSorted((left, right) => Number(/\d+$/.exec(left)![0]) - Number(/\d+$/.exec(right)![0]));
}

/** A file that may legitimately be absent; a thrown error still reaches the reader's guard. */
const readOptionalFile = (fs: FileSystem.FileSystem, path: string) =>
  fs.readFileString(path).pipe(Effect.option);

// ---------------------------------------------------------------------------
// CPU, load, memory

type CpuReading = {
  readonly cpuCount: number | null;
  readonly cpuCounters: CpuCounters | null;
};

type MemoryReading = {
  readonly memUsedBytes: number | null;
  readonly memTotalBytes: number | null;
  readonly swapUsedBytes: number | null;
  readonly swapTotalBytes: number | null;
};

/**
 * `/proc/stat` per proc(5): only the first eight fields count, because
 * `guest` and `guest_nice` are already inside `user` and `nice`. Every Linux
 * since 2.6.11 prints at least those eight; a shorter line is malformed.
 */
export function parseProcStat(text: string): CpuReading {
  const [firstLine = ""] = text.split("\n", 1);
  const match = /^cpu\s+(\d+(?:\s+\d+)*)\s*$/.exec(firstLine);
  const fields = match ? match[1]!.split(/\s+/).slice(0, 8).map(parseNonNegativeInteger) : [];
  const cpuCounters =
    fields.length === 8 && fields.every((field) => field !== null)
      ? { fields: fields as ReadonlyArray<number> }
      : null;
  const cpuCount = text.split("\n").filter((line) => /^cpu\d+\s/.test(line)).length;
  return { cpuCount: cpuCounters && cpuCount > 0 ? cpuCount : null, cpuCounters };
}

export const readCpu = (roots: HostStatsRoots) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return parseProcStat(yield* fs.readFileString(`${roots.procRoot}/stat`));
  }).pipe(withNullsOnFailure<CpuReading>({ cpuCount: null, cpuCounters: null }));

export const readLoad = (roots: HostStatsRoots) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(`${roots.procRoot}/loadavg`);
    const match = /^(\d+(?:\.\d+)?)\s/.exec(text);
    return { load1: match ? Number(match[1]) : null };
  }).pipe(withNullsOnFailure<{ readonly load1: number | null }>({ load1: null }));

export const readMemory = (roots: HostStatsRoots) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(`${roots.procRoot}/meminfo`);
    const kibibytes = new Map(
      Array.from(text.matchAll(/^(\w+):\s+(\d+) kB$/gm), (match) => [
        match[1]!,
        Number(match[2]) * 1024,
      ]),
    );
    const usedAndTotal = (totalKey: string, freeKey: string) => {
      const total = kibibytes.get(totalKey);
      const free = kibibytes.get(freeKey);
      return total === undefined || free === undefined
        ? { used: null, total: null }
        : { used: Math.max(0, total - free), total };
    };
    const memory = usedAndTotal("MemTotal", "MemAvailable");
    const swap = usedAndTotal("SwapTotal", "SwapFree");
    return {
      memUsedBytes: memory.used,
      memTotalBytes: memory.total,
      swapUsedBytes: swap.used,
      swapTotalBytes: swap.total,
    };
  }).pipe(
    withNullsOnFailure<MemoryReading>({
      memUsedBytes: null,
      memTotalBytes: null,
      swapUsedBytes: null,
      swapTotalBytes: null,
    }),
  );

// ---------------------------------------------------------------------------
// Network

/** Receive and transmit bytes per interface from `/proc/net/dev`, or null when malformed. */
export function parseProcNetDev(text: string): ReadonlyArray<NetworkInterfaceCounters> | null {
  const [header = "", ...lines] = text.split("\n");
  if (!header.startsWith("Inter-|")) return null;
  const interfaces: Array<NetworkInterfaceCounters> = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === "") continue;
    const match = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    const fields = match?.[2]!.trim().split(/\s+/).map(parseNonNegativeInteger);
    if (!match || !fields || fields.length < 16 || fields.some((field) => field === null)) {
      return null;
    }
    interfaces.push({ name: match[1]!, rxBytes: fields[0]!, txBytes: fields[8]! });
  }
  return interfaces;
}

/**
 * Counters of the interfaces backed by hardware: only those have a `device`
 * link in `/sys/class/net`, which leaves out `lo`, `tailscale0`, bridges and
 * veths.
 */
export const readNetwork = (roots: HostStatsRoots) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const interfaces = parseProcNetDev(yield* fs.readFileString(`${roots.procRoot}/net/dev`));
    if (!interfaces) return { netCounters: null };
    const physical = yield* Effect.filter(interfaces, (networkInterface) =>
      fs.exists(`${roots.sysRoot}/class/net/${networkInterface.name}/device`),
    );
    return { netCounters: physical };
  }).pipe(
    withNullsOnFailure<{ readonly netCounters: ReadonlyArray<NetworkInterfaceCounters> | null }>({
      netCounters: null,
    }),
  );

// ---------------------------------------------------------------------------
// Temperature

/** Chips in preference order, with the label that names the package temperature. */
const CPU_TEMPERATURE_CHIPS: ReadonlyArray<{
  readonly name: string;
  readonly labels: ReadonlyArray<string>;
}> = [
  { name: "k10temp", labels: ["Tctl", "Tdie"] },
  { name: "coretemp", labels: ["Package id 0"] },
  { name: "zenpower", labels: ["Tctl", "Tdie"] },
];

/**
 * The package temperature of the first preferred chip present. The chip's
 * labelled input wins; without labels, its first input. A preferred chip
 * with an unreadable value is null rather than a lower-priority sensor.
 */
export const readCpuTemperature = (roots: HostStatsRoots) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const hwmonDirectory = `${roots.sysRoot}/class/hwmon`;
    const chips = new Map<string, string>();
    for (const entry of sortedByIndex(yield* fs.readDirectory(hwmonDirectory), /^hwmon\d+$/)) {
      const name = yield* readOptionalFile(fs, `${hwmonDirectory}/${entry}/name`);
      if (Option.isSome(name) && !chips.has(name.value.trim())) {
        chips.set(name.value.trim(), `${hwmonDirectory}/${entry}`);
      }
    }
    const preferred = CPU_TEMPERATURE_CHIPS.find((chip) => chips.has(chip.name));
    if (!preferred) return { cpuTemperatureC: null };
    const chipDirectory = chips.get(preferred.name)!;
    const inputs = sortedByIndex(
      (yield* fs.readDirectory(chipDirectory))
        .filter((entry) => /^temp\d+_input$/.test(entry))
        .map((entry) => entry.replace(/_input$/, "")),
      /^temp\d+$/,
    );
    let chosen = inputs[0];
    for (const input of inputs) {
      const label = yield* readOptionalFile(fs, `${chipDirectory}/${input}_label`);
      if (Option.isSome(label) && preferred.labels.includes(label.value.trim())) {
        chosen = input;
        break;
      }
    }
    if (!chosen) return { cpuTemperatureC: null };
    const millidegrees = parseInteger(yield* fs.readFileString(`${chipDirectory}/${chosen}_input`));
    return { cpuTemperatureC: millidegrees === null ? null : millidegrees / 1000 };
  }).pipe(
    withNullsOnFailure<{ readonly cpuTemperatureC: number | null }>({ cpuTemperatureC: null }),
  );

// ---------------------------------------------------------------------------
// GPUs

const GPU_VENDORS: Readonly<Record<string, HostStatsGpu["vendor"]>> = {
  "0x1002": "amd",
  "0x10de": "nvidia",
  "0x8086": "intel",
};

/** The sysfs files `amdgpu` and `i915`/`xe` expose; a card with none of them is not measurable. */
const GPU_METRIC_FILES = ["gpu_busy_percent", "mem_info_vram_used", "mem_info_vram_total"] as const;

type NvidiaReading = Pick<HostStatsGpu, "busyPercent" | "vramUsedBytes" | "vramTotalBytes">;

/**
 * A PCI address in one spelling: `nvidia-smi` prints an 8-digit domain
 * (`00000000:64:00.0`), sysfs a 4-digit one (`0000:64:00.0`).
 */
export function normalizePciAddress(address: string): string | null {
  const match = /^([0-9a-f]{1,8}):([0-9a-f]{2}):([0-9a-f]{2})\.([0-7])$/i.exec(address.trim());
  if (!match) return null;
  const [, domain, bus, device, fn] = match;
  return `${Number.parseInt(domain!, 16)}:${bus!.toLowerCase()}:${device!.toLowerCase()}.${fn}`;
}

/**
 * One `pci.bus_id, utilization.gpu, memory.used, memory.total` line per GPU,
 * memory in MiB, keyed by normalized PCI address. Lines are keyed rather than
 * matched by position because nothing guarantees `nvidia-smi` and DRM
 * enumerate GPUs in the same order.
 */
export function parseNvidiaSmi(stdout: string): ReadonlyMap<string, NvidiaReading> {
  const readings = new Map<string, NvidiaReading>();
  for (const line of stdout.split("\n")) {
    const [busId = "", ...metrics] = line.split(",");
    const address = normalizePciAddress(busId);
    if (!address || metrics.length !== 3) continue;
    const [busy = null, used = null, total = null] = metrics.map(parseNonNegativeInteger);
    if (busy === null && used === null && total === null) continue;
    readings.set(address, {
      busyPercent: percentOrNull(busy),
      vramUsedBytes: used === null ? null : used * MIB,
      vramTotalBytes: total === null ? null : total * MIB,
    });
  }
  return readings;
}

/** The card's PCI address from `device/uevent`, or null when absent. */
const readPciAddress = (fs: FileSystem.FileSystem, device: string) =>
  readOptionalFile(fs, `${device}/uevent`).pipe(
    Effect.map((uevent) => {
      const slot = Option.isSome(uevent)
        ? /^PCI_SLOT_NAME=(.+)$/m.exec(uevent.value)?.[1]
        : undefined;
      return slot ? normalizePciAddress(slot) : null;
    }),
  );

/** Stdout of `nvidia-smi` when it exits 0 within its timeout, otherwise null. */
const queryNvidiaSmi = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(
    ChildProcess.make("nvidia-smi", NVIDIA_SMI_ARGS, { stdin: "ignore", stderr: "ignore" }),
  );
  const [stdout, exitCode] = yield* Effect.all(
    [handle.stdout.pipe(Stream.decodeText, Stream.mkString), handle.exitCode],
    { concurrency: 2 },
  );
  return exitCode === 0 ? stdout : null;
}).pipe(
  Effect.scoped,
  Effect.timeoutOption(NVIDIA_SMI_TIMEOUT),
  Effect.map(Option.getOrNull),
  Effect.orElseSucceed(() => null),
);

const unavailableGpu = (id: string, vendor: HostStatsGpu["vendor"]): HostStatsGpu => ({
  id,
  vendor,
  state: "unavailable",
  busyPercent: null,
  vramUsedBytes: null,
  vramTotalBytes: null,
});

/**
 * Every DRM card that reports something. AMD and Intel expose busy percent
 * and VRAM in sysfs. NVIDIA needs `nvidia-smi`, which wakes a
 * runtime-suspended GPU and drains a laptop battery, so a suspended card is
 * reported as sleeping and nothing is spawned. A card with no metric files
 * (a virtual display adapter) is skipped; no measurable card is null.
 */
export const readGpus = (roots: HostStatsRoots) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const drmDirectory = `${roots.sysRoot}/class/drm`;
    const readNumber = (path: string) =>
      readOptionalFile(fs, path).pipe(
        Effect.map((text) => (Option.isSome(text) ? parseNonNegativeInteger(text.value) : null)),
      );

    const gpus: Array<HostStatsGpu> = [];
    const awakeNvidia: Array<{ readonly id: string; readonly address: string | null }> = [];
    let anyNvidiaSleeping = false;
    for (const id of sortedByIndex(yield* fs.readDirectory(drmDirectory), /^card\d+$/)) {
      const device = `${drmDirectory}/${id}/device`;
      const vendorId = yield* readOptionalFile(fs, `${device}/vendor`);
      if (Option.isNone(vendorId)) continue;
      const vendor = GPU_VENDORS[vendorId.value.trim().toLowerCase()] ?? "other";
      if (vendor === "nvidia") {
        const runtimeStatus = yield* readOptionalFile(fs, `${device}/power/runtime_status`);
        const sleeping = Option.isSome(runtimeStatus) && runtimeStatus.value.trim() === "suspended";
        anyNvidiaSleeping ||= sleeping;
        if (!sleeping) awakeNvidia.push({ id, address: yield* readPciAddress(fs, device) });
        gpus.push({ ...unavailableGpu(id, vendor), state: sleeping ? "sleeping" : "unavailable" });
        continue;
      }
      const metricFilesPresent = yield* Effect.forEach(GPU_METRIC_FILES, (file) =>
        fs.exists(`${device}/${file}`),
      );
      if (!metricFilesPresent.some(Boolean)) continue;
      const busy = yield* readNumber(`${device}/gpu_busy_percent`);
      const vramUsedBytes = yield* readNumber(`${device}/mem_info_vram_used`);
      const vramTotalBytes = yield* readNumber(`${device}/mem_info_vram_total`);
      gpus.push({
        id,
        vendor,
        state: "active",
        busyPercent: percentOrNull(busy),
        vramUsedBytes,
        vramTotalBytes,
      });
    }

    // nvidia-smi queries every NVIDIA GPU at once, so one sleeping GPU keeps it
    // from running at all; the awake ones then stay unavailable. A card whose
    // PCI address has no nvidia-smi line also stays unavailable.
    if (awakeNvidia.length > 0 && !anyNvidiaSleeping) {
      const stdout = yield* queryNvidiaSmi;
      const readings = stdout === null ? new Map() : parseNvidiaSmi(stdout);
      for (const { id, address } of awakeNvidia) {
        const reading = address === null ? undefined : readings.get(address);
        const gpuIndex = gpus.findIndex((gpu) => gpu.id === id);
        if (reading) gpus[gpuIndex] = { ...gpus[gpuIndex]!, state: "active", ...reading };
      }
    }
    return { gpus: gpus.length > 0 ? gpus : null };
  }).pipe(
    withNullsOnFailure<{ readonly gpus: ReadonlyArray<HostStatsGpu> | null }>({ gpus: null }),
  );
