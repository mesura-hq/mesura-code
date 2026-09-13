// @effect-diagnostics nodeBuiltinImport:off - the home directory a launch defaults to.
import * as NodeOS from "node:os";
import {
  type EditorHighlightDefinition,
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
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { APPLY_EDITS_LUA, SET_CURSOR_LUA, SET_VIEWPORT_LUA } from "./hostPlugin.ts";
import { NvimAdapter } from "./NvimAdapter.ts";
import { NvimBridge } from "./NvimBridge.ts";

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

type Listener = (event: EditorSessionEvent) => Effect.Effect<void>;

interface OpenBuffer {
  readonly relativePath: string;
  readonly absolutePath: string;
  lastUsedAt: number;
}

interface Session {
  readonly threadId: string;
  readonly bridge: NvimBridge.Session;
  readonly scope: Scope.Closeable;
  readonly listeners: Set<Listener>;
  /**
   * Events on their way to the listeners.
   *
   * A queue rather than a call straight through, because the bridge tells its
   * watchers from a plain callback and a listener is an Effect. One fiber
   * drains this, so events reach every attachment in the order Neovim produced
   * them rather than in whatever order a scheduler happened to pick.
   */
  readonly outbox: Queue.Queue<EditorSessionEvent>;
  /** Keyed by absolute path, so two threads with the same file do not collide. */
  readonly buffers: Map<string, OpenBuffer>;
  /** The file the window is showing now. */
  currentPath: string | null;
  attachedClients: number;
  lastActivityAt: number;
  /** Stops the bridge subscription when the session goes. */
  unsubscribe: (() => void) | null;
}

export interface EditorSessionManagerOptions {
  /** Where Neovim reads its configuration. Normally the server setting. */
  readonly configDirectory: string;
  readonly stateDir: string;
  readonly homeDir?: string | undefined;
  readonly maxSessions?: number | undefined;
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

  const publish = (session: Session, event: EditorSessionEvent) => {
    Queue.offerUnsafe(session.outbox, event);
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

  const stopSession = (session: Session) =>
    Effect.gen(function* () {
      session.unsubscribe?.();
      session.unsubscribe = null;
      session.listeners.clear();
      yield* Scope.close(session.scope, Effect.void as never).pipe(
        Effect.catchCause(() => Effect.void),
      );
    });

  /**
   * Lets the oldest unattached session go once there are too many.
   *
   * By `attachedClients` rather than by age alone: a session somebody is
   * looking at must never be taken away underneath them, however long ago it
   * was started. A session nobody is attached to costs a Neovim and its
   * plugins, which is worth reclaiming.
   */
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
    yield* Effect.forEach(doomed, stopSession, { discard: true });
  });

  /** Starts a Neovim for a thread and wires its notifications to the listeners. */
  const startSession = Effect.fn("EditorSessionManager.startSession")(function* (threadId: string) {
    const scope = yield* Scope.make();
    const bridge = yield* NvimBridge.spawn({
      cols: 120,
      rows: 40,
      configDirectory: options.configDirectory,
      stateDir: options.stateDir,
      homeDir: options.homeDir ?? NodeOS.homedir(),
    }).pipe(
      Scope.provide(scope),
      Effect.provideService(NvimAdapter, adapter),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.mapError((cause) => spawnErrorFor(threadId, cause)),
      Effect.tapCause(() => Scope.close(scope, Effect.void as never)),
    );

    const outbox = yield* Queue.make<EditorSessionEvent>().pipe(Scope.provide(scope));

    const session: Session = {
      threadId,
      bridge,
      scope,
      outbox,
      listeners: new Set(),
      buffers: new Map(),
      currentPath: null,
      attachedClients: 0,
      lastActivityAt: now(),
      unsubscribe: null,
    };

    yield* Queue.takeBetween(outbox, 1, Number.MAX_SAFE_INTEGER).pipe(
      Effect.flatMap((events) =>
        Effect.forEach(
          events,
          (event) =>
            Effect.forEach(session.listeners, (listener) => listener(event), { discard: true }),
          { discard: true },
        ),
      ),
      Effect.forever,
      Effect.catchCause(() => Effect.void),
      Effect.forkIn(scope),
    );

    return session;
  });

  const dropSession = (threadId: string) =>
    Effect.gen(function* () {
      let doomed: Session | undefined;
      yield* SynchronizedRef.update(sessions, (current) => {
        doomed = current.get(threadId);
        if (doomed === undefined) return current;
        const next = new Map(current);
        next.delete(threadId);
        return next;
      });
      if (doomed !== undefined) yield* stopSession(doomed);
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

  const snapshotOf = (session: Session): EditorSessionSnapshot => ({
    relativePath: session.currentPath ?? "",
    lines: [...session.bridge.lines],
    cursor: session.bridge.cursor,
    mode: session.bridge.mode,
    topline: Math.max(1, session.bridge.topLine + 1),
    hlDefs: {},
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
    const absolutePath = yield* resolveWithinRoot(input.threadId, input.cwd, input.relativePath);

    // Set inside the lock, read by the repair below. A local rather than
    // shared state: only this call can be inside the lock for this thread.
    let created = false;

    return yield* withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const existing = (yield* SynchronizedRef.get(sessions)).get(input.threadId);
        const session = existing ?? (yield* startSession(input.threadId));

        if (existing === undefined) {
          created = true;
          // Everything a reader could need is set *before* the session becomes
          // reachable. Published first and filled in after, an attachment that
          // arrived in between would find a session with no file and send a
          // snapshot whose `relativePath` is empty — which the contract
          // refuses, so the client would get an encoding failure rather than
          // an editor.
          session.currentPath = input.relativePath;
          wireNotifications(session);

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
        const snapshot = snapshotOf(session);
        // Every attachment is told which file the session now has open, not
        // just the caller. One session serves the whole thread, so a client
        // that does not learn about the switch would keep applying this
        // buffer's line events to the file it still believes is open.
        publish(session, { type: "snapshot", snapshot });
        return snapshot;
      }).pipe(
        // A session that could not be opened is not a session. Left in the
        // map it would hold a Neovim, occupy one of the slots, and claim to be
        // showing a file it never opened.
        Effect.tapCause(() => (created ? dropSession(input.threadId) : Effect.void)),
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
    let lastTopline = -1;
    const sentHighlightIds = new Set<number>();
    let lastVisual = "";

    const unsubscribe = session.bridge.subscribe((event) => {
      if (event.kind === "lines") {
        publish(session, {
          type: "lines",
          first: event.first,
          last: event.last,
          lines: [...event.lines],
        });
        return;
      }

      if (event.kind === "cmdline") {
        publish(session, { type: "cmdline", cmdline: event.cmdline });
        return;
      }

      if (event.kind === "message") {
        publish(session, { type: "message", kind: event.messageKind, text: event.text });
        return;
      }

      if (event.kind === "notification") {
        if (event.method !== "mesura:write") return;
        const absolutePath = String(event.params[0] ?? "");
        const buffer = session.buffers.get(absolutePath);
        if (buffer === undefined) return;
        publish(session, { type: "writeRequested", relativePath: buffer.relativePath });
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
        publish(session, { type: "cursor", line, col });
      }
      if (session.bridge.mode !== lastMode) {
        lastMode = session.bridge.mode;
        publish(session, { type: "mode", mode: lastMode, blocking: false });
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
        publish(session, { type: "visual", visual });
      }

      // Everything drawn over the text: flash's labels, the search highlight,
      // a plugin's virtual text. Sent per frame and only for the lines whose
      // drawing moved, because the alternative is the whole window on every
      // one of the two hundred frames a second an idle session produces.
      if (event.kind === "flush" && event.changedLines.length > 0) {
        const changed = new Set(event.changedLines);
        // The definitions first, in the same frame. A run that arrives naming
        // a colour the client has never been given is drawn in no colour at
        // all, and the id is the only thing the drawing refers to.
        const unseen: Record<string, EditorHighlightDefinition> = {};
        for (const [id, definition] of session.bridge.highlightDefinitions) {
          if (sentHighlightIds.has(id)) continue;
          sentHighlightIds.add(id);
          unseen[String(id)] = definition;
        }
        if (Object.keys(unseen).length > 0) publish(session, { type: "hlDefs", hlDefs: unseen });

        publish(session, {
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
        publish(session, { type: "viewport", topline, botline });
      }
    });

    session.unsubscribe = unsubscribe;
  };

  const requireSession = (threadId: string) => lookup(threadId);

  const service: EditorSessionManager["Service"] = {
    open,
    attachStream: (input, emit) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const session = yield* requireSession(input.threadId);
          // The snapshot goes to this attachment alone, and before the listener
          // is registered, so a delta cannot arrive ahead of the state it edits.
          yield* emit({ type: "snapshot", snapshot: snapshotOf(session) });
          session.listeners.add(emit);
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
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const session = yield* requireSession(input.threadId);
          yield* request(session, "nvim_input", [input.keys]);
        }),
      ),
    viewport: (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const session = yield* requireSession(input.threadId);
          // The buffer's own grid, not the outer one. With `ext_multigrid` the
          // outer grid is the whole screen and resizing it leaves the window
          // inside it whatever size it was, so the columns a flash label needs
          // never reach the grid the label is drawn on. The id is not a
          // constant: the redraw stream assigns it, and the bridge is what
          // reads that stream. Before the first `win_pos` there is nothing to
          // resize but the outer grid.
          const gridId = session.bridge.bufferGridId;
          yield* request(
            session,
            gridId === null ? "nvim_ui_try_resize" : "nvim_ui_try_resize_grid",
            gridId === null ? [input.cols, input.rows] : [gridId, input.cols, input.rows],
          );
          yield* request(session, "nvim_exec_lua", [
            SET_VIEWPORT_LUA,
            [session.bridge.attachedBuffer, input.topline, input.rows],
          ]);
        }),
      ),
    setCursor: (input) =>
      withThreadLock(
        input.threadId,
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
      withThreadLock(
        input.threadId,
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
    withThreadLock(input.threadId, dropSession(input.threadId));

  // Every session is a child process, so the server stopping has to stop them.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const current = yield* SynchronizedRef.get(sessions);
      yield* SynchronizedRef.set(sessions, new Map());
      yield* Effect.forEach(current.values(), stopSession, { discard: true });
    }),
  );

  return service;
});

export const make = Effect.fn("EditorSessionManager.make")(function* () {
  const config = yield* ServerConfig;
  const settings = yield* ServerSettingsService;
  const current = yield* settings.getSettings.pipe(
    Effect.catchCause(() => Effect.succeed({ neovimConfigDirectory: "~/.neovim" })),
  );
  return yield* makeWithOptions({
    configDirectory: current.neovimConfigDirectory,
    stateDir: config.neovimRuntimeDir,
  });
});

export const layer = Layer.effect(EditorSessionManager, make());
