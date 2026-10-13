// Entry point: live WorkloadHost with injected filesystem and process boundaries only.
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as ByteSize from "effect/ByteSize";
import { ChildProcessSpawner } from "effect/process";
import * as ProcessRunner from "../processRunner.ts";
import * as WorkloadHost from "./WorkloadHost.ts";

const unit = "mesura-workload-preview.service";
const managerOutput = `Id=${unit}\nLoadState=loaded\nActiveState=active\nSubState=running\nControlGroup=/fixture.service\nInvocationID=${"b".repeat(32)}\nExecMainStartTimestampMonotonic=12345678901234567890\nEnvironment="SECRET=private value" "MESURA_WORKLOAD_GENERATION=${"a".repeat(32)}"\n`;
const cgroup = "/sys/fs/cgroup/fixture.service";
function hostLayer(
  options: { manager?: string; code?: number; changedPid?: boolean; sockets?: string } = {},
) {
  const calls: string[] = [];
  let reads = 0;
  const fs = FileSystem.makeNoop({
    realPath: (path) => Effect.succeed(path),
    readDirectory: (path) =>
      Effect.succeed(
        path === cgroup ? ["child", "memory.stat", "memory.current", "cgroup.procs"] : [],
      ),
    stat: (path) =>
      Effect.succeed({
        type: path === `${cgroup}/child` ? "Directory" : "File",
        mtime: Option.none(),
        atime: Option.none(),
        birthtime: Option.none(),
        dev: 0,
        ino: Option.none(),
        mode: 0o600,
        nlink: Option.none(),
        uid: Option.none(),
        gid: Option.none(),
        rdev: Option.none(),
        size: ByteSize.bytes(0),
        blksize: Option.none(),
        blocks: Option.none(),
      }),
    stream: (path) => {
      const contents = path.endsWith("memory.stat")
        ? "anon 123\nfile 9999\n"
        : path.endsWith("memory.current")
          ? "10122\n"
          : path.endsWith("cgroup.procs")
            ? path.includes("/child/")
              ? "42\n"
              : "41\n"
            : path.startsWith("/proc/41/")
              ? `41 (name with spaces) S ${Array(18).fill("0").join(" ")} ${options.changedPid && reads++ > 0 ? "2" : "1"}\n`
              : path.startsWith("/proc/42/")
                ? `42 (child) S ${Array(18).fill("0").join(" ")} 1\n`
                : "12345678-1234-1234-1234-123456789abc\n";
      return Stream.encodeText(Stream.make(contents));
    },
  });
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) => {
      calls.push(input.command);
      const stdout = input.command.endsWith("systemctl")
        ? (options.manager ?? managerOutput)
        : input.command.endsWith("ss")
          ? (options.sockets ??
            'LISTEN 0 511 0.0.0.0:6040 0.0.0.0:* users:(("node",pid=42,fd=3))\nLISTEN 0 511 [::1]:6026 [::]:* users:(("node",pid=41,fd=4))\n')
          : JSON.stringify({
              Self: { DNSName: "fixture.tailnet.ts.net.", TailscaleIPs: ["100.64.1.2"] },
            });
      return Effect.succeed({
        stdout,
        stderr: "private stderr",
        code: ChildProcessSpawner.ExitCode(options.code ?? 0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      });
    },
  });
  return {
    calls,
    layer: WorkloadHost.layer.pipe(
      Layer.provide(Path.layer),
      Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner)),
      Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)),
    ),
  };
}

it.effect("F2 manager retains exact generation while discarding raw environment and stderr", () =>
  Effect.gen(function* () {
    const fixture = hostLayer();
    const host = yield* WorkloadHost.WorkloadHost.pipe(Effect.provide(fixture.layer));
    const manager = yield* host.manager(unit);
    expect(manager).toMatchObject({
      state: "running",
      generation: "a".repeat(32),
      startMonotonic: "12345678901234567890",
    });
    expect(JSON.stringify(manager)).not.toMatch(/SECRET|private/);
  }),
);
it.effect("F2 manager proves absence only with successful not-found metadata", () =>
  Effect.gen(function* () {
    for (const [code, state] of [
      [0, "absent"],
      [1, "unknown"],
    ] as const) {
      const fixture = hostLayer({
        manager: `Id=${unit}\nLoadState=not-found\nActiveState=inactive\nSubState=dead\n`,
        code,
      });
      const host = yield* WorkloadHost.WorkloadHost.pipe(Effect.provide(fixture.layer));
      expect((yield* host.manager(unit)).state).toBe(state);
    }
  }),
);
it.effect("F2 cgroup RAM uses anon and descendant sockets retain sorted verified ports", () =>
  Effect.gen(function* () {
    const fixture = hostLayer();
    const host = yield* WorkloadHost.WorkloadHost.pipe(Effect.provide(fixture.layer));
    const resources = yield* host.resources("/fixture.service");
    expect(resources).toMatchObject({
      ramBytes: 123,
      memoryCurrentBytes: 10122,
      incomplete: false,
    });
    expect(resources.listeners.map((listener) => listener.port)).toEqual([6026, 6040]);
    expect(yield* host.tailnet).toEqual({
      magicDnsName: "fixture.tailnet.ts.net",
      tailnetIpv4Addresses: ["100.64.1.2"],
    });
    expect(fixture.calls).toEqual(["/usr/bin/ss", "/usr/bin/tailscale"]);
  }),
);
it.effect("F2 raced PID reuse and escaped cgroup never yield attributed listeners", () =>
  Effect.gen(function* () {
    const fixture = hostLayer({ changedPid: true });
    const host = yield* WorkloadHost.WorkloadHost.pipe(Effect.provide(fixture.layer));
    expect((yield* host.resources("/fixture.service")).listeners).toEqual([]);
    expect((yield* host.resources("/../user.slice")).incomplete).toBe(true);
  }),
);

it.effect("F2 active exited manager unit never claims a running process", () =>
  Effect.gen(function* () {
    const fixture = hostLayer({
      manager: managerOutput.replace("SubState=running", "SubState=exited"),
    });
    const host = yield* WorkloadHost.WorkloadHost.pipe(Effect.provide(fixture.layer));
    expect((yield* host.manager(unit)).state).toBe("unknown");
  }),
);
