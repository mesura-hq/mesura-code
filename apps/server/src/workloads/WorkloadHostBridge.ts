import type { WorkloadControlRefusal } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { WorkloadRecord } from "./WorkloadRecord.ts";

export class WorkloadBridgeError extends Schema.TaggedError<WorkloadBridgeError>()(
  "WorkloadBridgeError",
  {
    reason: Schema.Literals([
      "wrapper-unavailable",
      "invalid-launch",
      "replay-context-unavailable",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return "The workload host command is unavailable.";
  }
}
export class WorkloadHostBridge extends Context.Service<
  WorkloadHostBridge,
  {
    readonly available: Effect.Effect<boolean>;
    readonly validateReplay: (
      record: WorkloadRecord,
    ) => Effect.Effect<WorkloadControlRefusal | null>;
    readonly stop: (record: WorkloadRecord) => Effect.Effect<number, WorkloadBridgeError>;
    readonly replay: (record: WorkloadRecord) => Effect.Effect<number, WorkloadBridgeError>;
  }
>()("t3/workloads/WorkloadHostBridge") {}

// Paths are trusted composition, never RPC input. Replay uses the private
// registry recipe, not the server's credentials or its full environment.
export const layerWith = (
  options: { readonly wrapper?: string; readonly runtime?: string; readonly manager?: string } = {},
) =>
  Layer.effect(
    WorkloadHostBridge,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const platform = yield* HostProcess.Platform;
      const home = yield* HostProcess.HomeDirectory;
      const environment = yield* HostProcess.Environment;
      const uid = yield* Effect.sync(() => process.getuid?.());
      const wrapper = options.wrapper ?? "/usr/local/bin/mesura-agent-service";
      const runtime = options.runtime ?? `/run/user/${uid}`;
      const approvedEnvironment = {
        HOME: home,
        XDG_RUNTIME_DIR: runtime,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
        ...(environment.XDG_STATE_HOME ? { XDG_STATE_HOME: environment.XDG_STATE_HOME } : {}),
      };
      const executable = (filename: string) =>
        fs.stat(filename).pipe(
          Effect.map((stat) => stat.type === "File" && (stat.mode & 0o111) !== 0),
          Effect.orElseSucceed(() => false),
        );
      const available = Effect.gen(function* () {
        if (
          platform !== "linux" ||
          uid === undefined ||
          !path.isAbsolute(home) ||
          !path.isAbsolute(wrapper)
        )
          return false;
        if (
          !options.runtime &&
          environment.XDG_RUNTIME_DIR &&
          environment.XDG_RUNTIME_DIR !== runtime
        )
          return false;
        if (
          environment.DBUS_SESSION_BUS_ADDRESS &&
          environment.DBUS_SESSION_BUS_ADDRESS !== approvedEnvironment.DBUS_SESSION_BUS_ADDRESS
        )
          return false;
        const stat = yield* fs.stat(wrapper);
        return (
          stat.type === "File" &&
          (stat.mode & 0o111) !== 0 &&
          (stat.mode & 0o022) === 0 &&
          Option.isSome(stat.uid) &&
          (stat.uid.value === 0 || stat.uid.value === uid)
        );
      }).pipe(Effect.orElseSucceed(() => false));
      const validateReplay: WorkloadHostBridge["Service"]["validateReplay"] = (record) =>
        Effect.gen(function* () {
          if (
            !record.PATH ||
            !record.environmentId ||
            !record.providerInstanceId ||
            record.providerThreadRef?.driver !== "codex" ||
            !record.providerThreadRef.nativeId
          )
            return "replay-context-unavailable" as const;
          if (
            !/^[1-9][0-9]*(?:[KMGTPE](?:B)?)?$/.test(record.memoryHigh) ||
            record.argv.length === 0
          )
            return "invalid-launch" as const;
          if ((yield* fs.stat(record.cwd)).type !== "Directory") return "invalid-launch" as const;
          const command = record.argv[0]!;
          const candidates = command.includes("/")
            ? [path.resolve(record.cwd, command)]
            : record.PATH.split(":").map((entry) => path.resolve(record.cwd, entry, command));
          for (const candidate of candidates) if (yield* executable(candidate)) return null;
          return "invalid-launch" as const;
        }).pipe(Effect.orElseSucceed(() => "invalid-launch" as const));
      const run = (
        command: string,
        args: ReadonlyArray<string>,
        cwd: string,
        env: Record<string, string>,
      ) =>
        Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make(command, args, {
                cwd,
                env,
                extendEnv: false,
                shell: false,
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
                killSignal: "SIGTERM",
                forceKillAfter: "2 seconds",
              }),
            );
            return yield* child.exitCode;
          }),
        ).pipe(
          Effect.timeout("80 seconds"),
          Effect.mapError((cause) => new WorkloadBridgeError({ reason: "invalid-launch", cause })),
        );
      return WorkloadHostBridge.of({
        available,
        validateReplay,
        stop: (record) =>
          run(options.manager ?? "/usr/bin/systemctl", ["--user", "stop", record.unit], home, {
            ...approvedEnvironment,
            PATH: "/usr/bin:/bin",
          }),
        replay: (record) =>
          run(
            wrapper,
            [record.name, "--memory", record.memoryHigh, "--", ...record.argv],
            record.cwd,
            {
              ...approvedEnvironment,
              PATH: record.PATH ?? "",
              MESURA_ENVIRONMENT_ID: record.environmentId ?? "",
              MESURA_PROVIDER_INSTANCE_ID: record.providerInstanceId ?? "",
              MESURA_WORKLOAD_IDENTITY_KIND: "codex-thread",
              CODEX_THREAD_ID: record.providerThreadRef?.nativeId ?? "",
            },
          ),
      });
    }),
  );
export const layer = layerWith();
