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
  type EditorSessionOpenInput,
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
 * The editor sessions a server is holding, one per thread.
 *
 * One per thread rather than one per file, because a session is a whole
 * Neovim: starting one costs a plugin load, and what it accumulates — marks,
 * registers, the jumplist, undo — is exactly what a developer expects to still
 * be there when they move between two files in the same piece of work. Opening
 * a second file switches the window to another buffer inside the session that
 * is already running.
 *
 * Shaped after `terminal/Manager.ts`, deliberately and file by file: a thread
 * keeps a long-lived child process, clients attach and detach from it, it
 * survives a disconnect, and it has to be stopped when the server stops. Those
 * are the terminal's problems, already solved once here.
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
 * What the session knows about one client lane's key batches.
 *
 * `generation` is `Session.restarts` when the batch was first seen: a re-send
 * from an earlier Neovim cannot be vouched for (see `EditorSessionInputLostError`).
 * `accepted` counts the bytes of `keys` Neovim has taken, so a partial
 * acceptance resumes where it stopped.
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

interface OpenBuffer {
  readonly relativePath: string;
  readonly absolutePath: string;
  lastUsedAt: number;
}

/**
 * The longest a key's text waits for a cursor read before it goes out alone.
 *
 * Most keys never wait: the host plugin pushes the cursor ahead of the frame.
 * The read is the fallback, and it answers in about a millisecond, or in tens
 * of milliseconds on a loaded server; the text waits for it, so the caret
 * moves with the letter however slow the read is. This bound is only for a
 * Neovim whose main loop is held with the text already sent (`:!make`, a
 * prompt): past it the text is shown with the caret where it was, the caret
 * follows when Neovim answers, and the trace and the log say it happened.
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
  readonly listeners: Map<Listener, Attachment>;
  /**
   * Events on their way to the listeners.
   *
   * A queue rather than a call straight through, because the bridge tells its
   * watchers from a plain callback and a listener is an Effect. One fiber
   * drains this, so events reach every attachment in the order Neovim produced
   * them rather than in whatever order a scheduler happened to pick.
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
   * Key batches by client lane, so a re-sent batch is applied once.
   *
   * Per lane, because two windows type into one session: a single "last
   * batch" let window B's input erase window A's record, and A's re-send was
   * applied twice. Bounded by `MAX_INPUT_LANES`, oldest lane first.
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
    readonly open: (
      input: EditorSessionOpenInput,
    ) => Effect.Effect<EditorSessionSnapshot, EditorSessionError>;
    /**
     * Registers a listener for the life of the caller's scope, after sending
     * it a snapshot of where the session is now.
     *
     * The snapshot comes first and it comes to this attachment only: a client
     * that joins late has to be told the whole state before a delta means
     * anything, and a client that is already attached must not be sent a
     * second one.
     */
    readonly attachStream: (
      input: EditorSessionAttachInput,
      emit: Listener,
    ) => Effect.Effect<() => void, EditorSessionError>;
    readonly input: (input: EditorSessionInputInput) => Effect.Effect<void, EditorSessionError>;
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
   * One permit per thread, held for a whole session lifecycle operation.
   *
   * The map reference is synchronized, and that is not enough on its own: a
   * `Session` is a mutable object living inside it, and every field that
   * matters — which file the window shows, how many clients are attached,
   * whether it is still alive — is written outside the reference. Two `open`
   * calls for one thread would otherwise both find no session, both spawn a
   * Neovim, and the second would overwrite the first in the map, leaving a
   * live process nothing can reach and nothing will ever kill.
   *
   * Taken from `terminal/Manager.ts`, which had the same problem first.
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
   * A counter, not a clock.
   *
   * Eviction only needs to know which session was used least recently, and a
   * counter answers that exactly. A wall clock would answer it too, and would
   * also make this depend on time, which is a service to thread through and a
   * thing for a test to have to control.
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
   * Resolves a path inside the project, the same way a read does.
   *
   * Neovim is given the name and never opens the file, so this is not an
   * access check — but a name is still something the developer did not ask
   * for, and a buffer called `../../.ssh/id_rsa` would be shown to them as
   * though it were theirs.
   */
  const resolveWithinRoot = (threadId: string, cwd: string, relativePath: string) =>
    Effect.gen(function* () {
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
  const deliverNow = (session: Session, event: EditorSessionEvent) =>
    Effect.gen(function* () {
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
  const stopSession = (session: Session, reason: EditorSessionEndReason) =>
    Effect.gen(function* () {
      session.unsubscribe?.();
      session.unsubscribe = null;
      yield* deliverNow(session, { type: "exited", code: null, reason });
      session.listeners.clear();
      yield* Scope.close(session.scope, Effect.void as never).pipe(
        Effect.catchCause(() => Effect.void),
      );
    });

  /**
   * Lets the oldest unattached session go once there are too many.
   *
   * By whether anybody is attached rather than by age alone: a session
   * somebody is looking at must never be taken away underneath them, however
   * long ago it started. The consequence, said out loud rather than left to be
   * discovered: when every session is attached this evicts nothing, so the
   * limit bounds idle sessions and not live ones. A developer with thirty
   * threads open at once really would be running thirty Neovims. That is the
   * right trade while the alternative is closing an editor somebody is typing
   * into, and it is the thing to revisit if it ever bites.
   */
  const evictIfNeeded = Effect.fn("EditorSessionManager.evictIfNeeded")(function* (
    /**
     * How many sessions are about to join. Eviction runs before the new
     * session is in the map — so that it can never choose the one being
     * opened — which means it has to be told that one is coming.
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
   * Starts a Neovim for a thread and wires its notifications to the listeners.
   *
   * `cwd` is the thread's project, and it is not optional in practice: the
   * configuration's plugins root themselves at Neovim's working directory. Left
   * at the server's own (the home directory, for the installed service),
   * neo-tree built a tree of the whole home directory and re-rendered it on
   * every edit — measured at 100% CPU and 1.7 GB, with each keystroke waiting
   * ten seconds or more behind it.
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
      Effect.catchCause(() => Effect.void),
      Effect.forkIn(scope),
    );

    return session;
  });

  const dropSession = (threadId: string, reason: EditorSessionEndReason) =>
    Effect.gen(function* () {
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

  const lookup = (threadId: string) =>
    Effect.gen(function* () {
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
   * Where the session is now.
   *
   * `withHighlightDefinitions` is for a client that has none of them yet: one
   * that just attached, or every client after a restart renumbered them.
   * Definitions otherwise go out once per session, so a client that attached
   * later — a reload, a second window — never had the colours: flash's labels
   * were drawn with no background over the letters they replace, and its
   * dimmed backdrop was not dimmed. A file switch leaves them out, because
   * every attached client already holds them and a long session has thousands.
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
  const trimBuffers = (session: Session) =>
    Effect.gen(function* () {
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
          // Everything a reader could need is set *before* the session becomes
          // reachable. Published first and filled in after, an attachment that
          // arrived in between would find a session with no file and send a
          // snapshot whose `relativePath` is empty — which the contract
          // refuses, so the client would get an encoding failure rather than
          // an editor.
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
        // Not `session.currentPath` yet. The path is what every snapshot and
        // every published `lines` event is attributed to, so committing it
        // before the buffer actually exists means a failure anywhere below
        // leaves a live session naming the new file while the mirror still
        // carries the old one's text — and the next attachment gets that pair
        // and saves it. It is set once the mirror is on the buffer, just
        // before the snapshot is built. Nothing has to be restored on failure:
        // leaving it alone *is* the restore, because the old value is still
        // there. A session created by this very call is dropped by the
        // `tapCause` below, so its early assignment cannot outlive a failure
        // either.
        session.buffers.set(absolutePath, {
          relativePath: input.relativePath,
          absolutePath,
          lastUsedAt: now(),
        });
        yield* trimBuffers(session);

        // The buffer `mesura.open` returns is the one the mirror must follow,
        // and it is taken here rather than left to the `BufEnter`
        // announcement. That announcement is a notification and lands whenever
        // the notification fiber reaches it, which can be after the snapshot
        // below is built — and a snapshot built from the previous buffer sends
        // the client somebody else's text as the file it asked for. Under a
        // configuration that restores a session or opens a picker at start,
        // that somebody else is a plugin, and the client then saves a plugin's
        // window over the file. Measured: a workflow file and a source file
        // were both reduced to a picker's one-line prompt this way.
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
        // Every attachment is told which file the session now has open, not
        // just the caller. One session serves the whole thread, so a client
        // that does not learn about the switch would keep applying this
        // buffer's line events to the file it still believes is open.
        // Held text goes first: the snapshot already contains it, and a
        // `lines` event arriving after it would be applied a second time.
        session.releaseHeld();
        publish(session, { type: "snapshot", snapshot });
        return snapshot;
      }).pipe(
        // A session that could not be opened is not a session. Left in the
        // map it would hold a Neovim, occupy one of the slots, and claim to be
        // showing a file it never opened.
        Effect.tapCause(() => (created ? dropSession(input.threadId, "closed") : Effect.void)),
      ),
    );
  });

  /**
   * Turns what a session reports into wire events.
   *
   * Three kinds arrive. Text comes as `lines`, passed through in Neovim's own
   * zero-based half-open terms rather than translated, so the off-by-one lives
   * in one place instead of somewhere nobody looks. A frame carries the cursor
   * and mode, which are read rather than taken from the redraw stream because
   * the stream's own cursor lags a mapping that has already run. And
   * `mesura:write` is the one that is not drawing at all: Neovim asking for
   * the buffer to be saved, which the host answers because the host, not
   * Neovim, owns the file.
   */
  const wireNotifications = (session: Session) => {
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
     * Events held back while a key's text waits for the cursor it moved.
     *
     * A `lines` event arrives before the frame that draws it. Published as
     * it came, it left in a stream chunk of its own, and the RPC server sends
     * the next chunk only after the client's Ack: the caret trailed the letter
     * it typed by a whole round trip. So from a `lines` event on, everything is
     * held, in order, and published together at the frame. The host plugin
     * pushes the cursor ahead of that frame, so normally nothing waits on
     * Neovim. When no push came, the frame forks a cursor read and the text
     * waits for it; a watchdog bounds that wait for a read Neovim cannot
     * answer while its main loop is held.
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

      // A frame. Under a real configuration these arrive about every four
      // milliseconds whether or not anything changed, so nothing is sent
      // unless the cursor or the mode actually moved — otherwise an idle
      // session would push a couple of hundred messages a second saying
      // nothing.
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
  };

  const requireSession = (threadId: string) => lookup(threadId);

  /**
   * Gives Neovim `keys`, from byte `progress.accepted` on, until it has all.
   *
   * `nvim_input` answers how many bytes it took, and takes fewer once its
   * input buffer is full: the rest is sent again once Neovim has read some.
   * One request per batch in the normal case.
   */
  /**
   * Gives the buffer's grid `cols` columns and `rows` rows.
   *
   * The buffer's own grid, not the outer one. With `ext_multigrid` the outer
   * grid is the whole screen and resizing it leaves the window inside it
   * whatever size it was, so the columns a flash label needs never reach the
   * grid the label is drawn on. The id is not a constant: the redraw stream
   * assigns it, and the bridge is what reads that stream. Before the first
   * `win_pos` there is nothing to resize but the outer grid.
   */
  const resizeGrid = (session: Session, cols: number, rows: number) =>
    Effect.gen(function* () {
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
  const growGridFor = (session: Session, keys: string) =>
    Effect.gen(function* () {
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
      // A change nothing predicted (a mapping, a completion, a paste wider
      // than the bound left room for) can still have scrolled the window
      // sideways. Once the grid is wide enough again, scrolling back is what
      // takes the shift away: Neovim does not undo it on a wider grid by
      // itself, and it keeps the cursor in view if 0 would hide it.
      // Only when the line fits: past the bound the shift is the window's
      // to keep, and resetting it would redraw every row on every key.
      if (
        bridge.leftColumn > 0 &&
        lineFits(bridge.lines[bridge.cursor.line - 1] ?? "", bridge.tabstop, session.grid.cols)
      ) {
        yield* request(session, "nvim_exec_lua", [RESET_LEFT_COLUMN_LUA, [bridge.attachedBuffer]]);
      }
    });

  const submitKeys = (session: Session, keys: string, progress: { accepted: number }) =>
    Effect.gen(function* () {
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
            return;
          }
          let receipt = session.inputReceipts.get(sequence.lane);
          if (receipt !== undefined && sequence.index < receipt.index) return;
          if (receipt !== undefined && sequence.index === receipt.index) {
            // Accepted by a Neovim that has since exited: the restored text
            // may or may not hold it, so it is neither applied nor resent.
            if (receipt.generation !== session.restarts) {
              return yield* new EditorSessionInputLostError({
                threadId: session.threadId,
                detail: "Neovim restarted after it took these keys",
              });
            }
            if (receipt.done) return;
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
    settleForTest: (input) =>
      Effect.gen(function* () {
        const session = (yield* SynchronizedRef.get(sessions)).get(input.threadId);
        if (session === undefined) return;
        yield* session.bridge.settle.pipe(Effect.catchCause(() => Effect.void));
      }),
  };

  const closeThread = (input: EditorSessionCloseInput) =>
    withThreadLock(input.threadId, dropSession(input.threadId, "closed"));

  /**
   * Puts a new Neovim under a session whose process exited.
   *
   * In the same session object, so the client's attachment — which holds the
   * session's listeners, not the process — keeps working and simply receives a
   * snapshot. The alternative left a thread whose editor answered nothing until
   * the server restarted: the attachment stayed open to a session with no
   * process behind it, and every call on it failed.
   *
   * The file is reopened with the text the mirror last held, which is the text
   * the client is showing. Neovim's undo history does not survive, and the
   * message says so. Bounded, because a configuration that kills Neovim at
   * start would otherwise restart it forever.
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
        yield* Scope.close(session.bridgeScope, Effect.void as never).pipe(
          Effect.catchCause(() => Effect.void),
        );

        if (session.restarts >= MAX_RESTARTS_PER_SESSION) {
          yield* giveUp(
            session,
            `Neovim exited ${session.restarts + 1} times; reopen the file to start it again.`,
          );
          return;
        }
        session.restarts += 1;
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
  const giveUp = (session: Session, text: string) =>
    Effect.gen(function* () {
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
 * One attachment as a stream, which is what the websocket layer serves.
 *
 * The attach runs on the stream's own fiber, so an attach that fails — no
 * session for the thread, as after a server restart — fails the stream and the
 * client hears it. REGRESSION: this was `Stream.callback` first, which runs its
 * registration on a forked fiber nothing watches. The failure vanished there,
 * the stream stayed open and silent, and the client never learned it had to
 * open the file again. A session that ends sends `exited`, and the stream ends
 * after it.
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
