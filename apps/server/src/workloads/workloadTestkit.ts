import type * as ProviderRuntimeResources from "../agentResources/ProviderRuntimeResources.ts";
import * as Deferred from "effect/Deferred";
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

// Real private registry and v2 ownership for control/RPC tests. Host and process
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

// The temporary launcher models the direct wrapper's argv/cwd/environment
// boundary. It does not contact systemd or an installed wrapper.
export const controlTargetSource = String.raw`
import json,os,sys
with open(sys.argv[1],"w") as file:
    json.dump({"argv":sys.argv[2:],"cwd":os.getcwd(),"env":dict(os.environ)},file)
`;
export const withHostBridgeFixture = <A, E, R>(
  test: (fixture: {
    record: WorkloadRecord;
    root: string;
    receipt: string;
    actions: string;
    children: ChildProcessSpawner.ChildProcessHandle[];
    launched: Deferred.Deferred<void>;
  }) => Effect.Effect<A, E, R>,
  options: { script?: string } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-control-direct-" });
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
    yield* fs.writeFileString(
      wrapper,
      options.script ??
        `#!/usr/bin/python3
import json,subprocess,sys
with open(${encodeString(actions)},"w") as output: json.dump(sys.argv[1:],output)
assert sys.argv[1:5] == ["preview","--memory","64M","--"]
subprocess.run(sys.argv[5:],check=True)
`,
      { mode: 0o700 },
    );
    const record: WorkloadRecord = {
      ...recordFixture(),
      version: 2,
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
    };
    const children: ChildProcessSpawner.ChildProcessHandle[] = [];
    const launched = yield* Deferred.make<void>();
    const capture = ChildProcessSpawner.ChildProcessSpawner.of({
      ...spawner,
      spawn: (command) =>
        spawner.spawn(command).pipe(
          Effect.tap((child) =>
            Effect.sync(() => {
              children.push(child);
            }).pipe(Effect.andThen(Deferred.succeed(launched, undefined))),
          ),
        ),
    });
    return yield* test({ record, root, receipt, actions, children, launched }).pipe(
      Effect.provide(
        WorkloadHostBridge.layerWith({
          wrapper,
          runtime: path.join(root, "runtime"),
          manager,
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
      }),
      Effect.provideService(HostProcess.HomeDirectory, root),
      Effect.provideService(HostProcess.Platform, "linux"),
    );
  });
