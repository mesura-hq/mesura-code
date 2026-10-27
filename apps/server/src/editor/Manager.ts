// @effect-diagnostics nodeBuiltinImport:off - the home directory a launch defaults to.
import * as NodeOS from "node:os";
import {
  type EditorHighlightDefinition,
  type EditorSessionEndReason,
  EditorSessionInputLostError,
  EditorSessionLookupError,
  EditorSessionRpcError,
  EditorSessionSpawnError,
  type EditorSessionAttachInput,
  type EditorSessionCloseInput,
  type EditorSessionError,
  type EditorSessionEvent,
  type EditorSessionInputInput,
  type EditorSessionInputResult,
  type EditorSessionOpenInput,
  type EditorSessionOpenResult,
  type EditorSessionReplaceTextInput,
  type EditorSessionSetCursorInput,
  type EditorSessionSnapshot,
  type EditorSessionViewportInput,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  gridColumnsForViewport,
  grownGridColumns,
  lineFits,
  mayExpandUnpredictably,
  RESERVATION_BATCHES,
} from "./gridWidth.ts";
import {
  APPLY_EDITS_LUA,
  RESET_LEFT_COLUMN_LUA,
  SET_CURSOR_LUA,
  SET_VIEWPORT_LUA,
} from "./hostPlugin.ts";
import { NvimAdapter } from "./NvimAdapter.ts";
import { NvimBridge } from "./NvimBridge.ts";
import { makeEditorTrace, summarizeEditorEvent } from "./editorTrace.ts";

/**
 * One editor session per thread, not per file: a session is a whole Neovim, and its
 * marks, registers, jumplist and undo must survive a switch between files of one thread.
 * A second file opens as another buffer in the running session.
 * Shaped after `terminal/Manager.ts`, which solves the same long-lived-child problems.
 */

/** How many sessions a server holds before it starts letting the oldest go. */
const DEFAULT_MAX_SESSIONS = 16;

/** How many buffers one session keeps before closing the least recently used. */
const MAX_BUFFERS_PER_SESSION = 32;

/** How many times one session replaces a Neovim that exited before giving up. */
const MAX_RESTARTS_PER_SESSION = 3;

type Listener = (event: EditorSessionEvent) => Effect.Effect<void>;

/** An event and its place in the session's stream, given when it was made. */
interface StampedEvent {
  readonly seq: number;
  readonly event: EditorSessionEvent;
}

/**
 * One attachment's place in the stream.
 *
 * `fromSeq` is the last event its snapshot already holds: the drain skips
 * those, so a delta never reaches a client twice. Until the snapshot has gone
 * out (`primed`), later events wait in `pending`, so none overtakes it.
 */
interface Attachment {
  readonly fromSeq: number;
  primed: boolean;
  readonly pending: Array<EditorSessionEvent>;
}

/**
 * `generation` is `Session.restarts` when the batch was first seen: a re-send
 * from an earlier Neovim cannot be vouched for (see `EditorSessionInputLostError`).
 * `accepted` counts the bytes of `keys` Neovim took, so a partial acceptance resumes.
 */
interface InputReceipt {
  readonly index: number;
  readonly generation: number;
  accepted: number;
  done: boolean;
}

/** Client lanes remembered per session: windows and reloads, not keys. */
const MAX_INPUT_LANES = 16;
/** How long Neovim's full input buffer may refuse keys before the batch fails. */
const INPUT_BUFFER_PATIENCE = 200;
/**
 * How long `mesura.escape_state` after a batch may take before the answer says
 * `blocking`. The read is not a fast call, so a Neovim that started waiting
 * for a key after `nvim_get_mode` answered would hold it, and the thread's
 * lock with it.
 */
const ESCAPE_STATE_PATIENCE = Duration.millis(250);

interface OpenBuffer {
  readonly relativePath: string;
  readonly absolutePath: string;
  lastUsedAt: number;
}

/**
 * The longest a key's text waits for a fallback cursor read before it goes out alone.
 * A normal read answers in milliseconds. This bound is for a Neovim whose main loop
 * is held (`:!make`, a prompt): the text then goes out with the old caret, and the
 * trace and the log record it.
 */
const TEXT_WAIT_MS = 1_000;

/** The grid a new Neovim attaches with, before any client has described its window. */
const INITIAL_GRID = { cols: 120, rows: 40, reservedBatches: 0 } as const;

interface Session {
  readonly threadId: string;
  /** The project Neovim runs in. Kept so a replacement starts in the same place. */
  readonly cwd: string;
  /** Replaced when Neovim exits under a live session; see `restartSession`. */
  bridge: NvimBridge.Session;
  /** The session's lifetime: the outbox and the fiber draining it. */
  readonly scope: Scope.Closeable;
  /** The Neovim process's lifetime, a child of `scope`. */
  bridgeScope: Scope.Closeable;
  /** How many times Neovim has been replaced in this session. */
  restarts: number;
  /**
   * The last key batch left Neovim waiting for a key in its own command (`g`,
   * `Z`, an operator). Neovim defers a non-fast request until that key comes,
   * so a call that would send one checks first; see `refuseWhileWaitingForKey`.
   */
  waitingForKey: boolean;
  readonly listeners: Map<Listener, Attachment>;
  /**
   * A queue because the bridge notifies from a plain callback and a listener is an
   * Effect. One fiber drains it, so every attachment gets events in Neovim's order.
   */
  readonly outbox: Queue.Queue<StampedEvent>;
  /** The last sequence number given to an event; see `Attachment`. */
  eventSeq: number;
  /** Keyed by absolute path, so two threads with the same file do not collide. */
  readonly buffers: Map<string, OpenBuffer>;
  /** The file the window is showing now. */
  currentPath: string | null;
  attachedClients: number;
  lastActivityAt: number;
  /** Stops the bridge subscription when the session goes. */
  unsubscribe: (() => void) | null;
  /**
   * Key batches by client lane, so a re-sent batch is applied once. Per lane because
   * two windows type into one session: one shared record let window B erase window A's,
   * and A's re-send was applied twice. Bounded by `MAX_INPUT_LANES`, oldest lane first.
   */
  readonly inputReceipts: Map<string, InputReceipt>;
  /** Publishes the events `wireNotifications` holds for a cursor; see there. */
  releaseHeld: () => void;
  /**
   * The size of the grid the host last gave Neovim's window, and the rows the
   * client last asked for. The columns are the host's own (`gridWidth.ts`);
   * reset with the grid when Neovim is replaced.
   */
  grid: { cols: number; rows: number; reservedBatches: number };
}

export interface EditorSessionManagerOptions {
  /** Where Neovim reads its configuration. Normally the server setting. */
  readonly configDirectory: string;
  readonly stateDir: string;
  readonly homeDir?: string | undefined;
  readonly maxSessions?: number | undefined;
  /** A JSONL file to trace every call and event into. See `editorTrace.ts`. */
  readonly tracePath?: string | undefined;
}

export class EditorSessionManager extends Context.Service<
  EditorSessionManager,
  {
    /** Answers the snapshot and where Neovim is for Escape; see `EditorSessionOpenResult`. */
    readonly open: (
      input: EditorSessionOpenInput,
    ) => Effect.Effect<EditorSessionOpenResult, EditorSessionError>;
    /**
     * Registers a listener after sending it, and only it, a snapshot. A late client
     * needs the whole state before a delta means anything, and an attached client
     * must not get a second snapshot.
     */
    readonly attachStream: (
      input: EditorSessionAttachInput,
      emit: Listener,
    ) => Effect.Effect<() => void, EditorSessionError>;
    /** Answers where Neovim is once it has consumed the keys; see `EditorSessionInputResult`. */
    readonly input: (
      input: EditorSessionInputInput,
    ) => Effect.Effect<EditorSessionInputResult, EditorSessionError>;
    readonly viewport: (
      input: EditorSessionViewportInput,
    ) => Effect.Effect<void, EditorSessionError>;
    readonly setCursor: (
      input: EditorSessionSetCursorInput,
    ) => Effect.Effect<void, EditorSessionError>;
    readonly replaceText: (
      input: EditorSessionReplaceTextInput,
    ) => Effect.Effect<void, EditorSessionError>;
    readonly close: (input: EditorSessionCloseInput) => Effect.Effect<void>;
    /** Closes whatever a thread had, if anything. Archiving a thread calls it. */
    readonly closeThread: (input: EditorSessionCloseInput) => Effect.Effect<void>;
    /** Whether a thread has a live session. For tests; cheap and read-only. */
    readonly hasSessionForTest: (input: EditorSessionCloseInput) => Effect.Effect<boolean>;
    /** Waits until the session has caught up. For tests. */
    readonly settleForTest: (input: EditorSessionCloseInput) => Effect.Effect<void>;
  }
>()("t3/editor/Manager/EditorSessionManager") {}

/** The launch reasons, carried to the client rather than flattened to "failed". */
const spawnErrorFor = (threadId: string, cause: unknown): EditorSessionSpawnError => {
  const tagged = cause as { _tag?: string; reason?: string; detail?: string; message?: string };
  const reason =
    tagged._tag === "NvimLaunchError" || tagged._tag === "NvimSpawnError"
      ? ((tagged.reason ?? "spawn-failed") as EditorSessionSpawnError["reason"])
      : "spawn-failed";
  return new EditorSessionSpawnError({
    threadId,
    reason,
    detail: tagged.detail ?? tagged.message ?? String(cause),
  });
};

export const makeWithOptions = Effect.fn("EditorSessionManager.makeWithOptions")(function* (
  options: EditorSessionManagerOptions,
) {
  const adapter = yield* NvimAdapter;
  const path = yield* Path.Path;
  // Resolved once here and provided to each spawn, so opening a file needs
  // nothing in context but the manager itself.
  const fileSystem = yield* FileSystem.FileSystem;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sessions = yield* SynchronizedRef.make(new Map<string, Session>());
  const threadLocks = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());

  /**
   * One permit per thread, held for a whole session lifecycle operation. The map
   * reference is synchronized, but `Session` fields are mutated outside it: without
   * this lock, two `open` calls both spawn a Neovim and the second orphans the first.
   */
  const getThreadLock = (threadId: string) =>
    SynchronizedRef.modifyEffect(threadLocks, (current) => {
      const existing = current.get(threadId);
      if (existing !== undefined) return Effect.succeed([existing, current] as const);
      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => [semaphore, new Map(current).set(threadId, semaphore)] as const),
      );
    });

  const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(getThreadLock(threadId), (semaphore) => semaphore.withPermit(effect));

  /**
   * A counter, not a clock: eviction needs only the least recently used order, and a
   * wall clock would add a time dependency for tests to control.
   */
  let activityTick = 0;
  const now = () => (activityTick += 1);

  /** Set once the manager is shutting down; see its finalizer. */
  let stopping = false;

  const trace = makeEditorTrace(
    options.tracePath === undefined ? undefined : path.resolve(options.tracePath),
  );
  yield* Effect.addFinalizer(() => Effect.sync(trace.close));

  /** Sessions whose Neovim exited, and the bridge that did, waiting to be replaced. */
  const exits = yield* Queue.make<{
    readonly session: Session;
    readonly exited: NvimBridge.Session;
  }>();

  /** Gives an event its place in the session's stream. */
  const stamp = (session: Session, event: EditorSessionEvent): StampedEvent => {
    session.eventSeq += 1;
    return { seq: session.eventSeq, event };
  };

  const publishStamped = (session: Session, stamped: StampedEvent) => {
    if (trace.enabled) {
      trace.record({
        dir: "out",
        thread: session.threadId,
        ...summarizeEditorEvent(stamped.event),
      });
    }
    Queue.offerUnsafe(session.outbox, stamped);
  };

  const publish = (session: Session, event: EditorSessionEvent) =>
    publishStamped(session, stamp(session, event));

  /**
   * `withThreadLock`, recording the call when tracing is on: how long it queued
   * behind the lock and how long Neovim took to answer once it had it.
   */
  const withTracedLock = <A, E, R>(
    threadId: string,
    call: string,
    /** A thunk, so the per-keystroke path allocates nothing while tracing is off. */
    detail: () => Record<string, unknown>,
    effect: Effect.Effect<A, E, R>,
  ) => {
    if (!trace.enabled) return withThreadLock(threadId, effect);
    const queuedAt = performance.now();
    return withThreadLock(
      threadId,
      Effect.suspend(() => {
        const acquiredAt = performance.now();
        const done = (outcome: string) =>
          Effect.sync(() =>
            trace.record({
              dir: "in",
              thread: threadId,
              call,
              ...detail(),
              outcome,
              waitedMs: Math.round(acquiredAt - queuedAt),
              tookMs: Math.round(performance.now() - acquiredAt),
            }),
          );
        return effect.pipe(
          Effect.tap(() => done("ok")),
          Effect.tapCause(() => done("failed")),
        );
      }),
    );
  };

  /**
   * Resolves a path inside the project. Neovim never opens the file, so this is not an
   * access check, but a buffer named `../../.ssh/id_rsa` must not appear as a project file.
   */
  const resolveWithinRoot = Effect.fn(function* (
    threadId: string,
    cwd: string,
    relativePath: string,
  ) {
    const root = path.resolve(cwd);
    const absolutePath = path.resolve(root, relativePath);
    const contained = absolutePath === root || absolutePath.startsWith(`${root}${path.sep}`);
    if (!contained) {
      return yield* new EditorSessionRpcError({
        threadId,
        method: "open",
        detail: `path leaves the project: ${relativePath}`,
      });
    }
    return absolutePath;
  });

  /**
   * Sends an event to the attachments now, not through the outbox.
   *
   * For what is said as a session goes: stopping it closes the scope of the
   * fiber that drains the outbox, so a queued event would almost never arrive.
   */
  const deliverNow = Effect.fn(function* (session: Session, event: EditorSessionEvent) {
    if (trace.enabled) {
      trace.record({ dir: "out", thread: session.threadId, ...summarizeEditorEvent(event) });
    }
    yield* Effect.forEach([...session.listeners.keys()], (listener) => listener(event), {
      discard: true,
    });
  });

  /**
   * Stops a session, and tells its attachments it is gone.
   *
   * Told rather than dropped silently: the attachment's stream ends on `exited`,
   * and a client whose stream simply went quiet kept sending keys to a session
   * that no longer existed, with nothing on screen saying so.
   */
  const stopSession = Effect.fn(function* (session: Session, reason: EditorSessionEndReason) {
    session.unsubscribe?.();
    session.unsubscribe = null;
    yield* deliverNow(session, { type: "exited", code: null, reason });
    session.listeners.clear();
    yield* Scope.close(session.scope, Effect.void as never).pipe(Effect.ignoreCause);
  });

  /**
   * Lets the oldest unattached session go once there are too many. An attached session
   * is never evicted, so the limit bounds idle sessions, not live ones: thirty attached
   * threads run thirty Neovims. Revisit if that ever bites.
   */
  const evictIfNeeded = Effect.fn("EditorSessionManager.evictIfNeeded")(function* (
    /**
     * How many sessions are about to join. Eviction runs before the new
     * session is in the map, so it can never choose the one being opened.
     */
    incoming: number,
  ) {
    const doomed: Session[] = [];
    yield* SynchronizedRef.update(sessions, (current) => {
      const excess = current.size + incoming - maxSessions;
      if (excess <= 0) return current;
      const idle = [...current.values()]
        .filter((session) => session.attachedClients === 0)
        .sort((left, right) => left.lastActivityAt - right.lastActivityAt);
      const next = new Map(current);
      for (const session of idle.slice(0, excess)) {
        next.delete(session.threadId);
        doomed.push(session);
      }
      return next;
    });
    // Nobody is attached to an evicted session, so the reason reaches no one.
    yield* Effect.forEach(doomed, (session) => stopSession(session, "closed"), { discard: true });
  });

  const spawnBridge = (threadId: string, cwd: string, scope: Scope.Closeable) =>
    NvimBridge.spawn({
      cols: INITIAL_GRID.cols,
      rows: INITIAL_GRID.rows,
      cwd,
      configDirectory: options.configDirectory,
      stateDir: options.stateDir,
      homeDir: options.homeDir ?? NodeOS.homedir(),
    }).pipe(
      Scope.provide(scope),
      Effect.provideService(NvimAdapter, adapter),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.mapError((cause) => spawnErrorFor(threadId, cause)),
    );

  /**
   * `cwd` must be the thread's project: plugins root themselves at Neovim's working
   * directory. At the server's home directory, neo-tree re-rendered the whole home
   * on every edit (measured: 100% CPU, 1.7 GB, keystrokes delayed 10 s or more).
   */
  const startSession = Effect.fn("EditorSessionManager.startSession")(function* (
    threadId: string,
    cwd: string,
  ) {
    const scope = yield* Scope.make();
    const bridgeScope = yield* Scope.fork(scope);
    const bridge = yield* spawnBridge(threadId, cwd, bridgeScope).pipe(
      Effect.tapCause(() => Scope.close(scope, Effect.void as never)),
    );

    const outbox = yield* Queue.make<StampedEvent>().pipe(Scope.provide(scope));

    const session: Session = {
      threadId,
      cwd,
      bridge,
      scope,
      bridgeScope,
      restarts: 0,
      waitingForKey: false,
      outbox,
      eventSeq: 0,
      listeners: new Map(),
      buffers: new Map(),
      currentPath: null,
      attachedClients: 0,
      lastActivityAt: now(),
      unsubscribe: null,
      inputReceipts: new Map(),
      releaseHeld: () => {},
      grid: { ...INITIAL_GRID },
    };

    yield* Queue.takeBetween(outbox, 1, Number.MAX_SAFE_INTEGER).pipe(
      Effect.flatMap((events) =>
        Effect.forEach(
          events,
          ({ seq, event }) =>
            Effect.forEach(
              [...session.listeners],
              ([listener, attachment]) => {
                if (seq <= attachment.fromSeq) return Effect.void;
                if (!attachment.primed) {
                  attachment.pending.push(event);
                  return Effect.void;
                }
                return listener(event);
              },
              { discard: true },
            ),
          { discard: true },
        ),
      ),
      Effect.forever,
      Effect.ignoreCause,
      Effect.forkIn(scope),
    );

    return session;
  });

  const dropSession = Effect.fn(function* (threadId: string, reason: EditorSessionEndReason) {
    let doomed: Session | undefined;
    yield* SynchronizedRef.update(sessions, (current) => {
      doomed = current.get(threadId);
      if (doomed === undefined) return current;
      const next = new Map(current);
      next.delete(threadId);
      return next;
    });
    if (doomed !== undefined) yield* stopSession(doomed, reason);
  });

  const lookup = Effect.fn(function* (threadId: string) {
    const session = (yield* SynchronizedRef.get(sessions)).get(threadId);
    if (session === undefined) return yield* new EditorSessionLookupError({ threadId });
    session.lastActivityAt = now();
    return session;
  });

  const request = (session: Session, method: string, params: ReadonlyArray<unknown>) =>
    session.bridge.request(method, params).pipe(
      Effect.mapError(
        (cause) =>
          new EditorSessionRpcError({
            threadId: session.threadId,
            method,
            detail: cause.message,
          }),
      ),
    );

  /**
   * `withHighlightDefinitions` is for a client that has none yet: a new attachment, or
   * every client after a restart renumbered them. Without it, a late client drew flash
   * labels with no colours. A file switch omits them: attached clients already hold them.
   */
  const snapshotOf = (
    session: Session,
    { withHighlightDefinitions }: { readonly withHighlightDefinitions: boolean },
  ): EditorSessionSnapshot => ({
    relativePath: session.currentPath ?? "",
    lines: [...session.bridge.lines],
    cursor: session.bridge.cursor,
    mode: session.bridge.mode,
    jumping: session.bridge.jumping,
    topline: Math.max(1, session.bridge.topLine + 1),
    hlDefs: withHighlightDefinitions
      ? Object.fromEntries(
          [...session.bridge.highlightDefinitions].map(([id, definition]) => [
            String(id),
            definition,
          ]),
        )
      : {},
  });

  /** Forgets the least recently used buffers once a session holds too many. */
  const trimBuffers = Effect.fn(function* (session: Session) {
    if (session.buffers.size <= MAX_BUFFERS_PER_SESSION) return;
    const oldest = [...session.buffers.values()]
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)
      .slice(0, session.buffers.size - MAX_BUFFERS_PER_SESSION);
    for (const buffer of oldest) {
      session.buffers.delete(buffer.absolutePath);
      yield* request(session, "nvim_exec_lua", ["mesura.close(...)", [buffer.absolutePath]]).pipe(
        Effect.catchCause(() => Effect.void),
      );
    }
  });

  const open = Effect.fn("EditorSessionManager.open")(function* (input: EditorSessionOpenInput) {
    if (stopping) {
      return yield* new EditorSessionRpcError({
        threadId: input.threadId,
        method: "open",
        detail: "the server is stopping",
      });
    }
    const absolutePath = yield* resolveWithinRoot(input.threadId, input.cwd, input.relativePath);

    // Set inside the lock, read by the repair below. A local rather than
    // shared state: only this call can be inside the lock for this thread.
    let created = false;

    return yield* withTracedLock(
      input.threadId,
      "open",
      () => ({ path: input.relativePath, lines: input.lines.length }),
      Effect.gen(function* () {
        const cwd = path.resolve(input.cwd);
        let existing = (yield* SynchronizedRef.get(sessions)).get(input.threadId);
        // A thread whose project moved — it was given a worktree — gets a
        // Neovim started in the new one. Plugins root themselves at Neovim's
        // working directory, and a session keeps the one it started in.
        if (existing !== undefined && existing.cwd !== cwd) {
          yield* dropSession(input.threadId, "replaced");
          existing = undefined;
        }
        const session = existing ?? (yield* startSession(input.threadId, cwd));
        // Opening a file is someone asking for the editor, so the restart
        // budget starts over. It exists to stop a configuration that kills
        // Neovim at start from looping, not to count a day's worth of `:q`.
        session.restarts = 0;

        if (existing === undefined) {
          created = true;
          // Set before the session becomes reachable: an attachment in between would
          // send a snapshot with an empty `relativePath`, which the contract refuses.
          session.currentPath = input.relativePath;
          yield* wireNotifications(session);

          // Eviction runs before this session joins the map, so the session
          // being opened right now cannot be the one chosen to go.
          yield* evictIfNeeded(1);
          yield* SynchronizedRef.update(sessions, (current) =>
            new Map(current).set(input.threadId, session),
          );
        }

        session.lastActivityAt = now();
        // Before any non-fast request below: see `cancelPendingCommand`.
        yield* cancelPendingCommand(session, "open");
        // Not `session.currentPath` yet: a failure below would leave the new name on the
        // old buffer's text, and the next attachment would save that pair. It is set once
        // the mirror is on the buffer, so failure needs no restore. A session created by
        // this call is dropped by the `tapCause` below.
        session.buffers.set(absolutePath, {
          relativePath: input.relativePath,
          absolutePath,
          lastUsedAt: now(),
        });
        yield* trimBuffers(session);

        // Follow the buffer `mesura.open` returns, not the `BufEnter` notification: that
        // can land after the snapshot, which then carries another buffer's text. Under a
        // config that opens a picker at start, the client saved the picker's one-line
        // prompt over real files (measured).
        const openedBuffer = (yield* request(session, "nvim_exec_lua", [
          "return mesura.open(...)",
          [absolutePath, [...input.lines]],
        ])) as number;
        // A hard failure rather than a skipped follow. Skipping put the
        // snapshot back on whichever buffer the mirror happened to be on,
        // which is the defect this call exists to fix — re-entered through the
        // guard added to fix it.
        if (typeof openedBuffer !== "number") {
          return yield* new EditorSessionRpcError({
            threadId: session.threadId,
            method: "open",
            detail: "mesura.open did not answer with a buffer number",
          });
        }
        yield* session.bridge.followBuffer(openedBuffer).pipe(
          Effect.mapError(
            (cause) =>
              new EditorSessionRpcError({
                threadId: session.threadId,
                method: "open",
                detail: cause.message,
              }),
          ),
        );
        yield* session.bridge.settle.pipe(
          Effect.mapError(
            (cause) =>
              new EditorSessionRpcError({
                threadId: input.threadId,
                method: "open",
                detail: cause.message,
              }),
          ),
        );

        session.currentPath = input.relativePath;
        const snapshot = snapshotOf(session, { withHighlightDefinitions: created });
        // Every attachment gets the snapshot, or it would apply this buffer's `lines` to
        // the file it still believes is open. Held text goes first: the snapshot already
        // contains it, and a `lines` event after it would be applied twice.
        session.releaseHeld();
        publish(session, { type: "snapshot", snapshot });
        // After the snapshot went out: the read is a Neovim round trip, and
        // attached clients need not wait for it.
        const escape = yield* modeAfterKeys(session);
        return { ...snapshot, escape };
      }).pipe(
        // A session that could not be opened is not a session. Left in the
        // map it would hold a Neovim, occupy one of the slots, and claim to be
        // showing a file it never opened.
        Effect.tapCause(() => (created ? dropSession(input.threadId, "closed") : Effect.void)),
      ),
    );
  });

  /**
   * `lines` keep Neovim's zero-based half-open ranges, so the off-by-one lives in one
   * place. Cursor and mode are read, not taken from the redraw stream, whose cursor lags
   * a mapping that already ran. `mesura:write` asks the host to save: the host owns the file.
   */
  const wireNotifications = Effect.fn("EditorSessionManager.wireNotifications")(function (
    session: Session,
  ) {
    let lastCursorLine = -1;
    let lastCursorCol = -1;
    let lastMode = "";
    let lastJumping = false;
    let lastTopline = -1;
    /** The lines Neovim showed at the last published frame, inclusive. */
    let lastShownFrom = 1;
    let lastShownTo = 0;
    const sentHighlightIds = new Set<number>();
    let lastVisual = "";

    /**
     * From a `lines` event to its frame, events are held and published together: alone,
     * `lines` left in its own stream chunk, and the RPC server waits for the client's Ack
     * before the next, so the caret trailed by a round trip. Without a cursor push, the
     * text waits for a cursor read, bounded by the `TEXT_WAIT_MS` watchdog.
     */
    // Stamped as they are made, not as they go out: a snapshot taken while
    // they wait already holds them, and an attachment made then must skip them.
    let held: Array<StampedEvent> | null = null;
    let holdNumber = 0;
    /** Created by the watchdog this returns; see the end of this function. */
    let holdsStarted: Queue.Queue<number> | null = null;
    let heldSince = 0;
    const release = () => {
      if (held === null) return;
      const events = held;
      held = null;
      // How long text waited for its cursor: the cost of the hold, traced.
      if (trace.enabled) {
        trace.record({
          dir: "hold",
          thread: session.threadId,
          heldMs: Math.round(performance.now() - heldSince),
          events: events.length,
        });
      }
      for (const stamped of events) publishStamped(session, stamped);
    };
    const send = (event: EditorSessionEvent) => {
      if (held === null) publish(session, event);
      else held.push(stamp(session, event));
    };
    const hold = () => {
      if (held !== null) return;
      held = [];
      heldSince = performance.now();
      holdNumber += 1;
      if (holdsStarted !== null) Queue.offerUnsafe(holdsStarted, holdNumber);
    };

    const bridge = session.bridge;
    const unsubscribeBridge = bridge.subscribe((event) => {
      if (event.kind === "exited") {
        release();
        Queue.offerUnsafe(exits, { session, exited: bridge });
        return;
      }
      if (event.kind === "lines") {
        hold();
        // Attributed to the file the session has open. A delta with no name on
        // it is one the client cannot check, and this is the only place that
        // knows which file the mirror is on.
        const relativePath = session.currentPath;
        if (relativePath === null) return;
        send({
          type: "lines",
          relativePath,
          first: event.first,
          last: event.last,
          lines: [...event.lines],
        });
        return;
      }

      if (event.kind === "cmdline") {
        send({ type: "cmdline", cmdline: event.cmdline });
        return;
      }

      if (event.kind === "message") {
        send({ type: "message", kind: event.messageKind, text: event.text });
        return;
      }

      if (event.kind === "notification") {
        if (event.method !== "mesura:write") return;
        const absolutePath = String(event.params[0] ?? "");
        const buffer = session.buffers.get(absolutePath);
        if (buffer === undefined) return;
        send({ type: "writeRequested", relativePath: buffer.relativePath });
        return;
      }

      // A frame. A real configuration produces one about every 4 ms even when idle,
      // so only a cursor or mode change is sent.
      const { line, col } = session.bridge.cursor;
      if (line !== lastCursorLine || col !== lastCursorCol) {
        lastCursorLine = line;
        lastCursorCol = col;
        send({ type: "cursor", line, col });
      }
      if (session.bridge.mode !== lastMode || session.bridge.jumping !== lastJumping) {
        lastMode = session.bridge.mode;
        lastJumping = session.bridge.jumping;
        send({
          type: "mode",
          mode: lastMode,
          blocking: false,
          jumping: lastJumping,
        });
      }

      // The selection. Sent whenever it moves or ends, and compared as a whole
      // rather than end by end: a selection grows from either end, and the one
      // that did not move is not evidence that nothing happened.
      const visual = session.bridge.visual;
      const visualKey =
        visual === null
          ? ""
          : `${visual.kind}:${visual.anchor.line}:${visual.anchor.col}:${visual.cursor.line}:${visual.cursor.col}`;
      if (visualKey !== lastVisual) {
        lastVisual = visualKey;
        send({ type: "visual", visual });
      }

      // Everything drawn over the text: flash's labels, the search highlight,
      // a plugin's virtual text. Sent per frame and only for the lines whose
      // drawing moved, because the alternative is the whole window on every
      // one of the two hundred frames a second an idle session produces.
      if (event.kind === "flush" && event.changedLines.length > 0) {
        const changed = new Set(event.changedLines);
        // Lines that scrolled out of the window are erased too. Nothing redraws
        // a line Neovim no longer shows, so a label on it would otherwise stay
        // on the client for as long as Monaco keeps that line in view.
        const shownFrom = session.bridge.topLine + 1;
        const shownTo = Math.max(shownFrom, session.bridge.botLine);
        for (let line = lastShownFrom; line <= lastShownTo; line += 1) {
          if (line < shownFrom || line > shownTo) changed.add(line);
        }
        lastShownFrom = shownFrom;
        lastShownTo = shownTo;
        // The definitions first, in the same frame. A run that arrives naming
        // a colour the client has never been given is drawn in no colour at
        // all, and the id is the only thing the drawing refers to.
        const unseen: Record<string, EditorHighlightDefinition> = {};
        for (const [id, definition] of session.bridge.highlightDefinitions) {
          if (sentHighlightIds.has(id)) continue;
          sentHighlightIds.add(id);
          unseen[String(id)] = definition;
        }
        if (Object.keys(unseen).length > 0) send({ type: "hlDefs", hlDefs: unseen });

        send({
          type: "decorations",
          overlays: session.bridge.overlays.filter((overlay) => changed.has(overlay.line)),
          highlightRuns: session.bridge.highlightRuns.filter((run) => changed.has(run.line)),
          rows: [...changed],
        });
      }

      // The window Neovim is showing. Half the viewport agreement lives here:
      // a key that scrolls — `G`, `Ctrl-D`, a search that jumps — moves
      // Neovim's window and nothing else would ever tell the client, which
      // would leave the developer's caret somewhere they cannot see.
      const topline = session.bridge.topLine + 1;
      const botline = Math.max(topline, session.bridge.botLine);
      if (topline !== lastTopline) {
        lastTopline = topline;
        send({ type: "viewport", topline, botline });
      }

      // A push lands ahead of its frame, so the text waits for that frame and
      // goes out with the caret and the drawing. A read lands after it.
      if (event.kind === "cursor" ? event.source === "read" : !bridge.cursorReadPending) release();
    });
    const unsubscribe = () => {
      unsubscribeBridge();
      release();
    };
    session.releaseHeld = release;
    session.unsubscribe = unsubscribe;

    // The bound on a hold, returned for the caller to run: it sleeps until
    // the latest hold has waited `TEXT_WAIT_MS`, measured from when
    // that hold began, and releases it if it is still the one held. Forked in
    // the bridge's scope, so a replaced Neovim takes it along.
    return Effect.gen(function* () {
      const queue = yield* Queue.unbounded<number>().pipe(Scope.provide(session.bridgeScope));
      holdsStarted = queue;
      yield* Queue.takeAll(queue).pipe(
        Effect.flatMap((started) => {
          const number = started.at(-1);
          const waited = performance.now() - heldSince;
          return Effect.sleep(Duration.millis(Math.max(0, TEXT_WAIT_MS - waited))).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                if (holdNumber !== number || held === null) return Effect.void;
                if (trace.enabled) {
                  trace.record({ dir: "hold", thread: session.threadId, timedOut: true });
                }
                release();
                return Effect.logWarning(
                  "Neovim did not answer a cursor read; its text was sent without the cursor",
                  { thread: session.threadId, waitedMs: TEXT_WAIT_MS },
                );
              }),
            ),
          );
        }),
        Effect.forever,
        Effect.forkIn(session.bridgeScope),
      );
    });
  });

  const requireSession = (threadId: string) => lookup(threadId);

  /**
   * Gives Neovim `keys`, from byte `progress.accepted` on, until it has all.
   *
   * `nvim_input` answers how many bytes it took, and takes fewer once its
   * input buffer is full: the rest is sent again once Neovim has read some.
   * One request per batch in the normal case.
   */
  /**
   * Resizes the buffer's own grid: with `ext_multigrid`, resizing the outer grid leaves
   * the window's size alone. The redraw stream assigns the grid id; before the first
   * `win_pos`, only the outer grid exists.
   */
  const resizeGrid = Effect.fn(function* (session: Session, cols: number, rows: number) {
    // Unchanged is no request at all: Neovim would answer it with nothing.
    if (cols === session.grid.cols && rows === session.grid.rows) return;
    const gridId = session.bridge.bufferGridId;
    yield* request(
      session,
      gridId === null ? "nvim_ui_try_resize" : "nvim_ui_try_resize_grid",
      gridId === null ? [cols, rows] : [gridId, cols, rows],
    );
    session.grid = { ...session.grid, cols, rows };
  });

  /**
   * Widens the grid before keys that could carry the cursor's line past its
   * edge, so Neovim never has to scroll the window sideways to show the
   * cursor. Before the keys rather than after their text arrives: once Neovim
   * has drawn a key past the edge, the scroll has happened. See `gridWidth.ts`.
   */
  const growGridFor = Effect.fn(function* (session: Session, keys: string) {
    // These keys finish a command Neovim is waiting in, so they draw no text,
    // and Neovim would hold the requests below until it had them: the keys
    // would wait behind requests that wait for the keys.
    if (session.waitingForKey) return;
    const bridge = session.bridge;
    const unpredictable = mayExpandUnpredictably(keys, bridge.mode);
    session.grid.reservedBatches = unpredictable
      ? RESERVATION_BATCHES
      : Math.max(0, session.grid.reservedBatches - 1);
    const cols = grownGridColumns(session.grid.cols, {
      lines: bridge.lines,
      topline: bridge.topLine + 1,
      rows: session.grid.rows,
      tabstop: bridge.tabstop,
      cursorLine: bridge.cursor.line,
      pendingCells: keys.length,
      unpredictable,
    });
    if (cols !== null) yield* resizeGrid(session, cols, session.grid.rows);
    // An unpredicted change (a mapping, a completion, a wide paste) can still scroll the
    // window sideways, and Neovim does not undo that on a wider grid. Reset it only when
    // the line fits: past the bound, a reset would redraw every row on every key.
    if (
      bridge.leftColumn > 0 &&
      lineFits(bridge.lines[bridge.cursor.line - 1] ?? "", bridge.tabstop, session.grid.cols)
    ) {
      yield* request(session, "nvim_exec_lua", [RESET_LEFT_COLUMN_LUA, [bridge.attachedBuffer]]);
    }
  });

  const submitKeys = Effect.fn(function* (
    session: Session,
    keys: string,
    progress: { accepted: number },
  ) {
    if (progress.accepted === 0) yield* growGridFor(session, keys);
    const bytes = new TextEncoder().encode(keys);
    let refusals = 0;
    while (progress.accepted < bytes.length) {
      const rest =
        progress.accepted === 0
          ? keys
          : new TextDecoder().decode(bytes.subarray(progress.accepted));
      const written = yield* request(session, "nvim_input", [rest]);
      const taken = typeof written === "number" ? written : bytes.length - progress.accepted;
      progress.accepted += taken;
      if (taken > 0) continue;
      refusals += 1;
      if (refusals > INPUT_BUFFER_PATIENCE) {
        return yield* new EditorSessionRpcError({
          threadId: session.threadId,
          method: "nvim_input",
          detail: "Neovim's input buffer stayed full",
        });
      }
      yield* Effect.sleep(Duration.millis(5));
    }
  });

  /**
   * Refuses the call while Neovim waits for the rest of a command (`g`, `Z`, an operator):
   * Neovim defers non-fast requests until that key, which `input` sends under the same
   * lock, so the thread deadlocked. Checked with `nvim_get_mode`, which Neovim answers
   * while waiting, and only when the last batch left it waiting.
   */
  const refuseWhileWaitingForKey = Effect.fn(function* (session: Session, method: string) {
    if (!session.waitingForKey) return;
    const reported = (yield* request(session, "nvim_get_mode", [])) as {
      readonly blocking: boolean;
    };
    session.waitingForKey = reported.blocking;
    if (!reported.blocking) return;
    return yield* new EditorSessionRpcError({
      threadId: session.threadId,
      method,
      detail: "Neovim is waiting for the rest of a command; finish or cancel it first",
    });
  });

  /**
   * Sends `<Esc>` for calls that must reach Neovim (open, an outside write), where
   * `refuseWhileWaitingForKey` would lose state. `nvim_input` is taken while Neovim
   * waits, and the mode read is ordered behind it (see `modeAfterKeys`). A half-typed
   * command is the user's to retype; a lost write is not.
   */
  const cancelPendingCommand = Effect.fn(function* (session: Session, method: string) {
    if (!session.waitingForKey) return;
    const readMode = request(session, "nvim_get_mode", []).pipe(
      Effect.map((reported) => (reported as { readonly blocking: boolean }).blocking),
    );
    let blocking = yield* readMode;
    if (blocking) {
      yield* request(session, "nvim_input", ["<Esc>"]);
      blocking = yield* readMode;
    }
    session.waitingForKey = blocking;
    if (!blocking) return;
    return yield* new EditorSessionRpcError({
      threadId: session.threadId,
      method,
      detail: "Neovim is still waiting for a key after <Esc>",
    });
  });

  /**
   * `nvim_get_mode` is ordered after pending keys, yet answers at once with `blocking`
   * set when Neovim waits for a key (neovim#6247; see `conformance/inputMode.test.ts`).
   * Plain non-blocking `n` is read again with `mesura.escape_state`, because flash's `f`
   * (in `getcharstr()`) and flash's labels do not show in the mode.
   */
  const modeAfterKeys = Effect.fn(
    function* (session: Session) {
      const reported = (yield* request(session, "nvim_get_mode", [])) as {
        readonly mode: string;
        readonly blocking: boolean;
      };
      session.waitingForKey = reported.blocking;
      const settled: EditorSessionInputResult = {
        mode: reported.mode,
        blocking: reported.blocking,
        jumping: false,
      };
      if (settled.blocking || settled.mode !== "n") return settled;
      const state = yield* request(session, "nvim_exec_lua", [
        "return mesura.escape_state(...)",
        [session.bridge.attachedBuffer],
      ]).pipe(Effect.timeoutOption(ESCAPE_STATE_PATIENCE));
      // No answer in time: Neovim is holding its main loop, so an Escape has
      // to reach it rather than release the editor.
      if (Option.isNone(state)) {
        session.waitingForKey = true;
        return { ...settled, blocking: true };
      }
      const { waiting, jumping } = (state.value ?? {}) as {
        readonly waiting?: boolean;
        readonly jumping?: boolean;
      };
      return { ...settled, blocking: waiting === true, jumping: jumping === true };
    },
    (effect, session: Session) =>
      effect.pipe(
        // The keys are Neovim's already, so the batch succeeds; where Neovim is
        // stays unknown, which keeps the next Escape for Neovim. Failing the
        // batch instead would have the client send it again.
        Effect.orElseSucceed((): EditorSessionInputResult => {
          session.waitingForKey = true;
          return { mode: session.bridge.mode, blocking: true, jumping: false };
        }),
      ),
  );

  const service: EditorSessionManager["Service"] = {
    open,
    attachStream: (input, emit) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const session = yield* requireSession(input.threadId);
          // The snapshot and the attachment's place in the stream are taken
          // in one step, so every event is either in the snapshot or after
          // it, never both. Events stamped later wait in `pending` until the
          // snapshot is out, so none overtakes it.
          const { snapshot, attachment } = yield* Effect.sync(() => {
            const attachment: Attachment = {
              fromSeq: session.eventSeq,
              primed: false,
              pending: [],
            };
            session.listeners.set(emit, attachment);
            return {
              snapshot: snapshotOf(session, { withHighlightDefinitions: true }),
              attachment,
            };
          });
          yield* emit({ type: "snapshot", snapshot });
          // Primed only once nothing waits, checked and set in one step.
          while (true) {
            const next = yield* Effect.sync(() => {
              const event = attachment.pending.shift();
              if (event === undefined) attachment.primed = true;
              return event;
            });
            if (next === undefined) break;
            yield* emit(next);
          }
          session.attachedClients += 1;
          // Returned rather than held in a scope, matching the terminal: the
          // websocket layer already knows how to pair one of these with a
          // stream's lifetime, and a second shape would be a second thing to get
          // right.
          return () => {
            session.listeners.delete(emit);
            session.attachedClients = Math.max(0, session.attachedClients - 1);
            session.lastActivityAt = now();
          };
        }),
      ),
    // The driving calls take the same lock. Each is a round trip to a shared
    // Neovim, and two of them interleaved would send their halves in whatever
    // order the scheduler chose — a cursor move landing between an operator
    // and its motion is a different edit from the one asked for.
    input: (input) =>
      withTracedLock(
        input.threadId,
        "input",
        () => ({ keys: input.keys }),
        Effect.gen(function* () {
          const session = yield* requireSession(input.threadId);
          const sequence = input.sequence;
          if (sequence === undefined) {
            yield* submitKeys(session, input.keys, { accepted: 0 });
            return yield* modeAfterKeys(session);
          }
          // A batch skipped as already applied still answers with where Neovim
          // is now: the client's Escape is decided by the latest answer.
          let receipt = session.inputReceipts.get(sequence.lane);
          if (receipt !== undefined && sequence.index < receipt.index) {
            return yield* modeAfterKeys(session);
          }
          if (receipt !== undefined && sequence.index === receipt.index) {
            // Accepted by a Neovim that has since exited: the restored text
            // may or may not hold it, so it is neither applied nor resent.
            if (receipt.generation !== session.restarts) {
              return yield* new EditorSessionInputLostError({
                threadId: session.threadId,
                detail: "Neovim restarted after it took these keys",
              });
            }
            if (receipt.done) return yield* modeAfterKeys(session);
          } else {
            receipt = {
              index: sequence.index,
              generation: session.restarts,
              accepted: 0,
              done: false,
            };
            session.inputReceipts.delete(sequence.lane);
            session.inputReceipts.set(sequence.lane, receipt);
            if (session.inputReceipts.size > MAX_INPUT_LANES) {
              const oldest = session.inputReceipts.keys().next().value;
              if (oldest !== undefined) session.inputReceipts.delete(oldest);
            }
          }
          // Not interruptible: a client that disconnects mid-call must not
          // leave keys Neovim took unrecorded, or its re-send types them
          // twice. The re-send queues on the thread's lock behind this.
          const accepted = receipt;
          yield* Effect.uninterruptible(
            submitKeys(session, input.keys, accepted).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  accepted.done = true;
                }),
              ),
            ),
          );
          return yield* modeAfterKeys(session);
        }),
      ),
    viewport: (input) =>
      withTracedLock(
        input.threadId,
        "viewport",
        () => ({
          topline: input.topline,
          rows: input.rows,
          cols: input.cols,
          source: input.source ?? "keys",
        }),
        Effect.gen(function* () {
          const session = yield* requireSession(input.threadId);
          yield* refuseWhileWaitingForKey(session, "viewport");
          const cols = gridColumnsForViewport(
            input.cols,
            {
              lines: session.bridge.lines,
              topline: input.topline,
              rows: input.rows,
              tabstop: session.bridge.tabstop,
            },
            session.grid.cols,
            session.grid.reservedBatches > 0,
          );
          yield* resizeGrid(session, cols, input.rows);
          // The cursor moves into the window only for a scroll Neovim never
          // saw; see `SET_VIEWPORT_LUA` and `EditorViewportSource`.
          yield* request(session, "nvim_exec_lua", [
            SET_VIEWPORT_LUA,
            [session.bridge.attachedBuffer, input.topline, input.rows, input.source !== "pointer"],
          ]);
        }),
      ),
    setCursor: (input) =>
      withTracedLock(
        input.threadId,
        "setCursor",
        () => ({ line: input.line, col: input.col }),
        Effect.gen(function* () {
          const session = yield* requireSession(input.threadId);
          yield* refuseWhileWaitingForKey(session, "setCursor");
          // The window showing the mirror's buffer, not the current one. A
          // plugin can own the window while the mirror is on the file, and
          // moving the cursor in *that* window moves the plugin's.
          yield* request(session, "nvim_exec_lua", [
            SET_CURSOR_LUA,
            [session.bridge.attachedBuffer, input.line, input.col - 1],
          ]);
        }),
      ),
    replaceText: (input) =>
      withTracedLock(
        input.threadId,
        "replaceText",
        () => ({ edits: input.edits.length }),
        Effect.gen(function* () {
          const session = yield* requireSession(input.threadId);
          if (input.edits.length === 0) return;
          // An outside write is the file's new text and must land: refusing it
          // left the editor on the old text, which the next save wrote back.
          yield* cancelPendingCommand(session, "replaceText");
          // One Lua call, so the whole write is one undo step. Why that
          // matters, and why the edits go back to front, is on APPLY_EDITS_LUA.
          yield* request(session, "nvim_exec_lua", [
            APPLY_EDITS_LUA,
            [
              session.bridge.attachedBuffer,
              input.edits.map((edit) => [
                edit.startLine - 1,
                edit.startCol - 1,
                edit.endLine - 1,
                edit.endCol - 1,
                edit.text.split("\n"),
              ]),
            ],
          ]);
        }),
      ),
    close: (input) => closeThread(input),
    closeThread: (input) => closeThread(input),
    hasSessionForTest: (input) =>
      SynchronizedRef.get(sessions).pipe(Effect.map((current) => current.has(input.threadId))),
    settleForTest: Effect.fn(function* (input) {
      const session = (yield* SynchronizedRef.get(sessions)).get(input.threadId);
      if (session === undefined) return;
      yield* session.bridge.settle.pipe(Effect.ignoreCause);
    }),
  };

  const closeThread = (input: EditorSessionCloseInput) =>
    withThreadLock(input.threadId, dropSession(input.threadId, "closed"));

  /**
   * Puts a new Neovim under the same session object, so attachments survive and get a
   * snapshot; otherwise every call failed until the server restarted. The file reopens
   * with the mirror's text, without undo history. Bounded by `MAX_RESTARTS_PER_SESSION`
   * against a configuration that kills Neovim at start.
   */
  const restartSession = (session: Session, exited: NvimBridge.Session) =>
    withThreadLock(
      session.threadId,
      Effect.gen(function* () {
        const current = (yield* SynchronizedRef.get(sessions)).get(session.threadId);
        if (current !== session || session.bridge !== exited) return;

        const openBuffer = [...session.buffers.values()].find(
          (buffer) => buffer.relativePath === session.currentPath,
        );
        const lines = [...exited.lines];
        session.unsubscribe?.();
        session.unsubscribe = null;
        yield* Scope.close(session.bridgeScope, Effect.void as never).pipe(Effect.ignoreCause);

        if (session.restarts >= MAX_RESTARTS_PER_SESSION) {
          yield* giveUp(
            session,
            `Neovim exited ${session.restarts + 1} times; reopen the file to start it again.`,
          );
          return;
        }
        session.restarts += 1;
        session.waitingForKey = false;
        session.bridgeScope = yield* Scope.fork(session.scope);
        session.bridge = yield* spawnBridge(session.threadId, session.cwd, session.bridgeScope);
        session.grid = { ...INITIAL_GRID };

        if (openBuffer !== undefined) {
          const buffer = yield* request(session, "nvim_exec_lua", [
            "return mesura.open(...)",
            [openBuffer.absolutePath, lines],
          ]);
          if (typeof buffer === "number") {
            yield* session.bridge.followBuffer(buffer);
            yield* session.bridge.settle;
          }
        }
        // Wired only once the new Neovim is on the file. Before that it shows
        // whatever it started on — a dashboard, a restored session — and its
        // text would reach the clients as the file's.
        yield* wireNotifications(session);
        publish(session, {
          type: "snapshot",
          snapshot: snapshotOf(session, { withHighlightDefinitions: true }),
        });
        publish(session, {
          type: "message",
          kind: "emsg",
          text: "Neovim exited and was restarted. Undo history from before is gone.",
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("could not restart Neovim for a session", { cause }).pipe(
            Effect.andThen(giveUp(session, "Neovim exited and could not be restarted.")),
          ),
        ),
      ),
    );

  /** Drops a session whose Neovim cannot be replaced, and says why. */
  const giveUp = Effect.fn(function* (session: Session, text: string) {
    yield* deliverNow(session, { type: "message", kind: "emsg", text });
    yield* dropSession(session.threadId, "gave-up");
  });

  // Each restart on its own fiber, so a slow one — a real configuration takes a
  // plugin load — does not hold up another thread's. The thread's lock still
  // orders restarts within one thread.
  yield* Queue.take(exits).pipe(
    Effect.flatMap(({ session, exited }) => Effect.forkScoped(restartSession(session, exited))),
    Effect.forever,
    Effect.forkScoped,
  );

  // Every session is a child process, so the server stopping has to stop them.
  // `stopping` also turns away an `open` that arrives after this has run: the
  // session it started would be in no map, and its Neovim would outlive the
  // manager until the process exited.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      stopping = true;
      const current = yield* SynchronizedRef.get(sessions);
      yield* SynchronizedRef.set(sessions, new Map());
      yield* Effect.forEach(current.values(), (session) => stopSession(session, "stopping"), {
        discard: true,
      });
    }),
  );

  return service;
});

/**
 * The attach runs on the stream's own fiber, so a failed attach fails the stream.
 * REGRESSION: `Stream.callback` registered on an unwatched forked fiber, so the
 * failure vanished and the client never learned to reopen the file.
 * The stream ends after an `exited` event.
 */
export const attachEventStream = (
  manager: EditorSessionManager["Service"],
  input: EditorSessionAttachInput,
): Stream.Stream<EditorSessionEvent, EditorSessionError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<EditorSessionEvent, Cause.Done>();
      yield* Effect.acquireRelease(
        manager.attachStream(input, (event) =>
          Queue.offer(queue, event).pipe(
            Effect.andThen(event.type === "exited" ? Queue.end(queue) : Effect.void),
            Effect.asVoid,
          ),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      return Stream.fromQueue(queue);
    }),
  );

export const make = Effect.fn("EditorSessionManager.make")(function* () {
  const config = yield* ServerConfig;
  const settings = yield* ServerSettingsService;
  const current = yield* settings.getSettings.pipe(
    Effect.catchCause(() => Effect.succeed({ neovimConfigDirectory: "~/.neovim" })),
  );
  return yield* makeWithOptions({
    configDirectory: current.neovimConfigDirectory,
    stateDir: config.neovimRuntimeDir,
    tracePath: Option.getOrUndefined(
      yield* Config.String("MESURA_EDITOR_TRACE").pipe(Config.option),
    ),
  });
});

export const layer = Layer.effect(EditorSessionManager, make());
