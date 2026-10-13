import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Manager from "../orchestration-v2/ProviderSessionManager.ts";
import * as Resources from "./ProviderRuntimeResources.ts";

const a = ThreadId.make("a");
const b = ThreadId.make("b");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const descriptor = (scope = "scope"): ProviderAdapter.ProviderRuntimeLaunchDescriptor => ({
  status: "verified",
  verifiedScopeKey: scope,
});
const sample = (scope = "scope"): ProviderAdapter.ProviderRuntimeAnonymousMemory => ({
  status: "available",
  verifiedScopeKey: scope,
  anonymousBytes: 42,
  sampledAt: "2026-10-13T00:00:00.000Z",
});
const observation = (token: string, scope = "scope"): ProviderAdapter.ProviderRuntimeObservation =>
  Object.freeze({
    launchToken: token,
    readLaunchDescriptor: Effect.succeed(descriptor(scope)),
    readAnonymousMemory: Effect.succeed(sample(scope)),
  });
function runtime(
  id: string,
  resourceObservation?: ProviderAdapter.ProviderRuntimeObservation,
): ProviderAdapter.ProviderAdapterV2SessionRuntime {
  const unused = () => Effect.die("passive resource read called a provider operation");
  return {
    instanceId,
    driver,
    providerSessionId: ProviderSessionId.make(id),
    providerSession: {} as ProviderAdapter.ProviderAdapterV2SessionRuntime["providerSession"],
    events: Stream.empty,
    ...(resourceObservation === undefined ? {} : { resourceObservation }),
    ensureThread: unused,
    resumeThread: unused,
    startTurn: unused,
    steerTurn: unused,
    interruptTurn: unused,
    respondToRuntimeRequest: unused,
    readThreadSnapshot: unused,
    rollbackThread: unused,
    forkThread: unused,
  };
}
function row(
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  threads: ReadonlyArray<ThreadId> = [a],
): Manager.ProviderRuntimeSnapshot {
  return {
    runtime,
    instanceId: runtime.instanceId,
    driver: runtime.driver,
    providerSessionId: runtime.providerSessionId,
    attachedThreadIds: threads,
    loadedProviderThreads: [],
  };
}
const withRead = (
  current: Ref.Ref<ReadonlyArray<Manager.ProviderRuntimeSnapshot>>,
  effect: Effect.Effect<void, never, Resources.ProviderRuntimeResources>,
) =>
  effect.pipe(
    Effect.provide(
      Resources.layer.pipe(
        Layer.provide(
          Layer.mock(Manager.ProviderSessionManagerV2)({ snapshotRuntimes: Ref.get(current) }),
        ),
      ),
    ),
  );

it.effect(
  "two attached threads share one whole-scope sample and detach changes only membership",
  () =>
    Effect.gen(function* () {
      let samples = 0;
      const base = observation("launch");
      const shared = runtime("shared", {
        ...base,
        readAnonymousMemory: Effect.sync(() => {
          samples++;
          return sample();
        }),
      });
      const current = yield* Ref.make<ReadonlyArray<Manager.ProviderRuntimeSnapshot>>([
        row(shared, [a, b]),
        row(shared, [b]),
      ]);
      yield* withRead(
        current,
        Effect.gen(function* () {
          const resources = yield* Resources.ProviderRuntimeResources;
          const result = yield* resources.read({ threadId: a });
          assert.lengthOf(result.groups, 1);
          assert.equal(result.groups[0]!.anonymousBytes, 42);
          assert.equal(result.groups[0]!.attachedThreadCount, 2);
          assert.equal(samples, 1);
          yield* Ref.set(current, [row(shared, [b])]);
          assert.isEmpty((yield* resources.read({ threadId: a })).groups);
          const detached = yield* resources.read({ threadId: b });
          assert.equal(detached.groups[0]!.anonymousBytes, 42);
          assert.equal(detached.groups[0]!.attachedThreadCount, 1);
        }),
      );
    }),
);

it.effect(
  "distinct known tokens claiming one scope reject attribution, including an uninitialized contender outside the filter",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      const initialized = runtime("initialized", {
        ...observation("one"),
        readAnonymousMemory: Effect.sync(() => {
          reads++;
          return sample();
        }),
      });
      const uninitialized = runtime("uninitialized", {
        ...observation("two"),
        readAnonymousMemory: Effect.succeed({
          status: "unavailable",
          verifiedScopeKey: null,
          anonymousBytes: null,
          sampledAt: null,
          reason: "not_initialized",
        }),
      });
      const current = yield* Ref.make<ReadonlyArray<Manager.ProviderRuntimeSnapshot>>([
        row(initialized),
        row(uninitialized, [b]),
      ]);
      yield* withRead(
        current,
        Effect.gen(function* () {
          const result = yield* (yield* Resources.ProviderRuntimeResources).read({ threadId: a });
          assert.equal(result.groups[0]!.reason, "ambiguous_scope");
          assert.equal(result.groups[0]!.anonymousBytes, null);
          assert.equal(reads, 0);
        }),
      );
    }),
);

it.effect.each(["conflict", "replacement", "release", "membership", "new unrelated"] as const)(
  "rejects late attribution after %s while preserving current membership",
  (change) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const original = runtime("session", {
        ...observation("old"),
        readAnonymousMemory: Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(finish)),
          Effect.as(sample()),
        ),
      });
      const current = yield* Ref.make<ReadonlyArray<Manager.ProviderRuntimeSnapshot>>([
        row(original, [a, b]),
      ]);
      yield* withRead(
        current,
        Effect.gen(function* () {
          const resources = yield* Resources.ProviderRuntimeResources;
          const pending = yield* resources.read().pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          if (change === "conflict")
            yield* Ref.set(current, [
              row(original),
              row(runtime("added", observation("new")), [b]),
            ]);
          if (change === "new unrelated")
            yield* Ref.set(current, [
              row(original),
              row(runtime("added", observation("new", "other")), [b]),
            ]);
          if (change === "replacement")
            yield* Ref.set(current, [row(runtime("session", observation("replacement")), [a])]);
          if (change === "release") yield* Ref.set(current, []);
          if (change === "membership") yield* Ref.set(current, [row(original, [b])]);
          yield* Deferred.succeed(finish, undefined);
          const result = yield* Fiber.join(pending);
          if (change === "membership") {
            assert.equal(result.groups[0]!.anonymousBytes, 42);
            assert.equal(result.groups[0]!.attachedThreadCount, 1);
          } else {
            assert.isTrue(result.groups.every((group) => group.anonymousBytes === null));
            if (change === "release") assert.isEmpty(result.groups);
            else assert.isTrue(result.incomplete);
          }
        }),
      );
    }),
);

it.effect.each(["scope drift", "exit", "collision"] as const)(
  "rejects %s at the final descriptor pass",
  (final) =>
    Effect.gen(function* () {
      let sampled = false;
      const one = runtime("one", {
        launchToken: "one",
        readLaunchDescriptor: Effect.sync(() =>
          sampled
            ? final === "exit"
              ? { status: "unavailable", verifiedScopeKey: null, reason: "exited" }
              : descriptor("moved")
            : descriptor(),
        ),
        readAnonymousMemory: Effect.sync(() => {
          sampled = true;
          return sample();
        }),
      });
      const two = runtime("two", {
        ...observation("two", "other"),
        readLaunchDescriptor: Effect.sync(() =>
          descriptor(sampled && final === "collision" ? "moved" : "other"),
        ),
      });
      const current = yield* Ref.make<ReadonlyArray<Manager.ProviderRuntimeSnapshot>>([
        row(one),
        row(two, [b]),
      ]);
      yield* withRead(
        current,
        Effect.gen(function* () {
          const result = yield* (yield* Resources.ProviderRuntimeResources).read({ threadId: a });
          assert.equal(result.groups[0]!.anonymousBytes, null);
          assert.equal(
            result.groups[0]!.reason,
            final === "exit"
              ? "exited"
              : final === "collision"
                ? "ambiguous_scope"
                : "identity_changed",
          );
        }),
      );
    }),
);

it.effect.each([
  "initial snapshot",
  "initial descriptor",
  "counter",
  "final descriptor",
  "final snapshot",
] as const)("applies the one-second deadline to %s and interrupts scoped work", (stage) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const block = Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
    );
    let descriptorReads = 0;
    const one = runtime("one", {
      launchToken: "one",
      readLaunchDescriptor: Effect.suspend(() => {
        descriptorReads++;
        return (stage === "initial descriptor" && descriptorReads === 1) ||
          (stage === "final descriptor" && descriptorReads === 2)
          ? block
          : Effect.succeed(descriptor());
      }),
      readAnonymousMemory: stage === "counter" ? block : Effect.succeed(sample()),
    });
    let snapshotReads = 0;
    const managerLayer = Layer.mock(Manager.ProviderSessionManagerV2)({
      snapshotRuntimes: Effect.suspend(() => {
        snapshotReads++;
        return (stage === "initial snapshot" && snapshotReads === 1) ||
          (stage === "final snapshot" && snapshotReads === 2)
          ? block
          : Effect.succeed([row(one)]);
      }),
    });
    yield* Effect.gen(function* () {
      const resources = yield* Resources.ProviderRuntimeResources;
      const pending = yield* resources.read().pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(pending);
      yield* Deferred.await(interrupted);
      assert.isTrue(result.incomplete);
      assert.isEmpty(result.groups);
    }).pipe(Effect.provide(Resources.layer.pipe(Layer.provide(managerLayer))));
  }),
);

it.effect("the 32-group cap refuses incomplete contender proof and performs no samples", () =>
  Effect.gen(function* () {
    let reads = 0;
    const rows = Array.from({ length: 33 }, (_, index) =>
      row(
        runtime(String(index), {
          ...observation(String(index), String(index)),
          readAnonymousMemory: Effect.sync(() => {
            reads++;
            return sample(String(index));
          }),
        }),
      ),
    );
    const current = yield* Ref.make<ReadonlyArray<Manager.ProviderRuntimeSnapshot>>(rows);
    yield* withRead(
      current,
      Effect.gen(function* () {
        const result = yield* (yield* Resources.ProviderRuntimeResources).read();
        assert.isTrue(result.incomplete);
        assert.lengthOf(result.groups, 32);
        assert.isTrue(result.groups.every((group) => group.anonymousBytes === null));
        assert.equal(reads, 0);
      }),
    );
  }),
);

it.effect("unsupported providers cause no provider or manager control call", () =>
  Effect.gen(function* () {
    const current = yield* Ref.make<ReadonlyArray<Manager.ProviderRuntimeSnapshot>>([
      row(runtime("unsupported")),
    ]);
    yield* withRead(
      current,
      Effect.gen(function* () {
        const result = yield* (yield* Resources.ProviderRuntimeResources).read();
        assert.equal(result.groups[0]!.status, "unsupported");
        assert.equal(result.groups[0]!.reason, "unsupported_provider");
        assert.equal(result.groups[0]!.anonymousBytes, null);
        assert.isFalse(result.incomplete);
      }),
    );
  }),
);

it.effect.each(["scope", "different-scope"])(
  "refuses token reuse across distinct raw runtimes claiming %s",
  (scope) =>
    Effect.gen(function* () {
      let samples = 0;
      const captured = (key: string) => ({
        ...observation("reused", key),
        readAnonymousMemory: Effect.sync(() => {
          samples++;
          return sample(key);
        }),
      });
      const first = runtime("first", captured("scope"));
      const second = runtime("second", captured(scope));
      const current = yield* Ref.make<ReadonlyArray<Manager.ProviderRuntimeSnapshot>>([
        row(first),
        row(second, [b]),
      ]);
      yield* withRead(
        current,
        Effect.gen(function* () {
          const result = yield* (yield* Resources.ProviderRuntimeResources).read();
          assert.lengthOf(result.groups, 2);
          assert.isTrue(
            result.groups.every(
              (group) => group.anonymousBytes === null && group.reason === "ambiguous_scope",
            ),
          );
          assert.equal(samples, 0);
        }),
      );
    }),
);

it.effect.each(["release", "detach", "replacement"] as const)(
  "publishes no stale group or membership when %s precedes a blocked-sample deadline",
  (change) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const original = runtime("session", {
        ...observation("original"),
        readAnonymousMemory: Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
        ),
      });
      const current = yield* Ref.make<ReadonlyArray<Manager.ProviderRuntimeSnapshot>>([
        row(original, [a, b]),
      ]);
      yield* withRead(
        current,
        Effect.gen(function* () {
          const resources = yield* Resources.ProviderRuntimeResources;
          const pending = yield* resources.read({ threadId: a }).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          yield* Ref.set(
            current,
            change === "release"
              ? []
              : change === "detach"
                ? [row(original, [b])]
                : [row(runtime("session", observation("replacement")), [b])],
          );
          yield* TestClock.adjust("1 second");
          const result = yield* Fiber.join(pending);
          assert.isTrue(result.incomplete);
          assert.isEmpty(result.groups);
        }),
      );
    }),
);
