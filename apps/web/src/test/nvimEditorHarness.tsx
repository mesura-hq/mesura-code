import { flushBrowserTasks } from "./browserTasks";
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
 *   cursor effects never run; the keys effect needs only the editor. Given a
 *   `layout`, the editor also lays out a model with word wrap on
 *   (`makeHarnessModel`), so the text, cursor and viewport effects run against
 *   an editor that scrolls, reveals and reports its visible lines as Monaco's
 *   does — see `makeFakeEditor`.
 * - `monaco-editor` itself (see `mockMonacoEditor`) and the keybindings atom.
 *
 * `mountMonacoFileSurface` goes one level up: it mounts `MonacoFileSurface`
 * itself, with its dismissal installed, on an editor whose keys arrive through
 * the DOM — see there.
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
  type EditorSessionInputResult,
  type EditorSessionSnapshot,
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
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";
import * as RpcClientError from "effect/rpc/RpcClientError";
import type { ReactNode } from "react";
import { expect, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

export const HARNESS_ENVIRONMENT_ID = EnvironmentId.make("nvim-harness-environment");
const HARNESS_THREAD_ID = ThreadId.make("nvim-harness-thread");
export const HARNESS_RELATIVE_PATH = "notes.txt";
/** The contract's bound on `editorSession.input`'s `keys`. */
export const INPUT_KEYS_LIMIT = 1024;

/** One request the fake server received, in arrival order. */
interface HarnessRequest {
  readonly method: "input" | "setCursor" | "replaceText" | "viewport" | "open";
  readonly threadId: string;
  /** The keys, for `input`; `line:col`, for `setCursor`; `topline:rows:cols`, for `viewport`. */
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
  /** Settles with where Neovim is at that moment: what an `input` answers. */
  readonly reply: Deferred.Deferred<EditorSessionInputResult | undefined, HarnessReplyError>;
}

function makeTransport() {
  const requests: PendingRequest[] = [];
  /** What Neovim was given, in order: every `input` and `setCursor` the server accepted. */
  const applied: Array<{ readonly method: string; readonly payload: string }> = [];
  let autoReply = true;
  /** While set, `open` waits for `replyNext(reply, "open")` instead of answering at once. */
  let opensHeld = false;
  let maxInFlightInputs = 0;
  let maxInFlightKeyLane = 0;
  let waiters: Array<() => void> = [];
  const RESTING_IN_NORMAL: EditorSessionInputResult = {
    mode: "n",
    blocking: false,
    jumping: false,
  };
  /** What an `input` answers when it settles: where the test says Neovim is. */
  let neovimMode: EditorSessionInputResult | undefined = RESTING_IN_NORMAL;

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
      Deferred.doneUnsafe(request.reply, Effect.succeed(neovimMode));
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
      const reply = yield* Deferred.make<EditorSessionInputResult | undefined, HarnessReplyError>();
      const request: PendingRequest = { method, threadId, payload, settled: false, reply };
      requests.push(request);
      maxInFlightInputs = Math.max(maxInFlightInputs, inFlightInputs());
      maxInFlightKeyLane = Math.max(maxInFlightKeyLane, inFlightKeyLane());
      notify();
      // The server rejects what the contract would reject, so an oversized
      // batch cannot pass by reaching a fake that does not check.
      if (method === "input" && payload.length > INPUT_KEYS_LIMIT) {
        settle(request, { kind: "server-error" });
      } else if (method === "open" ? !opensHeld : autoReply || method === "viewport") {
        settle(request, { kind: "ok" });
      }
      return yield* Deferred.await(reply);
    });

  /** What the harness file holds, as every attachment's snapshot and every `open` reply say. */
  const DEFAULT_SNAPSHOT: EditorSessionSnapshot = {
    relativePath: HARNESS_RELATIVE_PATH,
    lines: [""],
    cursor: { line: 1, col: 1 },
    mode: "n",
    jumping: false,
    topline: 1,
    hlDefs: {},
  };
  let snapshot = DEFAULT_SNAPSHOT;
  /** The lines every `open` handed Neovim, in order. */
  const openedLines: Array<ReadonlyArray<string>> = [];
  /** While set, an attachment opens with no snapshot: Neovim has not answered yet. */
  let snapshotHeld = false;
  /** One queue per live attachment, fed by `emit`. */
  const attachments = new Set<Queue.Queue<EditorSessionEvent>>();
  const attach = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<EditorSessionEvent>();
        attachments.add(queue);
        const opening: ReadonlyArray<EditorSessionEvent> = snapshotHeld
          ? []
          : [{ type: "snapshot", snapshot }];
        return Stream.concat(Stream.fromIterable(opening), Stream.fromQueue(queue)).pipe(
          Stream.ensuring(Effect.sync(() => attachments.delete(queue))),
        );
      }),
    );

  const makeSession = (): RpcSession =>
    ({
      client: {
        [WS_METHODS.editorSessionAttach]: attach,
        [WS_METHODS.editorSessionOpen]: (input: {
          threadId: string;
          relativePath: string;
          lines: ReadonlyArray<string>;
        }) => {
          openedLines.push(input.lines);
          // As the server does: the file opens with the text the client handed
          // over, and every attachment hears a snapshot of it before the open
          // answers, with the escape state an `input` answers too.
          return receive("open", input.threadId, input.relativePath).pipe(
            Effect.map((escape) => {
              const opened = { ...snapshot, relativePath: input.relativePath, lines: input.lines };
              // The session now holds this text: a later attachment sees it.
              snapshot = opened;
              for (const queue of attachments) {
                Queue.offerUnsafe(queue, { type: "snapshot", snapshot: opened });
              }
              return { ...opened, ...(escape === undefined ? {} : { escape }) };
            }),
          );
        },
        // Answers where Neovim was when the reply settled, not when the
        // request arrived: once it has consumed the keys.
        [WS_METHODS.editorSessionInput]: (input: { threadId: string; keys: string }) =>
          receive("input", input.threadId, input.keys),
        [WS_METHODS.editorSessionSetCursor]: (input: {
          threadId: string;
          line: number;
          col: number;
        }) => receive("setCursor", input.threadId, `${input.line}:${input.col}`),
        [WS_METHODS.editorSessionViewport]: (input: {
          threadId: string;
          topline: number;
          rows: number;
          cols: number;
        }) => receive("viewport", input.threadId, `${input.topline}:${input.rows}:${input.cols}`),
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
    /** The `viewport` requests, in arrival order, as `{ topline, rows, cols }`. */
    viewports: () =>
      requests
        .filter((request) => request.method === "viewport")
        .map((request) => {
          const [topline = 0, rows = 0, cols = 0] = request.payload.split(":").map(Number);
          return { topline, rows, cols };
        }),
    /** The lines every `open` handed Neovim, in order: the text the client had. */
    openedLines: () => openedLines as ReadonlyArray<ReadonlyArray<string>>,
    /** What the next attachment's snapshot says the file holds. */
    setSnapshot: (next: Partial<EditorSessionSnapshot>) => {
      snapshot = { ...snapshot, ...next };
    },
    /** Where Neovim is from here on, as every `input` that settles answers. */
    setNeovimMode: (next: Partial<EditorSessionInputResult>) => {
      neovimMode = { ...RESTING_IN_NORMAL, ...next };
    },
    /** Every `input` from here on answers nothing, as a host from before answers carried the mode. */
    answerLikeAnOlderHost: () => {
      neovimMode = undefined;
    },
    /** Attachments made from here on open without their snapshot: Neovim has not answered. */
    holdSnapshot: () => {
      snapshotHeld = true;
    },
    /** Sends events down every live attachment, as Neovim's drawing would. */
    emit: (...events: ReadonlyArray<EditorSessionEvent>) => {
      for (const queue of attachments) {
        for (const event of events) Queue.offerUnsafe(queue, event);
      }
    },
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
    /** Hold every `open` until the test answers it: Neovim has not answered yet. */
    holdOpens: () => {
      opensHeld = true;
    },
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
      openedLines.length = 0;
      snapshot = DEFAULT_SNAPSHOT;
      snapshotHeld = false;
      neovimMode = RESTING_IN_NORMAL;
      applied.length = 0;
      autoReply = true;
      opensHeld = false;
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

/**
 * What `monaco.editor.create` hands out under `mockMonacoEditor`. Set by
 * `mountMonacoFileSurface` for the one surface it mounts.
 */
let createSurfaceEditor: ((host: HTMLElement) => unknown) | null = null;

/**
 * Enough of `monaco-editor` for a driver whose model is null, and for
 * `MonacoFileSurface` to create its editor and apply its theme.
 */
export function mockMonacoEditor() {
  const enumLike = new Proxy({}, { get: (_target, property) => String(property) });
  class Range {
    constructor(
      readonly startLineNumber: number,
      readonly startColumn: number,
      readonly endLineNumber: number,
      readonly endColumn: number,
    ) {}
    static fromPositions(
      start: { lineNumber: number; column: number },
      end: { lineNumber: number; column: number } = start,
    ) {
      return new Range(start.lineNumber, start.column, end.lineNumber, end.column);
    }
  }
  return {
    Uri: {
      parse: (value: string) => ({ toString: () => value }),
    },
    Range,
    languages: { getLanguages: () => [] },
    editor: {
      EditorOption: enumLike,
      ScrollType: enumLike,
      ContentWidgetPositionPreference: enumLike,
      TrackedRangeStickiness: enumLike,
      create: (host: HTMLElement) => {
        if (createSurfaceEditor === null) {
          throw new Error("monaco.editor.create was called outside mountMonacoFileSurface");
        }
        return createSurfaceEditor(host);
      },
      defineTheme: () => {},
      setTheme: () => {},
    },
  };
}

interface FakeCursorEvent {
  readonly source: string;
  readonly position: { readonly lineNumber: number; readonly column: number };
}

/**
 * A text model over fixed lines, enough for the driver: the reads, the URI the
 * driver checks against the open path, and `applyEdits` for whole-line
 * replacements, which is what a snapshot that agrees with the model needs —
 * none.
 */
export function makeHarnessModel(lines: ReadonlyArray<string>, uri: string) {
  const content = [...lines];
  return {
    uri: { toString: () => uri },
    getLineCount: () => content.length,
    getLineContent: (lineNumber: number) => content[lineNumber - 1] ?? "",
    getLineMaxColumn: (lineNumber: number) => (content[lineNumber - 1] ?? "").length + 1,
    getLinesContent: () => [...content],
    getValue: () => content.join("\n"),
    onDidChangeContent: () => ({ dispose: () => {} }),
    applyEdits: (edits: ReadonlyArray<unknown>) => {
      if (edits.length > 0) throw new Error("the harness model takes no edits");
    },
    undo: () => {},
  };
}

export type HarnessModel = ReturnType<typeof makeHarnessModel>;

/**
 * A text model that takes edits, as Monaco's does: every edit in one
 * `applyEdits` call is placed against the text before the call, a column past
 * a line's end clamps to that end, and the content listeners hear the change
 * synchronously — which is what the driver's own-edit flag exists for.
 */
export function makeEditableHarnessModel(lines: ReadonlyArray<string>, uri: string) {
  let text = lines.join("\n");
  const listeners = new Set<(event: { changes: ReadonlyArray<unknown> }) => void>();
  const content = () => text.split("\n");
  const offsetOf = (lineNumber: number, column: number) => {
    const current = content();
    const line = Math.min(Math.max(1, lineNumber), current.length);
    let offset = 0;
    for (let index = 0; index < line - 1; index += 1) offset += (current[index] ?? "").length + 1;
    const length = (current[line - 1] ?? "").length;
    return offset + Math.min(Math.max(1, column), length + 1) - 1;
  };
  return {
    uri: { toString: () => uri },
    getLineCount: () => content().length,
    getLineContent: (lineNumber: number) => content()[lineNumber - 1] ?? "",
    getLineMaxColumn: (lineNumber: number) => (content()[lineNumber - 1] ?? "").length + 1,
    getLinesContent: () => content(),
    getValue: () => text,
    /** Monaco's offset to position, against the text as it is now. */
    getPositionAt: (offset: number) => {
      const before = text.slice(0, Math.max(0, Math.min(offset, text.length))).split("\n");
      return { lineNumber: before.length, column: (before.at(-1) ?? "").length + 1 };
    },
    onDidChangeContent: (listener: (event: { changes: ReadonlyArray<unknown> }) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    applyEdits: (
      edits: ReadonlyArray<{
        readonly range: {
          readonly startLineNumber: number;
          readonly startColumn: number;
          readonly endLineNumber: number;
          readonly endColumn: number;
        };
        readonly text: string;
      }>,
    ) => {
      const placed = edits
        .map((edit) => ({
          start: offsetOf(edit.range.startLineNumber, edit.range.startColumn),
          end: offsetOf(edit.range.endLineNumber, edit.range.endColumn),
          text: edit.text,
        }))
        .toSorted((left, right) => right.start - left.start);
      for (const edit of placed)
        text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
      const changes = placed.map((edit) => ({
        rangeOffset: edit.start,
        text: edit.text,
      }));
      for (const listener of listeners) listener({ changes });
    },
    undo: () => {},
  };
}

/** One call the driver made on the editor, stamped by `recordEditorCalls`. */
export interface RecordedEditorCall {
  readonly method: string;
  readonly args: ReadonlyArray<unknown>;
  /** What `stamp()` returned when the call was made. */
  readonly stamp: number;
}

/**
 * Wraps an editor so every method call is recorded, in order, with a stamp the
 * test supplies — a React commit count, say — and `afterCall` observers run
 * after each call returns.
 */
export function recordEditorCalls(editor: unknown, stamp: () => number = () => 0) {
  const calls: RecordedEditorCall[] = [];
  const afterCall = new Set<(stamp: number) => void>();
  const recorded = new Proxy(editor as object, {
    get: (target, property, receiver) => {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function" || typeof property !== "string") return value;
      return (...args: unknown[]) => {
        const at = stamp();
        calls.push({ method: property, args, stamp: at });
        const result = (value as (...inner: unknown[]) => unknown)(...args);
        for (const observe of afterCall) observe(at);
        return result;
      };
    },
  });
  return {
    editor: recorded,
    calls: calls as ReadonlyArray<RecordedEditorCall>,
    afterCall,
  };
}

/**
 * How the fake editor lays its model out: Monaco with word wrap on, every
 * line `ceil(length / wrapColumn)` rows of `lineHeight` pixels, in a viewport
 * `height` pixels tall.
 */
export interface HarnessLayout {
  readonly model: HarnessModel;
  readonly wrapColumn: number;
  readonly lineHeight: number;
  readonly height: number;
}

/** Monaco's layout arithmetic for `HarnessLayout`, in pixels. */
function wrappedLayout(layout: HarnessLayout) {
  const { model, wrapColumn, lineHeight, height } = layout;
  const rowsOf = (lineNumber: number) =>
    Math.max(1, Math.ceil(model.getLineContent(lineNumber).length / wrapColumn));
  const topOf = (lineNumber: number) => {
    let top = 0;
    for (let line = 1; line < lineNumber; line += 1) top += rowsOf(line) * lineHeight;
    return top;
  };
  /** The lines any part of which is inside `[scrollTop, scrollTop + height)`. */
  const visibleRange = (scrollTop: number) => {
    let first = 0;
    let last = 0;
    for (let line = 1; line <= model.getLineCount(); line += 1) {
      const top = topOf(line);
      const bottom = top + rowsOf(line) * lineHeight;
      if (bottom > scrollTop && top < scrollTop + height) {
        if (first === 0) first = line;
        last = line;
      }
    }
    return { startLineNumber: first, endLineNumber: last };
  };
  /** The top of the wrapped row that holds `column` of `lineNumber`. */
  const rowTopOf = (lineNumber: number, column: number) =>
    topOf(lineNumber) + Math.floor((column - 1) / wrapColumn) * lineHeight;
  return { topOf, visibleRange, rowTopOf };
}

/**
 * A Monaco editor that delivers a keydown and a mouse click, and, given a
 * layout, scrolls: `setScrollTop`, `revealPosition` (the smallest scroll that
 * shows the position, as `ScrollType.Immediate` does), `getVisibleRanges` and
 * `onDidScrollChange`, with the arithmetic of `wrappedLayout`.
 *
 * Given a `host`, the editor also lives in the DOM, as Monaco 0.56 does: a
 * focusable `native-edit-context` node inside the host holds the caret,
 * `focus` and `hasTextFocus` are about that node, and `onKeyDown` listens to
 * keydowns on it. A key then reaches the driver only if nothing earlier in the
 * event's path — the dismissal's capture listener on the document — stopped it.
 */
function makeFakeEditor(layout?: HarnessLayout, host?: HTMLElement) {
  let keyListener: ((event: { browserEvent: KeyboardEvent }) => void) | undefined;
  let cursorListener: ((event: FakeCursorEvent) => void) | undefined;
  const scrollListeners = new Set<() => void>();
  const container = document.createElement("div");
  const disposable = { dispose: () => {} };
  const arithmetic = layout === undefined ? null : wrappedLayout(layout);
  let scrollTop = 0;
  let position: { lineNumber: number; column: number } | null = null;
  const editContext = host === undefined ? null : document.createElement("div");
  if (editContext !== null && host !== undefined) {
    editContext.className = "native-edit-context";
    editContext.tabIndex = 0;
    host.append(editContext);
  }
  const inDom: Record<string, unknown> =
    editContext === null
      ? {}
      : {
          focus: () => editContext.focus(),
          hasTextFocus: () => document.activeElement === editContext,
          onKeyDown: (listener: (event: { browserEvent: KeyboardEvent }) => void) => {
            const onKeyDown = (browserEvent: KeyboardEvent) => listener({ browserEvent });
            editContext.addEventListener("keydown", onKeyDown);
            return { dispose: () => editContext.removeEventListener("keydown", onKeyDown) };
          },
        };

  const scrollTo = (top: number) => {
    const next = Math.max(0, top);
    if (next === scrollTop) return;
    scrollTop = next;
    for (const listener of scrollListeners) listener();
  };

  const scrolling: Record<string, unknown> =
    layout === undefined || arithmetic === null
      ? {}
      : {
          getModel: () => layout.model,
          getLayoutInfo: () => ({ height: layout.height, width: 1600 }),
          getScrollTop: () => scrollTop,
          setScrollTop: scrollTo,
          getTopForLineNumber: arithmetic.topOf,
          getTopForPosition: arithmetic.rowTopOf,
          getVisibleRanges: () => [arithmetic.visibleRange(scrollTop)],
          getPosition: () => position,
          setPosition: (next: { lineNumber: number; column: number }) => {
            position = next;
          },
          revealPosition: (target: { lineNumber: number; column: number }) => {
            const rowTop = arithmetic.rowTopOf(target.lineNumber, target.column);
            if (rowTop < scrollTop) scrollTo(rowTop);
            else if (rowTop + layout.lineHeight > scrollTop + layout.height) {
              scrollTo(rowTop + layout.lineHeight - layout.height);
            }
          },
          onDidScrollChange: (listener: () => void) => {
            scrollListeners.add(listener);
            return { dispose: () => scrollListeners.delete(listener) };
          },
        };

  const editor = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === "then") return undefined;
        if (typeof property === "string" && property in inDom) return inDom[property];
        if (typeof property === "string" && property in scrolling) return scrolling[property];
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
          return (option: unknown) =>
            option === "lineHeight" && layout !== undefined
              ? layout.lineHeight
              : { fontFamily: "monospace", fontSize: 12, lineHeight: 18 };
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
    /** The node that holds the caret, given a `host`. */
    editContext,
    /** The lines Monaco shows now, as `getVisibleRanges` reports them. */
    visibleRange: () => arithmetic?.visibleRange(scrollTop) ?? null,
    /** Whether the wrapped row holding `column` of `lineNumber` is in view. */
    showsPosition: (lineNumber: number, column: number) => {
      if (layout === undefined || arithmetic === null) return false;
      const rowTop = arithmetic.rowTopOf(lineNumber, column);
      return rowTop >= scrollTop && rowTop + layout.lineHeight <= scrollTop + layout.height;
    },
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
  readonly layout?: HarnessLayout;
}) {
  await using stack = new AsyncDisposableStack();
  const registry = AtomRegistry.make();
  stack.defer(() => registry.dispose());
  const fake = makeFakeEditor(options.layout);
  const screen = stack.use(
    await render(
      <RegistryContext.Provider value={registry}>
        {options.renderEditor(fake.editor)}
      </RegistryContext.Provider>,
    ),
  );
  await flushHarness();
  const lifetime = stack.move();
  return {
    registry,
    container: screen.container,
    press: async (init: KeyboardEventInit) => {
      await act(async () => fake.press(init));
    },
    visibleRange: fake.visibleRange,
    showsPosition: fake.showsPosition,
    click: async (lineNumber: number, column: number) => {
      await act(async () => fake.click(lineNumber, column));
    },
    unmount: () => lifetime.disposeAsync(),
    [Symbol.asyncDispose]: () => lifetime.disposeAsync(),
  };
}

/**
 * The model cache `MonacoFileSurface` takes as a prop, holding one model: the
 * layout's. Enough of `MonacoFileModels` for the surface to open the file.
 */
function makeSurfaceModels(model: HarnessModel) {
  return {
    acquire: () => ({ model, reused: false }),
    release: () => {},
    saveViewState: () => {},
    viewStateFor: () => null,
  };
}

/**
 * Mounts `MonacoFileSurface` — the file panel's editor, with its Neovim hook,
 * its status strip and its dismissal listeners — on an editor that lives in
 * the DOM (`makeFakeEditor` with a host) and lays out `layout`.
 *
 * Keys are typed the way a browser delivers them: `type` dispatches a keydown
 * on whatever element has focus, so the dismissal's capture listener on the
 * document sees it first, and the editor's own listener only if the dismissal
 * let it through. A key typed after focus left the editor lands on the body.
 *
 * `keysOutsideEditor` records every keydown that reached the document with its
 * target outside the editor and not taken by anyone (`defaultPrevented` false):
 * the keys the chat composer's type-to-focus would take
 * (`shouldRedirectInputToComposer` in `ChatView.tsx`).
 *
 * The test file mocks what the surface needs beyond the editor and the
 * session; see `MonacoFileSurface.escape.browser.test.tsx`.
 */
export async function mountMonacoFileSurface(options: {
  readonly layout: HarnessLayout;
  readonly renderSurface: (models: unknown) => ReactNode;
}) {
  await using stack = new AsyncDisposableStack();
  const registry = AtomRegistry.make();
  stack.defer(() => registry.dispose());
  const container = document.createElement("div");
  let fake: ReturnType<typeof makeFakeEditor> | null = null;
  createSurfaceEditor = (host) => {
    fake = makeFakeEditor(options.layout, host);
    return fake.editor;
  };
  stack.defer(() => {
    createSurfaceEditor = null;
  });
  const keysOutsideEditor: Array<string> = [];
  const recordKeyOutsideEditor = (event: KeyboardEvent) => {
    const host = container.querySelector("[data-monaco-file-surface]");
    const target = event.target instanceof Node ? event.target : null;
    if (event.defaultPrevented) return;
    if (host !== null && target !== null && host.contains(target)) return;
    keysOutsideEditor.push(event.key);
  };
  document.addEventListener("keydown", recordKeyOutsideEditor);
  stack.defer(() => document.removeEventListener("keydown", recordKeyOutsideEditor));
  const models = makeSurfaceModels(options.layout.model);
  stack.use(
    await render(
      <RegistryContext.Provider value={registry}>
        {options.renderSurface(models)}
      </RegistryContext.Provider>,
      { container },
    ),
  );
  await flushHarness();
  const lifetime = stack.move();
  const editContext = () => {
    const node = (fake as ReturnType<typeof makeFakeEditor> | null)?.editContext ?? null;
    if (node === null) throw new Error("the surface never created its editor");
    return node;
  };
  return {
    registry,
    container,
    /** Puts the caret in the editor, as a click on its text does. */
    focusEditor: async () => {
      await act(async () => editContext().focus());
    },
    /** Whether the editor holds the keyboard. */
    editorHasFocus: () => document.activeElement === editContext(),
    /** One keydown, dispatched on whatever has focus, as the browser does. */
    type: async (init: KeyboardEventInit) => {
      const target =
        document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
      await act(async () => {
        target.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
        );
      });
    },
    keysOutsideEditor: keysOutsideEditor as ReadonlyArray<string>,
    unmount: () => lifetime.disposeAsync(),
    [Symbol.asyncDispose]: () => lifetime.disposeAsync(),
  };
}

/** Drains browser tasks and React work without waiting for elapsed time. */
export async function flushHarness(rounds = 5): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await flushBrowserTasks();
    });
  }
}

/** Waits for an observable editor milestone through the browser runner. */
export async function settleUntil(predicate: () => boolean, what: string): Promise<void> {
  await vi.waitFor(() => {
    const seen = editorTransport.requests
      .map((request) => `${request.method}(${JSON.stringify(request.payload)})`)
      .join(", ");
    expect(predicate(), `${what}. Requests the server saw: [${seen}]`).toBe(true);
  });
}

/** Waits for a timer-driven editor milestone, such as a viewport or retry. */
export async function waitForReal(predicate: () => boolean, limitMs: number, what: string) {
  await vi.waitFor(() => expect(predicate(), what).toBe(true), { timeout: limitMs });
}

export const harnessThreadRef: ScopedThreadRef = {
  environmentId: HARNESS_ENVIRONMENT_ID,
  threadId: HARNESS_THREAD_ID,
};
