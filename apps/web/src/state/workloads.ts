import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { createEnvironmentSessionAtoms } from "@t3tools/client-runtime/state/session";
import {
  AuthDiagnosticsReadScope,
  EnvironmentAuthorizationError,
  WS_METHODS,
  sessionGrantsScope,
  type AuthSessionState,
  type EnvironmentId,
  type WorkloadControlInput,
  type WorkloadControlResult,
  type WorkloadListInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";

type ControlState = {
  readonly pending: "start" | "stop" | null;
  readonly result: WorkloadControlResult | null;
  readonly unknownOutcome: boolean;
  readonly accessUnavailable: boolean;
  readonly settledAt: number | null;
};

/** Identical targets share one poll. Control settlement refreshes every active filter on its host. */
export function createWorkloadAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  const refreshSignal = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.keepAlive),
  );
  const deniedSession = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<string | null>(null).pipe(Atom.keepAlive),
  );
  const controlState = Atom.family((_key: string) =>
    Atom.make<ControlState>({
      pending: null,
      result: null,
      unknownOutcome: false,
      accessUnavailable: false,
      settledAt: null,
    }).pipe(Atom.keepAlive),
  );
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:workloads:list",
    tag: WS_METHODS.workloadsList,
    refreshIntervalMs: 3_000,
    staleTimeMs: 0,
    idleTtlMs: 0,
    refreshTrigger: ({ environmentId }) => refreshSignal(environmentId),
  });
  const scheduler = createAtomCommandScheduler();
  const commandOptions = {
    scheduler,
    concurrency: {
      mode: "serial" as const,
      key: ({
        environmentId,
        input,
      }: {
        environmentId: EnvironmentId;
        input: WorkloadControlInput;
      }) => `${environmentId}:${input.recordId}`,
    },
    onSettled: (
      { environmentId }: { environmentId: EnvironmentId },
      registry: Parameters<typeof refreshEnvironment>[0],
    ) => Effect.sync(() => refreshEnvironment(registry, environmentId)),
  };
  function refreshEnvironment(
    registry: import("effect/reactivity/AtomRegistry").AtomRegistry,
    environmentId: EnvironmentId,
  ) {
    registry.update(refreshSignal(environmentId), (value) => value + 1);
  }
  return {
    list,
    sessions: createEnvironmentSessionAtoms(runtime),
    deniedSession,
    controlState: (environmentId: EnvironmentId, recordId: string) =>
      controlState(`${environmentId}:${recordId}`),
    refreshEnvironment,
    refreshSignal,
    start: createEnvironmentRpcCommand(runtime, {
      ...commandOptions,
      label: "workloads:start",
      tag: WS_METHODS.workloadsStart,
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      ...commandOptions,
      label: "workloads:stop",
      tag: WS_METHODS.workloadsStop,
    }),
  };
}

const isEnvironmentAuthorizationError = Schema.is(EnvironmentAuthorizationError);

const workloadEnvironment = createWorkloadAtoms(connectionAtomRuntime);
export const WorkloadStateContext =
  createContext<ReturnType<typeof createWorkloadAtoms>>(workloadEnvironment);

const sessionAccessKey = (session: AuthSessionState) =>
  JSON.stringify([
    session.authenticated,
    session.scopes?.toSorted() ?? null,
    session.permissions?.toSorted() ?? null,
  ]);

const subscribeVisibility = (change: () => void) => {
  document.addEventListener("visibilitychange", change);
  return () => document.removeEventListener("visibilitychange", change);
};

export function useWorkloadQuery(
  environmentId: EnvironmentId,
  input: WorkloadListInput,
  visible: boolean,
) {
  const state = useContext(WorkloadStateContext);
  const registry = useContext(RegistryContext);
  const documentVisible = useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== "hidden",
    () => false,
  );
  const sessionResult = useAtomValue(state.sessions.sessionStateAtom(environmentId));
  const session = Option.getOrNull(AsyncResult.value(sessionResult));
  const canRead =
    sessionResult._tag !== "Failure" &&
    session !== null &&
    sessionGrantsScope(session, AuthDiagnosticsReadScope);
  const deniedSession = useAtomValue(state.deniedSession(environmentId));
  const accessDenied = session !== null && deniedSession === sessionAccessKey(session);
  const active = visible && documentVisible && canRead && !accessDenied;
  const target = state.list({ environmentId, input });
  const query = useEnvironmentQuery(active ? target : null);
  const [retained, setRetained] = useState<{
    environmentId: EnvironmentId;
    threadId: WorkloadListInput["threadId"];
    query: typeof query;
  } | null>(null);
  if (active && query.data !== null && retained?.query.data !== query.data)
    setRetained({ environmentId, threadId: input.threadId, query });
  useEffect(() => {
    if (isEnvironmentAuthorizationError(query.failure) && session !== null) {
      registry.set(state.deniedSession(environmentId), sessionAccessKey(session));
    }
  }, [environmentId, query.failure, registry, session, state]);
  const refresh = useCallback(() => {
    registry.set(state.deniedSession(environmentId), null);
    registry.refresh(target);
  }, [environmentId, registry, state, target]);
  const shown = active
    ? query
    : retained?.environmentId === environmentId && retained.threadId === input.threadId
      ? retained.query
      : query;
  return {
    ...shown,
    data: canRead && !accessDenied ? shown.data : null,
    refresh,
    canRead,
    accessDenied,
    active,
    fresh: active && query.isSuccess && !query.isPending,
  };
}

/** One pending operation per environment/record, shared by Hosts and thread views. */
export function useWorkloadControl(environmentId: EnvironmentId, recordId: string) {
  const state = useContext(WorkloadStateContext);
  const registry = useContext(RegistryContext);
  const atom = state.controlState(environmentId, recordId);
  const current = useAtomValue(atom);
  const canStart = useAtomValue(state.start.permissionAtom(environmentId));
  const canStop = useAtomValue(state.stop.permissionAtom(environmentId));
  const start = useAtomCommand(state.start, { reportFailure: false, reportDefect: false });
  const stop = useAtomCommand(state.stop, { reportFailure: false, reportDefect: false });
  const run = useCallback(
    async (operation: "start" | "stop", input: WorkloadControlInput) => {
      if (registry.get(atom).pending !== null) return;
      const refreshBefore = registry.get(state.refreshSignal(environmentId));
      registry.set(atom, {
        pending: operation,
        result: null,
        unknownOutcome: false,
        accessUnavailable: false,
        settledAt: null,
      });
      try {
        const reply = await (operation === "start" ? start : stop)({ environmentId, input });
        const accessUnavailable =
          reply._tag === "Failure" &&
          isEnvironmentAuthorizationError(squashAtomCommandFailure(reply));
        registry.set(atom, {
          pending: null,
          result: reply._tag === "Success" ? reply.value : null,
          unknownOutcome:
            !accessUnavailable && (reply._tag !== "Success" || isAtomCommandInterrupted(reply)),
          accessUnavailable,
          settledAt: Date.now(),
        });
      } catch {
        registry.set(atom, {
          pending: null,
          result: null,
          unknownOutcome: true,
          accessUnavailable: false,
          settledAt: Date.now(),
        });
      } finally {
        // Unknown transport outcomes are observed too. A mutation is never replayed automatically.
        if (registry.get(state.refreshSignal(environmentId)) === refreshBefore)
          state.refreshEnvironment(registry, environmentId);
      }
    },
    [atom, environmentId, registry, start, state, stop],
  );
  return { ...current, canStart, canStop, run };
}
