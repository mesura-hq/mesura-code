import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";

type Snapshot = ProviderSessionManager.ProviderRuntimeSnapshot;
export interface ProviderRuntimeResourceGroup {
  readonly groupId: string;
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly providerSessionId: ProviderSessionId;
  readonly attachedThreadCount: number;
  readonly status: "available" | "unavailable" | "unsupported";
  readonly anonymousBytes: number | null;
  readonly sampledAt: string | null;
  readonly reason: ProviderAdapter.ProviderRuntimeResourceReason | null;
}
export interface ProviderRuntimeResourceSummary {
  readonly groups: ReadonlyArray<ProviderRuntimeResourceGroup>;
  readonly incomplete: boolean;
}

export class ProviderRuntimeResources extends Context.Service<
  ProviderRuntimeResources,
  {
    readonly read: (input?: {
      readonly threadId?: ThreadId;
    }) => Effect.Effect<ProviderRuntimeResourceSummary>;
  }
>()("t3/agentResources/ProviderRuntimeResources") {}

const CAP = 32;
const membership = (rows: ReadonlyArray<Snapshot>) =>
  new Set(rows.flatMap((row) => row.attachedThreadIds));
const groupRows = (rows: ReadonlyArray<Snapshot>) => {
  const groups = new Map<ProviderAdapter.ProviderAdapterV2SessionRuntime, Array<Snapshot>>();
  for (const row of rows) {
    const key = row.runtime;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()];
};
const unavailable = (
  rows: ReadonlyArray<Snapshot>,
  reason: ProviderAdapter.ProviderRuntimeResourceReason,
): ProviderRuntimeResourceGroup => {
  const row = rows[0]!;
  const observation = row.runtime.resourceObservation;
  return {
    groupId: observation?.launchToken ?? `unsupported:${row.instanceId}:${row.providerSessionId}`,
    driver: row.driver,
    instanceId: row.instanceId,
    providerSessionId: row.providerSessionId,
    attachedThreadCount: membership(rows).size,
    status: reason === "unsupported_provider" ? "unsupported" : "unavailable",
    anonymousBytes: null,
    sampledAt: null,
    reason,
  };
};

const make = Effect.gen(function* () {
  const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const read: ProviderRuntimeResources["Service"]["read"] = (input = {}) =>
    Effect.suspend(() => {
      const selected = (rows: ReadonlyArray<Snapshot>) =>
        groupRows(rows).filter(
          (group) => input.threadId === undefined || membership(group).has(input.threadId),
        );
      const incomplete = (rows: ReadonlyArray<Snapshot>): ProviderRuntimeResourceSummary => ({
        groups: selected(rows)
          .slice(0, CAP)
          .map((group) =>
            unavailable(
              group,
              group[0]!.runtime.resourceObservation === undefined
                ? "unsupported_provider"
                : "incomplete",
            ),
          ),
        incomplete: true,
      });
      return Effect.gen(function* () {
        const initial = yield* manager.snapshotRuntimes;
        const initialGroups = groupRows(initial);
        // Every captured contender participates, even without protocol readiness or
        // a matching thread filter. A capped pass cannot prove collision exclusion.
        if (initialGroups.length > CAP) return incomplete(initial);
        const observations = new Map<
          ProviderAdapter.ProviderAdapterV2SessionRuntime,
          ProviderAdapter.ProviderRuntimeObservation
        >();
        for (const row of initial)
          if (row.runtime.resourceObservation !== undefined)
            observations.set(row.runtime, row.runtime.resourceObservation);
        const tokenOwners = new Map<string, Set<ProviderAdapter.ProviderAdapterV2SessionRuntime>>();
        for (const [runtime, observation] of observations) {
          const owners = tokenOwners.get(observation.launchToken) ?? new Set();
          owners.add(runtime);
          tokenOwners.set(observation.launchToken, owners);
        }
        const reusedTokens = new Set(
          [...tokenOwners].filter(([, owners]) => owners.size > 1).map(([token]) => token),
        );
        const descriptors = new Map<
          ProviderAdapter.ProviderAdapterV2SessionRuntime,
          ProviderAdapter.ProviderRuntimeLaunchDescriptor
        >();
        for (const [runtime, observation] of observations)
          descriptors.set(runtime, yield* observation.readLaunchDescriptor);
        const collisions = (values: typeof descriptors) => {
          const tokens = new Map<string, Set<string>>();
          for (const [runtime, descriptor] of values)
            if (descriptor.status === "verified") {
              const owners = tokens.get(descriptor.verifiedScopeKey) ?? new Set<string>();
              owners.add(observations.get(runtime)!.launchToken);
              tokens.set(descriptor.verifiedScopeKey, owners);
            }
          return new Set([...tokens].filter(([, owners]) => owners.size > 1).map(([key]) => key));
        };
        const initialCollisions = collisions(descriptors);
        const samples = new Map<string, ProviderAdapter.ProviderRuntimeAnonymousMemory>();
        for (const rows of selected(initial)) {
          const runtime = rows[0]!.runtime;
          const observation = observations.get(runtime);
          const descriptor = descriptors.get(runtime);
          if (
            observation !== undefined &&
            descriptor?.status === "verified" &&
            !initialCollisions.has(descriptor.verifiedScopeKey) &&
            !reusedTokens.has(observation.launchToken)
          )
            samples.set(observation.launchToken, yield* observation.readAnonymousMemory);
        }
        const finalDescriptors: typeof descriptors = new Map();
        for (const [runtime, observation] of observations)
          finalDescriptors.set(runtime, yield* observation.readLaunchDescriptor);
        const final = yield* manager.snapshotRuntimes;
        if (
          groupRows(final).length > CAP ||
          final.some((row) => {
            const observation = row.runtime.resourceObservation;
            return (
              observation !== undefined &&
              (observations.get(row.runtime) !== observation ||
                observations.get(row.runtime)?.launchToken !== observation.launchToken)
            );
          })
        )
          return incomplete(final);
        const finalCollisions = collisions(finalDescriptors);
        const groups = selected(final)
          .slice(0, CAP)
          .map((rows): ProviderRuntimeResourceGroup => {
            const runtime = rows[0]!.runtime;
            const observation = observations.get(runtime);
            if (runtime.resourceObservation === undefined)
              return unavailable(rows, "unsupported_provider");
            if (observation === undefined) return unavailable(rows, "incomplete");
            if (reusedTokens.has(observation.launchToken))
              return unavailable(rows, "ambiguous_scope");
            const descriptor = descriptors.get(runtime);
            const after = finalDescriptors.get(runtime);
            if (descriptor?.status !== "verified")
              return {
                ...unavailable(rows, descriptor?.reason ?? "incomplete"),
                status: descriptor?.status ?? "unavailable",
              };
            if (after?.status !== "verified")
              return {
                ...unavailable(rows, after?.reason ?? "incomplete"),
                status: after?.status ?? "unavailable",
              };
            if (
              initialCollisions.has(descriptor.verifiedScopeKey) ||
              finalCollisions.has(after.verifiedScopeKey)
            )
              return unavailable(rows, "ambiguous_scope");
            if (after.verifiedScopeKey !== descriptor.verifiedScopeKey)
              return unavailable(rows, "identity_changed");
            // All current references must retain their raw runtime and token. Entry
            // replacement during attachment/activity is deliberately irrelevant.
            if (
              rows.some(
                (row) => observations.get(row.runtime)?.launchToken !== observation.launchToken,
              )
            )
              return unavailable(rows, "identity_changed");
            const sample = samples.get(observation.launchToken);
            if (sample === undefined) return unavailable(rows, "incomplete");
            if (sample.status !== "available")
              return { ...unavailable(rows, sample.reason), status: sample.status };
            if (sample.verifiedScopeKey !== after.verifiedScopeKey)
              return unavailable(rows, "identity_changed");
            return {
              ...unavailable(rows, "incomplete"),
              status: "available",
              reason: null,
              anonymousBytes: sample.anonymousBytes,
              sampledAt: sample.sampledAt,
            };
          });
        return { groups, incomplete: groups.some((group) => group.reason === "incomplete") };
      }).pipe(
        Effect.timeout("1 second"),
        Effect.catch(() => Effect.succeed({ groups: [], incomplete: true })),
      );
    });
  return ProviderRuntimeResources.of({ read });
});

export const layer = Layer.effect(ProviderRuntimeResources, make);
