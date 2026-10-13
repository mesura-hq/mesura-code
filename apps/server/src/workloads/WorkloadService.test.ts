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
    control?: "start" | "stop";
    platform?: NodeJS.Platform;
    repeatOld?: "start" | "stop";
    queuedGate?: Effect.Effect<void>;
    stopGate?: Effect.Effect<void>;
    launchGate?: Effect.Effect<void>;
    replacementOnFailure?: boolean;

    available?: boolean;
    additionalRecord?: boolean;
    repeatList?: boolean;
    launchRefusal?:
      | "replay-context-unavailable"
      | "invalid-launch"
      | "wrapper-environment-incompatible";
    replaceQueued?: "generation" | "argv" | "owner";
    replayCode?: number;
    newBinding?: "observed" | "unverified";
    noReplacement?: boolean;
    stopCode?: number;
    stopState?: WorkloadHost.WorkloadManagerSnapshot["state"];
    savedPath?: string | null;
    legacyThread?: boolean;
    inputThread?: string;
    inputGeneration?: string;
    inputRecordId?: string;
    unsafeRecord?: boolean;
    unavailableProjection?: boolean;

    generation?: string;
    invocationId?: string;
    startMonotonic?: string;
    bootId?: string;
    unit?: string;
    state?: WorkloadHost.WorkloadManagerSnapshot["state"];
    changeAfterRead?: boolean;
    loopback?: boolean;
    binding?: string;
    missingControlGroup?: boolean;
    differentEnvironment?: boolean;
    hostname?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-workload-list-" });
    let managerCalls = 0;
    let resourceCalls = 0;
    let mutations = 0;
    let capabilityReads = 0;
    let ramReads = 0;
    const ramFilters: Array<string | undefined> = [];
    let held = false;
    let liveGeneration = "a".repeat(32);
    let liveInvocation = "b".repeat(32);
    let state = options.state ?? "running";

    const raw = recordFixture({
      ...(options.legacyThread ? { thread: "obsolete-app-label" } : {}),
      ...(options.savedPath === undefined ? {} : { PATH: options.savedPath }),
      ...(options.binding === "unverified"
        ? { binding: "unverified", unitInvocationId: null, unitStartMonotonic: null, bootId: null }
        : options.differentEnvironment
          ? { environmentId: "environment-b" }
          : {}),
    });

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
          state,
          unit: options.unit ?? raw.unit,
          generation:
            options.changeAfterRead && managerCalls++ > 0
              ? "c".repeat(32)
              : (options.generation ?? liveGeneration),
          invocationId: options.invocationId ?? liveInvocation,
          startMonotonic: options.startMonotonic ?? raw.unitStartMonotonic,
          controlGroup: options.missingControlGroup ? null : "/fixture.service",
        })),
      bootId: Effect.succeed(options.bootId ?? "12345678-1234-1234-1234-123456789abc"),
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
    const bridge = Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      return WorkloadHostBridge.WorkloadHostBridge.of({
        available: Effect.sync(() => {
          capabilityReads++;
          return options.available ?? true;
        }),
        withLock: (_record, use) =>
          Effect.gen(function* () {
            if (options.queuedGate) yield* options.queuedGate;
            if (options.replaceQueued === "owner")
              yield* applyProviderFixture(
                ThreadId.make("other"),
                "native-a",
                "provider-service",
              ).pipe(
                Effect.provideService(ProjectionStore.ProjectionStoreV2, projections),
                Effect.orDie,
              );
            else if (options.replaceQueued)
              yield* fs
                .writeFileString(
                  path.join(dir, `${raw.recordKey}.json`),
                  JSON.stringify({
                    ...raw,
                    ...(options.replaceQueued === "generation"
                      ? { generation: "c".repeat(32) }
                      : { argv: ["foreign"] }),
                  }),
                )
                .pipe(Effect.orDie);
            held = true;
            return yield* use({
              validateReplay: () =>
                (options.launchGate ?? Effect.void).pipe(Effect.as(options.launchRefusal ?? null)),
              stop: Effect.gen(function* () {
                expect(held).toBe(true);
                mutations++;
                if (options.stopGate) yield* options.stopGate;
                state = options.stopState ?? "absent";
                return options.stopCode ?? 0;
              }),
              replay: (value) =>
                Effect.gen(function* () {
                  expect(held).toBe(true);
                  mutations++;
                  expect(value.argv).toEqual(raw.argv);
                  if ([0, 3].includes(options.replayCode ?? 0)) {
                    liveGeneration = "c".repeat(32);
                    liveInvocation = "d".repeat(32);
                    state = "running";
                  }
                  if (
                    ((options.replayCode ?? 0) === 0 && !options.noReplacement) ||
                    options.replacementOnFailure
                  ) {
                    yield* fs
                      .writeFileString(
                        path.join(dir, `${raw.recordKey}.json`),
                        JSON.stringify({
                          ...raw,
                          thread: null,
                          generation: liveGeneration,
                          binding: options.newBinding ?? "observed",
                          unitInvocationId:
                            options.newBinding === "unverified" ? null : liveInvocation,
                          unitStartMonotonic:
                            options.newBinding === "unverified" ? null : raw.unitStartMonotonic,
                          bootId: options.newBinding === "unverified" ? null : raw.bootId,
                        }),
                      )
                      .pipe(Effect.orDie);
                  }
                  return options.replayCode ?? 0;
                }),
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  held = false;
                }),
              ),
            );
          }),
      });
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
        Layer.provide(
          Layer.effect(WorkloadHostBridge.WorkloadHostBridge, bridge).pipe(
            Layer.provide(ProjectionStore.layer),
          ),
        ),
        Layer.provide(WorkloadThreadQuery.layer),
        Layer.provide(Layer.succeed(WorkloadHost.WorkloadHost, host)),
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
      const control =
        options.control === undefined
          ? undefined
          : yield* service[options.control]({
              recordId: options.inputRecordId ?? raw.recordKey,
              expectedGeneration: options.inputGeneration ?? raw.generation,
              threadId: ThreadId.make(options.inputThread ?? threadId),
            });
      const repeat =
        options.repeatOld === undefined
          ? undefined
          : yield* service[options.repeatOld]({
              recordId: raw.recordKey,
              expectedGeneration: raw.generation,
              threadId,
            });
      const ramReadsAfterControl = ramReads;
      const list = yield* service.list({});
      const capabilityReadsAfterList = capabilityReads;
      const filtered = yield* service.list({ threadId: ThreadId.make("other") });
      const capabilityReadsAfterFiltered = capabilityReads;
      const repeatedList = options.repeatList ? yield* service.list({}) : undefined;
      return {
        ramReadsAfterControl,
        control,
        repeat,
        list,
        filtered,
        repeatedList,
        capabilityReadsAfterList,
        capabilityReadsAfterFiltered,
      };
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(HostProcess.Environment, { XDG_STATE_HOME: root }),
      Effect.provideService(HostProcess.Platform, options.platform ?? "linux"),
    );
    return { ...result, resourceCalls, mutations, held, capabilityReads, ramReads, ramFilters };
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
      binding: "matched",
      registration: "observed",
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
it.effect("F2 controls observe capability afresh for each separate operation", () =>
  Effect.gen(function* () {
    const result = yield* runFixture({ control: "stop", repeatOld: "stop" });
    expect(result.control).toMatchObject({ status: "completed", result: "stopped" });
    expect(result.repeat).toMatchObject({ status: "completed", result: "already-stopped" });
    expect(result.mutations).toBe(1);
    expect(result.capabilityReadsAfterList).toBe(3);
    expect(result.capabilityReadsAfterFiltered).toBe(3);
  }),
);
it.effect.each([
  { name: "replacement", options: { generation: "c".repeat(32) }, binding: "mismatched" },
  { name: "unknown manager", options: { state: "unknown" as const }, binding: "unknown" },
  { name: "unverified registration", options: { binding: "unverified" }, binding: "unverified" },
  {
    name: "same-configuration manual restart",
    options: { invocationId: "d".repeat(32) },
    binding: "mismatched",
  },
  {
    name: "changed monotonic start",
    options: { startMonotonic: "12345678901234567891" },
    binding: "mismatched",
  },
  {
    name: "changed boot",
    options: { bootId: "12345678-1234-1234-1234-123456789abd" },
    binding: "mismatched",
  },
  {
    name: "different canonical manager unit",
    options: { unit: "mesura-workload-other.service" },
    binding: "mismatched",
  },
])("F2 list withholds live association and telemetry for $name", ({ options, binding }) =>
  Effect.gen(function* () {
    const { list, resourceCalls } = yield* runFixture(options);
    expect(list.workloads[0]).toMatchObject({
      association: { state: "unassigned" },
      binding,
      ramBytes: null,
      ports: [],
      remoteUrl: null,
    });
    expect(resourceCalls).toBe(0);
  }),
);
it.effect("F2 list discards telemetry when the generation changes during observation", () =>
  Effect.gen(function* () {
    const { list } = yield* runFixture({ changeAfterRead: true });
    expect(list.workloads[0]).toMatchObject({
      association: { state: "unassigned" },
      binding: "mismatched",
      ramBytes: null,
      ports: [],
    });
  }),
);
it.effect("F2 absent collected unit keeps assigned historical record without live memory", () =>
  Effect.gen(function* () {
    const { list } = yield* runFixture({ state: "absent" });
    expect(list.workloads[0]).toMatchObject({
      association: { state: "assigned" },
      managerState: "absent",
      binding: "historical",
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
      binding: "matched",
      registration: "observed",
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
  "..",
  "-",
  "a..b",
  "-host.tailnet.ts.net",
  "host-.tailnet.ts.net",
  "x".repeat(64) + ".ts.net",
  Array(4).fill("x".repeat(63)).join("."),
])("F2 V12 list refuses malformed MagicDNS hostname %s", (hostname) =>
  Effect.gen(function* () {
    const { list } = yield* runFixture({ hostname });
    expect(list.workloads[0]).toMatchObject({
      remoteUrl: null,
      ports: [6026, 6040],
      defaultPort: 6026,
      binding: "matched",
    });
    expect(list.incomplete).toBe(false);
  }),
);

it.effect.each([
  "host-with-hyphen.tailnet.ts.net",
  "x".repeat(63) + ".tailnet.ts.net",
  [...Array(3).fill("x".repeat(63)), "y".repeat(61)].join("."),
])("F2 V12 list preserves valid bounded DNS hostname %s", (hostname) =>
  Effect.gen(function* () {
    const { list } = yield* runFixture({ hostname });
    expect(list.workloads[0]).toMatchObject({
      remoteUrl: "http://" + hostname + ":6026",
      ports: [6026, 6040],
      defaultPort: 6026,
    });
    expect(list.incomplete).toBe(false);
  }),
);

it.effect("F2 control V2 stop proves absent unverified history without a manager mutation", () =>
  Effect.gen(function* () {
    const { control } = yield* runFixture({
      control: "stop",
      state: "absent",
      binding: "unverified",
    });
    expect(control).toMatchObject({
      status: "completed",
      operation: "stop",
      result: "already-stopped",
      mutationAttempted: false,
    });
  }),
);

it.effect.each([
  { name: "unit", options: { unit: "mesura-workload-foreign.service" } },
  { name: "generation", options: { generation: "f".repeat(32) } },
  { name: "InvocationID", options: { invocationId: "f".repeat(32) } },
  { name: "start", options: { startMonotonic: "12345678901234567891" } },
  { name: "boot", options: { bootId: "12345678-1234-1234-1234-123456789abd" } },
  { name: "unverified", options: { binding: "unverified" } },
  { name: "unknown", options: { state: "unknown" as const } },
])("F2 control V2 refuses loaded Stop with $name mismatch before dispatch", ({ options }) =>
  Effect.gen(function* () {
    const { control, mutations, held } = yield* runFixture({ control: "stop", ...options });
    expect(control).toMatchObject({ status: "refused", mutationAttempted: false });
    expect(mutations).toBe(0);
    expect(held).toBe(false);
  }),
);
it.effect.each(["generation", "argv", "owner"] as const)(
  "F2 control V2 rechecks real queued %s before dispatch",
  (replaceQueued) =>
    Effect.gen(function* () {
      const { control, mutations } = yield* runFixture({ control: "stop", replaceQueued });
      expect(control).toMatchObject({ status: "refused", mutationAttempted: false });
      expect(mutations).toBe(0);
    }),
);
it.effect.each(["running", "stopped", "failed", "unknown"] as const)(
  "F2 control V2 Start refuses loaded %s without stopping it",
  (state) =>
    Effect.gen(function* () {
      const { control, mutations } = yield* runFixture({ control: "start", state });
      expect(control).toMatchObject({ status: "refused", mutationAttempted: false });
      expect(mutations).toBe(0);
    }),
);
it.effect.each([null, ""])(
  "F2 control V2 refuses unsupported saved PATH %s without bootstrap",
  (savedPath) =>
    Effect.gen(function* () {
      const { control, mutations } = yield* runFixture({
        control: "start",
        state: "absent",
        savedPath,
      });
      expect(control).toMatchObject({
        status: "refused",
        reason: "wrapper-environment-incompatible",
      });
      expect(mutations).toBe(0);
    }),
);
it.effect("F2 control V2 Stop completion requires terminal observation rather than exit zero", () =>
  Effect.gen(function* () {
    const { control, mutations } = yield* runFixture({ control: "stop", stopState: "running" });
    expect(control).toMatchObject({
      status: "partial",
      stage: "stop-completion",
      mutationAttempted: true,
    });
    expect(mutations).toBe(1);
  }),
);
it.effect("F2 control V2 Stop keeps history and releases the lease after proven completion", () =>
  Effect.gen(function* () {
    const { control, mutations, held, list } = yield* runFixture({ control: "stop" });
    expect(control).toMatchObject({
      status: "completed",
      result: "stopped",
      managerState: "absent",
      mutationAttempted: true,
    });
    expect(mutations).toBe(1);
    expect(held).toBe(false);
    expect(list.workloads[0]?.generation).toBe("a".repeat(32));
  }),
);
it.effect.each(["observed", "unverified"] as const)(
  "F2 control V2 Start admits a distinct %s generation without claiming health",
  (newBinding) =>
    Effect.gen(function* () {
      const { control, mutations } = yield* runFixture({
        control: "start",
        state: "absent",
        newBinding,
      });
      expect(control).toMatchObject({
        status: "completed",
        result: "admitted",
        newGeneration: "c".repeat(32),
        registration: newBinding,
      });
      expect(mutations).toBe(1);
    }),
);
it.effect.each([
  { code: 1, status: "partial" },
  { code: 3, status: "partial" },
  { code: 2, status: "partial" },
])("F2 control V2 distinguishes wrapper exit $code and never compensates", ({ code, status }) =>
  Effect.gen(function* () {
    const { control, mutations, list } = yield* runFixture({
      control: "start",
      state: "absent",
      replayCode: code,
    });
    expect(control).toMatchObject({ status, mutationAttempted: true });
    expect(mutations).toBe(1);
    expect(list.workloads[0]?.generation).toBe("a".repeat(32));
  }),
);
it.effect("F2 control V2 exit zero cannot fabricate registration without a replacement", () =>
  Effect.gen(function* () {
    const { control, mutations } = yield* runFixture({
      control: "start",
      state: "absent",
      noReplacement: true,
    });
    expect(control).toMatchObject({ status: "partial", stage: "verification" });
    expect(mutations).toBe(1);
  }),
);
it.effect.each([
  { name: "unrecognized wrapper", options: { available: false } },
  { name: "wrong destination", options: { differentEnvironment: true } },
  { name: "wrong thread", options: { inputThread: "thread:other" } },
  { name: "stale generation", options: { inputGeneration: "f".repeat(32) } },
])("F2 control V2 refuses $name with no manager mutation", ({ options }) =>
  Effect.gen(function* () {
    const { control, mutations } = yield* runFixture({ control: "stop", ...options });
    expect(control).toMatchObject({ status: "refused", mutationAttempted: false });
    expect(mutations).toBe(0);
  }),
);

it.effect.each(["start", "stop"] as const)(
  "F2 control V2 stale %s A cannot act on admitted B",
  (repeatOld) =>
    Effect.gen(function* () {
      const { control, repeat, mutations } = yield* runFixture({
        control: "start",
        state: "absent",
        repeatOld,
      });
      expect(control).toMatchObject({ status: "completed", newGeneration: "c".repeat(32) });
      expect(repeat).toMatchObject({
        status: "refused",
        reason: "stale-generation",
        mutationAttempted: false,
      });
      expect(mutations).toBe(1);
    }),
);
it.effect.each(["queued", "dispatched"] as const)(
  "F2 control V2 90 second budget distinguishes %s expiry and releases its lease",
  (stage) =>
    Effect.gen(function* () {
      const reached = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const wait = Deferred.succeed(reached, undefined).pipe(
        Effect.andThen(Deferred.await(gate)),
        Effect.ensuring(Deferred.succeed(cancelled, undefined)),
      );
      const request = yield* runFixture({
        control: "stop",
        ...(stage === "queued" ? { queuedGate: wait } : { stopGate: wait }),
      }).pipe(
        Effect.tap(() => Deferred.succeed(finished, undefined)),
        Effect.forkScoped,
      );
      yield* Deferred.await(reached);
      yield* TestClock.adjust("86 seconds");
      expect(yield* Deferred.isDone(finished)).toBe(false);
      yield* TestClock.adjust("5 seconds");
      const result = yield* Fiber.join(request);
      yield* Deferred.await(cancelled);
      expect(result.control).toMatchObject(
        stage === "queued"
          ? { status: "refused", reason: "deadline", mutationAttempted: false }
          : { status: "partial", stage: "stop-completion", mutationAttempted: true },
      );
      expect(result.mutations).toBe(stage === "queued" ? 0 : 1);
      expect(result.held).toBe(false);
    }).pipe(Effect.scoped),
);

it.effect("F2 control V2 unsupported host refuses execution without a manager attempt", () =>
  Effect.gen(function* () {
    const { control, mutations } = yield* runFixture({ control: "stop", platform: "win32" });
    expect(control).toMatchObject({
      status: "refused",
      reason: "unsupported-host",
      mutationAttempted: false,
    });
    expect(mutations).toBe(0);
  }),
);

it.effect("F2 control V2 replay clears legacy thread text and keeps the actual native owner", () =>
  Effect.gen(function* () {
    const { control, mutations, list } = yield* runFixture({
      control: "start",
      state: "absent",
      legacyThread: true,
    });
    expect(control).toMatchObject({
      status: "completed",
      result: "admitted",
      newGeneration: "c".repeat(32),
    });
    expect(mutations).toBe(1);
    expect(list.workloads[0]?.association).toMatchObject({
      state: "assigned",
      threadId: "thread:service",
    });
  }),
);

it.effect.each([
  "replay-context-unavailable",
  "invalid-launch",
  "wrapper-environment-incompatible",
] as const)("F2 control V2 honors a known host preflight %s before admission", (launchRefusal) =>
  Effect.gen(function* () {
    const { control, mutations } = yield* runFixture({
      control: "start",
      state: "absent",
      launchRefusal,
    });
    expect(control).toMatchObject({
      status: "refused",
      reason: launchRefusal,
      mutationAttempted: false,
    });
    expect(mutations).toBe(0);
  }),
);

it.effect.each(["start", "stop"] as const)(
  "F2 control V2 registration failure leaves retained A unassigned and unable to %s B",
  (repeatOld) =>
    Effect.gen(function* () {
      const { control, repeat, list, mutations } = yield* runFixture({
        control: "start",
        state: "absent",
        replayCode: 3,
        repeatOld,
      });
      expect(control).toMatchObject({
        status: "partial",
        stage: "registration",
        admission: "accepted",
        registration: "unchanged",
        newGeneration: null,
        mutationAttempted: true,
      });
      expect(list.workloads[0]).toMatchObject({
        generation: "a".repeat(32),
        managerState: "running",
        binding: "mismatched",
        association: { state: "unassigned", threadId: null, reason: "generation" },
        ports: [],
        ramBytes: null,
        remoteUrl: null,
      });
      expect(repeat).toMatchObject({
        status: "refused",
        reason: repeatOld === "stop" ? "binding-mismatch" : "unit-loaded",
        mutationAttempted: false,
      });
      expect(mutations).toBe(1);
    }),
);
it.effect(
  "F2 control V2 exit3 cannot assert unchanged registration after a record replacement",
  () =>
    Effect.gen(function* () {
      const { control, list, mutations } = yield* runFixture({
        control: "start",
        state: "absent",
        replayCode: 3,
        replacementOnFailure: true,
      });
      expect(control).toMatchObject({
        status: "partial",
        stage: "registration",
        admission: "accepted",
        registration: "unknown",
        newGeneration: null,
      });
      expect(list.workloads[0]?.generation).toBe("c".repeat(32));
      expect(mutations).toBe(1);
    }),
);
it.effect(
  "F2 control V2 replay preflight expires after10seconds without dispatch and releases its lease",
  () =>
    Effect.gen(function* () {
      const reached = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const launchGate = Deferred.succeed(reached, undefined).pipe(
        Effect.andThen(Deferred.await(gate)),
        Effect.ensuring(Deferred.succeed(cancelled, undefined)),
      );
      const request = yield* runFixture({ control: "start", state: "absent", launchGate }).pipe(
        Effect.tap(() => Deferred.succeed(finished, undefined)),
        Effect.forkScoped,
      );
      yield* Deferred.await(reached);
      yield* TestClock.adjust("9 seconds");
      expect(yield* Deferred.isDone(finished)).toBe(false);
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(cancelled);
      const result = yield* Fiber.join(request);
      expect(result.control).toMatchObject({
        status: "refused",
        reason: "deadline",
        mutationAttempted: false,
      });
      expect(result.mutations).toBe(0);
      expect(result.held).toBe(false);
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
