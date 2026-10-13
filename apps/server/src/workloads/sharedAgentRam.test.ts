import { expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, ProviderSessionId } from "@t3tools/contracts";
import type * as ProviderRuntimeResources from "../agentResources/ProviderRuntimeResources.ts";
import { projectSharedAgentRam } from "./sharedAgentRam.ts";

const group = (
  overrides: Partial<ProviderRuntimeResources.ProviderRuntimeResourceGroup> = {},
): ProviderRuntimeResources.ProviderRuntimeResourceGroup => ({
  groupId: "12345678-1234-4234-8234-123456789abc",
  driver: ProviderDriverKind.make("codex"),
  instanceId: ProviderInstanceId.make("codex"),
  providerSessionId: ProviderSessionId.make("private-session"),
  attachedThreadCount: 2,
  status: "available",
  anonymousBytes: 123,
  sampledAt: "2026-10-13T00:00:00.000Z",
  reason: null,
  ...overrides,
});
const unsupported = () =>
  group({
    groupId: "unsupported:codex:private-session",
    status: "unsupported",
    anonymousBytes: null,
    sampledAt: null,
    reason: "unsupported_provider",
  });

it("projects only the public allowlist and preserves shared zero and count", () => {
  const privateGroup = Object.assign(group({ anonymousBytes: 0 }), {
    verifiedScopeKey: "private-scope",
    pid: 7654321,
    proof: "private-proof",
  });
  const result = projectSharedAgentRam({ groups: [privateGroup], incomplete: false });
  expect(result).toEqual({
    status: "available",
    incomplete: false,
    groups: [
      {
        groupId: privateGroup.groupId,
        driver: "codex",
        instanceId: "codex",
        attachedThreadCount: 2,
        status: "available",
        anonymousBytes: 0,
        sampledAt: "2026-10-13T00:00:00.000Z",
        reason: null,
      },
    ],
  });
  expect(JSON.stringify(result)).not.toMatch(
    /private-|providerSessionId|launchToken|pid|proof|verifiedScopeKey/,
  );
});

it("omits unsupported fallback identity while preserving a legitimate mixed sample", () => {
  const result = projectSharedAgentRam({ groups: [group(), unsupported()], incomplete: false });
  expect(result.status).toBe("unavailable");
  expect(result.groups).toHaveLength(1);
  expect(result.groups[0]?.anonymousBytes).toBe(123);
  expect(JSON.stringify(result)).not.toContain("private-session");
  expect(projectSharedAgentRam({ groups: [unsupported()], incomplete: false })).toEqual({
    status: "unsupported",
    groups: [],
    incomplete: false,
  });
});

it("distinguishes a complete empty read from unsupported and timed-out reads", () => {
  expect(projectSharedAgentRam({ groups: [], incomplete: false })).toEqual({
    status: "available",
    groups: [],
    incomplete: false,
  });
  expect(projectSharedAgentRam({ groups: [], incomplete: true })).toEqual({
    status: "unavailable",
    groups: [],
    incomplete: true,
  });
  const result = projectSharedAgentRam({
    groups: [
      group({ status: "unavailable", anonymousBytes: null, sampledAt: null, reason: "exited" }),
    ],
    incomplete: false,
  });
  expect(result).toMatchObject({
    status: "unavailable",
    groups: [{ anonymousBytes: null, sampledAt: null, reason: "exited" }],
  });
});

it.each([
  { attachedThreadCount: -1 },
  { anonymousBytes: Number.MAX_SAFE_INTEGER + 1 },
  { anonymousBytes: NaN },
  { sampledAt: "not-a-time" },
  { groupId: "private-token" },
  { anonymousBytes: null },
])("fails closed for an invalid private row %j", (overrides) => {
  expect(projectSharedAgentRam({ groups: [group(overrides)], incomplete: false })).toEqual({
    status: "unavailable",
    groups: [],
    incomplete: true,
  });
});

it("drops all duplicated launch identities instead of publishing ambiguous bytes", () => {
  expect(projectSharedAgentRam({ groups: [group(), group()], incomplete: false })).toEqual({
    status: "unavailable",
    groups: [],
    incomplete: true,
  });
});

it("validates all-unsupported inputs before taking the omission shortcut", () => {
  for (const groups of [
    Array.from({ length: 33 }, unsupported),
    [group({ ...unsupported(), attachedThreadCount: -1 })],
  ]) {
    expect(projectSharedAgentRam({ groups, incomplete: false })).toEqual({
      status: "unavailable",
      groups: [],
      incomplete: true,
    });
  }
  const unknownReason = unsupported();
  Object.defineProperty(unknownReason, "reason", { value: "unknown-reason" });
  expect(projectSharedAgentRam({ groups: [unknownReason], incomplete: false })).toEqual({
    status: "unavailable",
    groups: [],
    incomplete: true,
  });
});

it("never publishes available bytes from an oversized private result", () => {
  expect(
    projectSharedAgentRam({
      groups: Array.from({ length: 33 }, () => group()),
      incomplete: false,
    }),
  ).toEqual({ status: "unavailable", groups: [], incomplete: true });
});

it("preserves 32 distinct valid launch samples and rejects a 33rd distinct launch", () => {
  const groups = Array.from({ length: 33 }, (_, index) =>
    group({ groupId: `12345678-1234-4234-8234-${index.toString(16).padStart(12, "0")}` }),
  );
  const accepted = projectSharedAgentRam({ groups: groups.slice(0, 32), incomplete: false });
  expect(accepted.status).toBe("available");
  expect(accepted.incomplete).toBe(false);
  expect(accepted.groups).toHaveLength(32);
  expect(accepted.groups.map((row) => row.groupId)).toEqual(
    groups.slice(0, 32).map((row) => row.groupId),
  );
  expect(
    accepted.groups.every((row) => row.anonymousBytes === 123 && row.attachedThreadCount === 2),
  ).toBe(true);
  expect(projectSharedAgentRam({ groups, incomplete: false })).toEqual({
    status: "unavailable",
    groups: [],
    incomplete: true,
  });
});
