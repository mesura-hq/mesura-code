import { RegistryContext } from "@effect/atom-react";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import {
  AuthDiagnosticsReadScope,
  AuthEnvironmentMaintainScope,
  EnvironmentId,
  type EnvironmentAuthorizationError,
  ThreadId,
  WS_METHODS,
  type AuthEnvironmentScope,
  type AuthSessionState,
  type WorkloadControlInput,
  type WorkloadControlResult,
  type WorkloadListInput,
  type WorkloadListResult,
  type WorkloadSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act, type ReactNode } from "react";

import { createWorkloadAtoms, WorkloadStateContext } from "./workloads";

export const ENVIRONMENT = EnvironmentId.make("workload-host-a");
export const OTHER_ENVIRONMENT = EnvironmentId.make("workload-host-b");
export const THREAD = ThreadId.make("workload-thread");
export const OTHER_THREAD = ThreadId.make("other-workload-thread");
export const RECORD = "a".repeat(64);
export function workload(overrides: Partial<WorkloadSummary> = {}): WorkloadSummary {
  return {
    recordId: RECORD,
    name: "Frontend preview",
    association: { state: "assigned", threadId: THREAD, reason: null },
    managerState: "running",
    ramBytes: 16 * 1024 * 1024,
    memoryCurrentBytes: 128 * 1024 * 1024,
    ports: [5173],
    defaultPort: 5173,
    remoteUrl: "https://preview.example.test:5173",
    controlsAvailable: true,
    ...overrides,
  };
}
export function workloadList(
  rows: readonly WorkloadSummary[] = [workload()],
  overrides: Partial<WorkloadListResult> = {},
): WorkloadListResult {
  return {
    registryState: "available",
    workloads: rows,
    incomplete: false,
    diagnostics: [],
    agentRamAttribution: "unsupported",
    sharedAgentRam: { status: "unsupported", groups: [], incomplete: false },
    ...overrides,
  };
}
export function session(
  scopes: readonly AuthEnvironmentScope[] = [
    AuthDiagnosticsReadScope,
    AuthEnvironmentMaintainScope,
  ],
): AuthSessionState {
  return {
    authenticated: true,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "test-session",
    },
    scopes,
    permissions: scopes,
  };
}
export const completedStop: WorkloadControlResult = {
  recordId: RECORD,
  status: "completed",
  operation: "stop",
  result: "stopped",
  mutationAttempted: true,
  managerState: "stopped",
};

/** Only HTTP/WS transport replies are replaced. Query, grants, guards and commands stay real. */
export async function makeWorkloadHarness(
  environmentIds: readonly EnvironmentId[] = [ENVIRONMENT, OTHER_ENVIRONMENT],
) {
  const grants = new Map(
    environmentIds.map((environmentId) => [environmentId, session()] as const),
  );
  // Transport origins are independent of arbitrary environment IDs, which can contain colons.
  // URL.hostname is a string. Inferred template-literal keys reject that lookup.
  const transportHosts = new Map<string, EnvironmentId>(
    environmentIds.map(
      (environmentId, index) => [`fixture-${index}.example.test`, environmentId] as const,
    ),
  );
  const calls = {
    list: [] as { environmentId: EnvironmentId; input: WorkloadListInput }[],
    controls: [] as {
      environmentId: EnvironmentId;
      operation: "start" | "stop";
      input: WorkloadControlInput;
    }[],
  };
  const replies = {
    list: (
      _environmentId: EnvironmentId,
      _input: WorkloadListInput,
    ): Effect.Effect<WorkloadListResult, EnvironmentAuthorizationError | Schema.SchemaError> =>
      Effect.succeed(workloadList()),
    control: (
      _environmentId: EnvironmentId,
      _operation: "start" | "stop",
      _input: WorkloadControlInput,
    ): Effect.Effect<WorkloadControlResult, EnvironmentAuthorizationError> =>
      Effect.succeed(completedStop),
  };
  const supervisors = await Effect.runPromise(
    Effect.gen(function* () {
      const result = new Map<
        EnvironmentId,
        EnvironmentSupervisor.EnvironmentSupervisor["Service"]
      >();
      for (const [hostname, environmentId] of transportHosts) {
        const target = new PrimaryConnectionTarget({
          environmentId,
          label: environmentId,
          httpBaseUrl: `https://${hostname}`,
          wsBaseUrl: `wss://${hostname}`,
        });
        const client = {
          [WS_METHODS.workloadsList]: (input: WorkloadListInput) =>
            Effect.suspend(() => {
              calls.list.push({ environmentId, input });
              return replies.list(environmentId, input);
            }),
          [WS_METHODS.workloadsStart]: (input: WorkloadControlInput) =>
            Effect.suspend(() => {
              calls.controls.push({ environmentId, operation: "start", input });
              return replies.control(environmentId, "start", input);
            }),
          [WS_METHODS.workloadsStop]: (input: WorkloadControlInput) =>
            Effect.suspend(() => {
              calls.controls.push({ environmentId, operation: "stop", input });
              return replies.control(environmentId, "stop", input);
            }),
        };
        const rpcSession = { client, initialConfig: Effect.never } as unknown as RpcSession;
        const prepared: PreparedConnection = {
          environmentId,
          label: environmentId,
          httpBaseUrl: target.httpBaseUrl,
          socketUrl: target.wsBaseUrl,
          httpAuthorization: null,
          target,
        };
        result.set(
          environmentId,
          EnvironmentSupervisor.EnvironmentSupervisor.of({
            target,
            state: yield* SubscriptionRef.make<SupervisorConnectionState>({
              ...AVAILABLE_CONNECTION_STATE,
              desired: true,
              network: "online",
              phase: "connected",
              attempt: 1,
              generation: 1,
            }),
            session: yield* SubscriptionRef.make(Option.some(rpcSession)),
            prepared: yield* SubscriptionRef.make(Option.some(prepared)),
            connect: Effect.void,
            disconnect: Effect.void,
            retryNow: Effect.void,
          }),
        );
      }
      return result;
    }),
  );
  const getSupervisor = (id: EnvironmentId) => {
    const value = supervisors.get(id);
    if (!value) throw new Error(`Unexpected fixture environment: ${id}`);
    return value;
  };
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (id, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, getSupervisor(id));
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    id,
    stream,
  ) =>
    Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, getSupervisor(id));
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
    followStream,
    stateChanges: (id: EnvironmentId) => SubscriptionRef.changes(getSupervisor(id).state),
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const http = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const environmentId = transportHosts.get(url.hostname);
      const grant = environmentId === undefined ? undefined : grants.get(environmentId);
      if (url.pathname !== "/api/auth/session" || !grant)
        throw new Error(`Unexpected HTTP fixture request: ${url}`);
      return HttpClientResponse.fromWeb(request, Response.json(grant));
    }),
  );
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
      Layer.succeed(HttpClient.HttpClient, http),
    ),
  );
  const atoms = createWorkloadAtoms(runtime);
  const registry = AtomRegistry.make({ timeoutResolution: 1 });
  return {
    atoms,
    registry,
    calls,
    replies,
    supervisors,
    provider: (children: ReactNode) => (
      <RegistryContext.Provider value={registry}>
        <WorkloadStateContext.Provider value={atoms}>{children}</WorkloadStateContext.Provider>
      </RegistryContext.Provider>
    ),
    read: async (input: WorkloadListInput = {}, environmentId = ENVIRONMENT) => {
      let value: WorkloadListResult | undefined;
      await act(async () => {
        value = await Effect.runPromise(
          AtomRegistry.getResult(registry, atoms.list({ environmentId, input }), {
            suspendOnWaiting: true,
          }),
        );
      });
      return value!;
    },
    grant: async (environmentId: EnvironmentId, scopes: readonly AuthEnvironmentScope[]) => {
      grants.set(environmentId, session(scopes));
      await act(async () => {
        registry.refresh(atoms.sessions.sessionStateAtom(environmentId));
        await Effect.runPromise(
          AtomRegistry.getResult(registry, atoms.sessions.sessionStateAtom(environmentId), {
            suspendOnWaiting: true,
          }),
        );
      });
    },
    settledControl: (environmentId = ENVIRONMENT, recordId = RECORD) =>
      new Promise<void>((resolve) => {
        const atom = atoms.controlState(environmentId, recordId);
        const before = registry.get(atom);
        let unsubscribe = () => {};
        const check = () => {
          const state = registry.get(atom);
          if (state !== before && state.pending === null && state.settledAt !== null) {
            unsubscribe();
            resolve();
          }
        };
        unsubscribe = registry.subscribe(atom, check);
        check();
      }),
    dispose: () => registry.dispose(),
  };
}
export type WorkloadHarness = Awaited<ReturnType<typeof makeWorkloadHarness>>;

/** The viewport is a platform boundary; the real useMediaQuery hook stays subscribed. */
export function installWorkloadViewport(initialMobile: boolean) {
  let mobile = initialMobile;
  const lists = new Set<MediaQueryList>();
  const original = window.matchMedia;
  window.matchMedia = (query: string) => {
    const list = original.call(window, query);
    Object.defineProperty(list, "matches", {
      configurable: true,
      get: () => (query === "(max-width: 767px)" ? mobile : false),
    });
    lists.add(list);
    return list;
  };
  return {
    setMobile: (next: boolean) => {
      mobile = next;
      for (const list of lists) list.dispatchEvent(new Event("change"));
    },
    restore: () => {
      window.matchMedia = original;
    },
  };
}

const identity = { recordId: RECORD };
export const controlOutcomes = [
  [completedStop, "Stopped", "Host state: stopped."],
  [
    {
      ...identity,
      status: "refused",
      operation: "stop",
      reason: "owner-mismatch",
      mutationAttempted: false,
      managerState: "running",
    },
    "Stop refused",
    "The owning thread changed",
  ],
  [
    {
      ...identity,
      status: "completed",
      operation: "stop",
      result: "already-stopped",
      mutationAttempted: false,
      managerState: "absent",
    },
    "Already stopped",
    "Host state: absent.",
  ],
  [
    {
      ...identity,
      status: "completed",
      operation: "start",
      result: "admitted",
      mutationAttempted: true,
      registration: "recorded",
      managerState: "unknown",
    },
    "Start accepted",
    "Launch recorded. Host state: unknown.",
  ],
  [
    {
      ...identity,
      status: "incomplete",
      operation: "start",
      admission: "accepted",
      mutationAttempted: true,
      registration: "unknown",
      managerState: "unknown",
    },
    "Start outcome incomplete",
    "Start was accepted. Its saved launch is unconfirmed.",
  ],
  [
    {
      ...identity,
      status: "incomplete",
      operation: "stop",
      mutationAttempted: true,
      managerState: "running",
    },
    "Stop outcome incomplete",
    "Host state: running",
  ],
  [
    {
      ...identity,
      status: "incomplete",
      operation: "start",
      mutationAttempted: true,
      admission: "accepted",
      registration: "failed",
      managerState: "unknown",
    },
    "Start outcome incomplete",
    "Start was accepted, but its record could not be saved.",
  ],
  [
    {
      ...identity,
      status: "incomplete",
      operation: "start",
      mutationAttempted: true,
      admission: "unknown",
      registration: "unknown",
      managerState: "unknown",
    },
    "Start outcome incomplete",
    "The start result is not confirmed.",
  ],
] satisfies readonly [WorkloadControlResult, string, string][];

/** Runs the caller's test Effect inside React's act lifetime, without creating an Effect runtime. */
export function actEffect<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const flush = act(async () => done);
    return yield* effect.pipe(
      Effect.ensuring(
        Effect.promise(async () => {
          resolveDone();
          await flush;
        }),
      ),
    );
  });
}
