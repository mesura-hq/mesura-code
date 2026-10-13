import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { WorkloadListInput, WorkloadListResult, WorkloadControlResult } from "./workloads.ts";
import { SharedAgentRamSummary } from "./sharedAgentRam.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

const decodeControl = Schema.decodeUnknownSync(WorkloadControlResult);
const decodeInput = Schema.decodeUnknownSync(WorkloadListInput);
const decodeResult = Schema.decodeUnknownSync(WorkloadListResult);
const encodeResult = Schema.encodeSync(WorkloadListResult);
// The approved control slice adds two protected methods to the former read-only
// catalogue. Preserve list and its optional filter while changing that tag guard.
it("F2 wire contract exposes a workload catalogue and protected controls with an optional thread filter", () => {
  expect(decodeInput({})).toEqual({});
  expect(decodeInput({ threadId: "thread-a" })).toEqual({ threadId: "thread-a" });
  expect(
    [...WsRpcGroup.requests.keys()].filter((method) => method.startsWith("workloads.")),
  ).toEqual([WS_METHODS.workloadsList, WS_METHODS.workloadsStart, WS_METHODS.workloadsStop]);
});
it("F2 wire summary keeps association status registration and nullable RAM independent", () => {
  const result = {
    registryState: "available",
    incomplete: true,
    diagnostics: [{ code: "observation-incomplete", count: 1 }],
    agentRamAttribution: "unsupported",
    workloads: [
      {
        recordId: "a".repeat(64),
        name: "preview",
        association: { state: "unassigned", threadId: null, reason: "generation" },
        managerState: "unknown",
        binding: "unknown",
        registration: "incomplete",
        ramBytes: null,
        memoryCurrentBytes: null,
        ports: [],
        defaultPort: null,
        remoteUrl: null,
        generation: "a".repeat(32),
        controlsAvailable: false,
      },
    ],
  };
  expect(decodeResult(result)).toEqual({
    ...result,
    sharedAgentRam: { status: "unsupported", groups: [], incomplete: false },
  });
  // controlsAvailable now reports a compatible host capability. It does not
  // grant stop authority to this unassigned, unknown invocation.
  const compatible = {
    ...result,
    workloads: [{ ...result.workloads[0], controlsAvailable: true }],
  };
  expect(decodeResult(compatible)).toEqual({
    ...compatible,
    sharedAgentRam: { status: "unsupported", groups: [], incomplete: false },
  });
  expect(() =>
    decodeResult({ ...result, workloads: [{ ...result.workloads[0], generation: "invalid" }] }),
  ).toThrow();
  expect(() =>
    decodeResult({ ...result, workloads: [{ ...result.workloads[0], ports: [65536] }] }),
  ).toThrow();
});

it("F2 control V2 outcomes reject contradictory mutation and admission claims", () => {
  const identity = { recordId: "a".repeat(64), oldGeneration: "b".repeat(32) };
  const valid = {
    ...identity,
    status: "completed",
    operation: "stop",
    result: "already-stopped",
    mutationAttempted: false,
    managerState: "absent",
  };
  expect(decodeControl(valid)).toEqual(valid);
  expect(() => decodeControl({ ...valid, mutationAttempted: true })).toThrow();
  expect(() => decodeControl({ ...valid, managerState: "running" })).toThrow();
  expect(() =>
    decodeControl({
      ...identity,
      status: "partial",
      operation: "stop",
      stage: "admission",
      mutationAttempted: true,
      admission: "accepted",
      registration: "unknown",
      managerState: "unknown",
    }),
  ).toThrow();
  expect(() =>
    decodeControl({
      ...identity,
      status: "completed",
      operation: "start",
      result: "admitted",
      mutationAttempted: true,
      newGeneration: "invalid",
      registration: "unverified",
      managerState: "unknown",
    }),
  ).toThrow();
});

it("F2 control V2 completed replay cannot retain the old generation", () => {
  const result = {
    recordId: "a".repeat(64),
    oldGeneration: "b".repeat(32),
    status: "completed",
    operation: "start",
    result: "admitted",
    mutationAttempted: true,
    newGeneration: "b".repeat(32),
    registration: "unverified",
    managerState: "unknown",
  };
  expect(() => decodeControl(result)).toThrow();
});

it("F2 control V2 partial replay validates distinct known generations and permits unknown generation", () => {
  const result = {
    recordId: "a".repeat(64),
    oldGeneration: "b".repeat(32),
    status: "partial",
    operation: "start",
    stage: "verification",
    mutationAttempted: true,
    admission: "accepted",
    registration: "unverified",
    newGeneration: "b".repeat(32),
    managerState: "unknown",
  };
  expect(() => decodeControl(result)).toThrow();
  const distinct = { ...result, newGeneration: "c".repeat(32) };
  expect(decodeControl(distinct)).toEqual(distinct);
  const unknown = { ...result, newGeneration: null };
  expect(decodeControl(unknown)).toEqual(unknown);
});

const decodeSharedRam = Schema.decodeUnknownSync(SharedAgentRamSummary);
const publicRamGroup = {
  groupId: "12345678-1234-4234-8234-123456789abc",
  driver: "codex",
  instanceId: "codex",
  attachedThreadCount: 2,
  status: "available",
  anonymousBytes: 0,
  sampledAt: "2026-10-13T00:00:00.000Z",
  reason: null,
};
const publicRamSummary = { status: "available", groups: [publicRamGroup], incomplete: false };
it("shared RAM preserves valid zero, missing-field compatibility, and fresh defaults", () => {
  expect(decodeSharedRam(publicRamSummary)).toEqual(publicRamSummary);
  const oldResponse = {
    registryState: "absent",
    workloads: [],
    diagnostics: [],
    incomplete: false,
    agentRamAttribution: "unsupported",
  };
  const first = decodeResult(oldResponse);
  const second = decodeResult(oldResponse);
  expect(first.sharedAgentRam).toEqual({ status: "unsupported", groups: [], incomplete: false });
  expect(first.sharedAgentRam).not.toBe(second.sharedAgentRam);
  expect(first.sharedAgentRam.groups).not.toBe(second.sharedAgentRam.groups);
  expect(encodeResult(first).sharedAgentRam).toEqual(first.sharedAgentRam);
  expect(() => decodeResult({ ...oldResponse, sharedAgentRam: null })).toThrow();
});
it.each([
  { anonymousBytes: -1 },
  { anonymousBytes: Infinity },
  { anonymousBytes: NaN },
  { anonymousBytes: Number.MAX_SAFE_INTEGER + 1 },
  { attachedThreadCount: -1 },
  { attachedThreadCount: 1.5 },
  { attachedThreadCount: Number.MAX_SAFE_INTEGER + 1 },
  { groupId: "private-session" },
  { sampledAt: "2026-10-13" },
  { sampledAt: "2026-02-30T00:00:00.000Z" },
  { sampledAt: "2026-10-13T00:00:00+00:00" },
  { anonymousBytes: null },
  { reason: "exited" },
])("shared RAM rejects an invalid available tuple %j", (change) => {
  expect(() =>
    decodeSharedRam({ ...publicRamSummary, groups: [{ ...publicRamGroup, ...change }] }),
  ).toThrow();
});
it("shared RAM rejects duplicate IDs, overflow, contradictory status and unsupported rows", () => {
  for (const groups of [
    [publicRamGroup, publicRamGroup],
    Array.from({ length: 33 }, () => publicRamGroup),
  ]) {
    expect(() => decodeSharedRam({ ...publicRamSummary, groups })).toThrow();
  }
  expect(() => decodeSharedRam({ ...publicRamSummary, incomplete: true })).toThrow();
  expect(() =>
    decodeSharedRam({ status: "unsupported", groups: [publicRamGroup], incomplete: false }),
  ).toThrow();
  expect(() =>
    decodeSharedRam({
      status: "unavailable",
      groups: [{ ...publicRamGroup, status: "unavailable", reason: "exited" }],
      incomplete: false,
    }),
  ).toThrow();
  expect(
    decodeSharedRam({
      status: "unavailable",
      groups: [
        {
          ...publicRamGroup,
          status: "unavailable",
          anonymousBytes: null,
          sampledAt: null,
          reason: "exited",
        },
      ],
      incomplete: false,
    }),
  ).toMatchObject({ groups: [{ anonymousBytes: null, sampledAt: null }] });
});

it("shared RAM accepts 32 distinct valid rows and rejects the 33rd distinct row", () => {
  const groups = Array.from({ length: 33 }, (_, index) => ({
    ...publicRamGroup,
    groupId: `12345678-1234-4234-8234-${index.toString(16).padStart(12, "0")}`,
  }));
  const accepted = { ...publicRamSummary, groups: groups.slice(0, 32) };
  expect(decodeSharedRam(accepted)).toEqual(accepted);
  expect(() => decodeSharedRam({ ...publicRamSummary, groups })).toThrow();
});

it.each(["2024-02-29T00:00:00.000Z", "2000-02-29T23:59:59.999Z", "0000-01-01T00:00:00.000Z"])(
  "shared RAM accepts an exact UTC calendar boundary %s",
  (sampledAt) => {
    const summary = { ...publicRamSummary, groups: [{ ...publicRamGroup, sampledAt }] };
    expect(decodeSharedRam(summary)).toEqual(summary);
  },
);

it.each([
  "2025-02-29T00:00:00.000Z",
  "1900-02-29T00:00:00.000Z",
  "2026-04-31T00:00:00.000Z",
  "2026-01-01T24:00:00.000Z",
])("shared RAM rejects a normalized invalid calendar boundary %s", (sampledAt) => {
  expect(() =>
    decodeSharedRam({ ...publicRamSummary, groups: [{ ...publicRamGroup, sampledAt }] }),
  ).toThrow();
});
