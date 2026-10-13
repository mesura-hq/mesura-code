import type { WorkloadControlRefusal } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { WorkloadRecord } from "./WorkloadRecord.ts";

// An executable or schema2 record alone does not establish FD9 compatibility.
const COMPATIBLE_WRAPPER_DIGEST =
  "1be7d193120bc5158c2cf61b796948c4f30d2538e9ae61650db46fd94f56c0b6";
export class WorkloadBridgeError extends Schema.TaggedError<WorkloadBridgeError>()(
  "WorkloadBridgeError",
  {
    reason: Schema.Literals(["handoff-unavailable", "lock-unavailable", "invalid-launch"]),
    cause: Schema.Defect(),
    stage: Schema.optionalKey(
      Schema.Literals([
        "canonical",
        "wrapper",
        "ancestors",
        "descriptor",
        "acquisition",
        "dispatch",
      ]),
    ),
  },
) {
  override get message() {
    return "The workload host boundary is unavailable.";
  }
}
export interface WorkloadLease {
  readonly validateReplay: (
    record: WorkloadRecord,
  ) => Effect.Effect<WorkloadControlRefusal | null, WorkloadBridgeError>;
  readonly stop: Effect.Effect<number, WorkloadBridgeError>;
  readonly replay: (record: WorkloadRecord) => Effect.Effect<number, WorkloadBridgeError>;
}
export class WorkloadHostBridge extends Context.Service<
  WorkloadHostBridge,
  {
    readonly available: Effect.Effect<boolean>;
    readonly withLock: <A, E, R>(
      record: WorkloadRecord,
      use: (lease: WorkloadLease) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | WorkloadBridgeError, R>;
  }
>()("t3/workloads/WorkloadHostBridge") {}

// Fixed stdlib source travels in the SEA bundle. All request data uses separate
// JSON frames. FD9 stays on one OFD until the enclosing Effect scope closes.
const bridgeSource = String.raw`
import fcntl, hashlib, json, os, pathlib, re, shutil, signal, stat, subprocess, sys
c = json.loads(sys.argv[1])
uid = os.getuid()
child = None
stage = "canonical"

def finish(signum, frame):
    if child is not None and child.poll() is None:
        child.terminate()
        try: child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=2)
    raise SystemExit(0)
signal.signal(signal.SIGTERM, finish)
signal.signal(signal.SIGINT, finish)

def emit(value):
    print(json.dumps(value), flush=True)

def private_dir(text, runtime=False):
    p = pathlib.Path(text)
    if not p.is_absolute() or ".." in p.parts: raise ValueError()
    if runtime: private_dir(str(p.parent))
    current = pathlib.Path(p.anchor)
    for i, part in enumerate(("", *p.parts[1:])):
        if part: current /= part
        try: link = current.lstat()
        except FileNotFoundError:
            try: current.mkdir(mode=0o700)
            except FileExistsError: pass
            link = current.lstat()
        final = i == len(p.parts)-1
        if stat.S_ISLNK(link.st_mode):
            if final or link.st_uid != 0: raise ValueError()
            info = current.stat()
        else: info = link
        if not stat.S_ISDIR(info.st_mode): raise ValueError()
        if final:
            if info.st_uid != uid or info.st_mode & (0o022 if runtime else 0o077): raise ValueError()
        elif info.st_uid not in (0, uid) or info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX:
            raise ValueError()

def safe_file(s):
    return stat.S_ISREG(s.st_mode) and s.st_uid == uid and not s.st_mode & 0o077 and s.st_nlink == 1

def wrapper_valid():
    p = c["wrapper"]
    s = os.lstat(p)
    if not stat.S_ISREG(s.st_mode) or s.st_uid not in (0,uid) or s.st_mode & 0o022 or s.st_size > 65536: return False
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(fd)
        if (s.st_dev,s.st_ino) != (opened.st_dev,opened.st_ino): return False
        return hashlib.sha256(os.read(fd,65537)).hexdigest() == c["digest"] and os.access(p,os.X_OK)
    finally: os.close(fd)

try:
    if uid != c["uid"] or not re.fullmatch(r"mesura-workload-[a-zA-Z0-9_.][a-zA-Z0-9_.-]*\.service",c["unit"]): raise ValueError()
    if hashlib.sha256(c["unit"].encode("ascii")).hexdigest() != c["key"]: raise ValueError()
    stage = "wrapper"
    if not wrapper_valid():
        emit({"kind":"refused","reason":"handoff-unavailable"}); raise SystemExit(0)
    directory = str(pathlib.Path(c["runtime"]) / "mesura-workloads")
    stage = "ancestors"
    private_dir(directory, runtime=True)
    lock_path = str(pathlib.Path(directory) / (c["key"]+".registration.lock"))
    stage = "descriptor"
    fd = os.open(lock_path,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK,0o600)
    if not safe_file(os.fstat(fd)): raise ValueError()
    stage = "acquisition"
    emit({"kind":"waiting"})
    fcntl.flock(fd,fcntl.LOCK_EX)
    link, opened = os.lstat(lock_path), os.fstat(fd)
    if not safe_file(link) or (link.st_dev,link.st_ino)!=(opened.st_dev,opened.st_ino): raise ValueError()
    if fd != 9:
        os.dup2(fd,9,inheritable=False);os.close(fd)
    emit({"kind":"locked"})
    for line in sys.stdin:
        if len(line)>2097152: raise ValueError()
        request = json.loads(line)
        action = request["action"]
        if not wrapper_valid():
            emit({"kind":"refused","reason":"handoff-unavailable"});continue
        if action == "validate" or action == "replay":
            r = request["record"]
            env = dict(c["environment"])
            env.update({"PATH":r["PATH"],"MESURA_ENVIRONMENT_ID":r["environmentId"],"MESURA_PROVIDER_INSTANCE_ID":r["providerInstanceId"],"MESURA_WORKLOAD_IDENTITY_KIND":"codex-thread","CODEX_THREAD_ID":r["providerThreadRef"]["nativeId"]})
            reason = None
            if not isinstance(r["PATH"],str) or not r["PATH"]: reason="wrapper-environment-incompatible"
            elif not os.path.isdir(r["cwd"]) or not re.fullmatch(r"[1-9][0-9]*(?:[KMGTPE](?:B)?)?",r["memoryHigh"]): reason="invalid-launch"
            else:
                # Relative argv/PATH entries belong to the retained effective cwd,
                # not the server cwd. Keep the original strings for Popen.
                os.chdir(r["cwd"])
                if any(not shutil.which(tool,path=r["PATH"]) for tool in ("id","flock","systemctl","mktemp","systemd-run","rm")): reason="wrapper-environment-incompatible"
                elif not shutil.which(r["argv"][0],path=r["PATH"]): reason="invalid-launch"
            if reason is not None:
                emit({"kind":"refused","reason":reason});continue
            if action == "validate": emit({"kind":"valid"});continue
            env["MESURA_WORKLOAD_LOCK_HANDOFF"]=json.dumps({"unit":c["unit"],"key":c["key"],"path":lock_path},separators=(",",":"))
            command=[c["wrapper"],r["name"],"--memory",r["memoryHigh"],"--",*r["argv"]]
            cwd=r["cwd"]
            inherited=(9,)
        elif action == "stop":
            env=c["environment"];command=[c["manager"],"--user","stop",c["unit"]];cwd=c["environment"]["HOME"];inherited=()
        else: raise ValueError()
        # No bridge pipes reach a launcher. Only replay receives the shared FD9.
        stage = "dispatch"
        child=subprocess.Popen(command,cwd=cwd,env=env,shell=False,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True,pass_fds=inherited)
        code=child.wait()
        child=None
        emit({"kind":"exit","code":code})
except Exception:
    emit({"kind":"refused","reason":"lock-unavailable","stage":stage})
finally:
    finish(None,None)
`;
const Frame = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("waiting") }),
  Schema.Struct({ kind: Schema.Literal("locked") }),
  Schema.Struct({ kind: Schema.Literal("valid") }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literals([
      "handoff-unavailable",
      "lock-unavailable",
      "invalid-launch",
      "wrapper-environment-incompatible",
    ]),
    stage: Schema.optionalKey(
      Schema.Literals([
        "canonical",
        "wrapper",
        "ancestors",
        "descriptor",
        "acquisition",
        "dispatch",
      ]),
    ),
  }),
  Schema.Struct({ kind: Schema.Literal("exit"), code: Schema.Int }),
]);
const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(Frame));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// Configuration is trusted composition, never RPC input. Staged tests replace
// paths, manager executable and digest explicitly; production recognizes only
// the reviewed V5 and uses /usr/bin/systemctl. No RPC input configures this layer.
export const layerWith = (
  options: {
    readonly wrapper?: string;
    readonly runtime?: string;
    readonly digest?: string;
    readonly manager?: string;
  } = {},
) =>
  Layer.effect(
    WorkloadHostBridge,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const platform = yield* HostProcess.Platform;
      const home = yield* HostProcess.HomeDirectory;
      const environment = yield* HostProcess.Environment;
      const uid = yield* Effect.sync(() => process.getuid?.());
      const wrapper = options.wrapper ?? "/usr/local/bin/mesura-agent-service";
      const runtime = options.runtime ?? `/run/user/${uid}`;
      const digest = options.digest ?? COMPATIBLE_WRAPPER_DIGEST;
      const approvedEnvironment = {
        HOME: home,
        XDG_RUNTIME_DIR: runtime,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
        ...(environment.XDG_STATE_HOME ? { XDG_STATE_HOME: environment.XDG_STATE_HOME } : {}),
      };
      const available = Effect.gen(function* () {
        if (
          platform !== "linux" ||
          uid === undefined ||
          !home.startsWith("/") ||
          (!options.runtime &&
            environment.XDG_RUNTIME_DIR &&
            environment.XDG_RUNTIME_DIR !== runtime)
        )
          return false;
        if (
          environment.DBUS_SESSION_BUS_ADDRESS &&
          environment.DBUS_SESSION_BUS_ADDRESS !== approvedEnvironment.DBUS_SESSION_BUS_ADDRESS
        )
          return false;
        const stat = yield* fs.stat(wrapper);
        if (stat.type !== "File" || Number(stat.size) > 65536) return false;
        const data = yield* fs.readFile(wrapper);
        return Hex.encode(yield* crypto.digest("SHA-256", data)) === digest;
      }).pipe(Effect.catch(() => Effect.succeed(false)));
      const withLock: WorkloadHostBridge["Service"]["withLock"] = (record, use) =>
        Effect.gen(function* () {
          if (!(yield* available))
            return yield* Effect.fail(
              new WorkloadBridgeError({ reason: "handoff-unavailable", cause: null }),
            );
          const input = yield* Queue.make<Uint8Array>();
          const output = yield* Queue.make<typeof Frame.Type, WorkloadBridgeError>();
          const child = yield* spawner
            .spawn(
              ChildProcess.make(
                "/usr/bin/python3",
                [
                  "-u",
                  "-c",
                  bridgeSource,
                  encodeJson({
                    wrapper,
                    manager: options.manager ?? "/usr/bin/systemctl",
                    runtime,
                    digest,
                    uid,
                    unit: record.unit,
                    key: record.recordKey,
                    environment: approvedEnvironment,
                  }),
                ],
                {
                  shell: false,
                  env: {},
                  extendEnv: false,
                  stdin: Stream.fromQueue(input),
                  stderr: "ignore",
                  killSignal: "SIGTERM",
                  forceKillAfter: "2 seconds",
                },
              ),
            )
            .pipe(
              Effect.mapError(
                (cause) => new WorkloadBridgeError({ reason: "lock-unavailable", cause }),
              ),
            );
          yield* Effect.addFinalizer(() => Queue.shutdown(input));
          yield* child.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) =>
              Effect.try({
                try: () => decodeFrame(line),
                catch: (cause) => new WorkloadBridgeError({ reason: "lock-unavailable", cause }),
              }).pipe(Effect.flatMap((frame) => Queue.offer(output, frame))),
            ),
            Effect.ensuring(
              Queue.fail(
                output,
                new WorkloadBridgeError({ reason: "lock-unavailable", cause: null }),
              ),
            ),
            Effect.forkScoped,
          );
          const locked = yield* Effect.gen(function* () {
            const first = yield* Queue.take(output);
            return first.kind === "waiting" ? yield* Queue.take(output) : first;
          }).pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError(
              (cause) => new WorkloadBridgeError({ reason: "lock-unavailable", cause }),
            ),
          );
          if (locked.kind !== "locked")
            return yield* Effect.fail(
              new WorkloadBridgeError({
                reason:
                  locked.kind === "refused" && locked.reason === "handoff-unavailable"
                    ? "handoff-unavailable"
                    : "lock-unavailable",
                cause: null,
                ...(locked.kind === "refused" && locked.stage !== undefined
                  ? { stage: locked.stage }
                  : {}),
              }),
            );
          const request = (action: "validate" | "stop" | "replay", value?: WorkloadRecord) =>
            Effect.gen(function* () {
              yield* Queue.offer(
                input,
                new TextEncoder().encode(encodeJson({ action, record: value }) + "\n"),
              );
              return yield* Queue.take(output);
            });
          return yield* use({
            validateReplay: (value) =>
              request("validate", value).pipe(
                Effect.map((frame) =>
                  frame.kind === "valid"
                    ? null
                    : frame.kind === "refused"
                      ? frame.reason
                      : "invalid-launch",
                ),
              ),
            stop: request("stop").pipe(
              Effect.flatMap((frame) =>
                frame.kind === "exit"
                  ? Effect.succeed(frame.code)
                  : Effect.fail(
                      new WorkloadBridgeError({ reason: "handoff-unavailable", cause: null }),
                    ),
              ),
            ),
            replay: (value) =>
              request("replay", value).pipe(
                Effect.flatMap((frame) =>
                  frame.kind === "exit"
                    ? Effect.succeed(frame.code)
                    : Effect.fail(
                        new WorkloadBridgeError({ reason: "invalid-launch", cause: null }),
                      ),
                ),
              ),
          });
        }).pipe(Effect.scoped);
      return WorkloadHostBridge.of({ available, withLock });
    }),
  );
export const layer = layerWith();
