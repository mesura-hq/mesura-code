import type {
  EditorCmdline,
  EditorHighlightDefinition,
  EditorSessionEndReason,
  EditorSessionEvent,
  EditorVisual,
} from "@t3tools/contracts";

// An import in the wrong direction, kept on purpose: the row bookkeeping must happen in the
// fold (an event lost to a coalesced render is a flash label that never goes away), and the
// renderer needs the same arithmetic, so the alternative is two drifting copies.
import {
  applyDecorationEvent,
  EMPTY_DECORATION_STATE,
  type DecorationState,
} from "../components/files/monaco/nvim/nvimDecorations.ts";

/**
 * Pure and apart from the atom wiring, like `terminalSession.ts`, so the arithmetic can be
 * driven against a real Neovim without a runtime in the way.
 */

/**
 * Absolute state, never a delta: two events between renders reach a component as one
 * render (`useSyncExternalStore`), so a delta-only state would skip the first and drift.
 * The driver reconciles to `lines`; `sequence` tells it whether it missed anything.
 */
export interface EditorSessionState {
  /** The file the session has open, as the last snapshot named it. */
  readonly relativePath: string | null;
  readonly lines: ReadonlyArray<string>;
  readonly cursor: { readonly line: number; readonly col: number } | null;
  readonly mode: string;
  /** flash is labelling jump targets; Neovim's own mode says `n` meanwhile. */
  readonly jumping: boolean;
  readonly topline: number;
  /** The command line Neovim is showing, `null` when it is closed. */
  readonly cmdline: EditorCmdline | null;
  /** The last message Neovim wrote, and its kind. `null` once cleared. */
  readonly message: { readonly kind: string; readonly text: string } | null;
  /** Everything drawn over the text, by row. */
  readonly decorations: DecorationState;
  /** The colours those drawings refer to, by highlight id. */
  readonly hlDefs: Readonly<Record<string, EditorHighlightDefinition>>;
  /** The selection Neovim is showing, `null` outside visual mode. */
  readonly visual: EditorVisual | null;
  /**
   * How many times Neovim asked the host to write the file. A count, not a flag on the
   * latest event: a `:w` followed by any other event shares one render, and the write
   * would never flush while the developer is told the file is saved.
   */
  readonly writeRequests: number;
  /**
   * Why the session ended, once it has. The attachment's stream stops here,
   * so nothing after this describes a live Neovim.
   */
  readonly ended: EditorSessionEndReason | null;
  readonly latestEvent: EditorSessionEvent | null;
  readonly sequence: number;
  /**
   * How many snapshots arrived. The server sends one to every attachment on
   * each `open`, so a count above the one an open began at is that open's
   * answer, even when the snapshot and the events after it reached the client
   * in one update.
   */
  readonly snapshots: number;
  /** The lines the last snapshot carried, before any delta after it. */
  readonly snapshotLines: ReadonlyArray<string>;
}

export const EMPTY_EDITOR_SESSION_STATE: EditorSessionState = {
  relativePath: null,
  lines: [],
  cursor: null,
  mode: "n",
  jumping: false,
  topline: 1,
  cmdline: null,
  message: null,
  decorations: EMPTY_DECORATION_STATE,
  hlDefs: {},
  visual: null,
  writeRequests: 0,
  ended: null,
  latestEvent: null,
  sequence: 0,
  snapshots: 0,
  snapshotLines: [],
};

/**
 * Neither Neovim nor Monaco has a zero-line buffer (`dG` leaves one empty line), so an
 * empty array is a state the reconcile cannot express as edits.
 */
const AN_EMPTY_BUFFER: ReadonlyArray<string> = [""];

/**
 * One `nvim_buf_lines_event` applied to the lines it describes a change to.
 *
 * Neovim's own terms: zero-based, half-open, and `last === -1` for the whole
 * buffer. `splice` clamps a `first` past the end, which is what an append is.
 */
export function applyLinesEvent(
  lines: ReadonlyArray<string>,
  event: { readonly first: number; readonly last: number; readonly lines: ReadonlyArray<string> },
): ReadonlyArray<string> {
  if (event.last === -1) return event.lines.length === 0 ? AN_EMPTY_BUFFER : [...event.lines];
  const next = [...lines];
  next.splice(event.first, Math.max(0, event.last - event.first), ...event.lines);
  // Deleting the last line standing leaves an empty array here and one empty
  // line in Neovim. Measured: `gg` `dG` on a three-line buffer sends
  // `{first: 0, last: 3, lines: []}` and `nvim_buf_get_lines` then answers
  // `[""]`.
  return next.length === 0 ? AN_EMPTY_BUFFER : next;
}

export function applyEditorSessionEvent(
  state: EditorSessionState,
  event: EditorSessionEvent,
): EditorSessionState {
  const base = { ...state, latestEvent: event, sequence: state.sequence + 1 };
  switch (event.type) {
    case "snapshot":
      return {
        ...base,
        snapshots: state.snapshots + 1,
        snapshotLines: event.snapshot.lines,
        // A snapshot is a new file or a new attachment, so nothing drawn over
        // the old one survives it.
        decorations: EMPTY_DECORATION_STATE,
        hlDefs: { ...state.hlDefs, ...event.snapshot.hlDefs },
        visual: null,
        relativePath: event.snapshot.relativePath,
        lines: event.snapshot.lines,
        cursor: event.snapshot.cursor,
        mode: event.snapshot.mode,
        jumping: event.snapshot.jumping ?? false,
        topline: event.snapshot.topline,
        // A snapshot is a live session. The subscription re-attaches by itself
        // when the connection comes back, so one can follow an `exited`.
        ended: null,
      };
    case "lines":
      // Regression guard: a delta for another file is refused, since three defects wrote
      // one buffer's change into another file on save. `sequence` still advances, so the
      // driver sees a dropped frame and reconciles in full against the unchanged `lines`.
      if (state.relativePath === null || event.relativePath !== state.relativePath) return base;
      return { ...base, lines: applyLinesEvent(state.lines, event) };
    case "cursor":
      return { ...base, cursor: { line: event.line, col: event.col } };
    case "mode":
      return { ...base, mode: event.mode, jumping: event.jumping ?? false };
    case "viewport":
      return { ...base, topline: event.topline };
    case "cmdline":
      // A closing command line clears the message with it. Neovim's own
      // `msg_clear` does not always arrive, and a stale error sitting under a
      // command that has since succeeded is worse than no message at all.
      return { ...base, cmdline: event.cmdline, message: null };
    case "message":
      return {
        ...base,
        message: event.text === "" ? null : { kind: event.kind, text: event.text },
      };
    case "decorations":
      return { ...base, decorations: applyDecorationEvent(state.decorations, event).state };
    case "hlDefs":
      // Additions only. Neovim never redefines an id it has already sent, and
      // a session that was reattached sends them all again.
      return { ...base, hlDefs: { ...state.hlDefs, ...event.hlDefs } };
    case "visual":
      return { ...base, visual: event.visual };
    case "writeRequested":
      return { ...base, writeRequests: state.writeRequests + 1 };
    case "exited":
      return { ...base, ended: event.reason };
    default:
      return base;
  }
}
