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

/**
 * What a frame says about whether the cursor is worth asking for.
 *
 * Pure and exported so each trigger can be held on its own. Driven through a
 * real Neovim they overlap — a half-page scroll changes the viewport *and*
 * redraws every row — so a behavioural test passes with any one of them
 * deleted, which is the shape of a guard that looks covered and is not.
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
 * Four triggers, each a class of key the others miss.
 *
 * - `cursorMoves` counts a `grid_cursor_goto` that actually moved, which is
 *   `h`, `j`, `k`, `l` and the arrows.
 * - `hasModeChange` is the keys that change the mode and move nothing. `i` at
 *   the start of a line is the one that made this necessary.
 * - `hasViewport` is the scrolling keys, and it is not redundant: `<C-d>`
 *   scrolls the text under a cursor that stays on the same screen row, so
 *   Neovim sends no `grid_cursor_goto` at all even though the buffer cursor
 *   moved half a page. Measured — the viewport went from 0 to 11 with the move
 *   count unchanged.
 * - `changedRows` covers the rest, the awkward one being a long line scrolling
 *   sideways under a cursor parked at the last column: no new screen position,
 *   no new topline, new text.
 *
 * A real configuration emits about 230 frames a second while completely idle
 * and nearly all of them draw nothing. An idle frame matches none of these and
 * costs nothing.
 */
export function shouldReadCursor(trigger: CursorReadTrigger): boolean {
  return (
    trigger.hasModeChange ||
    trigger.hasViewport ||
    trigger.changedRows > 0 ||
    trigger.cursorMoves !== trigger.lastCursorMoves
  );
}

/**
 * What a session tells whoever is watching it.
 *
 * Deliberately close to what Neovim said rather than to what a client wants:
 * turning a redraw into something drawable is the business of whoever is
 * drawing, and a bridge that decided it here would have to decide it again
 * differently for the next surface.
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
       * The cursor and the mode were re-read, and are now current.
       *
       * Its own kind rather than a second `flush`, because it is not a frame:
       * nothing was drawn. The read is forked off the notification fiber — see
       * the comment at its trigger — so it finishes after the frame that
       * caused it, and this is what says it has.
       */
      readonly kind: "cursor";
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
 * Joins the `[attribute, text]` chunks Neovim writes a line of text as.
 *
 * The attributes are its own highlight ids, and this host has no use for them
 * on the command line or in a message: both are drawn in the status strip's
 * own colours, and the only distinction that matters — an error — comes from
 * `msg_show`'s kind rather than from a chunk's attribute.
 */
const joinChunks = (chunks: unknown): string =>
  Array.isArray(chunks)
    ? chunks.map((chunk) => (Array.isArray(chunk) ? String(chunk[1] ?? "") : "")).join("")
    : "";

/**
 * Neovim's byte offset into a string, as an index a client can slice on.
 *
 * `cmdline_show` and `cmdline_pos` count bytes, because Vim counts bytes.
 * Passing that straight to a client puts the caret in the wrong place the
 * moment a command holds anything outside ASCII — a search for `café`, a
 * path with an accent — and it is the client that would have to know, which
 * is knowledge the wire should not be asking it for.
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
 * The command line and the messages, pulled out of a redraw batch.
 *
 * They arrive mixed in with the drawing because Neovim externalises them
 * through the same stream, and they are the two things in it that are already
 * text rather than cells. Everything else in a redraw is a drawing, and
 * reading a drawing is `GridModel`'s job.
 *
 * `previous` is the command line as it stood, because `cmdline_pos` reports a
 * caret that moved without the text changing — `Left`, `Home`, `Ctrl-B` — and
 * carries nothing else. Without it the caret in the strip freezes wherever the
 * last `cmdline_show` left it.
 *
 * `msg_history_show` is the whole of `:messages`, which arrives as one event
 * under its own name rather than as a run of `msg_show`s.
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
 * A visual selection, in Neovim's own terms.
 *
 * Both ends are given because neither is "the start": a selection made upwards
 * has its anchor below its cursor, and a client that assumed otherwise would
 * draw nothing for half of them. `kind` is the mode itself, so `v`, `V` and
 * the literal Ctrl-V stay distinguishable.
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
    /** One past the last buffer line drawn, as `win_viewport` reports it. */
    readonly botLine: number;
    /** The grid the developer's window is drawn on, `null` until Neovim says. */
    readonly bufferGridId: number | null;
    readonly overlays: ReadonlyArray<GridOverlay>;
    /**
     * The colours Neovim has defined, by id.
     *
     * Kept as the wire's own shape rather than Neovim's raw attribute bag: the
     * bag carries terminal colour indexes and blend levels this host has no
     * use for, and passing it whole would make every client decide again which
     * parts mean something.
     */
    readonly highlightDefinitions: ReadonlyMap<number, EditorHighlightDefinition>;
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
     * Points the mirror at a buffer the host owns, and waits for it.
     *
     * The announcement route is a notification, so it lands whenever the
     * notification fiber gets to it. `open` cannot wait on that: it builds the
     * snapshot it answers with from the mirror, and a snapshot taken before
     * the announcement is the *previous* buffer's text sent to the client as
     * the file it just asked for. Under a configuration that restores a
     * session or opens a picker at start, that previous buffer is a plugin's,
     * and the client then saves a plugin's window over the file.
     */
    readonly followBuffer: (buffer: number) => Effect.Effect<void, NvimRpcError>;
    /**
     * The buffer the mirror is on.
     *
     * Every write has to name it. Since the host announces nothing and follows
     * only what it opened, the mirror and Neovim's *current* buffer are allowed
     * to disagree — a plugin owning the window is the ordinary case — so a
     * write aimed at buffer `0` lands in the plugin's buffer instead of the
     * file. Silently: the edit is lost, and the lines event it causes is
     * dropped by the guard in `applyLinesEvent`, so nothing reports it.
     */
    readonly attachedBuffer: number;
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
  /** Whether flash is labelling targets, read with the mode. */
  let jumping = false;
  let overlays: ReadonlyArray<GridOverlay> = [];
  let highlightRuns: ReadonlyArray<HighlightRun> = [];
  let flushWaiters: Array<Deferred.Deferred<void>> = [];
  let bufferEvents = 0;
  let frames = 0;
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
    // Neovim defines this rather than merely allowing it, in `:help
    // nvim_buf_lines_event`: "When {changedtick} is |v:null| this means the
    // screen lines (display) changed but not the buffer contents."
    //
    // A null `changedtick` marks a preview rather than a change, and `:s` sends
    // a stream of them: `inccommand` defaults to `nosplit`, so every keystroke
    // of a replacement being typed reports what the line *would* become. The
    // buffer itself does not move — `nvim_buf_get_lines` answers the old text
    // throughout — and every preview names the same range against the original,
    // so they are not deltas and do not compose. Applying them turns
    // `:%s/two/TWO\rMORE/` into a growing pile of half-typed fragments before
    // Enter is ever pressed. The committed event arrives with a real tick.
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
      // The visual anchor comes back in the same round trip as the cursor and
      // the mode, because it is only meaningful read with them: `getpos("v")`
      // answers wherever the cursor is when no selection is running, so the
      // mode is what says whether the answer means anything.
      //
      // Columns leave here in UTF-16 units, which is what the wire and Monaco
      // count in. Neovim counts bytes: on a line holding an accent or an emoji
      // the raw byte column put the caret several characters to the right, and
      // past the end of the line Monaco silently clamped it there.
      `local attached = ...
       local position = vim.api.nvim_win_get_cursor(0)
       local mode = vim.api.nvim_get_mode().mode
       local function utf16_col(line, byte)
         local text = vim.fn.getline(line)
         return vim.str_utfindex(text, "utf-16", math.min(byte, #text), false) + 1
       end
       local anchor = nil
       if mode:sub(1, 1) == "v" or mode:sub(1, 1) == "V" or mode:byte(1) == 22 then
         local other = vim.fn.getpos("v")
         anchor = { line = other[2], col = utf16_col(other[2], other[3] - 1) }
       end
       local tabstop = 8
       local jumping = false
       if attached ~= 0 and vim.api.nvim_buf_is_valid(attached) then
         tabstop = vim.bo[attached].tabstop
         -- flash draws in its own namespace. Looked up until flash, which loads
         -- lazily, has created it, and cached after: this runs on every key.
         mesura.flash_namespace = mesura.flash_namespace or vim.api.nvim_get_namespaces().flash
         local flash = mesura.flash_namespace
         if flash ~= nil then
           -- A label is the one mark with virtual text; the backdrop and the
           -- matches are plain highlights. Those stay up after an \`f\` motion,
           -- for \`;\` to repeat it, when no label is waiting.
           local marks = vim.api.nvim_buf_get_extmarks(attached, flash, 0, -1, { details = true })
           for _, mark in ipairs(marks) do
             if mark[4].virt_text ~= nil then
               jumping = true
               break
             end
           end
         end
       end
       return {
         line = position[1],
         col = utf16_col(position[1], position[2]),
         mode = mode,
         anchor = anchor,
         window = vim.api.nvim_get_current_win(),
         tabstop = tabstop,
         jumping = jumping,
       }`,
      [attachedBuffer],
    ])) as {
      line: number;
      col: number;
      mode: string;
      anchor?: { line: number; col: number };
      window: number;
      tabstop: number;
      jumping: boolean;
    };
    cursor = { line: state.line, col: state.col };
    mode = state.mode;
    jumping = state.jumping === true;
    visual =
      state.anchor === undefined
        ? null
        : { anchor: state.anchor, cursor: { line: state.line, col: state.col }, kind: state.mode };
    grid.setTabstop(state.tabstop);
    grid.setCurrentWindow(state.window);
  });

  /** Reads the cursor, then again for as long as frames asked while it was reading. */
  const readCursorUntilCurrent = Effect.gen(function* () {
    do {
      cursorRefreshAgain = false;
      yield* refreshCursorAndMode.pipe(
        Effect.tapCause((cause) =>
          Effect.logWarning("could not read the cursor after a frame", { cause }),
        ),
        Effect.catchCause(() => Effect.void),
      );
      // A `cursor` event carries the freshly read values to the manager, which
      // reads them the same way it reads them from a frame. The drawing frame
      // has already gone out by then.
      tell({ kind: "cursor" });
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
        // Accumulated across batches, not read off the one carrying the flush.
        // Neovim is free to split a redraw: `mode_change` can arrive in one
        // notification and the `flush` that ends the frame in the next, and a
        // flag read only at the flush is then false for a mode change that
        // certainly happened. Cleared once the frame it belongs to is handled.
        if (batch.some((event) => event[0] === "mode_change")) pendingModeChange = true;
        if (batch.some((event) => event[0] === "win_viewport")) pendingViewport = true;
        if (!hasFlush) return;
        frames += 1;
        const collected = grid.collect();
        overlays = collected.overlays;
        highlightRuns = collected.highlightRuns;

        // The cursor and the mode are re-read after a frame that could have
        // moved them, and this is the only place a key a person pressed can
        // update them. `input` is `nvim_input`, which is asynchronous and
        // answers nothing, so a motion that changes no text — `j`, `l`, an
        // arrow key — leaves every other channel silent: the buffer did not
        // change, and on a file that fits the window the viewport did not
        // either. Without this the session reported the cursor it was spawned
        // with for as long as it lived, the manager compared that unchanged
        // value against itself and published nothing, and the caret on screen
        // never moved.
        //
        // Forked, never awaited here. This is the one fiber consuming
        // notifications, so awaiting a response inside it stops the whole
        // stream until Neovim answers — and Neovim does not always answer.
        // `:!make`, a `press ENTER` prompt and `vim.fn.input()` all hold the
        // main loop with drawing already on screen. Awaiting here made every
        // frame wait behind that, `mesura_settled` markers never arrived, and
        // `settle` — which has no timeout and is called under the thread's
        // lock — would never resolve, taking the thread with it.
        //
        // One in flight at a time. Triggers arriving while a read is pending
        // collapse into one more read after it, which keeps a burst of typing
        // to two round trips rather than one per frame. Dropping them instead
        // lost the frame that ends a flash jump when it landed mid-read, and
        // left the client showing FLASH with Escape routed to a Neovim that
        // was no longer waiting for it.
        const trigger: CursorReadTrigger = {
          hasModeChange: pendingModeChange,
          hasViewport: pendingViewport,
          changedRows: collected.changedRows.length,
          cursorMoves: grid.cursorMoves,
          lastCursorMoves,
        };
        pendingModeChange = false;
        pendingViewport = false;
        if (shouldReadCursor(trigger)) {
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
    Effect.catchCause(() => Effect.void),
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
