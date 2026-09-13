import type { EditorSessionEvent } from "@t3tools/contracts";

/**
 * The thread's editor session, folded into the state a client renders.
 *
 * Pure, and in its own module for the same reason `terminalSession.ts` sits
 * beside `terminal.ts` in the shared client package: the arithmetic is where
 * the mistakes are, and separating it from the atom wiring is what lets it be
 * driven against a real Neovim without a runtime in the way.
 */

/**
 * What the driver reads: the session's state, not the last thing that happened.
 *
 * Absolute rather than a delta, and that is the whole design. Every event
 * other than `snapshot` describes a change against the text Neovim holds, so
 * a state that carried only the latest event would be correct exactly as long
 * as every event reached a render. It does not: `useSyncExternalStore` hands a
 * component the store's current value, and two events that land between two
 * renders produce one render carrying the second — the first is never applied,
 * and every delta after it is then measured against a model that has drifted.
 *
 * So the fold keeps the lines themselves, the way the terminal's fold keeps
 * the whole buffer rather than the last chunk. A coalesced render then costs
 * nothing: the state is still the truth, and the driver reconciles to it.
 * `sequence` is what tells a re-render something arrived, and it is also what
 * tells the driver whether it missed anything.
 */
export interface EditorSessionState {
  /** The file the session has open, as the last snapshot named it. */
  readonly relativePath: string | null;
  readonly lines: ReadonlyArray<string>;
  readonly cursor: { readonly line: number; readonly col: number } | null;
  readonly mode: string;
  readonly topline: number;
  readonly latestEvent: EditorSessionEvent | null;
  readonly sequence: number;
}

export const EMPTY_EDITOR_SESSION_STATE: EditorSessionState = {
  relativePath: null,
  lines: [],
  cursor: null,
  mode: "n",
  topline: 1,
  latestEvent: null,
  sequence: 0,
};

/**
 * A buffer with nothing in it.
 *
 * Neovim has no zero-line buffer: `dG` on a whole file leaves one empty line,
 * and so does a new buffer. Monaco has the same invariant. An empty array is
 * therefore not a buffer either of them can hold, and producing one puts the
 * fold in a state the reconcile below cannot express as edits.
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
        relativePath: event.snapshot.relativePath,
        lines: event.snapshot.lines,
        cursor: event.snapshot.cursor,
        mode: event.snapshot.mode,
        topline: event.snapshot.topline,
      };
    case "lines":
      return { ...base, lines: applyLinesEvent(state.lines, event) };
    case "cursor":
      return { ...base, cursor: { line: event.line, col: event.col } };
    case "mode":
      return { ...base, mode: event.mode };
    case "viewport":
      return { ...base, topline: event.topline };
    default:
      return base;
  }
}
