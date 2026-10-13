import * as ProviderRuntimeResources from "../agentResources/ProviderRuntimeResources.ts";
import { projectSharedAgentRam } from "./sharedAgentRam.ts";
import type {
  WorkloadControlInput,
  WorkloadControlResult,
  WorkloadControlRefusal,
  WorkloadAssociation,
  WorkloadDiagnostic,
  WorkloadListInput,
  WorkloadListResult,
  WorkloadSummary,
} from "@t3tools/contracts";
import { WorkloadControlInput as ControlInputSchema } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as WorkloadHostBridge from "./WorkloadHostBridge.ts";
import type { TailscaleStatus } from "@t3tools/tailscale";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as WorkloadHost from "./WorkloadHost.ts";
import * as WorkloadRegistry from "./WorkloadRegistry.ts";
import * as WorkloadThreadQuery from "./WorkloadThreadQuery.ts";

export class WorkloadService extends Context.Service<
  WorkloadService,
  {
    readonly start: (input: WorkloadControlInput) => Effect.Effect<WorkloadControlResult>;
    readonly stop: (input: WorkloadControlInput) => Effect.Effect<WorkloadControlResult>;
    readonly list: (input: WorkloadListInput) => Effect.Effect<WorkloadListResult>;
  }
>()("t3/workloads/WorkloadService") {}

function isNormalizedDnsName(hostname: string): boolean {
  return (
    hostname.length > 0 &&
    hostname.length <= 253 &&
    hostname
      .split(".")
      .every(
        (label) =>
          label.length > 0 &&
          label.length <= 63 &&
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
      )
  );
}

const CONTROL_BUDGET_MILLIS = 90_000;
// NodeChildProcessSpawner waits2s before SIGKILL, then up to1s for group exit.
// Reserve that release budget inside the request deadline.
const CLEANUP_BUDGET_MILLIS = 3_000;
const isControlInput = Schema.is(ControlInputSchema);

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const registry = yield* WorkloadRegistry.WorkloadRegistry;
  const query = yield* WorkloadThreadQuery.WorkloadThreadQuery;
  const host = yield* WorkloadHost.WorkloadHost;
  const bridge = yield* WorkloadHostBridge.WorkloadHostBridge;
  const runtimeResources = yield* ProviderRuntimeResources.ProviderRuntimeResources;
  const list: WorkloadService["Service"]["list"] = Effect.fn("WorkloadService.list")(function* (
    input: WorkloadListInput,
  ) {
    const scan = yield* registry.scan;
    const workloads: WorkloadSummary[] = [];
    const diagnostics: WorkloadDiagnostic[] = [...scan.diagnostics];
    let incomplete = scan.incomplete;
    const start = yield* Clock.currentTimeMillis;
    let tailnet: TailscaleStatus | null | undefined;
    let controlsAvailable: boolean | undefined;
    for (const record of [...scan.records].sort((a, b) => a.recordKey.localeCompare(b.recordKey))) {
      if ((yield* Clock.currentTimeMillis) - start >= 15000) {
        incomplete = true;
        diagnostics.push({ code: "observation-incomplete", count: 1 });
        break;
      }
      const resolved = yield* query.resolve(record);
      // Filter using persisted ownership before observing the host.
      if (input.threadId !== undefined && resolved.threadId !== input.threadId) continue;
      let manager = yield* host.manager(record.unit);
      let resources: WorkloadHost.WorkloadResources = {
        ramBytes: null,
        memoryCurrentBytes: null,
        listeners: [],
        incomplete:
          resolved.state === "assigned" &&
          manager.state === "running" &&
          manager.controlGroup === null,
      };
      if (
        resolved.state === "assigned" &&
        manager.state === "running" &&
        manager.controlGroup !== null
      ) {
        resources = yield* host.resources(manager.controlGroup);
        const after = yield* host.manager(record.unit);
        // Discard measurements if the unit stops or changes cgroup during reads.
        if (after.controlGroup !== manager.controlGroup || after.state !== manager.state)
          resources = { ramBytes: null, memoryCurrentBytes: null, listeners: [], incomplete: true };
        manager = after;
      }
      const association: WorkloadAssociation = resolved;
      const mayPublish = association.state === "assigned" && manager.state === "running";
      const listeners = mayPublish ? resources.listeners : [];
      const ports = [...new Set(listeners.map((listener) => listener.port))].sort((a, b) => a - b);
      const defaultPort = ports[0] ?? null;
      let remoteUrl: string | null = null;
      if (defaultPort !== null) {
        if (tailnet === undefined) tailnet = yield* host.tailnet;
        if (
          tailnet?.magicDnsName &&
          isNormalizedDnsName(tailnet.magicDnsName) &&
          listeners.some(
            (listener) =>
              listener.port === defaultPort &&
              (["0.0.0.0", "::", "*"].includes(listener.address) ||
                tailnet!.tailnetIpv4Addresses.includes(listener.address)),
          )
        )
          remoteUrl = `http://${tailnet.magicDnsName}:${defaultPort}`;
      }
      const observationIncomplete =
        manager.state === "unknown" ||
        resources.incomplete ||
        resolved.reason === "projection-unavailable";
      if (observationIncomplete) {
        incomplete = true;
        diagnostics.push({ code: "observation-incomplete", count: 1 });
      }
      if (controlsAvailable === undefined) controlsAvailable = yield* bridge.available;
      workloads.push({
        recordId: record.recordKey,
        name: record.name,
        association,
        managerState: manager.state,
        ramBytes: mayPublish ? resources.ramBytes : null,
        memoryCurrentBytes: mayPublish ? resources.memoryCurrentBytes : null,
        ports,
        defaultPort,
        remoteUrl,
        controlsAvailable,
      });
    }
    const sharedAgentRam = projectSharedAgentRam(yield* runtimeResources.read(input));
    const result: WorkloadListResult = {
      registryState: scan.state,
      workloads,
      incomplete,
      diagnostics,
      agentRamAttribution: "unsupported",
      sharedAgentRam,
    };
    return result;
  });

  const control = (
    operation: "start" | "stop",
    suppliedInput: WorkloadControlInput,
  ): Effect.Effect<WorkloadControlResult> =>
    Effect.suspend(() => {
      const input = { ...suppliedInput };
      let dispatched = false;
      let managerState: WorkloadSummary["managerState"] = "unknown";
      const refused = (reason: WorkloadControlRefusal): WorkloadControlResult => ({
        recordId: input.recordId,
        operation,
        status: "refused",
        reason,
        mutationAttempted: false,
        managerState,
      });
      const incomplete = (
        admission: "accepted" | "unknown" = "unknown",
        registration: "failed" | "unknown" = "unknown",
      ): WorkloadControlResult =>
        operation === "stop"
          ? {
              recordId: input.recordId,
              operation,
              status: "incomplete",
              mutationAttempted: true,
              managerState,
            }
          : {
              recordId: input.recordId,
              operation,
              status: "incomplete",
              mutationAttempted: true,
              admission,
              registration,
              managerState,
            };
      const run = Effect.gen(function* () {
        if (!isControlInput(input)) return refused("invalid-input");
        if (platform !== "linux") return refused("unsupported-host");
        const scan = yield* registry.scan;
        if (scan.state !== "available" || scan.incomplete) return refused("registry-unavailable");
        const records = scan.records.filter((record) => record.recordKey === input.recordId);
        if (records.length !== 1) return refused("record-unavailable");
        const record = records[0]!;
        const owner = yield* query.resolve(record);
        if (owner.state !== "assigned")
          return refused(
            owner.reason === "projection-unavailable" ? "owner-unavailable" : "owner-mismatch",
          );
        if (owner.threadId !== input.threadId) return refused("owner-mismatch");
        managerState = (yield* host.manager(record.unit)).state;
        if (
          operation === "stop" &&
          (managerState === "absent" || managerState === "stopped" || managerState === "failed")
        )
          return {
            recordId: input.recordId,
            operation,
            status: "completed",
            result: "already-stopped",
            mutationAttempted: false,
            managerState,
          } satisfies WorkloadControlResult;
        if (managerState === "unknown") return refused("manager-unknown");
        if (operation === "start" && managerState !== "absent") return refused("unit-loaded");
        if (!(yield* bridge.available)) return refused("wrapper-unavailable");
        if (operation === "start") {
          const launch = yield* bridge.validateReplay(record);
          if (launch !== null) return refused(launch);
        }
        // These commands address the current unit name. No generation lease or
        // guarantee against an independent replacement is implied.
        dispatched = true;
        const code = yield* operation === "stop" ? bridge.stop(record) : bridge.replay(record);
        managerState = (yield* host.manager(record.unit)).state;
        if (operation === "stop") {
          if (
            code === 0 &&
            (managerState === "absent" || managerState === "stopped" || managerState === "failed")
          )
            return {
              recordId: input.recordId,
              operation,
              status: "completed",
              result: "stopped",
              mutationAttempted: true,
              managerState,
            } satisfies WorkloadControlResult;
          return incomplete();
        }
        if (code === 0)
          return {
            recordId: input.recordId,
            operation,
            status: "completed",
            result: "admitted",
            mutationAttempted: true,
            registration: "recorded",
            managerState,
          } satisfies WorkloadControlResult;
        // Exit3 is the wrapper's accepted-admission/failed-registration receipt.
        // Other exits do not establish whether manager admission occurred.
        return code === 3 ? incomplete("accepted", "failed") : incomplete();
      });
      return run.pipe(
        Effect.catchTags({
          WorkloadBridgeError: (error) =>
            Effect.succeed(dispatched ? incomplete() : refused(error.reason)),
        }),
        Effect.timeoutOption(CONTROL_BUDGET_MILLIS - CLEANUP_BUDGET_MILLIS),
        Effect.map((value) =>
          Option.isSome(value) ? value.value : dispatched ? incomplete() : refused("deadline"),
        ),
      );
    });
  const start: WorkloadService["Service"]["start"] = (input) => control("start", input);
  const stop: WorkloadService["Service"]["stop"] = (input) => control("stop", input);
  return WorkloadService.of({ list, start, stop });
});
export const layer = Layer.effect(WorkloadService, make);
