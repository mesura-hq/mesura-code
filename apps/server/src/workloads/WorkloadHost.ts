import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { parseTailscaleStatus, type TailscaleStatus } from "@t3tools/tailscale";
import type { WorkloadSummary } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import * as ProcessRunner from "../processRunner.ts";

export interface WorkloadManagerSnapshot {
  readonly state: WorkloadSummary["managerState"];
  readonly unit: string | null;
  readonly generation: string | null;
  readonly invocationId: string | null;
  readonly startMonotonic: string | null;
  readonly controlGroup: string | null;
}
export interface WorkloadResources {
  readonly ramBytes: number | null;
  readonly memoryCurrentBytes: number | null;
  readonly listeners: ReadonlyArray<{ readonly port: number; readonly address: string }>;
  readonly incomplete: boolean;
}
export class WorkloadHost extends Context.Service<
  WorkloadHost,
  {
    readonly manager: (unit: string) => Effect.Effect<WorkloadManagerSnapshot>;
    readonly bootId: Effect.Effect<string | null>;
    readonly resources: (controlGroup: string) => Effect.Effect<WorkloadResources>;
    readonly tailnet: Effect.Effect<TailscaleStatus | null>;
  }
>()("t3/workloads/WorkloadHost") {}

const unknownManager: WorkloadManagerSnapshot = {
  state: "unknown",
  unit: null,
  generation: null,
  invocationId: null,
  startMonotonic: null,
  controlGroup: null,
};
const unknownResources: WorkloadResources = {
  ramBytes: null,
  memoryCurrentBytes: null,
  listeners: [],
  incomplete: true,
};
const ManagerProperties = Schema.Struct({
  Id: Schema.String,
  LoadState: Schema.String,
  ActiveState: Schema.String,
  SubState: Schema.String,
  ControlGroup: Schema.optionalKey(Schema.String),
  Environment: Schema.optionalKey(Schema.String),
  InvocationID: Schema.optionalKey(Schema.String),
  ExecMainStartTimestampMonotonic: Schema.optionalKey(Schema.String),
});
const decodeManager = Schema.decodeUnknownOption(ManagerProperties);
const hex32 = /^[0-9a-f]{32}$/;
const bootPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function managerSnapshot(stdout: string, unit: string): WorkloadManagerSnapshot {
  const entries = stdout
    .trim()
    .split("\n")
    .map((line) => {
      const separator = line.indexOf("=");
      return separator < 0
        ? null
        : ([line.slice(0, separator), line.slice(separator + 1)] as const);
    });
  if (entries.some((entry) => entry === null)) return unknownManager;
  const properties = entries.flatMap((entry) => (entry === null ? [] : [entry]));
  if (new Set(properties.map(([key]) => key)).size !== properties.length) return unknownManager;
  const decoded = decodeManager(Object.fromEntries(properties));
  if (Option.isNone(decoded) || decoded.value.Id !== unit) return unknownManager;
  const value = decoded.value;
  if (
    value.LoadState === "not-found" &&
    value.ActiveState === "inactive" &&
    value.SubState === "dead"
  )
    return { ...unknownManager, state: "absent", unit };
  if (value.LoadState !== "loaded") return unknownManager;
  const markers = tokenizeCliArgs(value.Environment).filter((token) =>
    token.startsWith("MESURA_WORKLOAD_GENERATION="),
  );
  const generation =
    markers.length === 1 ? markers[0]!.slice("MESURA_WORKLOAD_GENERATION=".length) : "";
  const invocation = value.InvocationID ?? "";
  const start = value.ExecMainStartTimestampMonotonic ?? "";
  const state =
    // Active/exited units can retain configuration without a running process.
    value.ActiveState === "active" && value.SubState === "running"
      ? "running"
      : value.ActiveState === "inactive"
        ? "stopped"
        : value.ActiveState === "failed"
          ? "failed"
          : "unknown";
  return {
    state,
    unit,
    generation: hex32.test(generation) ? generation : null,
    invocationId: hex32.test(invocation) && invocation !== "0".repeat(32) ? invocation : null,
    startMonotonic: /^[0-9]+$/.test(start) && BigInt(start) > 0n ? start : null,
    controlGroup: value.ControlGroup || null,
  };
}

function counter(text: string | null): number | null {
  if (text === null || !/^[0-9]+$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return Number.isSafeInteger(value) ? value : null;
}
function processStart(text: string | null): string | null {
  if (text === null) return null;
  const start = text
    .slice(text.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/)[19];
  return start !== undefined && /^[0-9]+$/.test(start) ? start : null;
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const readText = Effect.fnUntraced(
    function* (path: string) {
      const result = yield* collectUint8StreamText({
        stream: fs.stream(path, { bytesToRead: 65537 }),
        maxBytes: 65536,
      });
      return result.truncated || result.invalidUtf8 ? null : result.text;
    },
    Effect.orElseSucceed(() => null),
  );
  const command = Effect.fnUntraced(
    function* (executable: string, args: ReadonlyArray<string>) {
      const output = yield* runner.run({
        command: executable,
        args,
        timeout: "3 seconds",
        maxOutputBytes: 1024 * 1024,
        outputMode: "error",
      });
      return output.code === 0 &&
        !output.timedOut &&
        !output.stdoutTruncated &&
        !output.stdoutInvalidUtf8
        ? output.stdout
        : null;
    },
    Effect.orElseSucceed(() => null),
  );
  const manager: WorkloadHost["Service"]["manager"] = Effect.fnUntraced(function* (unit: string) {
    const output = yield* command("/usr/bin/systemctl", [
      "--user",
      "show",
      unit,
      "--property=Id,LoadState,ActiveState,SubState,ControlGroup,InvocationID,ExecMainStartTimestampMonotonic,Environment",
    ]);
    return output === null ? unknownManager : managerSnapshot(output, unit);
  });
  const bootId = readText("/proc/sys/kernel/random/boot_id").pipe(
    Effect.map((text) => (text !== null && bootPattern.test(text.trim()) ? text.trim() : null)),
  );
  const tailnet = command("/usr/bin/tailscale", ["status", "--json"]).pipe(
    Effect.flatMap((output) =>
      output === null
        ? Effect.succeed(null)
        : parseTailscaleStatus(output).pipe(Effect.orElseSucceed(() => null)),
    ),
  );

  const resources: WorkloadHost["Service"]["resources"] = Effect.fnUntraced(
    function* (controlGroup: string) {
      if (
        !controlGroup.startsWith("/") ||
        controlGroup === "/" ||
        path.normalize(controlGroup) !== controlGroup ||
        controlGroup.includes("\u0000")
      )
        return unknownResources;
      const root = `/sys/fs/cgroup${controlGroup}`;
      if ((yield* fs.realPath(root)) !== root) return unknownResources;
      const directories = [root];
      for (let index = 0; index < directories.length; index++) {
        const directory = directories[index]!;
        if (directory.slice(root.length).split("/").length > 32) return unknownResources;
        const entries = yield* fs.readDirectory(directory);
        if (entries.length > 1024) return unknownResources;
        for (const entry of entries) {
          const child = path.join(directory, entry);
          if (!child.startsWith(`${root}/`)) return unknownResources;
          if ((yield* fs.stat(child)).type !== "Directory") continue;
          if ((yield* fs.realPath(child)) !== child || directories.length >= 256)
            return unknownResources;
          directories.push(child);
        }
      }
      const readPids = Effect.fnUntraced(function* () {
        const pids = new Set<number>();
        for (const directory of directories) {
          const text = yield* readText(`${directory}/cgroup.procs`);
          if (
            text === null ||
            text
              .split(/\s+/)
              .filter(Boolean)
              .some((pid) => !/^[1-9][0-9]*$/.test(pid))
          )
            return null;
          for (const pid of text.split(/\s+/).filter(Boolean)) {
            const value = Number(pid);
            if (!Number.isSafeInteger(value) || pids.size >= 4096) return null;
            pids.add(value);
          }
        }
        return [...pids].sort((a, b) => a - b);
      });
      const pids = yield* readPids();
      if (pids === null) return unknownResources;
      const starts = new Map<number, string>();
      for (const pid of pids) {
        const start = processStart(yield* readText(`/proc/${pid}/stat`));
        if (start === null) return unknownResources;
        starts.set(pid, start);
      }
      const memoryStat = yield* readText(`${root}/memory.stat`);
      const anon = memoryStat?.split("\n").filter((line) => line.startsWith("anon ")) ?? [];
      const ramBytes = anon.length === 1 ? counter(anon[0]!.slice(5)) : null;
      const memoryCurrentBytes = counter(yield* readText(`${root}/memory.current`));
      const sockets = yield* command("/usr/bin/ss", ["-H", "-ltnp"]);
      const pidsAfter = yield* readPids();
      if (pidsAfter === null || pidsAfter.join(",") !== pids.join(",")) return unknownResources;
      for (const pid of pids)
        if (processStart(yield* readText(`/proc/${pid}/stat`)) !== starts.get(pid))
          return unknownResources;
      const listeners: Array<{ port: number; address: string }> = [];
      for (const line of sockets?.split("\n").filter(Boolean) ?? []) {
        if (![...line.matchAll(/\bpid=([0-9]+)\b/g)].some((match) => starts.has(Number(match[1]))))
          continue;
        const endpoint = line.trim().split(/\s+/)[3];
        if (!endpoint) continue;
        const separator = endpoint.lastIndexOf(":");
        const port = counter(endpoint.slice(separator + 1));
        const address = endpoint.slice(0, separator).replace(/^\[|\]$/g, "");
        if (port === null || port < 1 || port > 65535 || !address) continue;
        if (!listeners.some((listener) => listener.port === port && listener.address === address))
          listeners.push({ port, address });
      }
      listeners.sort((a, b) => a.port - b.port || a.address.localeCompare(b.address));
      return {
        ramBytes,
        memoryCurrentBytes,
        listeners,
        incomplete: ramBytes === null || memoryCurrentBytes === null || sockets === null,
      };
    },
    Effect.orElseSucceed(() => unknownResources),
  );
  return WorkloadHost.of({ manager, bootId, resources, tailnet });
});
export const layer = Layer.effect(WorkloadHost, make);
