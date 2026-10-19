/**
 * The modal editor's key path, mounted for real down to the RPC session.
 *
 * What is real: `useNvimFileEditor` and `useNvimDriver` under React, the
 * `editorSession*` commands and their schedulers, `useAtomCommand`, the
 * environment command and subscription plumbing in `client-runtime`, and
 * `NvimStatusStrip`, rendered the way `MonacoFileSurface` renders it.
 *
 * What is replaced, and nothing else:
 * - `connectionAtomRuntime`: an atom runtime whose `EnvironmentRegistry`
 *   hands every call the fake supervisor below. Its RPC session answers
 *   `editorSession.*` from a log the test controls, so a request's reply,
 *   failure and timing are the test's to decide. A disconnect sets the
 *   supervisor's session to `None`, as the real supervisor does, and fails
 *   the requests in flight with a transport `RpcClientError`.
 * - the Monaco editor: an object that hands out `onKeyDown` and answers every
 *   other call with a disposable. `model` is null, so the driver's text and
 *   cursor effects never run; the keys effect needs only the editor.
 * - `monaco-editor` itself (see `mockMonacoEditor`) and the keybindings atom.
 *
 * Wire it up in the test file, before the imports that load the editor:
 *
 * ```ts
 * const harness = vi.hoisted(() => () => import("~/test/nvimEditorHarness"));
 * vi.mock("~/connection/runtime", async () => (await harness()).mockConnectionRuntime());
 * vi.mock("~/state/server", async () => (await harness()).mockServerState());
 * vi.mock("monaco-editor", async () => (await harness()).mockMonacoEditor());
 * ```
 */
import { RegistryContext } from "@effect/atom-react";
import {
  EditorSessionInputLostError,
  EditorSessionRpcError,
  EnvironmentId,
  ThreadId,
  WS_METHODS,
  type EditorSessionEvent,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  EnvironmentRegistry,
  EnvironmentSupervisor,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";
import * as RpcClientError from "effect/rpc/RpcClientError";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

export const HARNESS_ENVIRONMENT_ID = EnvironmentId.make("nvim-harness-environment");
const HARNESS_THREAD_ID = ThreadId.make("nvim-harness-thread");
export const HARNESS_RELATIVE_PATH = "notes.txt";
/** The contract's bound on `editorSession.input`'s `keys`. */
export const INPUT_KEYS_LIMIT = 1024;

/** One request the fake server received, in arrival order. */
interface HarnessRequest {
  readonly method: "input" | "setCursor" | "replaceText" | "viewport" | "open";
  readonly threadId: string;
  /** The keys, for `input`; `line:col`, for `setCursor`. */
  readonly payload: string;
  readonly settled: boolean;
}

type Reply =
  | { readonly kind: "ok" }
  | { readonly kind: "server-error" }
  | { readonly kind: "input-lost" }
  | { readonly kind: "disconnect" };

/** How a request can fail: the server's answer, or the socket going away. */
type HarnessReplyError =
  | EditorSessionRpcError
  | EditorSessionInputLostError
  | RpcClientError.RpcClientError;

interface PendingRequest extends HarnessRequest {
  settled: boolean;
  readonly reply: Deferred.Deferred<void, HarnessReplyError>;
}

function makeTransport() {
  const requests: PendingRequest[] = [];
  /** What Neovim was given, in order: every `input` and `setCursor` the server accepted. */
  const applied: Array<{ readonly method: string; readonly payload: string }> = [];
  let autoReply = true;
  let maxInFlightInputs = 0;
  let maxInFlightKeyLane = 0;
  let waiters: Array<() => void> = [];

  const notify = () => {
    const current = waiters;
    waiters = [];
    for (const waiter of current) waiter();
  };

  const inFlightInputs = () =>
    requests.filter((request) => request.method === "input" && !request.settled).length;

  /** The calls that share the key lane: each one changes what the next key means. */
  const inFlightKeyLane = () =>
    requests.filter(
      (request) =>
        (request.method === "input" ||
          request.method === "setCursor" ||
          request.method === "replaceText") &&
        !request.settled,
    ).length;

  const settle = (request: PendingRequest, reply: Reply) => {
    if (request.settled) return;
    request.settled = true;
    if (reply.kind === "ok") {
      if (request.method === "input" || request.method === "setCursor") {
        applied.push({ method: request.method, payload: request.payload });
      }
      Deferred.doneUnsafe(request.reply, Effect.void);
    } else if (reply.kind === "server-error") {
      Deferred.doneUnsafe(
        request.reply,
        Effect.fail(
          new EditorSessionRpcError({
            threadId: request.threadId,
            method: "nvim_input",
            detail: "the harness refused the call",
          }),
        ),
      );
    } else if (reply.kind === "input-lost") {
      Deferred.doneUnsafe(
        request.reply,
        Effect.fail(
          new EditorSessionInputLostError({
            threadId: request.threadId,
            detail: "the harness restarted Neovim after it took these keys",
          }),
        ),
      );
    } else {
      Deferred.doneUnsafe(
        request.reply,
        Effect.fail(
          new RpcClientError.RpcClientError({
            reason: new RpcClientError.RpcClientDefect({
              message: "The harness closed the socket.",
              cause: null,
            }),
          }),
        ),
      );
    }
    notify();
  };

  const receive = (method: HarnessRequest["method"], threadId: string, payload: string) =>
    Effect.gen(function* () {
      const reply = yield* Deferred.make<void, HarnessReplyError>();
      const request: PendingRequest = { method, threadId, payload, settled: false, reply };
      requests.push(request);
      maxInFlightInputs = Math.max(maxInFlightInputs, inFlightInputs());
      maxInFlightKeyLane = Math.max(maxInFlightKeyLane, inFlightKeyLane());
      notify();
      // The server rejects what the contract would reject, so an oversized
      // batch cannot pass by reaching a fake that does not check.
      if (method === "input" && payload.length > INPUT_KEYS_LIMIT) {
        settle(request, { kind: "server-error" });
      } else if (autoReply || method === "viewport" || method === "open") {
        settle(request, { kind: "ok" });
      }
      return yield* Deferred.await(reply);
    });

  /** Every attachment opens with a snapshot of the harness file, as the server's does. */
  const snapshot: EditorSessionEvent = {
    type: "snapshot",
    snapshot: {
      relativePath: HARNESS_RELATIVE_PATH,
      lines: [""],
      cursor: { line: 1, col: 1 },
      mode: "n",
      jumping: false,
      topline: 1,
      hlDefs: {},
    },
  };
  const attach = () => Stream.concat(Stream.make(snapshot), Stream.never);

  const makeSession = (): RpcSession =>
    ({
      client: {
        [WS_METHODS.editorSessionAttach]: attach,
        [WS_METHODS.editorSessionOpen]: (input: { threadId: string; relativePath: string }) =>
          receive("open", input.threadId, input.relativePath).pipe(
            Effect.as({
              relativePath: input.relativePath,
              lines: [""],
              cursor: { line: 1, col: 1 },
              mode: "n",
              jumping: false,
              topline: 1,
              hlDefs: {},
            }),
          ),
        [WS_METHODS.editorSessionInput]: (input: { threadId: string; keys: string }) =>
          receive("input", input.threadId, input.keys),
        [WS_METHODS.editorSessionSetCursor]: (input: {
          threadId: string;
          line: number;
          col: number;
        }) => receive("setCursor", input.threadId, `${input.line}:${input.col}`),
        [WS_METHODS.editorSessionViewport]: (input: { threadId: string }) =>
          receive("viewport", input.threadId, ""),
        [WS_METHODS.editorSessionReplaceText]: (input: { threadId: string }) =>
          receive("replaceText", input.threadId, ""),
      },
    }) as unknown as RpcSession;

  const connectedState: SupervisorConnectionState = {
    desired: true,
    network: "online",
    phase: "connected",
    stage: null,
    attempt: 0,
    generation: 1,
    lastFailure: null,
    retryAt: null,
  };

  const sessionRef = Effect.runSync(SubscriptionRef.make(Option.some(makeSession())));
  const stateRef = Effect.runSync(SubscriptionRef.make(connectedState));
  const preparedRef = Effect.runSync(SubscriptionRef.make(Option.none()));

  const supervisor = {
    target: { environmentId: HARNESS_ENVIRONMENT_ID, label: "Harness host" },
    session: sessionRef,
    state: stateRef,
    prepared: preparedRef,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"];

  const provideStream = <A, E, R>(_environmentId: EnvironmentId, stream: Stream.Stream<A, E, R>) =>
    Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const registryService = {
    run: <A, E, R>(_environmentId: EnvironmentId, effect: Effect.Effect<A, E, R>) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    runStream: provideStream,
    followStream: provideStream,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"];

  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registryService),
  );

  return {
    runtime,
    requests: requests as ReadonlyArray<HarnessRequest>,
    applied: applied as ReadonlyArray<{ readonly method: string; readonly payload: string }>,
    /** The `input` requests only, in arrival order. */
    inputs: () => requests.filter((request) => request.method === "input"),
    inFlightInputs,
    get maxInFlightInputs() {
      return maxInFlightInputs;
    },
    /** The most `input`, `setCursor` and `replaceText` calls in flight at once. */
    get maxInFlightKeyLane() {
      return maxInFlightKeyLane;
    },
    /** The keys Neovim was given, concatenated in the order it was given them. */
    appliedKeys: () =>
      applied
        .filter((entry) => entry.method === "input")
        .map((entry) => entry.payload)
        .join(""),
    /** Hold every `input`/`setCursor`/`replaceText` request until the test answers it. */
    holdReplies: () => {
      autoReply = false;
    },
    /** Answer every request at once, now and from here on. */
    autoReplyAll: () => {
      autoReply = true;
      for (const request of requests) settle(request, { kind: "ok" });
    },
    /** Answers the oldest unanswered request that matches. */
    replyNext: (reply: Reply, method: HarnessRequest["method"] = "input") => {
      const request = requests.find(
        (candidate) => candidate.method === method && !candidate.settled,
      );
      if (request === undefined) throw new Error(`no ${method} request is waiting for a reply`);
      settle(request, reply);
    },
    /** The socket closes: the session goes away and every request in flight fails. */
    disconnect: () => {
      Effect.runSync(SubscriptionRef.set(sessionRef, Option.none()));
      const backoff: SupervisorConnectionState = { ...connectedState, phase: "backoff" };
      Effect.runSync(SubscriptionRef.set(stateRef, backoff));
      for (const request of requests) settle(request, { kind: "disconnect" });
    },
    /** A new socket, and a new session on it, as the supervisor's reconnect produces. */
    reconnect: () => {
      Effect.runSync(SubscriptionRef.set(sessionRef, Option.some(makeSession())));
      const reconnected: SupervisorConnectionState = { ...connectedState, generation: 2 };
      Effect.runSync(SubscriptionRef.set(stateRef, reconnected));
    },
    /** Resolves once `predicate` holds, re-checked after every request event. */
    waitUntil: (predicate: () => boolean) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (predicate()) resolve();
          else waiters.push(check);
        };
        check();
      }),
    reset: () => {
      requests.length = 0;
      applied.length = 0;
      autoReply = true;
      maxInFlightInputs = 0;
      maxInFlightKeyLane = 0;
      waiters = [];
      Effect.runSync(SubscriptionRef.set(sessionRef, Option.some(makeSession())));
      Effect.runSync(SubscriptionRef.set(stateRef, connectedState));
    },
  };
}

/** The one transport, shared by the mocked runtime and the test that drives it. */
export const editorTransport = makeTransport();

export function mockConnectionRuntime() {
  return { connectionAtomRuntime: editorTransport.runtime };
}

export function mockServerState() {
  return { primaryServerKeybindingsAtom: Atom.make([]) };
}

/** Enough of `monaco-editor` for a driver whose model is null. */
export function mockMonacoEditor() {
  const enumLike = new Proxy({}, { get: (_target, property) => String(property) });
  return {
    Uri: {
      parse: (value: string) => ({ toString: () => value }),
    },
    editor: {
      EditorOption: enumLike,
      ScrollType: enumLike,
      ContentWidgetPositionPreference: enumLike,
      TrackedRangeStickiness: enumLike,
    },
  };
}

interface FakeCursorEvent {
  readonly source: string;
  readonly position: { readonly lineNumber: number; readonly column: number };
}

/** A Monaco editor that only knows how to deliver a keydown and a mouse click. */
function makeFakeEditor() {
  let keyListener: ((event: { browserEvent: KeyboardEvent }) => void) | undefined;
  let cursorListener: ((event: FakeCursorEvent) => void) | undefined;
  const container = document.createElement("div");
  const disposable = { dispose: () => {} };
  const editor = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === "then") return undefined;
        if (property === "onKeyDown") {
          return (listener: (event: { browserEvent: KeyboardEvent }) => void) => {
            keyListener = listener;
            return {
              dispose: () => {
                if (keyListener === listener) keyListener = undefined;
              },
            };
          };
        }
        if (property === "onDidChangeCursorPosition") {
          return (listener: (event: FakeCursorEvent) => void) => {
            cursorListener = listener;
            return {
              dispose: () => {
                if (cursorListener === listener) cursorListener = undefined;
              },
            };
          };
        }
        if (property === "getContainerDomNode") return () => container;
        if (property === "getOption") {
          return () => ({ fontFamily: "monospace", fontSize: 12, lineHeight: 18 });
        }
        if (property === "getPosition") return () => null;
        if (property === "getVisibleRanges") return () => [];
        if (property === "createDecorationsCollection") {
          return () => ({ set: () => {}, clear: () => {}, append: () => [] });
        }
        return () => disposable;
      },
    },
  );
  return {
    editor,
    /** Delivers one keydown the way Monaco's `onKeyDown` does. */
    press: (init: KeyboardEventInit) => {
      if (keyListener === undefined) throw new Error("the driver is not listening for keys");
      keyListener({ browserEvent: new KeyboardEvent("keydown", { cancelable: true, ...init }) });
    },
    /** Moves the caret with the mouse, the one cursor move the client sends. */
    click: (lineNumber: number, column: number) => {
      if (cursorListener === undefined) throw new Error("the driver is not listening for clicks");
      cursorListener({ source: "mouse", position: { lineNumber, column } });
    },
  };
}

/** `KeyboardEventInit` for a printable character on a US layout. */
export function printable(character: string): KeyboardEventInit {
  const letter = /^[a-z]$/i.test(character);
  return {
    key: character,
    code: letter ? `Key${character.toUpperCase()}` : "",
    shiftKey: letter && character !== character.toLowerCase(),
  };
}

export const ESCAPE: KeyboardEventInit = { key: "Escape", code: "Escape", keyCode: 27 };

/**
 * Mounts `useNvimFileEditor` the way `MonacoFileSurface` does, with the status
 * strip under it, and returns what a test drives and reads.
 */
export async function mountNvimEditor(options: {
  readonly renderEditor: (editor: unknown) => ReactNode;
}) {
  const registry = AtomRegistry.make();
  const container = document.createElement("div");
  document.body.append(container);
  const fake = makeFakeEditor();
  let root: Root | undefined;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <RegistryContext.Provider value={registry}>
        {options.renderEditor(fake.editor)}
      </RegistryContext.Provider>,
    );
  });
  await flushHarness();
  return {
    registry,
    container,
    press: async (init: KeyboardEventInit) => {
      await act(async () => fake.press(init));
    },
    click: async (lineNumber: number, column: number) => {
      await act(async () => fake.click(lineNumber, column));
    },
    unmount: async () => {
      await act(async () => root?.unmount());
      container.remove();
      registry.dispose();
    },
  };
}

/** Lets promises, effects and React commits run. No clock is involved. */
export async function flushHarness(rounds = 5): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/**
 * Lets the harness run until `predicate` holds, and fails with `what` if it
 * never does. Bounded by turns of the event loop, not by a clock, so a red
 * run fails at once instead of waiting out the test timeout.
 */
export async function settleUntil(predicate: () => boolean, what: string): Promise<void> {
  for (let round = 0; round < 200; round += 1) {
    if (predicate()) return;
    await flushHarness(1);
  }
  if (predicate()) return;
  const seen = editorTransport.requests
    .map((request) => `${request.method}(${JSON.stringify(request.payload)})`)
    .join(", ");
  throw new Error(`never happened: ${what}. Requests the server saw: [${seen}]`);
}

export const harnessThreadRef: ScopedThreadRef = {
  environmentId: HARNESS_ENVIRONMENT_ID,
  threadId: HARNESS_THREAD_ID,
};
