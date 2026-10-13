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
import { encodeWorkloadRecord, type WorkloadRecord } from "./WorkloadRecord.ts";

export class WorkloadService extends Context.Service<
  WorkloadService,
  {
    readonly start: (input: WorkloadControlInput) => Effect.Effect<WorkloadControlResult>;
    readonly stop: (input: WorkloadControlInput) => Effect.Effect<WorkloadControlResult>;
    readonly list: (input: WorkloadListInput) => Effect.Effect<WorkloadListResult>;
  }
>()("t3/workloads/WorkloadService") {}

function bindingOf(
  record: WorkloadRecord,
  manager: WorkloadHost.WorkloadManagerSnapshot,
  bootId: string | null,
): WorkloadSummary["binding"] {
  if (manager.state === "absent") return "historical";
  if (record.binding === "unverified") return "unverified";
  if (manager.state === "unknown" || bootId === null) return "unknown";
  // A registration timestamp or PID cannot replace any observed invocation field.
  return manager.unit === record.unit &&
    manager.generation === record.generation &&
    manager.invocationId === record.unitInvocationId &&
    manager.startMonotonic === record.unitStartMonotonic &&
    bootId === record.bootId
    ? "matched"
    : "mismatched";
}

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
    const bootId = scan.records.length > 0 ? yield* host.bootId : null;
    let tailnet: TailscaleStatus | null | undefined;
    let controlsAvailable: boolean | undefined;
    for (const record of [...scan.records].sort((a, b) => a.recordKey.localeCompare(b.recordKey))) {
      if ((yield* Clock.currentTimeMillis) - start >= 15000) {
        incomplete = true;
        diagnostics.push({ code: "observation-incomplete", count: 1 });
        break;
      }
      const resolved = yield* query.resolve(record);
      // Filter using persisted ownership before observing the host. A live mismatch
      // may later revoke the visible association without leaking unrelated rows.
      if (input.threadId !== undefined && resolved.threadId !== input.threadId) continue;
      let manager = yield* host.manager(record.unit);
      let binding = bindingOf(record, manager, bootId);
      let resources: WorkloadHost.WorkloadResources = {
        ramBytes: null,
        memoryCurrentBytes: null,
        listeners: [],
        incomplete:
          resolved.state === "assigned" &&
          binding === "matched" &&
          manager.state === "running" &&
          manager.controlGroup === null,
      };
      if (
        resolved.state === "assigned" &&
        binding === "matched" &&
        manager.state === "running" &&
        manager.controlGroup !== null
      ) {
        resources = yield* host.resources(manager.controlGroup);
        const after = yield* host.manager(record.unit);
        // The same invocation can move cgroup or stop during socket/memory reads.
        if (after.controlGroup !== manager.controlGroup || after.state !== manager.state)
          resources = { ramBytes: null, memoryCurrentBytes: null, listeners: [], incomplete: true };
        manager = after;
        binding = bindingOf(record, after, yield* host.bootId);
      }
      const historical = binding === "historical";
      const association: WorkloadAssociation =
        resolved.state === "unassigned" || binding === "matched" || historical
          ? resolved
          : { state: "unassigned", threadId: null, reason: "generation" };
      const mayPublish =
        association.state === "assigned" && binding === "matched" && manager.state === "running";
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
        binding === "unknown" ||
        binding === "mismatched" ||
        (binding === "unverified" && manager.state !== "absent") ||
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
        binding,
        registration:
          record.binding === "unverified"
            ? "unverified"
            : binding === "matched" || historical
              ? "observed"
              : "incomplete",
        ramBytes: mayPublish ? resources.ramBytes : null,
        memoryCurrentBytes: mayPublish ? resources.memoryCurrentBytes : null,
        ports,
        defaultPort,
        remoteUrl,
        generation: record.generation,
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
      // Copy caller-owned input before any asynchronous work. The decoded record
      // contains fresh arrays; no mutable public list snapshot grants control.
      const input = { ...suppliedInput };
      const identity = { recordId: input.recordId, oldGeneration: input.expectedGeneration };
      let dispatched = false;
      let stage: "admission" | "registration" | "verification" = "admission";
      let admission: "accepted" | "unknown" = "unknown";
      let registration: "unchanged" | "unknown" = "unknown";
      const refused = (reason: WorkloadControlRefusal): WorkloadControlResult => ({
        ...identity,
        status: "refused",
        operation,
        reason,
        mutationAttempted: false,
      });
      const partial = (
        managerState: WorkloadSummary["managerState"] = "unknown",
      ): WorkloadControlResult =>
        operation === "stop"
          ? {
              ...identity,
              status: "partial",
              operation,
              stage: "stop-completion",
              mutationAttempted: true,
              admission: "not-applicable",
              registration: "unchanged",
              managerState,
            }
          : {
              ...identity,
              status: "partial",
              operation,
              stage,
              mutationAttempted: true,
              admission,
              registration,
              newGeneration: null,
              managerState,
            };
      const read = Effect.gen(function* () {
        const scan = yield* registry.scan;
        if (scan.state !== "available" || scan.incomplete)
          return { reason: "registry-unavailable" as const };
        const records = scan.records.filter((record) => record.recordKey === input.recordId);
        if (records.length !== 1) return { reason: "record-unavailable" as const };
        const record = records[0]!;
        if (record.generation !== input.expectedGeneration)
          return { reason: "stale-generation" as const };
        const owner = yield* query.resolve(record);
        if (owner.state !== "assigned")
          return {
            reason:
              owner.reason === "projection-unavailable"
                ? ("owner-unavailable" as const)
                : ("owner-mismatch" as const),
          };
        if (owner.threadId !== input.threadId) return { reason: "owner-mismatch" as const };
        return { record };
      });
      const run = Effect.gen(function* () {
        if (!isControlInput(input)) return refused("invalid-input");
        if (platform !== "linux") return refused("unsupported-host");
        const started = yield* Clock.currentTimeMillis;
        if (!(yield* bridge.available)) return refused("handoff-unavailable");
        const initial = yield* read;
        if ("reason" in initial) return refused(initial.reason);
        const record = initial.record;
        const fingerprint = encodeWorkloadRecord(record);
        const recheck = Effect.gen(function* () {
          if ((yield* Clock.currentTimeMillis) - started >= CONTROL_BUDGET_MILLIS)
            return "deadline" as const;
          const current = yield* read;
          if ("reason" in current) return current.reason;
          return encodeWorkloadRecord(current.record) === fingerprint
            ? null
            : ("snapshot-changed" as const);
        });
        return yield* bridge.withLock(record, (lease) =>
          Effect.gen(function* () {
            const queued = yield* recheck;
            if (queued !== null) return refused(queued);
            let manager = yield* host.manager(record.unit);
            if (operation === "stop") {
              if (manager.state === "absent")
                return {
                  ...identity,
                  status: "completed",
                  operation,
                  result: "already-stopped",
                  mutationAttempted: false,
                  managerState: "absent",
                } satisfies WorkloadControlResult;
              if (bindingOf(record, manager, yield* host.bootId) !== "matched")
                return refused(
                  manager.state === "unknown" ? "manager-unknown" : "binding-mismatch",
                );
              if (manager.state === "stopped" || manager.state === "failed")
                return {
                  ...identity,
                  status: "completed",
                  operation,
                  result: "already-stopped",
                  mutationAttempted: false,
                  managerState: manager.state,
                } satisfies WorkloadControlResult;
            } else {
              if (manager.state !== "absent")
                return refused(manager.state === "unknown" ? "manager-unknown" : "unit-loaded");
              // V4 snapshots the same PATH it uses for utilities. No bootstrap PATH
              // can honestly represent null/empty until the wrapper changes.
              if (!record.PATH) return refused("wrapper-environment-incompatible");
              const launch = yield* lease
                .validateReplay(record)
                .pipe(Effect.timeoutOption("10 seconds"));
              if (Option.isNone(launch)) return refused("deadline");
              if (launch.value !== null) return refused(launch.value);
            }
            const preflight = yield* recheck;
            if (preflight !== null) return refused(preflight);
            manager = yield* host.manager(record.unit);
            if (operation === "stop") {
              if (
                manager.state !== "running" ||
                bindingOf(record, manager, yield* host.bootId) !== "matched"
              )
                return refused("binding-mismatch");
              // systemd stop addresses a name. This cooperative OFD excludes only
              // participating replacements, not a hostile same-UID manager action.
              const final = yield* recheck;
              if (final !== null) return refused(final);
              dispatched = true;
              if ((yield* lease.stop) !== 0) return partial();
              const after = yield* host.manager(record.unit);
              if (
                after.state === "absent" ||
                ((after.state === "stopped" || after.state === "failed") &&
                  bindingOf(record, after, yield* host.bootId) === "matched")
              )
                return {
                  ...identity,
                  status: "completed",
                  operation,
                  result: "stopped",
                  mutationAttempted: true,
                  managerState: after.state,
                } satisfies WorkloadControlResult;
              return partial(after.state);
            }
            if (manager.state !== "absent")
              return refused(manager.state === "unknown" ? "manager-unknown" : "unit-loaded");
            const final = yield* recheck;
            if (final !== null) return refused(final);
            dispatched = true;
            const code = yield* lease.replay(record);
            if (code === 3) {
              admission = "accepted";
              stage = "registration";
              // Exit3 establishes admission, not the contents of the retained
              // record after failure. Preserve "unchanged" only after a fresh read.
              registration = (yield* recheck) === null ? "unchanged" : "unknown";
              return partial((yield* host.manager(record.unit)).state);
            }
            // V4 also exits1 before systemd-run (for example, failed mktemp).
            // An unchanged record cannot prove manager admission was attempted
            // and rejected. Keep ambiguous exits partial until a precise receipt
            // exists; do not parse diagnostic text into stop/admission authority.
            if (code !== 0) return partial();
            admission = "accepted";
            stage = "verification";
            const scan = yield* registry.scan;
            const candidates = scan.records.filter((next) => next.recordKey === record.recordKey);
            if (scan.state !== "available" || scan.incomplete || candidates.length !== 1)
              return partial();
            const next = candidates[0]!;
            const configuration = (value: WorkloadRecord) =>
              JSON.stringify([
                value.name,
                value.unit,
                value.recordKey,
                value.cwd,
                value.argv,
                value.PATH,
                value.providerThreadRef,
                value.environmentId,
                value.providerInstanceId,
                value.memoryHigh,
              ]);
            // Minimal replay clears MESURA_THREAD_ID. A retained legacy label is
            // not native ownership. Keep it pinned in the queued full snapshot,
            // but require its removal in the new record and compare actual owner.
            if (
              next.thread !== null ||
              next.generation === record.generation ||
              configuration(next) !== configuration(record)
            )
              return partial();
            const owner = yield* query.resolve(next);
            if (owner.state !== "assigned" || owner.threadId !== input.threadId) return partial();
            const after = yield* host.manager(record.unit);
            if (after.generation !== null && after.generation !== next.generation)
              return partial(after.state);
            if (
              next.binding === "observed" &&
              after.state !== "absent" &&
              bindingOf(next, after, yield* host.bootId) !== "matched"
            )
              return partial(after.state);
            return {
              ...identity,
              status: "completed",
              operation,
              result: "admitted",
              mutationAttempted: true,
              newGeneration: next.generation,
              registration: next.binding,
              managerState: after.state,
            } satisfies WorkloadControlResult;
          }),
        );
      });
      return run.pipe(
        Effect.catchTags({
          WorkloadBridgeError: (error) =>
            Effect.succeed(dispatched ? partial() : refused(error.reason)),
        }),
        Effect.timeoutOption(CONTROL_BUDGET_MILLIS - CLEANUP_BUDGET_MILLIS),
        Effect.map((value) =>
          Option.isSome(value) ? value.value : dispatched ? partial() : refused("deadline"),
        ),
      );
    });
  const start: WorkloadService["Service"]["start"] = (input) => control("start", input);
  const stop: WorkloadService["Service"]["stop"] = (input) => control("stop", input);
  return WorkloadService.of({ list, start, stop });
});
export const layer = Layer.effect(WorkloadService, make);
