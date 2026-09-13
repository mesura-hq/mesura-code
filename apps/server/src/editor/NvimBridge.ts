// @effect-diagnostics nodeBuiltinImport:off - the home and temp directories a launch defaults to.
import * as NodeOS from "node:os";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { GridModel, type GridOverlay, type HighlightRun } from "./GridModel.ts";
import { HOST_PLUGIN_LUA, HOST_PLUGIN_RELATIVE_PATH } from "./hostPlugin.ts";
import { NvimAdapter, type NvimSpawnError } from "./NvimAdapter.ts";
import {
  checkNvimVersion,
  NvimLaunchError,
  resolveNvimLaunch,
  NVIM_VERSION_FLOOR,
} from "./NvimLaunch.ts";
import { makeNvimRpc, type NvimRpcError } from "./NvimRpc.ts";

/**
 * One embedded Neovim, mirrored.
 *
 * The bridge owns three things that have to agree: the text, which arrives
 * incrementally through `nvim_buf_lines_event`; the screen, which arrives as
 * grid cells and is only meaningful read against the text; and the cursor and
 * mode, which are asked for rather than pushed because the redraw stream's own
 * cursor lags behind what a mapping has already done.
 *
 * Nothing here waits on a clock. Every settle point is a `flush` from Neovim or
 * the response to a request, which is what lets the conformance harness assert
 * equivalence rather than probability.
 */

export interface NvimCursor {
  readonly line: number;
  readonly col: number;
}

export declare namespace NvimBridge {
  export interface Session {
    readonly pid: number;
    /** The mirrored buffer, as Neovim reports it. */
    readonly lines: ReadonlyArray<string>;
    readonly cursor: NvimCursor;
    readonly mode: string;
    readonly topLine: number;
    readonly overlays: ReadonlyArray<GridOverlay>;
    readonly highlightRuns: ReadonlyArray<HighlightRun>;
    readonly request: (
      method: string,
      params: ReadonlyArray<unknown>,
    ) => Effect.Effect<unknown, NvimRpcError>;
    /**
     * Queues keys the way a keyboard does: asynchronously.
     *
     * Nothing in the protocol says when they have been consumed. `nvim_input`
     * answers as soon as the bytes are accepted, and under a real
     * configuration the request after it is commonly served first — measured,
     * with `f` under flash: the keys were accepted, the following request
     * reported no change, and the mapping fired afterwards. Use this for keys
     * that come from a person, and `type` when the caller has to know.
     */
    readonly input: (keys: string) => Effect.Effect<void, NvimRpcError>;
    /**
     * Types keys and returns once Neovim has executed them.
     *
     * `nvim_feedkeys` with the `m`, `t` and `x` flags: remapped, treated as
     * typed, and executed before the call answers. That makes it the exact
     * settle a harness needs. It is not a replacement for `input` on the path
     * a person types: `x` finishes the typeahead, so an operator sent on its
     * own — `d`, waiting for a motion — would be aborted rather than left
     * pending. Send whole sequences through it.
     */
    readonly type: (keys: string) => Effect.Effect<void, NvimRpcError>;
    readonly setLines: (lines: ReadonlyArray<string>) => Effect.Effect<void, NvimRpcError>;
    /** Resolves on the next `flush`, which is Neovim saying it finished drawing. */
    readonly awaitFlush: Effect.Effect<void>;
    /**
     * The same wait with no round trip behind it.
     *
     * `awaitFlush` asks Neovim for the cursor once the frame lands, and there
     * are frames after which Neovim will not answer: a plugin that reads a
     * key — flash waiting for a label — holds the main loop while its own
     * drawing is already on screen. Reading that drawing is exactly when this
     * is the one to use, because the frame arrives without being asked for.
     */
    readonly awaitFrame: Effect.Effect<void>;
    /**
     * Subscribes to the next frame now, and hands back the wait for it.
     *
     * Two steps because one is a race. A caller that sends a key and then
     * waits can lose: the frame the key caused can land in the gap between the
     * two, and the wait then belongs to a frame that has not been asked for —
     * which, on an idle Neovim, never arrives. Subscribing first closes the
     * gap, and it is the only way to time a key honestly.
     *
     * It resolves on the next frame, not on the next frame *this* caller
     * caused — nothing in the redraw stream says which key a frame belongs to.
     * A caller that needs to know its number is not contaminated has to bound
     * that itself, by measuring how often frames arrive with no key in flight.
     *
     * A subscription abandoned after a timeout stays in the queue and is
     * resolved by the next frame with nobody listening. That is harmless and
     * deliberate: dropping it would need a handle this returns no room for.
     */
    readonly nextFrame: Effect.Effect<Effect.Effect<void>>;
    /**
     * Monotonic counters, for measuring what a keystroke costs.
     *
     * Read either side of a key: the difference is that key's drawing and text
     * traffic. `frames` counts flushes, so a difference of zero says the key
     * caused no frame at all rather than a cheap one.
     */
    readonly metrics: {
      readonly gridCells: number;
      readonly cursorMoves: number;
      readonly bufferEvents: number;
      readonly frames: number;
    };
    /**
     * Waits until every key given has been executed and the mirror has caught
     * up with it.
     *
     * This is the settle point to use after sending keys, and `awaitFlush` is
     * not. Waiting for the next `flush` only works when the only thing drawing
     * is the key just sent, which is true of a bare Neovim and false of a real
     * configuration: a status line, a notifier and a plugin's timer all draw
     * on their own, so the next frame is usually not the one the key caused.
     */
    readonly settle: Effect.Effect<void, NvimRpcError>;
    /**
     * Milliseconds from a key going in to the redraw it caused coming back.
     *
     * The key must be one that actually changes the screen. A key that changes
     * nothing produces no redraw, so there is no frame to time and this waits
     * for one that never arrives.
     */
    readonly floorProbe: (keys: string) => Effect.Effect<number, NvimRpcError>;
  }
}

export interface NvimBridgeOptions {
  readonly cols: number;
  readonly rows: number;
  readonly executable?: string | undefined;
  readonly cwd?: string | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
  /**
   * The developer's configuration directory, `~` allowed.
   *
   * Left out, the session starts `--clean`: no configuration, no plugins.
   * That is what the conformance harness drives, and it is never what a real
   * editor session gets — a missing configuration directory is reported as a
   * `config-missing` error rather than quietly becoming a bare Neovim.
   */
  readonly configDirectory?: string | undefined;
  /** Overridable so the launch can be driven against a temporary home. */
  readonly homeDir?: string | undefined;
  /** The server state directory the scratch config home is built under. */
  readonly stateDir?: string | undefined;
  /** A file to open at startup. See `NvimLaunchInput.initialFile` for why. */
  readonly initialFile?: string | undefined;
  /** Raised in tests to prove the floor is enforced rather than declared. */
  readonly minimumVersion?:
    | { readonly major: number; readonly minor: number; readonly patch: number }
    | undefined;
}

const UI_OPTIONS = {
  rgb: true,
  ext_linegrid: true,
  ext_multigrid: true,
  ext_hlstate: true,
  ext_cmdline: true,
  ext_messages: true,
  ext_popupmenu: true,
  ext_tabline: true,
} as const;

const spawn = Effect.fn("NvimBridge.spawn")(function* (options: NvimBridgeOptions) {
  const adapter = yield* NvimAdapter;
  const fileSystem = yield* FileSystem.FileSystem;

  // The host plugin lives in a scratch runtime path that dies with the scope.
  const runtimeDirectory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "mesura-nvim-" });
  const pluginPath = `${runtimeDirectory}/${HOST_PLUGIN_RELATIVE_PATH}`;
  yield* fileSystem.makeDirectory(pluginPath.slice(0, pluginPath.lastIndexOf("/")), {
    recursive: true,
  });
  yield* fileSystem.writeFileString(pluginPath, HOST_PLUGIN_LUA);

  const launch =
    options.configDirectory === undefined
      ? {
          executable: "nvim",
          // No configuration at all, which is the harness's case and never a
          // real session's.
          args: [
            "--embed",
            "-n",
            "--clean",
            "--cmd",
            `set runtimepath^=${runtimeDirectory}`,
            "-c",
            `lua dofile([[${pluginPath}]])`,
          ],
          env: options.env,
        }
      : yield* resolveNvimLaunch({
          configDirectory: options.configDirectory,
          env: options.env ?? (process.env as Record<string, string | undefined>),
          homeDir: options.homeDir ?? NodeOS.homedir(),
          runtimeDir: runtimeDirectory,
          hostPluginPath: pluginPath,
          stateDir: options.stateDir ?? NodeOS.tmpdir(),
          ...(options.initialFile === undefined ? {} : { initialFile: options.initialFile }),
        });

  const child = yield* adapter.spawn({
    executable: options.executable ?? launch.executable,
    args: launch.args,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(launch.env === undefined ? {} : { env: launch.env }),
  });

  const rpc = yield* makeNvimRpc({ write: child.write, data: child.stdout });

  const grid = new GridModel();
  /** The buffer the mirror is following. Buffer numbers work as plain integers. */
  let attachedBuffer = 0;
  let lines: string[] = [];
  let cursor: NvimCursor = { line: 1, col: 1 };
  let mode = "n";
  let overlays: ReadonlyArray<GridOverlay> = [];
  let highlightRuns: ReadonlyArray<HighlightRun> = [];
  let flushWaiters: Array<Deferred.Deferred<void>> = [];
  let bufferEvents = 0;
  let frames = 0;
  /** Markers handed out by `settle`, resolved when Neovim sends them back. */
  let settleSequence = 0;
  const settleWaiters = new Map<number, Deferred.Deferred<void>>();

  const releaseFlushWaiters = () => {
    const waiting = flushWaiters;
    flushWaiters = [];
    for (const waiter of waiting) Deferred.doneUnsafe(waiter, Effect.void);
  };

  /**
   * Applies one `nvim_buf_lines_event`, the incremental text path.
   *
   * With one correction Neovim does not send. A buffer can never hold zero
   * lines: delete every line and Neovim reports the deletion, then silently
   * puts a single empty line back without telling attached clients about it.
   * A mirror that applies the event faithfully therefore ends up empty while
   * `nvim_buf_get_lines` answers `[""]` — one line apart, which is enough to
   * write an empty file over a real one on the next save. Found by driving
   * `ggVGd`, which none of the ordinary delete sequences reaches.
   */
  const applyLinesEvent = (params: ReadonlyArray<unknown>) => {
    const [handle, , firstLine, lastLine, replacement] = params as [
      { id?: number } | undefined,
      unknown,
      number,
      number,
      string[],
    ];
    // A buffer the mirror has left can still have events in flight, and
    // applying one of them splices the previous file's text into this one.
    if (typeof handle?.id === "number" && handle.id !== attachedBuffer) return;
    // The trailing `more` flag is deliberately unread. It marks a large update
    // split across several events, and each chunk's splice is self-consistent,
    // so the settled mirror is right either way. Only a `flush` landing between
    // two chunks could show a momentary mismatch, which the next flush corrects.
    if (lastLine === -1) {
      lines = [...replacement];
    } else {
      lines.splice(firstLine, lastLine - firstLine, ...replacement);
    }
    if (lines.length === 0) lines = [""];
  };

  /**
   * Follows a buffer: leaves the previous one and re-reads the text.
   *
   * `nvim_buf_attach` takes a plain integer buffer number, so naming a buffer
   * the host was told about needs no write-side extension codec.
   */
  const attachTo = Effect.fn("NvimBridge.attachTo")(function* (buffer: number) {
    if (buffer === attachedBuffer) return;
    const previous = attachedBuffer;

    // Attach and read first, and only then say which buffer this is following.
    // Committing up front costs the session its mirror for good: the attach can
    // fail — the buffer was wiped, the session is going away — and the failure
    // is logged rather than fatal, so the field would name a buffer no event
    // will ever arrive for, and the `buffer === attachedBuffer` line above would
    // refuse every later attempt to attach to it again.
    yield* rpc.request("nvim_buf_attach", [buffer, true, {}]);
    const current = (yield* rpc.request("nvim_buf_get_lines", [buffer, 0, -1, false])) as string[];

    attachedBuffer = buffer;
    lines = current.length === 0 ? [""] : current;
    grid.setBufferLines(lines);

    // Last, so a detach that fails cannot leave the mirror following nothing.
    if (previous !== 0) {
      yield* rpc.request("nvim_buf_detach", [previous]).pipe(Effect.catchCause(() => Effect.void));
    }
  });

  yield* rpc.notifications.pipe(
    Stream.runForEach((notification: { method: string; params: ReadonlyArray<unknown> }) =>
      Effect.gen(function* () {
        if (notification.method === "mesura_settled") {
          const [marker] = notification.params as [number];
          const waiter = settleWaiters.get(marker);
          if (waiter !== undefined) {
            settleWaiters.delete(marker);
            Deferred.doneUnsafe(waiter, Effect.void);
          }
          return;
        }
        if (notification.method === "mesura_buffer_changed") {
          const [buffer] = notification.params as [number];
          if (typeof buffer === "number") {
            yield* attachTo(buffer).pipe(
              Effect.tapCause((cause) =>
                Effect.logWarning("could not follow a buffer change", { buffer, cause }),
              ),
              Effect.catchCause(() => Effect.void),
            );
          }
          return;
        }
        if (notification.method === "nvim_buf_lines_event") {
          bufferEvents += 1;
          applyLinesEvent(notification.params);
          grid.setBufferLines(lines);
          return;
        }
        if (notification.method !== "redraw") return;
        grid.applyRedraw(notification.params as ReadonlyArray<ReadonlyArray<unknown>>);
        const hasFlush = (notification.params as ReadonlyArray<ReadonlyArray<unknown>>).some(
          (event) => event[0] === "flush",
        );
        if (!hasFlush) return;
        frames += 1;
        const collected = grid.collect();
        overlays = collected.overlays;
        highlightRuns = collected.highlightRuns;
        releaseFlushWaiters();
      }),
    ),
    Effect.catchCause(() => Effect.void),
    Effect.forkScoped,
  );

  // Neovim's stderr is the only place a broken configuration explains itself.
  yield* child.stderr.pipe(
    Stream.runForEach((line: string) =>
      line.trim().length === 0 ? Effect.void : Effect.logWarning("nvim", { line }),
    ),
    Effect.catchCause(() => Effect.void),
    Effect.forkScoped,
  );

  const awaitFlush = Effect.gen(function* () {
    const waiter = yield* Deferred.make<void>();
    flushWaiters.push(waiter);
    yield* Deferred.await(waiter);
  });

  /**
   * Drains Neovim's typeahead, then waits for a notification sent behind it.
   *
   * Both halves are load-bearing, and neither is a clock.
   *
   * `nvim_feedkeys` with the `x` flag and an empty string answers only once
   * Neovim has executed every key it holds, so its response is proof the keys
   * ran — no guess about how many frames a mapping takes.
   *
   * The round trip after it is a barrier on a different fiber. Buffer events
   * are applied to the mirror by the fiber that drains the notification queue,
   * and a request's response is resolved directly, so a response can overtake
   * the events it caused and leave the mirror one edit behind. Asking Neovim
   * to send a notification puts a marker in the same stream, behind those
   * events; when the marker arrives, they have been applied.
   *
   * A forced frame was the obvious barrier and it is the wrong one: `:redraw`
   * emits nothing when nothing changed, so a key that draws nothing — `gg` at
   * the top of a buffer — waits for a frame that never comes.
   */
  const settle = Effect.gen(function* () {
    yield* rpc.request("nvim_feedkeys", ["", "x", false]);
    const marker = (settleSequence += 1);
    const waiter = yield* Deferred.make<void>();
    settleWaiters.set(marker, waiter);
    yield* rpc
      .request("nvim_exec_lua", [
        // Said out loud when the channel is missing, unlike the host plugin's
        // own announcement, which stays quiet. There the host may genuinely not
        // have introduced itself yet; here the caller is waiting for a reply
        // that would never come, and a clear failure beats a hang.
        `local channel = vim.g.mesura_channel
         if type(channel) ~= "number" then
           error("the host channel is not set, so nothing can be settled")
         end
         vim.rpcnotify(channel, 'mesura_settled', ...)`,
        [marker],
      ])
      .pipe(
        // The marker is dropped on the way out, so a failed round trip leaves
        // nothing behind in the table.
        Effect.tapCause(() => Effect.sync(() => settleWaiters.delete(marker))),
      );
    yield* Deferred.await(waiter);
    yield* refreshCursorAndMode;
  });

  /**
   * Asks for the cursor, the mode and the current window in one round trip.
   *
   * Asked for rather than read out of the redraw stream, because the stream's
   * own cursor lags behind what a mapping has already done. The window comes
   * along because the grid model cannot work it out: `win_pos` says where
   * every window is and never which one the developer is in.
   */
  const refreshCursorAndMode = Effect.gen(function* () {
    const state = (yield* rpc.request("nvim_exec_lua", [
      `local position = vim.api.nvim_win_get_cursor(0)
       return {
         line = position[1],
         col = position[2] + 1,
         mode = vim.api.nvim_get_mode().mode,
         window = vim.api.nvim_get_current_win(),
       }`,
      [],
    ])) as { line: number; col: number; mode: string; window: number };
    cursor = { line: state.line, col: state.col };
    mode = state.mode;
    grid.setCurrentWindow(state.window);
  });

  // The version is read before the UI is attached, so a Neovim too old to
  // drive is refused rather than half-connected. `jumpoptions+=view` restores
  // a jump to the wrong view below the floor and reports nothing, which is the
  // kind of defect that is blamed on the host for months.
  const apiInfo = yield* rpc.request("nvim_get_api_info", []);
  const versionError = checkNvimVersion(apiInfo, options.minimumVersion ?? NVIM_VERSION_FLOOR);
  if (versionError !== null) return yield* versionError;

  yield* rpc.request("nvim_ui_attach", [options.cols, options.rows, UI_OPTIONS]);

  // The host plugin cannot find the host's channel on its own, so the host
  // tells it. Until this lands the plugin stays quiet rather than guessing a
  // channel and writing into somebody else's.
  const channelId = Array.isArray(apiInfo) ? (apiInfo[0] as unknown) : null;
  if (typeof channelId === "number") {
    yield* rpc.request("nvim_set_var", ["mesura_channel", channelId]);
  }

  // Read back rather than passing `0`: the mirror has to know which buffer it
  // is on, so that a later buffer change is recognised as a change.
  const currentBuffer = (yield* rpc.request("nvim_exec_lua", [
    "return vim.api.nvim_get_current_buf()",
    [],
  ])) as number;
  yield* attachTo(currentBuffer);
  yield* refreshCursorAndMode;

  // Deliberately redundant: the platform spawner already kills the child from
  // its own `acquireRelease`, so this is not what stops a leak. It is here so a
  // session that ends for its own reasons stops Neovim at a point this file
  // controls, and it is safe to remove if that ever stops being useful.
  yield* Effect.addFinalizer(() => child.kill("SIGTERM"));

  /** Sends keys and settles: the redraw, then the cursor and mode behind it. */
  const settleAfter = <A, E>(action: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      yield* action;
      yield* awaitFlush;
      yield* refreshCursorAndMode;
    });

  const session: NvimBridge.Session = {
    pid: child.pid,
    get lines() {
      return lines;
    },
    get cursor() {
      return cursor;
    },
    get mode() {
      return mode;
    },
    get topLine() {
      return grid.topLine;
    },
    get overlays() {
      return overlays;
    },
    get highlightRuns() {
      return highlightRuns;
    },
    request: rpc.request,
    input: (keys) => rpc.request("nvim_input", [keys]).pipe(Effect.asVoid),
    type: (keys) =>
      Effect.gen(function* () {
        // Termcodes first: `<Esc>` and friends are notation, and `nvim_feedkeys`
        // takes bytes, so feeding the literal text would type five characters.
        const coded = yield* rpc.request("nvim_replace_termcodes", [keys, true, false, true]);
        yield* rpc.request("nvim_feedkeys", [coded, "mtx", false]);
        yield* refreshCursorAndMode;
      }),
    settle,
    setLines: (next) =>
      settleAfter(rpc.request("nvim_buf_set_lines", [0, 0, -1, false, [...next]])),
    awaitFrame: awaitFlush,
    nextFrame: Effect.gen(function* () {
      const waiter = yield* Deferred.make<void>();
      flushWaiters.push(waiter);
      return Deferred.await(waiter);
    }),
    get metrics() {
      return { gridCells: grid.cellsDrawn, cursorMoves: grid.cursorMoves, bufferEvents, frames };
    },
    awaitFlush: Effect.gen(function* () {
      yield* awaitFlush;
      // Said out loud rather than swallowed. A Neovim that has died fails this
      // call, and reporting a clean settle with a stale cursor would be the one
      // place this bridge lies — in a design whose whole premise is waiting for
      // a real event rather than for a clock.
      yield* refreshCursorAndMode.pipe(
        Effect.tapCause((cause) =>
          Effect.logWarning("could not read the cursor after a redraw", { cause }),
        ),
        Effect.catchCause(() => Effect.void),
      );
    }),
    floorProbe: (keys) =>
      Effect.gen(function* () {
        const started = performance.now();
        yield* rpc.request("nvim_input", [keys]);
        yield* awaitFlush;
        return performance.now() - started;
      }),
  };

  return session;
});

/** Everything opening a session can fail with, named rather than widened. */
export type NvimBridgeError =
  | NvimSpawnError
  | NvimRpcError
  | NvimLaunchError
  | PlatformError.PlatformError;

export const NvimBridge = {
  spawn,
} satisfies {
  readonly spawn: (
    options: NvimBridgeOptions,
  ) => Effect.Effect<
    NvimBridge.Session,
    NvimBridgeError,
    NvimAdapter | FileSystem.FileSystem | Scope.Scope
  >;
};
