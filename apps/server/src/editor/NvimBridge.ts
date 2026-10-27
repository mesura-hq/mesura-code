// @effect-diagnostics nodeBuiltinImport:off - the home and temp directories a launch defaults to.
import * as NodeOS from "node:os";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { EditorHighlightDefinition } from "@t3tools/contracts";

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
 * One embedded Neovim, mirrored. The text arrives through `nvim_buf_lines_event` and the screen
 * as grid cells. The cursor and mode are requested, because the redraw stream's cursor lags behind
 * what a mapping already did. Nothing waits on a clock: every settle point is a `flush` or a
 * response, so the conformance harness can assert equivalence rather than probability.
 */

/**
 * What a frame says about whether the cursor is worth asking for. Pure and exported so a test can
 * hold each trigger alone: through a real Neovim they overlap (a half-page scroll changes the
 * viewport and redraws every row), so a behavioural test still passes with any one deleted.
 */
export interface CursorReadTrigger {
  /** Neovim changed mode in this batch. */
  readonly hasModeChange: boolean;
  /** Neovim reported a new viewport in this batch. */
  readonly hasViewport: boolean;
  /** How many buffer rows this frame redrew. */
  readonly changedRows: number;
  /** The grid's cursor-move count now. */
  readonly cursorMoves: number;
  /** The same count as of the last time the cursor was read. */
  readonly lastCursorMoves: number;
}

/**
 * Each trigger catches keys the others miss: `cursorMoves` (`hjkl`, arrows), `hasModeChange` (`i`
 * at line start moves nothing), `hasViewport` (`<C-d>` scrolls under a cursor that keeps its row,
 * so no `grid_cursor_goto`), `changedRows` (a long line scrolling sideways under a cursor at the
 * last column). Idle frames, about 230 a second under a real config, match none of them.
 */
export function shouldReadCursor(trigger: CursorReadTrigger): boolean {
  return (
    trigger.hasModeChange ||
    trigger.hasViewport ||
    trigger.changedRows > 0 ||
    trigger.cursorMoves !== trigger.lastCursorMoves
  );
}

/** What the host plugin's `mesura.cursor_state` answers. */
interface CursorState {
  readonly line: number;
  readonly col: number;
  readonly mode: string;
  readonly anchor?: { readonly line: number; readonly col: number } | null;
  readonly window: number;
  readonly tabstop: number;
  readonly jumping: boolean;
  /** The window's `leftcol`; absent from a plugin older than the host. */
  readonly leftcol?: number;
}

/**
 * What a session tells whoever is watching it. It stays close to what Neovim said: turning a
 * redraw into something drawable belongs to the client, and each surface does it differently.
 */
export type NvimBridgeEvent =
  | {
      /**
       * Neovim's output ended, which is the process ending. Nothing after this
       * is answered; the watcher decides whether a new process takes over.
       */
      readonly kind: "exited";
    }
  | {
      /**
       * The cursor and mode were re-read and are now current. Not a `flush`: nothing was drawn.
       * `read` comes from the cursor read forked off the notification fiber, after its frame.
       * `push` comes from the host plugin's autocommand, before the frame that draws the key.
       */
      readonly kind: "cursor";
      readonly source: "push" | "read";
    }
  | {
      readonly kind: "lines";
      readonly first: number;
      readonly last: number;
      readonly lines: ReadonlyArray<string>;
    }
  | {
      readonly kind: "flush";
      /**
       * The buffer lines whose drawing moved since the last frame.
       *
       * Buffer lines rather than grid rows, because a row means nothing on its
       * own: the same row is a different line the moment the window scrolls,
       * and a client that took rows would move every label one row per scroll.
       */
      readonly changedLines: ReadonlyArray<number>;
    }
  | {
      readonly kind: "cmdline";
      /** `null` when the command line closed. */
      readonly cmdline: NvimCmdline | null;
    }
  | {
      readonly kind: "message";
      /** Neovim's own kind: `emsg` and `echoerr` are errors, `""` is plain. */
      readonly messageKind: string;
      readonly text: string;
    }
  | {
      readonly kind: "notification";
      readonly method: string;
      readonly params: ReadonlyArray<unknown>;
    };

/**
 * Joins the `[attribute, text]` chunks of a Neovim text line. The attribute ids are dropped: the
 * status strip draws in its own colours, and an error comes from `msg_show`'s kind instead.
 */
const joinChunks = (chunks: unknown): string =>
  Array.isArray(chunks)
    ? chunks.map((chunk) => (Array.isArray(chunk) ? String(chunk[1] ?? "") : "")).join("")
    : "";

/**
 * Converts Neovim's byte offset into a string index. `cmdline_show` and `cmdline_pos` count bytes,
 * so passing them through puts the caret in the wrong place for non-ASCII text such as `café`,
 * and the client should not have to know that.
 */
function characterIndexForByte(text: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    if (bytes >= byteOffset) return index;
    const codePoint = text.codePointAt(index) ?? 0;
    bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return text.length;
}

/**
 * Pulls the command line and the messages, already text, out of a redraw batch. `GridModel` reads
 * the rest. `previous` is needed because `cmdline_pos` moves the caret (`Left`, `Home`, `Ctrl-B`)
 * without resending the text. `msg_history_show` carries all of `:messages` as one event.
 */
function tellCmdlineAndMessages(
  batch: ReadonlyArray<ReadonlyArray<unknown>>,
  previous: NvimCmdline | null,
): { readonly events: ReadonlyArray<NvimBridgeEvent>; readonly cmdline: NvimCmdline | null } {
  const events: NvimBridgeEvent[] = [];
  let cmdline = previous;
  for (const entry of batch) {
    const name = entry[0];
    for (let index = 1; index < entry.length; index += 1) {
      const args = entry[index];
      if (!Array.isArray(args)) continue;
      if (name === "cmdline_show") {
        const content = joinChunks(args[0]);
        cmdline = {
          content,
          pos: characterIndexForByte(content, typeof args[1] === "number" ? args[1] : 0),
          firstc: String(args[2] ?? ""),
          prompt: String(args[3] ?? ""),
        };
        events.push({ kind: "cmdline", cmdline });
        continue;
      }
      if (name === "cmdline_pos") {
        if (cmdline === null) continue;
        cmdline = {
          ...cmdline,
          pos: characterIndexForByte(cmdline.content, typeof args[0] === "number" ? args[0] : 0),
        };
        events.push({ kind: "cmdline", cmdline });
        continue;
      }
      if (name === "cmdline_hide") {
        cmdline = null;
        events.push({ kind: "cmdline", cmdline: null });
        continue;
      }
      if (name === "msg_show") {
        const text = joinChunks(args[1]);
        if (text.length === 0) continue;
        events.push({ kind: "message", messageKind: String(args[0] ?? ""), text });
        continue;
      }
      if (name === "msg_history_show") {
        // `:messages`, as one event carrying every remembered message. Sent as
        // one message of its own rather than replayed one at a time: the strip
        // shows the last message, and replaying them would show only the last
        // line of the answer to a command that asked for all of them.
        const entries = Array.isArray(args[0]) ? args[0] : [];
        const text = entries
          .map((remembered) => (Array.isArray(remembered) ? joinChunks(remembered[1]) : ""))
          .filter((line) => line.length > 0)
          .join("\n");
        if (text.length === 0) continue;
        events.push({ kind: "message", messageKind: "history", text });
        continue;
      }
      if (name === "msg_clear") {
        events.push({ kind: "message", messageKind: "", text: "" });
      }
    }
  }
  return { events, cmdline };
}

/**
 * Neovim's highlight attributes, in the shape the wire carries.
 *
 * `reverse` and `undercurl` are kept because dropping them is visible: Vim's
 * own `Search` is commonly a reversed pair rather than two colours, and a
 * diagnostic's wavy underline read as a straight one looks like a link.
 */
const wireHighlightDefinitions = (
  definitions: ReadonlyMap<
    number,
    { attributes: Record<string, unknown>; groups: ReadonlySet<string> }
  >,
): ReadonlyMap<number, EditorHighlightDefinition> => {
  const wire = new Map<number, EditorHighlightDefinition>();
  for (const [id, definition] of definitions) {
    const attributes = definition.attributes;
    const flag = (name: string) => (attributes[name] === true ? true : undefined);
    const colour = (name: string) =>
      typeof attributes[name] === "number" ? (attributes[name] as number) : undefined;
    wire.set(id, {
      fg: colour("foreground"),
      bg: colour("background"),
      bold: flag("bold"),
      italic: flag("italic"),
      underline: flag("underline"),
      undercurl: flag("undercurl"),
      reverse: flag("reverse"),
      groups: [...definition.groups],
    });
  }
  return wire;
};

/** The command line as Neovim draws it, with `ext_cmdline` on. */
export interface NvimCmdline {
  readonly content: string;
  readonly pos: number;
  /** `:` for a command, `/` or `?` for a search. */
  readonly firstc: string;
  readonly prompt: string;
}

/**
 * A visual selection in Neovim's terms. Both ends are given because a selection made upwards has
 * its anchor below its cursor. `kind` is the mode, so `v`, `V` and Ctrl-V stay distinct.
 */
export interface NvimVisual {
  readonly anchor: NvimCursor;
  readonly cursor: NvimCursor;
  readonly kind: string;
}

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
    /** flash is labelling jump targets. Neovim's mode stays `n` meanwhile. */
    readonly jumping: boolean;
    /** The selection Neovim is showing, `null` outside visual mode. */
    readonly visual: NvimVisual | null;
    readonly topLine: number;
    /** The mirrored buffer's `tabstop`, which decides how wide a tab is drawn. */
    readonly tabstop: number;
    /** How far the window is scrolled sideways (`leftcol`), as last pushed. */
    readonly leftColumn: number;
    /** One past the last buffer line drawn, as `win_viewport` reports it. */
    readonly botLine: number;
    /** The grid the developer's window is drawn on, `null` until Neovim says. */
    readonly bufferGridId: number | null;
    readonly overlays: ReadonlyArray<GridOverlay>;
    /**
     * The colours Neovim has defined, by id, in the wire's shape. Neovim's raw attribute bag also
     * carries terminal colour indexes and blend levels that no client uses.
     */
    readonly highlightDefinitions: ReadonlyMap<number, EditorHighlightDefinition>;
    readonly highlightRuns: ReadonlyArray<HighlightRun>;
    readonly request: (
      method: string,
      params: ReadonlyArray<unknown>,
    ) => Effect.Effect<unknown, NvimRpcError>;
    /**
     * Queues keys asynchronously, like a keyboard: use it for keys from a person. `nvim_input`
     * answers on acceptance, and a later request is often served before the keys run (measured
     * with `f` under flash). Use `type` when the caller has to know the keys ran.
     */
    readonly input: (keys: string) => Effect.Effect<void, NvimRpcError>;
    /**
     * Points the mirror at a buffer the host owns, and waits for it. `open` builds its snapshot
     * from the mirror, and the announcement notification can land late. A snapshot taken before it
     * holds the previous buffer, often a plugin's, and the client then saves that over the file.
     */
    readonly followBuffer: (buffer: number) => Effect.Effect<void, NvimRpcError>;
    /**
     * The buffer the mirror is on. Every write must name it: the mirror and Neovim's current buffer
     * can differ (a plugin owning the window), so a write to buffer `0` lands in the wrong buffer.
     * `applyLinesEvent` then drops the resulting lines event, so nothing reports the lost edit.
     */
    readonly attachedBuffer: number;
    /**
     * Types keys and returns once Neovim executed them: `nvim_feedkeys` with the `m`, `t` and `x`
     * flags (remapped, typed, executed before it answers). Send whole sequences: `x` ends the
     * typeahead, so a lone operator such as `d` is aborted rather than left pending.
     */
    readonly type: (keys: string) => Effect.Effect<void, NvimRpcError>;
    readonly setLines: (lines: ReadonlyArray<string>) => Effect.Effect<void, NvimRpcError>;
    /** Resolves on the next `flush`, which is Neovim saying it finished drawing. */
    readonly awaitFlush: Effect.Effect<void>;
    /**
     * `awaitFlush` without the cursor round trip. Use it when Neovim cannot answer: a plugin that
     * reads a key (flash waiting for a label) holds the main loop with its drawing already sent.
     */
    readonly awaitFrame: Effect.Effect<void>;
    /**
     * Subscribes to the next frame now and returns the wait for it, so the frame a key causes
     * cannot land between sending the key and waiting (on an idle Neovim that wait never ends).
     * It resolves on the next frame from any cause: bound that by measuring the idle frame rate.
     * An abandoned subscription stays queued until a later frame resolves it, which is harmless.
     */
    readonly nextFrame: Effect.Effect<Effect.Effect<void>>;
    /**
     * Monotonic counters, for measuring what a keystroke costs.
     *
     * Read either side of a key: the difference is that key's drawing and text
     * traffic. `frames` counts flushes, so a difference of zero says the key
     * caused no frame at all rather than a cheap one.
     */
    /**
     * A cursor read is in flight, and a `cursor` event will follow it.
     *
     * Read by the manager to hold a key's text until its cursor lands, so the
     * two reach the client together.
     */
    readonly cursorReadPending: boolean;
    readonly metrics: {
      readonly gridCells: number;
      readonly cursorMoves: number;
      readonly bufferEvents: number;
      readonly frames: number;
      /** Cursor reads sent to Neovim: the request a pushed cursor makes unnecessary. */
      readonly cursorReads: number;
    };
    /**
     * Waits until every key sent has run and the mirror caught up. Use this after sending keys,
     * not `awaitFlush`: under a real configuration a status line, a notifier or a plugin timer
     * draws on its own, so the next frame is usually not the one the key caused.
     */
    readonly settle: Effect.Effect<void, NvimRpcError>;
    /**
     * Watches the session. Returns the call that stops watching.
     *
     * A set of listeners rather than a second stream: the notification queue
     * has one consumer by construction, and handing it out would mean the
     * mirror and the watcher racing for the same events.
     */
    readonly subscribe: (listener: (event: NvimBridgeEvent) => void) => () => void;
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
   * The developer's configuration directory, `~` allowed. Omitted, the session starts `--clean`,
   * which only the conformance harness uses. A real session with a missing directory gets a
   * `config-missing` error rather than a bare Neovim.
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
  /** Whether flash is labelling targets, read with the mode. */
  let jumping = false;
  let overlays: ReadonlyArray<GridOverlay> = [];
  let highlightRuns: ReadonlyArray<HighlightRun> = [];
  let flushWaiters: Array<Deferred.Deferred<void>> = [];
  let bufferEvents = 0;
  let frames = 0;
  let cursorReads = 0;
  /** A `mesura:cursor` push landed since the last frame. */
  let cursorPushed = false;
  /** The grid's cursor-move count as of the last time the cursor was read. */
  let lastCursorMoves = 0;
  /** Whether a forked cursor read is already on its way. */
  let cursorRefreshPending = false;
  /** A frame that wanted a cursor read while one was already on its way. */
  let cursorRefreshAgain = false;
  /** A `mode_change` seen since the last frame was judged. */
  let pendingModeChange = false;
  /** A `win_viewport` seen since the last frame was judged. */
  let pendingViewport = false;
  /** The command line as it stands, so `cmdline_pos` has something to move. */
  let lastCmdline: NvimCmdline | null = null;
  let visual: NvimVisual | null = null;
  const watchers = new Set<(event: NvimBridgeEvent) => void>();

  const tell = (event: NvimBridgeEvent) => {
    // A watcher that throws must not stop the mirror from applying the next
    // event; it is watching, and the mirror is the thing that has to be right.
    for (const watcher of watchers) {
      try {
        watcher(event);
      } catch {
        /* a watcher's problem is its own */
      }
    }
  };
  /** Markers handed out by `settle`, resolved when Neovim sends them back. */
  let settleSequence = 0;
  const settleWaiters = new Map<number, Deferred.Deferred<void>>();

  const releaseFlushWaiters = () => {
    const waiting = flushWaiters;
    flushWaiters = [];
    for (const waiter of waiting) Deferred.doneUnsafe(waiter, Effect.void);
  };

  /**
   * Applies one `nvim_buf_lines_event`, with one correction Neovim does not send: after deleting
   * every line (`ggVGd`), Neovim restores one empty line without an event. A mirror left empty
   * against Neovim's `[""]` would write an empty file over a real one on the next save.
   */
  const applyLinesEvent = (params: ReadonlyArray<unknown>) => {
    const [handle, changedtick, firstLine, lastLine, replacement] = params as [
      { id?: number } | undefined,
      number | null | undefined,
      number,
      number,
      string[],
    ];
    // A buffer the mirror has left can still have events in flight, and
    // applying one of them splices the previous file's text into this one.
    if (typeof handle?.id === "number" && handle.id !== attachedBuffer) return null;
    // A null `changedtick` is a display-only preview (`:help nvim_buf_lines_event`). `inccommand`
    // sends one per keystroke of an `:s`, each against the original text, so they do not compose
    // and applying them piles up fragments. The committed change arrives with a real tick.
    if (changedtick === null || changedtick === undefined) return null;
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
    return {
      kind: "lines" as const,
      first: firstLine,
      last: lastLine,
      lines: [...replacement],
    };
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

    // Attach and read before committing `attachedBuffer`. The attach can fail (buffer wiped,
    // session closing) and the failure is only logged. Committing first would name a buffer no
    // event arrives for, and the `buffer === attachedBuffer` guard would refuse every retry.
    yield* rpc.request("nvim_buf_attach", [buffer, true, {}]);
    const current = (yield* rpc.request("nvim_buf_get_lines", [buffer, 0, -1, false])) as string[];

    attachedBuffer = buffer;
    lines = current.length === 0 ? [""] : current;
    // The push reads tabstop and flash's labels from the mirrored buffer.
    yield* rpc.request("nvim_exec_lua", ["mesura.attached = ...", [buffer]]);
    grid.setBufferLines(lines);

    // Last, so a detach that fails cannot leave the mirror following nothing.
    if (previous !== 0) {
      yield* rpc.request("nvim_buf_detach", [previous]).pipe(Effect.catchCause(() => Effect.void));
    }
  });

  /** Takes what `mesura.cursor_state` answered, from a read or a push. */
  const applyCursorState = (state: CursorState) => {
    cursor = { line: state.line, col: state.col };
    mode = state.mode;
    jumping = state.jumping === true;
    visual =
      state.anchor === undefined || state.anchor === null
        ? null
        : { anchor: state.anchor, cursor: { line: state.line, col: state.col }, kind: state.mode };
    grid.setTabstop(state.tabstop);
    grid.setLeftColumn(state.leftcol ?? 0);
    grid.setCurrentWindow(state.window);
  };

  /**
   * Requests the cursor, mode and current window in one round trip. The redraw stream's cursor lags
   * behind mappings, and `win_pos` never says which window is current. The host plugin pushes this
   * state after most keys (`mesura:cursor`); this read covers what moves the cursor silently.
   */
  const refreshCursorAndMode = Effect.gen(function* () {
    cursorReads += 1;
    const state = (yield* rpc.request("nvim_exec_lua", [
      "return mesura.cursor_state(...)",
      [attachedBuffer],
    ])) as CursorState;
    applyCursorState(state);
  });

  /** Reads the cursor, then again for as long as frames asked while it was reading. */
  const readCursorUntilCurrent = Effect.gen(function* () {
    do {
      cursorRefreshAgain = false;
      yield* refreshCursorAndMode.pipe(
        Effect.tapCause((cause) =>
          Effect.logWarning("could not read the cursor after a frame", { cause }),
        ),
        Effect.ignoreCause,
      );
      // A `cursor` event carries the freshly read values to the manager, which
      // reads them the same way it reads them from a frame. The drawing frame
      // has already gone out by then.
      tell({ kind: "cursor", source: "read" });
    } while (cursorRefreshAgain);
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        cursorRefreshPending = false;
      }),
    ),
  );

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
        if (notification.method === "nvim_buf_lines_event") {
          const applied = applyLinesEvent(notification.params);
          // Counted past the guards, not before them. The metric is documented
          // as a key's text traffic, and an `:s` preview or a burst from a
          // buffer the mirror has left is neither.
          if (applied === null) return;
          bufferEvents += 1;
          grid.setBufferLines(lines);
          tell(applied);
          return;
        }
        if (notification.method === "mesura:cursor") {
          const [state] = notification.params as [CursorState];
          if (state === undefined) return;
          applyCursorState(state);
          cursorPushed = true;
          tell({ kind: "cursor", source: "push" });
          return;
        }
        if (notification.method !== "redraw") {
          tell({
            kind: "notification",
            method: notification.method,
            params: notification.params,
          });
          return;
        }
        const external = tellCmdlineAndMessages(
          notification.params as ReadonlyArray<ReadonlyArray<unknown>>,
          lastCmdline,
        );
        lastCmdline = external.cmdline;
        for (const event of external.events) tell(event);
        grid.applyRedraw(notification.params as ReadonlyArray<ReadonlyArray<unknown>>);
        const batch = notification.params as ReadonlyArray<ReadonlyArray<unknown>>;
        const hasFlush = batch.some((event) => event[0] === "flush");
        // Accumulated across batches: Neovim can split a redraw, so `mode_change` and the `flush`
        // that ends the frame arrive in separate notifications. Cleared once that frame is handled.
        if (batch.some((event) => event[0] === "mode_change")) pendingModeChange = true;
        if (batch.some((event) => event[0] === "win_viewport")) pendingViewport = true;
        if (!hasFlush) return;
        frames += 1;
        const collected = grid.collect();
        overlays = collected.overlays;
        highlightRuns = collected.highlightRuns;

        // Re-read here: it is the only update for a typed motion that changes no text (`j`).
        // Forked, never awaited: Neovim can hold its loop (`:!make`, a press-ENTER prompt), and
        // awaiting on this sole notification fiber hung `settle` and the thread. One read in
        // flight, later triggers queue one more: dropping them lost the frame ending a flash jump.
        const trigger: CursorReadTrigger = {
          hasModeChange: pendingModeChange,
          hasViewport: pendingViewport,
          changedRows: collected.changedRows.length,
          cursorMoves: grid.cursorMoves,
          lastCursorMoves,
        };
        pendingModeChange = false;
        pendingViewport = false;
        if (cursorPushed) {
          // The plugin already said where the cursor is, ahead of this frame:
          // asking again would cost a Neovim round trip and tell nothing new.
          cursorPushed = false;
          lastCursorMoves = grid.cursorMoves;
        } else if (shouldReadCursor(trigger)) {
          lastCursorMoves = grid.cursorMoves;
          if (cursorRefreshPending) {
            cursorRefreshAgain = true;
          } else {
            cursorRefreshPending = true;
            yield* Effect.forkScoped(readCursorUntilCurrent);
          }
        }

        tell({
          kind: "flush",
          changedLines: collected.changedRows.map((row) => grid.topLine + row + 1),
        });
        releaseFlushWaiters();
      }),
    ),
    Effect.ignoreCause,
    // Reached only when the stream ends on its own, which `NvimRpc` makes it
    // do when the process's output closes. A scope closing interrupts this
    // fiber instead, so a session being stopped on purpose says nothing here.
    Effect.andThen(() => Effect.sync(() => tell({ kind: "exited" }))),
    Effect.forkScoped,
  );

  // Neovim's stderr is the only place a broken configuration explains itself.
  yield* child.stderr.pipe(
    Stream.runForEach((line: string) =>
      line.trim().length === 0 ? Effect.void : Effect.logWarning("nvim", { line }),
    ),
    Effect.ignoreCause,
    Effect.forkScoped,
  );

  const awaitFlush = Effect.gen(function* () {
    const waiter = yield* Deferred.make<void>();
    flushWaiters.push(waiter);
    yield* Deferred.await(waiter);
  });

  /**
   * Drains the typeahead (`nvim_feedkeys` with `x` answers once every held key ran), then waits
   * for a marker notification: a response can overtake the buffer events it caused, but the marker
   * queues behind them. Not `:redraw`: it emits nothing when nothing changed, so `gg` at the top of
   * a buffer would wait for a frame that never comes.
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
  const settleAfter = Effect.fn(function* <A, E>(
    action: Effect.Effect<A, E>,
  ): Effect.fn.Return<void, E | NvimRpcError> {
    yield* action;
    yield* awaitFlush;
    yield* refreshCursorAndMode;
  });

  const session: NvimBridge.Session = {
    pid: child.pid,
    get lines() {
      return lines;
    },
    get visual() {
      return visual;
    },
    get highlightDefinitions() {
      return wireHighlightDefinitions(grid.highlightDefinitions);
    },
    get botLine() {
      return grid.botLine;
    },
    get bufferGridId() {
      return grid.bufferGridId;
    },
    get cursor() {
      return cursor;
    },
    get mode() {
      return mode;
    },
    get jumping() {
      return jumping;
    },
    get topLine() {
      return grid.topLine;
    },
    get tabstop() {
      return grid.tabstop;
    },
    get leftColumn() {
      return grid.leftColumn;
    },
    get overlays() {
      return overlays;
    },
    get highlightRuns() {
      return highlightRuns;
    },
    request: rpc.request,
    input: (keys) => rpc.request("nvim_input", [keys]).pipe(Effect.asVoid),
    type: Effect.fn(function* (keys) {
      // Termcodes first: `<Esc>` and friends are notation, and `nvim_feedkeys`
      // takes bytes, so feeding the literal text would type five characters.
      const coded = yield* rpc.request("nvim_replace_termcodes", [keys, true, false, true]);
      yield* rpc.request("nvim_feedkeys", [coded, "mtx", false]);
      yield* refreshCursorAndMode;
    }),
    settle,
    subscribe: (listener) => {
      watchers.add(listener);
      return () => watchers.delete(listener);
    },
    setLines: (next) =>
      settleAfter(rpc.request("nvim_buf_set_lines", [0, 0, -1, false, [...next]])),
    followBuffer: (buffer) => attachTo(buffer),
    get attachedBuffer() {
      return attachedBuffer;
    },
    awaitFrame: awaitFlush,
    nextFrame: Effect.gen(function* () {
      const waiter = yield* Deferred.make<void>();
      flushWaiters.push(waiter);
      return Deferred.await(waiter);
    }),
    get cursorReadPending() {
      return cursorRefreshPending;
    },
    get metrics() {
      return {
        gridCells: grid.cellsDrawn,
        cursorMoves: grid.cursorMoves,
        bufferEvents,
        frames,
        cursorReads,
      };
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
        Effect.ignoreCause,
      );
    }),
    floorProbe: Effect.fn(function* (keys) {
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
