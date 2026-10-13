import type * as ProviderRuntimeResources from "../agentResources/ProviderRuntimeResources.ts";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { WorkloadRecord } from "./WorkloadRecord.ts";
import * as WorkloadHost from "./WorkloadHost.ts";
import * as WorkloadHostBridge from "./WorkloadHostBridge.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as WorkloadThreadQuery from "./WorkloadThreadQuery.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { applyFixtureThread } from "../orchestration-v2/testkit/factoryCardFixtures.ts";
import {
  EnvironmentId,
  EventId,
  OrchestrationV2ProviderThread,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { vi } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Fixtures exercise the same no-follow descriptor/metadata boundary as WorkloadRegistry. Remove with that boundary.
import type * as NodeFSP from "node:fs/promises";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String));

export function recordFixture(overrides: Record<string, unknown> = {}) {
  const unit = "mesura-workload-preview.service";
  return {
    version: 2,
    name: "preview",
    unit,
    recordKey: "3925284943fe057ff73181d687de1755b3012cc4bca421a4304d39e69041bbd6",
    generation: "a".repeat(32),
    unitInvocationId: "b".repeat(32),
    unitStartMonotonic: "12345678901234567890",
    bootId: "12345678-1234-1234-1234-123456789abc",
    binding: "observed",
    cwd: "/workspace",
    argv: ["node", "argument with spaces", "$(literal)"],
    PATH: "/nvm/node24/bin",
    thread: null,
    providerThreadRef: { driver: "codex", nativeId: "native-a" },
    environmentId: "environment-a",
    providerInstanceId: "codex",
    memoryHigh: "2G",
    startedAt: "2026-10-13T00:00:00+00:00",
    ...overrides,
  };
}

const epoch = DateTime.makeUnsafe("2026-10-13T00:00:00Z");
export const applyProviderFixture = Effect.fnUntraced(function* (
  threadId: ThreadId,
  nativeId: string,
  id: string,
  overrides: Partial<OrchestrationV2ProviderThread> = {},
) {
  const payload = OrchestrationV2ProviderThread.make({
    id: ProviderThreadId.make(id),
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver: ProviderDriverKind.make("codex"), nativeId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: epoch,
    updatedAt: epoch,
    ...overrides,
  });
  yield* (yield* ProjectionStore.ProjectionStoreV2).apply({
    id: EventId.make(`event:${id}`),
    type: "provider-thread.updated",
    threadId,
    occurredAt: epoch,
    payload,
  });
});

// Sandbox remaps trusted host ancestors to nobody. Only this external metadata
// changes in the fixture; private fixture directories and records stay real.
export async function fixtureFileSystem() {
  const actual = await vi.importActual<typeof NodeFSP>("node:fs/promises");
  return {
    ...actual,
    lstat: async (file: Parameters<typeof actual.lstat>[0]) => {
      const info = await actual.lstat(file);
      if ((file === "/home" || file === "/tmp") && info.uid === 65534) info.uid = 0;
      return info;
    },
  };
}

// Real private registry and v2 ownership for control/RPC tests. Host and lock
// boundaries stay injectable; ownership never comes from a mocked predicate.
export const withControlFixture = <A, E, R>(
  test: (fixture: {
    readonly record: ReturnType<typeof recordFixture>;
    readonly file: string;
    readonly threadId: ThreadId;
  }) => Effect.Effect<A, E, R>,
  runtimeResources: ProviderRuntimeResources.ProviderRuntimeResources["Service"] = {
    read: () => Effect.succeed({ groups: [], incomplete: false }),
  },
) =>
  Effect.gen(function* () {
    // The no-follow fs mock imports this module. Load the registry only after
    // that mock finishes, or Vite waits on its own module initialization.
    const WorkloadService = yield* Effect.promise(() => import("./WorkloadService.ts"));
    const WorkloadRegistry = yield* Effect.promise(() => import("./WorkloadRegistry.ts"));
    const ProviderRuntimeResources = yield* Effect.promise(
      () => import("../agentResources/ProviderRuntimeResources.ts"),
    );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const host = yield* WorkloadHost.WorkloadHost;
    const bridge = yield* WorkloadHostBridge.WorkloadHostBridge;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-control-" });
    const record = recordFixture({ cwd: root, argv: ["/usr/bin/true"], PATH: "/usr/bin:/bin" });
    const directory = path.join(root, "mesura-code/workloads");
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, record.recordKey + ".json");
    yield* fs.writeFileString(file, encodeJson(record), { mode: 0o600 });
    const domain = Layer.mergeAll(
      ProjectionStore.layer,
      WorkloadService.layer.pipe(
        Layer.provide(
          Layer.succeed(ProviderRuntimeResources.ProviderRuntimeResources, runtimeResources),
        ),
        Layer.provide(WorkloadRegistry.layer),
        Layer.provide(WorkloadThreadQuery.layer),
        Layer.provide(Layer.succeed(WorkloadHost.WorkloadHost, host)),
        Layer.provide(Layer.succeed(WorkloadHostBridge.WorkloadHostBridge, bridge)),
      ),
    ).pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provide(
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-a")),
        }),
      ),
    );
    return yield* Effect.gen(function* () {
      const threadId = yield* applyFixtureThread("control-rpc");
      yield* applyProviderFixture(threadId, "native-a", "provider-control-rpc");
      return yield* test({ record, file, threadId });
    }).pipe(
      Effect.provide(domain),
      Effect.provideService(HostProcess.Environment, { XDG_STATE_HOME: root }),
    );
  });

// Exact PYPATH seam from reviewed V4 b7eb73fa. The fixture invokes this source
// unchanged. It injects an owned namespace and a synchronous manager boundary;
// it does not prove real systemd FD handling or installed-wrapper compatibility.
const v4PathHelper = String.raw`
import json
import os
from pathlib import Path
import stat
import sys

operation, text, *binding = sys.argv[1:]
path = Path(text)
if not path.is_absolute() or ".." in path.parts:
    raise ValueError("workload path must be absolute and contain no parent traversal")
uid = os.getuid()

def private_directory(directory, runtime=False, create=True):
    if runtime:
        # Validate the private canonical parent before creating the runtime child.
        private_directory(directory.parent, create=create)
    current = Path(directory.anchor)
    for index, part in enumerate(("", *directory.parts[1:])):
        if part:
            current /= part
        try:
            link = current.lstat()
        except FileNotFoundError:
            if not create:
                raise
            try:
                current.mkdir(mode=0o700)
            except FileExistsError:
                pass
            link = current.lstat()
        final = index == len(directory.parts) - 1
        if stat.S_ISLNK(link.st_mode):
            if final or link.st_uid != 0:
                raise ValueError("workload path contains an untrusted symlink")
            target = current.stat()
        else:
            target = link
        if not stat.S_ISDIR(target.st_mode):
            raise ValueError("workload path contains a non-directory")
        if final:
            forbidden = 0o022 if runtime else 0o077
            if target.st_uid != uid or stat.S_IMODE(target.st_mode) & forbidden:
                raise ValueError("workload directory has an unsafe owner or mode")
        elif target.st_uid not in (0, uid):
            raise ValueError("workload ancestor has a foreign owner")
        elif target.st_mode & 0o022 and not target.st_mode & stat.S_ISVTX:
            raise ValueError("workload ancestor is writable without sticky protection")

def private_regular(metadata):
    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != uid
            or stat.S_IMODE(metadata.st_mode) & 0o077 or metadata.st_nlink != 1):
        raise ValueError("workload lock must be an owned private regular file")

runtime = operation.startswith("runtime-")
operation = operation.removeprefix("runtime-")
if operation == "directory":
    private_directory(path, runtime=runtime)
elif operation == "lock":
    private_directory(path.parent, runtime=runtime)
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        private_regular(os.fstat(descriptor))
    finally:
        os.close(descriptor)
elif operation in ("descriptor", "handoff"):
    if operation == "handoff":
        # Metadata selects the branch. Only the validated FD9 and its flock
        # establish the canonical lock; never open or create a handoff path.
        if not runtime or len(binding) != 2:
            raise ValueError("incomplete workload lock handoff")
        expected = {"unit": binding[0], "key": binding[1], "path": text}
        if json.loads(os.environ["MESURA_WORKLOAD_LOCK_HANDOFF"]) != expected:
            raise ValueError("workload lock handoff differs from the canonical binding")
    private_directory(path.parent, runtime=runtime, create=operation != "handoff")
    link = path.lstat()
    opened = os.fstat(9)
    private_regular(link)
    private_regular(opened)
    if (link.st_dev, link.st_ino) != (opened.st_dev, opened.st_ino):
        raise ValueError("workload lock changed during opening")
else:
    raise ValueError("unsupported workload path operation")
`;

export const controlTargetSource = String.raw`
import json,os,sys
try: os.fstat(9); fd9=True
except OSError: fd9=False
with open(sys.argv[1],"w") as file:
    json.dump({"argv":sys.argv[2:],"cwd":os.getcwd(),"env":dict(os.environ),"fd9":fd9,"stdio":[os.readlink("/proc/self/fd/"+str(n)) for n in (0,1,2)]},file)
`;

export const withHostBridgeFixture = <A, E, R>(
  test: (fixture: {
    record: WorkloadRecord;
    lock: string;
    root: string;
    receipt: string;
    actions: string;
    waiting: Deferred.Deferred<void>;
    children: ChildProcessSpawner.ChildProcessHandle[];
  }) => Effect.Effect<A, E, R>,
  options: { digest?: string; unsafe?: "mode" | "symlink" | "links"; script?: string } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-control-ofd-" });
    const runtime = path.join(root, "runtime");
    const wrapper = path.join(root, "wrapper.py");
    const receipt = path.join(root, "target.json");
    const actions = path.join(root, "actions.json");
    const manager = path.join(root, "manager.py");
    yield* fs.writeFileString(
      manager,
      "#!/usr/bin/python3\nimport json,sys\nwith open(" +
        encodeString(actions) +
        ',"w") as output: json.dump(sys.argv[1:],output)\n',
      { mode: 0o700 },
    );
    const script =
      options.script ??
      `#!/usr/bin/python3
import fcntl,json,os,subprocess,sys
with open(${encodeString(actions)},"w") as output: json.dump(sys.argv[1:],output)
meta=json.loads(os.environ["MESURA_WORKLOAD_LOCK_HANDOFF"])
subprocess.run(["/usr/bin/python3","-c",${encodeString(v4PathHelper)},"runtime-handoff",meta["path"],meta["unit"],meta["key"]],pass_fds=(9,),check=True)
subprocess.run(["/usr/bin/flock","-n","-x","9"],pass_fds=(9,),check=True)
fcntl.flock(9,fcntl.LOCK_EX|fcntl.LOCK_NB)
env=dict(os.environ); del env["MESURA_WORKLOAD_LOCK_HANDOFF"]
assert sys.argv[1:5] == ["preview","--memory","64M","--"]
subprocess.run(sys.argv[5:],env=env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True,check=True)
`;
    yield* fs.writeFileString(wrapper, script, { mode: 0o700 });
    yield* fs.makeDirectory(path.join(runtime, "mesura-workloads"), {
      recursive: true,
      mode: 0o700,
    });
    const record = recordFixture({
      cwd: root,
      PATH: "/usr/bin:/bin",
      memoryHigh: "64M",
      argv: [
        "/usr/bin/python3",
        "-c",
        controlTargetSource,
        receipt,
        "literal argument",
        "$(untouched)",
      ],
    }) as WorkloadRecord;
    const lock = path.join(runtime, "mesura-workloads", record.recordKey + ".registration.lock");
    yield* fs.writeFileString(lock, "retained", { mode: 0o600 });
    if (options.unsafe === "mode") yield* fs.chmod(lock, 0o644);
    if (options.unsafe === "symlink") {
      yield* fs.remove(lock);
      yield* fs.symlink(wrapper, lock);
    }
    if (options.unsafe === "links") yield* fs.link(lock, path.join(root, "alias"));
    const digest = Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(script)));
    let waitingCount = 0;
    const waiting = yield* Deferred.make<void>();
    const children: ChildProcessSpawner.ChildProcessHandle[] = [];
    const capture = ChildProcessSpawner.ChildProcessSpawner.of({
      ...spawner,
      spawn: (command) =>
        spawner.spawn(command).pipe(
          Effect.map((child) => {
            children.push(child);
            return {
              ...child,
              stdout: child.stdout.pipe(
                Stream.decodeText(),
                Stream.splitLines,
                Stream.tap((line) =>
                  line === '{"kind": "waiting"}' && ++waitingCount === 2
                    ? Deferred.succeed(waiting, undefined)
                    : Effect.void,
                ),
                Stream.map((line) => new TextEncoder().encode(line + "\n")),
              ),
            };
          }),
        ),
    });
    return yield* test({ record, lock, root, receipt, actions, waiting, children }).pipe(
      Effect.provide(
        WorkloadHostBridge.layerWith({
          wrapper,
          runtime,
          manager,
          digest: options.digest ?? digest,
        }).pipe(
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, capture)),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
      Effect.provideService(HostProcess.Environment, {
        XDG_STATE_HOME: root,
        ACCESS_TOKEN: "synthetic-secret",
        CODEX_HOME: "/unapproved/profile",
        BASH_ENV: "/unapproved/init",
        ENV: "/unapproved/env",
        NODE_OPTIONS: "unapproved-options",
        MESURA_THREAD_ID: "obsolete-thread",
        MESURA_WORKLOAD_GENERATION: "obsolete-generation",
      }),
      Effect.provideService(HostProcess.HomeDirectory, root),
    );
  });
