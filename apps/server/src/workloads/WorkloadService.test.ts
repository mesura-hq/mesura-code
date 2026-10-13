// Entry point: WorkloadService through real private records and v2 projections.
import * as ProviderRuntimeResources from "../agentResources/ProviderRuntimeResources.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { vi } from "vite-plus/test";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { applyFixtureThread } from "../orchestration-v2/testkit/factoryCardFixtures.ts";
import * as WorkloadService from "./WorkloadService.ts";
import * as WorkloadHostBridge from "./WorkloadHostBridge.ts";
import * as WorkloadRegistry from "./WorkloadRegistry.ts";
import * as WorkloadThreadQuery from "./WorkloadThreadQuery.ts";
import * as WorkloadHost from "./WorkloadHost.ts";
import { workloadRecordKey } from "./WorkloadRecord.ts";
import { recordFixture, applyProviderFixture } from "./workloadTestkit.ts";

vi.mock("node:fs/promises", async () => {
  const { fixtureFileSystem } = await import("./workloadTestkit.ts");
  return fixtureFileSystem();
});

const runFixture = (
  options: {
    ramSummary?: ProviderRuntimeResources.ProviderRuntimeResourceSummary;
    absentRegistry?: boolean;
    unsafeRegistry?: boolean;
    unsafeRecord?: boolean;
    control?: "start" | "stop";
    platform?: NodeJS.Platform;
    repeatOld?: "start" | "stop";
    available?: boolean;
    additionalRecord?: boolean;
    repeatList?: boolean;
    launchRefusal?: "invalid-launch" | "replay-context-unavailable";
    replayCode?: number;
    stopCode?: number;
    stopState?: WorkloadHost.WorkloadManagerSnapshot["state"];
    inputThread?: string;
    inputRecordId?: string;
    unavailableProjection?: boolean;
    state?: WorkloadHost.WorkloadManagerSnapshot["state"];
    changeAfterRead?: boolean;
    loopback?: boolean;
    missingControlGroup?: boolean;
    differentEnvironment?: boolean;
    hostname?: string;
    launchGate?: Effect.Effect<void>;
    stopGate?: Effect.Effect<void>;
  } = {},
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-workload-list-" });
    let managerCalls = 0,
      resourceCalls = 0,
      mutations = 0,
      capabilityReads = 0,
      ramReads = 0;
    const ramFilters: Array<string | undefined> = [];
    let state = options.state ?? "running";
    const raw = recordFixture(
      options.differentEnvironment ? { environmentId: "environment-b" } : {},
    );
    const dir = path.join(root, "mesura-code/workloads");
    yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
    yield* fs.writeFileString(path.join(dir, `${raw.recordKey}.json`), JSON.stringify(raw), {
      mode: options.unsafeRecord ? 0o644 : 0o600,
    });
    if (options.additionalRecord) {
      const unit = "mesura-workload-second.service";
      const recordKey = yield* workloadRecordKey(unit);
      yield* fs.writeFileString(
        path.join(dir, `${recordKey}.json`),
        JSON.stringify(recordFixture({ name: "second", unit, recordKey })),
        { mode: 0o600 },
      );
    }
    if (options.absentRegistry) yield* fs.remove(dir, { recursive: true });
    if (options.unsafeRegistry) yield* fs.chmod(dir, 0o755);
    const host = WorkloadHost.WorkloadHost.of({
      manager: () =>
        Effect.sync(() => ({
          state: options.changeAfterRead && managerCalls++ > 0 ? ("stopped" as const) : state,
          unit: raw.unit,
          controlGroup: options.missingControlGroup ? null : "/fixture.service",
        })),
      resources: () =>
        Effect.sync(() => {
          resourceCalls++;
          return {
            ramBytes: 123,
            memoryCurrentBytes: 10122,
            listeners: [
              { port: 6040, address: "127.0.0.1" },
              { port: 6026, address: options.loopback ? "::1" : "0.0.0.0" },
            ],
            incomplete: false,
          };
        }),
      tailnet: Effect.succeed({
        magicDnsName: options.hostname ?? "fixture.tailnet.ts.net",
        tailnetIpv4Addresses: ["100.64.1.2"],
      }),
    });
    const bridge = WorkloadHostBridge.WorkloadHostBridge.of({
      available: Effect.sync(() => {
        capabilityReads++;
        return options.available ?? true;
      }),
      validateReplay: () =>
        (options.launchGate ?? Effect.void).pipe(Effect.as(options.launchRefusal ?? null)),
      stop: () =>
        Effect.gen(function* () {
          mutations++;
          if (options.stopGate) yield* options.stopGate;
          state = options.stopState ?? "absent";
          return options.stopCode ?? 0;
        }),
      replay: () =>
        Effect.sync(() => {
          mutations++;
          state = "running";
          return options.replayCode ?? 0;
        }),
    });
    const layer = Layer.mergeAll(
      ProjectionStore.layer,
      WorkloadService.layer.pipe(
        Layer.provide(
          Layer.succeed(ProviderRuntimeResources.ProviderRuntimeResources, {
            read: (input = {}) =>
              Effect.sync(() => {
                ramReads++;
                ramFilters.push(input.threadId);
                return options.ramSummary ?? { groups: [], incomplete: false };
              }),
          }),
        ),
        Layer.provide(WorkloadRegistry.layer),
        Layer.provide(WorkloadThreadQuery.layer),
        Layer.provide(Layer.succeed(WorkloadHost.WorkloadHost, host)),
        Layer.provide(Layer.succeed(WorkloadHostBridge.WorkloadHostBridge, bridge)),
      ),
    ).pipe(
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provide(
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-a")),
        }),
      ),
    );
    const result = yield* Effect.gen(function* () {
      const threadId = yield* applyFixtureThread("service");
      yield* applyProviderFixture(threadId, "native-a", "provider-service");
      if (options.unavailableProjection)
        yield* (yield* SqlClient.SqlClient).unsafe(
          "DROP TABLE orchestration_v2_projection_provider_threads",
        );
      const service = yield* WorkloadService.WorkloadService;
      const input = {
        recordId: options.inputRecordId ?? raw.recordKey,
        threadId: ThreadId.make(options.inputThread ?? threadId),
      };
      const control =
        options.control === undefined ? undefined : yield* service[options.control](input);
      const repeat =
        options.repeatOld === undefined ? undefined : yield* service[options.repeatOld](input);
      const ramReadsAfterControl = ramReads;
      const list = yield* service.list({});
      const capabilityReadsAfterList = capabilityReads;
      const filtered = yield* service.list({ threadId: ThreadId.make("other") });
      const capabilityReadsAfterFiltered = capabilityReads;
      const repeatedList = options.repeatList ? yield* service.list({}) : undefined;
      return {
        control,
        repeat,
        list,
        filtered,
        repeatedList,
        ramReadsAfterControl,
        capabilityReadsAfterList,
        capabilityReadsAfterFiltered,
      };
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(HostProcess.Environment, { XDG_STATE_HOME: root }),
      Effect.provideService(HostProcess.Platform, options.platform ?? "linux"),
    );
    return { ...result, resourceCalls, mutations, capabilityReads, ramReads, ramFilters };
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

it.effect("F2 list combines real v2 ownership with observed status RAM ports and host URL", () =>
  Effect.gen(function* () {
    // Preserve the unavailable-host guard now that compatible hosts can expose
    // the approved control capability. The existing privacy assertions stay exact.
    const { list, filtered } = yield* runFixture({ available: false });
    expect(list.incomplete).toBe(false);
    expect(list.agentRamAttribution).toBe("unsupported");
    expect(list.workloads[0]).toMatchObject({
      association: { state: "assigned", threadId: "thread:service" },
      managerState: "running",
      ramBytes: 123,
      memoryCurrentBytes: 10122,
      ports: [6026, 6040],
      defaultPort: 6026,
      remoteUrl: "http://fixture.tailnet.ts.net:6026",
      controlsAvailable: false,
    });
    expect(filtered.workloads).toEqual([]);
    expect(JSON.stringify(list)).not.toMatch(
      /native-a|nvm|argument with spaces|unitInvocationId|Environment/,
    );
  }),
);
it.effect.each([
  { name: "several published records", options: { additionalRecord: true }, count: 2 },
  {
    name: "an unavailable host capability",
    options: { additionalRecord: true, available: false },
    count: 2,
  },
  { name: "an empty catalogue", options: { unsafeRecord: true }, count: 0 },
])("F2 list reads host capability once per nonempty request with $name", ({ options, count }) =>
  Effect.gen(function* () {
    const result = yield* runFixture({ ...options, repeatList: true });
    expect(result.list.workloads).toHaveLength(count);
    expect(result.filtered.workloads).toEqual([]);
    expect(result.repeatedList?.workloads).toHaveLength(count);
    expect(result.capabilityReadsAfterList).toBe(count === 0 ? 0 : 1);
    expect(result.capabilityReadsAfterFiltered).toBe(count === 0 ? 0 : 1);
    expect(result.capabilityReads).toBe(count === 0 ? 0 : 2);
  }),
);
it.effect("F2 absent collected unit keeps assigned historical record without live memory", () =>
  Effect.gen(function* () {
    const { list } = yield* runFixture({ state: "absent" });
    expect(list.workloads[0]).toMatchObject({
      association: { state: "assigned" },
      managerState: "absent",
      ramBytes: null,
    });
  }),
);
it.effect("F2 loopback-only listeners have no tailnet URL", () =>
  Effect.gen(function* () {
    const { list } = yield* runFixture({ loopback: true });
    expect(list.workloads[0]).toMatchObject({
      ports: [6026, 6040],
      defaultPort: 6026,
      remoteUrl: null,
    });
  }),
);

it.effect("F2 matched running unit without a cgroup reports incomplete unknown telemetry", () =>
  Effect.gen(function* () {
    const { list, resourceCalls } = yield* runFixture({ missingControlGroup: true });
    expect(list.incomplete).toBe(true);
    expect(list.workloads[0]).toMatchObject({
      association: { state: "assigned" },
      managerState: "running",
      ramBytes: null,
      ports: [],
    });
    expect(resourceCalls).toBe(0);
  }),
);

it.effect("F2 unknown manager preserves an independently unassigned destination identity", () =>
  Effect.gen(function* () {
    const { list, resourceCalls } = yield* runFixture({
      differentEnvironment: true,
      state: "unknown",
    });
    expect(list.workloads[0]).toMatchObject({
      association: { state: "unassigned", reason: "environment", threadId: null },
      managerState: "unknown",
      ramBytes: null,
    });
    expect(resourceCalls).toBe(0);
  }),
);

it.effect.each([
  {
    name: "exact owner",
    options: { control: "stop" as const },
    status: "completed",
    result: "stopped",
  },
  {
    name: "already absent",
    options: { control: "stop" as const, state: "absent" as const },
    status: "completed",
    result: "already-stopped",
  },
  {
    name: "already failed",
    options: { control: "stop" as const, state: "failed" as const },
    status: "completed",
    result: "already-stopped",
  },
  {
    name: "unknown manager",
    options: { control: "stop" as const, state: "unknown" as const },
    status: "refused",
    reason: "manager-unknown",
  },
  {
    name: "wrong thread",
    options: { control: "stop" as const, inputThread: "foreign" },
    status: "refused",
    reason: "owner-mismatch",
  },
  {
    name: "foreign environment",
    options: { control: "stop" as const, differentEnvironment: true },
    status: "refused",
    reason: "owner-mismatch",
  },
  {
    name: "missing wrapper",
    options: { control: "stop" as const, available: false },
    status: "refused",
    reason: "wrapper-unavailable",
  },
  {
    name: "unsupported host",
    options: { control: "stop" as const, platform: "win32" as const },
    status: "refused",
    reason: "unsupported-host",
  },
  {
    name: "loaded start",
    options: { control: "start" as const },
    status: "refused",
    reason: "unit-loaded",
  },
  {
    name: "invalid launch",
    options: {
      control: "start" as const,
      state: "absent" as const,
      launchRefusal: "invalid-launch" as const,
    },
    status: "refused",
    reason: "invalid-launch",
  },
  {
    name: "missing replay context",
    options: {
      control: "start" as const,
      state: "absent" as const,
      launchRefusal: "replay-context-unavailable" as const,
    },
    status: "refused",
    reason: "replay-context-unavailable",
  },
])("direct control preserves $name", ({ options, status, result, reason }) =>
  Effect.gen(function* () {
    const observed = yield* runFixture(options);
    expect(observed.control).toMatchObject({
      status,
      ...(result ? { result } : {}),
      ...(reason ? { reason } : {}),
    });
    expect(observed.mutations).toBe(result === "stopped" ? 1 : 0);
  }),
);
it.effect.each([
  { code: 0, status: "completed", admission: undefined, registration: "recorded" },
  { code: 3, status: "incomplete", admission: "accepted", registration: "failed" },
  { code: 1, status: "incomplete", admission: "unknown", registration: "unknown" },
])(
  "direct start reports wrapper exit $code without promising running health",
  ({ code, status, admission, registration }) =>
    Effect.gen(function* () {
      const { control, mutations } = yield* runFixture({
        control: "start",
        state: "absent",
        replayCode: code,
      });
      expect(control).toMatchObject({
        status,
        registration,
        mutationAttempted: true,
        ...(admission ? { admission } : { result: "admitted" }),
      });
      expect(mutations).toBe(1);
    }),
);
it.effect("stop exit zero requires a terminal manager observation", () =>
  Effect.gen(function* () {
    const { control } = yield* runFixture({ control: "stop", stopState: "running" });
    expect(control).toMatchObject({
      status: "incomplete",
      mutationAttempted: true,
      managerState: "running",
    });
  }),
);
it.effect("list discards telemetry if the unit stops during reads", () =>
  Effect.gen(function* () {
    const { list } = yield* runFixture({ changeAfterRead: true });
    expect(list.incomplete).toBe(true);
    expect(list.workloads[0]).toMatchObject({
      association: { state: "assigned" },
      managerState: "stopped",
      ramBytes: null,
      ports: [],
    });
  }),
);
it.effect.each(["start", "stop"] as const)(
  "direct %s deadline cancels suspended work",
  (operation) =>
    Effect.gen(function* () {
      const reached = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const gate = Deferred.succeed(reached, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Deferred.succeed(released, undefined)),
      );
      const request = yield* runFixture({
        control: operation,
        state: operation === "start" ? "absent" : "running",
        ...(operation === "start" ? { launchGate: gate } : { stopGate: gate }),
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(reached);
      yield* TestClock.adjust("87 seconds");
      const observed = yield* Fiber.join(request);
      yield* Deferred.await(released);
      expect(observed.control).toMatchObject(
        operation === "start"
          ? { status: "refused", reason: "deadline", mutationAttempted: false }
          : { status: "incomplete", mutationAttempted: true },
      );
    }).pipe(Effect.scoped),
);

// These refusals were already correct after reusing the accepted registry/query.
// Keep real private-file and SQL failures as guards rather than forcing a red.
it.effect.each([
  {
    name: "unsafe private record",
    options: { unsafeRecord: true },
    reason: "registry-unavailable",
  },
  {
    name: "missing canonical record",
    options: { inputRecordId: "0".repeat(64) },
    reason: "record-unavailable",
  },
  {
    name: "unavailable persisted projection",
    options: { unavailableProjection: true },
    reason: "owner-unavailable",
  },
])(
  "F2 control V2 real registry and SQL guard refuses $name before dispatch",
  ({ options, reason }) =>
    Effect.gen(function* () {
      const { control, mutations } = yield* runFixture({ control: "stop", ...options });
      expect(control).toMatchObject({ status: "refused", reason, mutationAttempted: false });
      expect(mutations).toBe(0);
    }),
);

it.effect.each([
  { name: "absent registry", options: { absentRegistry: true } },
  { name: "unsafe record", options: { unsafeRecord: true } },
  { name: "unsafe registry", options: { unsafeRegistry: true } },
  { name: "unsupported registry", options: { platform: "win32" as const } },
  { name: "one workload", options: {} },
  { name: "several workloads", options: { additionalRecord: true } },
])(
  "shared RAM is read once per list including $name and a filtered empty catalogue",
  ({ options }) =>
    Effect.gen(function* () {
      const result = yield* runFixture(options);
      expect(result.ramReads).toBe(2);
      expect(result.ramFilters).toEqual([undefined, "other"]);
      expect(result.list.sharedAgentRam).toEqual({
        status: "available",
        groups: [],
        incomplete: false,
      });
      expect(result.filtered.workloads).toEqual([]);
    }),
);
it.effect("shared RAM incompleteness does not replace the registered workload observation", () =>
  Effect.gen(function* () {
    const { list } = yield* runFixture({ ramSummary: { groups: [], incomplete: true } });
    expect(list.incomplete).toBe(false);
    expect(list.sharedAgentRam).toEqual({ status: "unavailable", groups: [], incomplete: true });
    expect(list.workloads[0]?.ramBytes).toBe(123);
    expect(list.workloads[0]?.memoryCurrentBytes).toBe(10122);
    expect(list.agentRamAttribution).toBe("unsupported");
  }),
);
it.effect.each([
  { control: "stop" as const },
  { control: "start" as const, state: "absent" as const },
  { control: "stop" as const, inputThread: "foreign" },
])("shared RAM sampling is independent of $control control execution and refusal", (options) =>
  Effect.gen(function* () {
    const result = yield* runFixture(options);
    expect(result.ramReadsAfterControl).toBe(0);
    expect(result.ramReads).toBe(2);
  }),
);
