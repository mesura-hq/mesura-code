import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { GridModel, type GridOverlay, type HighlightRun } from "./GridModel.ts";
import { HOST_PLUGIN_LUA, HOST_PLUGIN_RELATIVE_PATH } from "./hostPlugin.ts";
import { NvimAdapter, type NvimSpawnError } from "./NvimAdapter.ts";
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
    readonly input: (keys: string) => Effect.Effect<void, NvimRpcError>;
    readonly setLines: (lines: ReadonlyArray<string>) => Effect.Effect<void, NvimRpcError>;
    /** Resolves on the next `flush`, which is Neovim saying it finished drawing. */
    readonly awaitFlush: Effect.Effect<void>;
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
  /** Extra runtime paths prepended, for the developer's configuration later. */
  readonly extraArgs?: ReadonlyArray<string> | undefined;
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
  yield* fileSystem.makeDirectory(`${runtimeDirectory}/plugin`, { recursive: true });
  yield* fileSystem.writeFileString(pluginPath, HOST_PLUGIN_LUA);

  const process = yield* adapter.spawn({
    executable: options.executable ?? "nvim",
    args: [
      "--embed",
      "-n",
      ...(options.extraArgs ?? ["--clean"]),
      "--cmd",
      `set runtimepath^=${runtimeDirectory}`,
    ],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });

  const rpc = yield* makeNvimRpc({ write: process.write, data: process.stdout });

  const grid = new GridModel();
  let lines: string[] = [];
  let cursor: NvimCursor = { line: 1, col: 1 };
  let mode = "n";
  let overlays: ReadonlyArray<GridOverlay> = [];
  let highlightRuns: ReadonlyArray<HighlightRun> = [];
  let flushWaiters: Array<Deferred.Deferred<void>> = [];

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
    const [, , firstLine, lastLine, replacement] = params as [
      unknown,
      unknown,
      number,
      number,
      string[],
    ];
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

  yield* rpc.notifications.pipe(
    Stream.runForEach((notification: { method: string; params: ReadonlyArray<unknown> }) =>
      Effect.sync(() => {
        if (notification.method === "nvim_buf_lines_event") {
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
  yield* process.stderr.pipe(
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

  /** Asks for the cursor and mode rather than reading the redraw stream's. */
  const refreshCursorAndMode = Effect.gen(function* () {
    const position = (yield* rpc.request("nvim_win_get_cursor", [0])) as [number, number];
    const state = (yield* rpc.request("nvim_get_mode", [])) as { mode: string };
    cursor = { line: position[0], col: position[1] + 1 };
    mode = state.mode;
  });

  yield* rpc.request("nvim_ui_attach", [options.cols, options.rows, UI_OPTIONS]);
  // `0` rather than a handle read back from `nvim_get_current_buf`. A handle
  // arrives as a msgpack extension value and would have to be written back as
  // one; `0` means "the current buffer", which is the only buffer this session
  // has, so the round trip buys nothing and needs a write-side codec.
  yield* rpc.request("nvim_buf_attach", [0, true, {}]);
  lines = (yield* rpc.request("nvim_buf_get_lines", [0, 0, -1, false])) as string[];
  grid.setBufferLines(lines);
  yield* refreshCursorAndMode;

  // Deliberately redundant: the platform spawner already kills the child from
  // its own `acquireRelease`, so this is not what stops a leak. It is here so a
  // session that ends for its own reasons stops Neovim at a point this file
  // controls, and it is safe to remove if that ever stops being useful.
  yield* Effect.addFinalizer(() => process.kill("SIGTERM"));

  /** Sends keys and settles: the redraw, then the cursor and mode behind it. */
  const settleAfter = <A, E>(action: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      yield* action;
      yield* awaitFlush;
      yield* refreshCursorAndMode;
    });

  const session: NvimBridge.Session = {
    pid: process.pid,
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
    setLines: (next) =>
      settleAfter(rpc.request("nvim_buf_set_lines", [0, 0, -1, false, [...next]])),
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
export type NvimBridgeError = NvimSpawnError | NvimRpcError | PlatformError.PlatformError;

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
