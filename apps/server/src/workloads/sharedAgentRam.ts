import {
  ProviderDriverKind,
  ProviderInstanceId,
  SharedAgentRamGroup,
  SharedAgentRamReason,
  type SharedAgentRamSummary,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type * as ProviderRuntimeResources from "../agentResources/ProviderRuntimeResources.ts";

const isPublicGroup = Schema.is(SharedAgentRamGroup);
const isReason = Schema.is(SharedAgentRamReason);
const isDriver = Schema.is(ProviderDriverKind);
const isInstanceId = Schema.is(ProviderInstanceId);
const unavailableEmpty = (): SharedAgentRamSummary => ({
  status: "unavailable",
  groups: [],
  incomplete: true,
});

export function projectSharedAgentRam(
  input: ProviderRuntimeResources.ProviderRuntimeResourceSummary,
): SharedAgentRamSummary {
  if (input.groups.length > 32 || typeof input.incomplete !== "boolean") return unavailableEmpty();
  const counts = new Map<string, number>();
  for (const group of input.groups) counts.set(group.groupId, (counts.get(group.groupId) ?? 0) + 1);
  const groups: SharedAgentRamGroup[] = [];
  let invalid = false;
  let omitted = false;
  for (const group of input.groups) {
    // Omission must not turn a malformed fallback tuple into complete coverage.
    const fallback =
      group.status === "unsupported" &&
      group.reason === "unsupported_provider" &&
      group.groupId === `unsupported:${group.instanceId}:${group.providerSessionId}`;
    if (fallback) {
      omitted = true;
      if (
        (counts.get(group.groupId) ?? 0) > 1 ||
        !isDriver(group.driver) ||
        !isInstanceId(group.instanceId) ||
        !Number.isSafeInteger(group.attachedThreadCount) ||
        group.attachedThreadCount < 0 ||
        group.anonymousBytes !== null ||
        group.sampledAt !== null
      )
        invalid = true;
      continue;
    }
    const candidate = {
      groupId: group.groupId,
      driver: group.driver,
      instanceId: group.instanceId,
      attachedThreadCount: group.attachedThreadCount,
      status: group.status,
      anonymousBytes: group.anonymousBytes,
      sampledAt: group.sampledAt,
      reason: group.reason === null ? null : isReason(group.reason) ? group.reason : undefined,
    };
    if ((counts.get(group.groupId) ?? 0) > 1 || !isPublicGroup(candidate)) {
      invalid = true;
      continue;
    }
    groups.push(candidate);
  }
  if (input.groups.length > 0 && input.groups.every((group) => group.status === "unsupported")) {
    return invalid
      ? unavailableEmpty()
      : { status: "unsupported", groups: [], incomplete: input.incomplete };
  }
  if (
    !input.incomplete &&
    !invalid &&
    !omitted &&
    groups.every((group) => group.status === "available")
  ) {
    // Narrow the rows through the discriminant instead of casting the union.
    return {
      status: "available",
      groups: groups.filter((group) => group.status === "available"),
      incomplete: false,
    };
  }
  return { status: "unavailable", groups, incomplete: input.incomplete || invalid };
}
