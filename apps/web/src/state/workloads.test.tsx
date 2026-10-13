// @vitest-environment happy-dom
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import type { SupervisorConnectionState } from "@t3tools/client-runtime/connection";
import {
  AuthDiagnosticsReadScope,
  AuthEnvironmentMaintainScope,
  EnvironmentAuthorizationError,
  type WorkloadControlResult,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { useWorkloadControl, useWorkloadQuery } from "./workloads";
import {
  actEffect,
  ENVIRONMENT,
  GENERATION,
  makeWorkloadHarness,
  OTHER_ENVIRONMENT,
  RECORD,
  THREAD,
  type WorkloadHarness,
} from "./workloads.testkit";

let harness: WorkloadHarness;
let root: Root;
let container: HTMLDivElement;
let control: ReturnType<typeof useWorkloadControl>;
let queryView: ReturnType<typeof useWorkloadQuery>;
function Query(props: {
  environmentId?: typeof ENVIRONMENT;
  threadId?: typeof THREAD;
  visible?: boolean;
}) {
  const query = useWorkloadQuery(
    props.environmentId ?? ENVIRONMENT,
    props.threadId === undefined ? {} : { threadId: props.threadId },
    props.visible ?? true,
  );
  const nextControl = useWorkloadControl(props.environmentId ?? ENVIRONMENT, RECORD);
  useEffect(() => {
    queryView = query;
    control = nextControl;
  }, [query, nextControl]);
  return (
    <output>
      {query.accessDenied
        ? "denied"
        : query.canRead
          ? (query.data?.registryState ?? "waiting")
          : "no access"}
    </output>
  );
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  harness = await makeWorkloadHarness();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  harness.dispose();
  container.remove();
  Reflect.deleteProperty(document, "visibilityState");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render(children: ReactNode) {
  await act(async () => root.render(harness.provider(children)));
}
const input = { recordId: RECORD, expectedGeneration: GENERATION, threadId: THREAD };

describe("workload query lifecycle and guarded mutations", () => {
  it("does not read protected diagnostics for a maintenance-only destination", async () => {
    await harness.grant(ENVIRONMENT, [AuthEnvironmentMaintainScope]);
    await render(<Query />);
    expect(container.textContent).toBe("no access");
    expect(harness.calls.list).toHaveLength(0);
    expect(control.canStop).toBe(true);
  });
  it("shares identical targets, separates hosts and filters, and refreshes all active filters on settlement", async () => {
    await render(
      <>
        <Query />
        <Query />
        <Query threadId={THREAD} />
        <Query environmentId={OTHER_ENVIRONMENT} />
      </>,
    );
    await harness.read();
    await harness.read({ threadId: THREAD });
    await harness.read({}, OTHER_ENVIRONMENT);
    expect(
      harness.calls.list.filter(
        (call) => call.environmentId === ENVIRONMENT && call.input.threadId === undefined,
      ),
    ).toHaveLength(1);
    expect(harness.calls.list).toHaveLength(3);
    await act(async () => {
      await control.run("stop", input);
    }); // The last view targets host B.
    await harness.read({}, OTHER_ENVIRONMENT);
    expect(harness.calls.controls[0]?.environmentId).toBe(OTHER_ENVIRONMENT);
    expect(harness.calls.list.filter((call) => call.environmentId === ENVIRONMENT)).toHaveLength(2);
    await render(
      <>
        <Query />
        <Query threadId={THREAD} />
      </>,
    );
    await harness.read();
    await harness.read({ threadId: THREAD });
    const before = harness.calls.list.length;
    await act(async () => {
      await control.run("stop", input);
    });
    await harness.read();
    await harness.read({ threadId: THREAD });
    expect(harness.calls.list.length - before).toBe(2);
  });
  it("polls at three seconds only while a visible subscriber remains, including document hiding and reopening", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await render(
      <>
        <Query />
        <Query />
      </>,
    );
    await harness.read();
    const initial = harness.calls.list.length;
    await act(async () => vi.advanceTimersByTimeAsync(2_999));
    expect(harness.calls.list.length).toBe(initial);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    await harness.read();
    expect(harness.calls.list.length).toBe(initial + 1);
    await render(
      <>
        <Query visible={false} />
        <Query />
      </>,
    );
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    await harness.read();
    expect(harness.calls.list.length).toBe(initial + 2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    const hidden = harness.calls.list.length;
    await act(async () => vi.advanceTimersByTimeAsync(9_000));
    expect(harness.calls.list.length).toBe(hidden);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await harness.read();
    expect(harness.calls.list.length).toBeGreaterThan(hidden);
    await render(<Query visible={false} />);
    const closed = harness.calls.list.length;
    await act(async () => vi.advanceTimersByTimeAsync(9_000));
    expect(harness.calls.list.length).toBe(closed);
  });
  it("uses destination grants at execution after revocation, while diagnostics alone can still read", async () => {
    await render(<Query />);
    await harness.read();
    expect(control.canStop).toBe(true);
    const capturedRun = control.run;
    await harness.grant(ENVIRONMENT, [AuthDiagnosticsReadScope]);
    expect(control.canStop).toBe(false);
    await act(async () => {
      await capturedRun("stop", input);
    });
    expect(harness.calls.controls).toHaveLength(0);
    expect(control.accessUnavailable).toBe(true);
    expect(control.unknownOutcome).toBe(false);
    await harness.read();
    expect(container.textContent).toContain("available");
    await render(<Query environmentId={OTHER_ENVIRONMENT} />);
    await harness.read({}, OTHER_ENVIRONMENT);
    expect(control.canStop).toBe(true);
    await act(async () => {
      await control.run("stop", input);
    });
    expect(harness.calls.controls.map((call) => call.environmentId)).toEqual([OTHER_ENVIRONMENT]);
  });
  it("does not retry diagnostics authorization failures until an explicit refresh", async () => {
    harness.replies.list = () =>
      Effect.fail(
        new EnvironmentAuthorizationError({
          requiredScope: AuthDiagnosticsReadScope,
          message: "Revoked",
        }),
      );
    await render(<Query />);
    await act(async () => {
      await harness.read().catch(() => undefined);
    });
    expect(container.textContent).toBe("denied");
    const before = harness.calls.list.length;
    await harness.grant(ENVIRONMENT, [AuthDiagnosticsReadScope, AuthEnvironmentMaintainScope]);
    expect(container.textContent).toBe("denied");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await act(async () => vi.advanceTimersByTimeAsync(9_000));
    expect(harness.calls.list.length).toBe(before);
    harness.replies.list = () =>
      Effect.succeed({
        registryState: "absent",
        workloads: [],
        incomplete: false,
        diagnostics: [],
        agentRamAttribution: "unsupported",
        sharedAgentRam: { status: "unsupported", groups: [], incomplete: false },
      });
    await act(async () => queryView.refresh());
    await harness.read();
    expect(container.textContent).toBe("absent");
  });
  it.effect(
    "shares pending state across callers, observes a refused result, and never retries a mutation",
    () =>
      Effect.gen(function* () {
        const release = yield* Deferred.make<WorkloadControlResult>();
        const entered = yield* Deferred.make<void>();
        harness.replies.control = () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            return yield* Deferred.await(release);
          });
        yield* Effect.promise(() => render(<Query />));
        yield* Effect.promise(() => harness.read());
        let first!: Promise<void>;
        yield* actEffect(
          Effect.gen(function* () {
            first = control.run("stop", input);
            yield* Deferred.await(entered);
          }),
        );
        expect(control.pending).toBe("stop");
        yield* Effect.promise(() =>
          act(async () => {
            await control.run("start", input);
          }),
        );
        expect(harness.calls.controls).toHaveLength(1);
        const refusal = {
          recordId: RECORD,
          oldGeneration: GENERATION,
          status: "refused" as const,
          operation: "stop" as const,
          reason: "stale-generation" as const,
          mutationAttempted: false as const,
        };
        yield* actEffect(
          Deferred.succeed(release, refusal).pipe(Effect.andThen(Effect.promise(() => first))),
        );
        yield* Effect.promise(() => harness.read());
        expect(control.result).toEqual(refusal);
        expect(control.pending).toBeNull();
        expect(harness.calls.controls).toHaveLength(1);
      }),
  );
  it("refreshes an unknown transport outcome without claiming success or replaying", async () => {
    await render(<Query />);
    await harness.read();
    harness.replies.control = () => Effect.die(new Error("Socket disappeared"));
    const before = harness.calls.list.length;
    await act(async () => {
      await control.run("stop", input);
    });
    await harness.read();
    expect(control.unknownOutcome).toBe(true);
    expect(control.result).toBeNull();
    expect(harness.calls.controls).toHaveLength(1);
    expect(harness.calls.list.length).toBeGreaterThan(before);
  });
  it.effect("refreshes a mounted target after reconnect and stops observing on unmount", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => render(<Query />));
      yield* Effect.promise(() => harness.read());
      const before = harness.calls.list.length;
      const supervisor = harness.supervisors.get(ENVIRONMENT)!;
      const originalSession = yield* SubscriptionRef.get(supervisor.session);
      yield* actEffect(
        SubscriptionRef.set(supervisor.session, Option.none()).pipe(
          Effect.andThen(
            SubscriptionRef.update(supervisor.state, (state): SupervisorConnectionState => ({
              ...state,
              phase: "connecting",
              generation: state.generation + 1,
            })),
          ),
        ),
      );
      yield* actEffect(
        SubscriptionRef.set(supervisor.session, originalSession).pipe(
          Effect.andThen(
            SubscriptionRef.update(supervisor.state, (state): SupervisorConnectionState => ({
              ...state,
              phase: "connected",
            })),
          ),
        ),
      );
      yield* Effect.promise(() => harness.read());
      expect(harness.calls.list.length).toBeGreaterThan(before);
      yield* Effect.promise(() => render(null));
    }),
  );
});
