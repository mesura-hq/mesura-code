import { subscribe } from "@t3tools/client-runtime/rpc";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  followStreamInEnvironment,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type FileManagerEvent,
  type FileManagerStreamItem,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, type AtomRegistry } from "effect/unstable/reactivity";

import type {
  FileManagerSession,
  FileManagerTransport,
} from "~/components/files/mesuraFileManager/wsBridge";
import { appAtomRegistry } from "~/rpc/atomRegistry";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * The file manager's four RPCs, on the connection runtime.
 *
 * Pushes are the one thing not read from an atom's value: a stream atom keeps
 * the last element of each chunk, and a `changed` burst must reach the file
 * manager whole. The events atom therefore runs the stream to a callback and
 * carries nothing itself; subscribing to it is what keeps the session open,
 * exactly as the file panel's watch atom keeps its server watcher alive.
 */

export const fileManagerHost = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:file-manager:host",
  tag: WS_METHODS.fileManagerHost,
  staleTimeMs: 60 * 60_000,
});

const fileManagerQuery = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:file-manager:query",
  tag: WS_METHODS.fileManagerQuery,
});

const fileManagerMutate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:file-manager:mutate",
  tag: WS_METHODS.fileManagerMutate,
});

/** What one open session's stream feeds. */
export interface SessionSink {
  readonly onItem: (item: FileManagerStreamItem) => void;
}

/**
 * The sinks of the open sessions, by key. Registered before the stream starts
 * and released after it stops, so no item can arrive without a home; an item
 * for a key nobody holds is dropped.
 */
export function createSessionSinks() {
  const sinks = new Map<string, SessionSink>();
  return {
    register(key: string, sink: SessionSink): void {
      sinks.set(key, sink);
    },
    deliver(key: string, item: FileManagerStreamItem): void {
      sinks.get(key)?.onItem(item);
    },
    release(key: string): void {
      sinks.delete(key);
    },
    get size(): number {
      return sinks.size;
    },
  };
}

const sessionSinks = createSessionSinks();

export const sessionKey = (environmentId: EnvironmentId, sessionId: string) =>
  JSON.stringify([environmentId, sessionId]);

const fileManagerEvents = Atom.family((key: string) => {
  const [environmentId, sessionId] = JSON.parse(key) as [EnvironmentId, string];
  return connectionAtomRuntime
    .atom(
      Stream.runForEach(
        followStreamInEnvironment(
          environmentId,
          subscribe(WS_METHODS.fileManagerSubscribeEvents, { sessionId }),
        ),
        (item) => Effect.sync(() => sessionSinks.deliver(key, item)),
      ),
    )
    .pipe(Atom.withLabel(`environment-data:file-manager:events:${key}`));
});

/**
 * Turn a stream's items into the bridge's session: the ready marker settles
 * `ready`, events go to `onEvent`, and a failure of the atom is reported
 * once — as a rejection of `ready` when it comes first, through `onLost`
 * afterwards.
 */
export function followSession(
  subscribeToStream: (onItem: (item: FileManagerStreamItem) => void) => {
    readonly onFailure: (report: (cause: unknown) => void) => void;
    readonly stop: () => void;
  },
  onEvent: (event: FileManagerEvent) => void,
  onLost: (cause: unknown) => void,
): FileManagerSession {
  let opened = false;
  let settle: { resolve: () => void; reject: (cause: unknown) => void } | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const following = subscribeToStream((item) => {
    if ("ready" in item) {
      opened = true;
      settle?.resolve();
      return;
    }
    onEvent(item);
  });
  following.onFailure((cause) => {
    if (opened) onLost(cause);
    else settle?.reject(cause);
  });
  return { ready, stop: following.stop };
}

/**
 * Subscribe to an atom and compute it now.
 *
 * A runtime atom's effect starts on the atom's first read, and a plain
 * `registry.subscribe` never reads: it only asks to be told of changes. The
 * events atom below has nothing to change until its stream runs, so a plain
 * subscription left the session never opened, every bridge call waiting on a
 * readiness that could not come, and the columns empty with no error
 * anywhere. `immediate` is the read.
 */
export function watchAtom<A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<A>,
  onValue: (value: A) => void,
): () => void {
  return registry.subscribe(atom, onValue, { immediate: true });
}

/** The bridge's transport for one environment, over the application's atom registry. */
export function createFileManagerTransport(
  environmentId: EnvironmentId,
  registry: AtomRegistry.AtomRegistry = appAtomRegistry,
): FileManagerTransport {
  return {
    query: async (input) => {
      const result = await runAtomCommand(registry, fileManagerQuery, { environmentId, input });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value;
    },
    mutate: async (input) => {
      const result = await runAtomCommand(registry, fileManagerMutate, { environmentId, input });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value;
    },
    events: (sessionId, onEvent, onLost) => {
      const key = sessionKey(environmentId, sessionId);
      const atom = fileManagerEvents(key);
      return followSession(
        (onItem) => {
          sessionSinks.register(key, { onItem });
          let report: (cause: unknown) => void = () => undefined;
          // The atom settles only when the stream ends or fails; a settled
          // failure is the one signal that pushes have stopped.
          const unsubscribe = watchAtom(registry, atom, (result) => {
            if (AsyncResult.isFailure(result)) report(squashAtomCommandFailure(result));
          });
          return {
            onFailure: (next) => {
              report = next;
            },
            stop: () => {
              unsubscribe();
              sessionSinks.release(key);
            },
          };
        },
        onEvent,
        onLost,
      );
    },
  };
}
