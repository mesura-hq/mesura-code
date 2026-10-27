import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * One editor session per thread, not per file: a Neovim is expensive to start and carries registers,
 * marks, jumplist and undo across files in one piece of work. Every bound here is an early refusal:
 * the session carries whole files and screens, possibly to a phone on mobile data.
 */

const EditorLineSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const EditorColumnSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const EditorRowsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(500),
);
/**
 * The widest viewport a client may ask for.
 *
 * A request, not the grid: the host sizes Neovim's grid itself, past the
 * widest line the cursor can reach (`apps/server/src/editor/gridWidth.ts`), so
 * a client clamps what it measures to this and loses nothing by it.
 */
export const EDITOR_VIEWPORT_MAX_COLS = 1000;
const EditorColsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(EDITOR_VIEWPORT_MAX_COLS),
);

/**
 * The most lines an open may carry.
 *
 * Not an arbitrary round number: the file read truncates at a megabyte and a
 * truncated file never reaches the editor, so a file this long cannot arrive
 * through the path that feeds this.
 */
const EDITOR_MAX_LINES = 100_000;

const EditorLinesSchema = Schema.Array(Schema.String).check(Schema.isMaxLength(EDITOR_MAX_LINES));

export const EditorSessionThreadInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
});
export type EditorSessionThreadInput = typeof EditorSessionThreadInput.Type;

export const EditorSessionOpenInput = Schema.Struct({
  ...EditorSessionThreadInput.fields,
  cwd: TrimmedNonEmptyString,
  /**
   * Relative to `cwd`, and resolved against it the same way a read is, so a
   * path that climbs out of the project is refused. Neovim is given the name
   * only — it never opens the file itself — but a name is still a name the
   * developer did not ask for.
   */
  relativePath: TrimmedNonEmptyString,
  lines: EditorLinesSchema,
});
export type EditorSessionOpenInput = Schema.Codec.Encoded<typeof EditorSessionOpenInput>;

export const EditorSessionAttachInput = EditorSessionThreadInput;
export type EditorSessionAttachInput = Schema.Codec.Encoded<typeof EditorSessionAttachInput>;

/**
 * `lane` names one client's key stream for a thread and `index` counts its batches upwards. The
 * server answers a batch whose `index` is not above the lane's last applied one as a success without
 * applying it: a client that lost the reply re-sends, and Neovim already has it.
 */
export const EditorInputSequence = Schema.Struct({
  lane: Schema.String.check(Schema.isMaxLength(64)),
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type EditorInputSequence = typeof EditorInputSequence.Type;

export const EditorSessionInputInput = Schema.Struct({
  ...EditorSessionThreadInput.fields,
  /** Neovim key notation: `<C-w>v`, `<Esc>`, plain text. */
  keys: Schema.String.check(Schema.isMaxLength(1024)),
  sequence: Schema.optional(EditorInputSequence),
});
export type EditorSessionInputInput = Schema.Codec.Encoded<typeof EditorSessionInputInput>;

/**
 * Read after the keys ran, so a no-op batch still answers. The client releases the editor on Escape
 * only when the last batch answered plain normal mode, not `blocking`, with no flash label and none
 * pending; the attach stream's `mode` event can predate the keys. `blocking`: Neovim waits for a key
 * Escape must reach; a plugin's `getcharstr()` wait (flash's `f`) shows only in `state()`.
 */
export const EditorSessionInputResult = Schema.Struct({
  mode: Schema.String,
  blocking: Schema.Boolean,
  /** flash is labelling jump targets; Neovim's own mode says `n` meanwhile. */
  jumping: Schema.Boolean,
});
export type EditorSessionInputResult = typeof EditorSessionInputResult.Type;

/**
 * `pointer` (wheel, scrollbar, touch): Neovim never saw the scroll, so the host moves the cursor in,
 * as Vim's wheel does. `keys` or absent: never moves the cursor, because the request can be older
 * than keys Neovim already ran.
 */
export const EditorViewportSource = Schema.Literals(["pointer", "keys"]);
export type EditorViewportSource = typeof EditorViewportSource.Type;

export const EditorSessionViewportInput = Schema.Struct({
  ...EditorSessionThreadInput.fields,
  topline: EditorLineSchema,
  rows: EditorRowsSchema,
  cols: EditorColsSchema,
  source: Schema.optional(EditorViewportSource),
});
export type EditorSessionViewportInput = Schema.Codec.Encoded<typeof EditorSessionViewportInput>;

export const EditorSessionSetCursorInput = Schema.Struct({
  ...EditorSessionThreadInput.fields,
  line: EditorLineSchema,
  col: EditorColumnSchema,
});
export type EditorSessionSetCursorInput = Schema.Codec.Encoded<typeof EditorSessionSetCursorInput>;

const EditorTextEdit = Schema.Struct({
  startLine: EditorLineSchema,
  startCol: EditorColumnSchema,
  endLine: EditorLineSchema,
  endCol: EditorColumnSchema,
  /**
   * Capped like everything else here. The edits array is bounded at a
   * thousand, which bounds nothing on its own while one entry may carry a
   * string of any size — a megabyte is what the read path truncates at, so it
   * is the largest replacement that can honestly arrive.
   */
  text: Schema.String.check(Schema.isMaxLength(1_000_000)),
});
export type EditorTextEdit = typeof EditorTextEdit.Type;

export const EditorSessionReplaceTextInput = Schema.Struct({
  ...EditorSessionThreadInput.fields,
  /**
   * Capped because a replacement is how an agent's write reaches the buffer,
   * and one write should be one edit or a handful, never a thousand.
   */
  edits: Schema.Array(EditorTextEdit).check(Schema.isMaxLength(1000)),
});
export type EditorSessionReplaceTextInput = Schema.Codec.Encoded<
  typeof EditorSessionReplaceTextInput
>;

export const EditorSessionCloseInput = EditorSessionThreadInput;
export type EditorSessionCloseInput = Schema.Codec.Encoded<typeof EditorSessionCloseInput>;

const EditorCursor = Schema.Struct({
  line: EditorLineSchema,
  col: EditorColumnSchema,
});
export type EditorCursor = typeof EditorCursor.Type;

/**
 * `groups` carries the `ext_hlstate` group names, so the client can skip decorations the host
 * already draws: a visual selection painted twice, in two colours, is the failure this prevents.
 */
const EditorHighlightDefinition = Schema.Struct({
  fg: Schema.optional(Schema.Int),
  bg: Schema.optional(Schema.Int),
  bold: Schema.optional(Schema.Boolean),
  italic: Schema.optional(Schema.Boolean),
  underline: Schema.optional(Schema.Boolean),
  /**
   * A wavy underline rather than a straight one. Diagnostics use it, and a
   * client that folded it into `underline` would draw an error like a link.
   */
  undercurl: Schema.optional(Schema.Boolean),
  /**
   * The two colours swapped. Vim's own `Search` and `IncSearch` are usually
   * defined this way rather than as a pair, so dropping it paints a match in
   * the colours of the text around it and shows nothing.
   */
  reverse: Schema.optional(Schema.Boolean),
  groups: Schema.Array(Schema.String),
});
export type EditorHighlightDefinition = typeof EditorHighlightDefinition.Type;

const EditorHighlightDefinitions = Schema.Record(Schema.String, EditorHighlightDefinition);

export const EditorSessionSnapshot = Schema.Struct({
  relativePath: Schema.String.check(Schema.isNonEmpty()),
  lines: EditorLinesSchema,
  cursor: EditorCursor,
  mode: Schema.String,
  /** A jump plugin (flash) is labelling targets and waiting for one. */
  jumping: Schema.optionalKey(Schema.Boolean),
  topline: EditorLineSchema,
  hlDefs: EditorHighlightDefinitions,
});
export type EditorSessionSnapshot = typeof EditorSessionSnapshot.Type;

/**
 * `escape` is the one Escape confirmation a client has before its first batch, read under the
 * thread's lock. Only `open` carries it: an attach snapshot can be older than the last batch's answer.
 * A client takes it only while its lane sent nothing since the open began. Absent from older hosts.
 */
export const EditorSessionOpenResult = Schema.Struct({
  ...EditorSessionSnapshot.fields,
  escape: Schema.optionalKey(EditorSessionInputResult),
});
export type EditorSessionOpenResult = typeof EditorSessionOpenResult.Type;

const EditorOverlay = Schema.Struct({
  line: EditorLineSchema,
  col: EditorColumnSchema,
  text: Schema.String,
  hl: Schema.Int,
});
export type EditorOverlay = typeof EditorOverlay.Type;

const EditorHighlightRun = Schema.Struct({
  line: EditorLineSchema,
  startCol: EditorColumnSchema,
  /** One past the last column, so an empty run is `startCol === endCol`. */
  endCol: EditorColumnSchema,
  hl: Schema.Int,
});
export type EditorHighlightRun = typeof EditorHighlightRun.Type;

const EditorSnapshotEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  snapshot: EditorSessionSnapshot,
});

/**
 * A run of lines replaced, in `nvim_buf_lines_event`'s own terms.
 *
 * Zero-based and half-open — `first` is the first line replaced, `last` is one
 * past it — because that is what Neovim sends, and translating it here would
 * put the off-by-one somewhere nobody looks.
 */
/**
 * `relativePath` makes a delta applied to the wrong file unrepresentable: the client drops a
 * mismatch whatever route produced it. Without it, three defects wrote another file's text to disk.
 */
const EditorLinesEvent = Schema.Struct({
  type: Schema.Literal("lines"),
  /** The file this change belongs to, as the session's snapshot named it. */
  relativePath: TrimmedNonEmptyString,
  first: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  last: Schema.Int,
  lines: EditorLinesSchema,
});

const EditorCursorEvent = Schema.Struct({
  type: Schema.Literal("cursor"),
  line: EditorLineSchema,
  col: EditorColumnSchema,
});

const EditorModeEvent = Schema.Struct({
  type: Schema.Literal("mode"),
  mode: Schema.String,
  /** Neovim is waiting for a key a plugin asked for, so it will not answer. */
  blocking: Schema.Boolean,
  /**
   * flash is labelling jump targets. Neovim's own mode stays `n` throughout,
   * so this is the only way a client can tell the developer where the next
   * key goes.
   */
  jumping: Schema.optionalKey(Schema.Boolean),
});

/**
 * Both ends, because a selection made upwards has its anchor below its cursor. `kind` is the mode
 * itself, so `v`, `V` and a block's literal Ctrl-V stay distinct and map to Monaco selections.
 */
const EditorVisualEvent = Schema.Struct({
  type: Schema.Literal("visual"),
  visual: Schema.NullOr(
    Schema.Struct({
      anchor: EditorCursor,
      cursor: EditorCursor,
      kind: Schema.String,
    }),
  ),
});
export type EditorVisual = NonNullable<typeof EditorVisualEvent.Type.visual>;

const EditorViewportEvent = Schema.Struct({
  type: Schema.Literal("viewport"),
  topline: EditorLineSchema,
  botline: EditorLineSchema,
});

/**
 * `rows` names the rows this event replaces, so a decoration that went away can be removed:
 * nothing is sent for a row that now has nothing on it.
 */
const EditorDecorationsEvent = Schema.Struct({
  type: Schema.Literal("decorations"),
  overlays: Schema.Array(EditorOverlay),
  highlightRuns: Schema.Array(EditorHighlightRun),
  rows: Schema.Array(EditorLineSchema),
});

const EditorHighlightDefinitionsEvent = Schema.Struct({
  type: Schema.Literal("hlDefs"),
  /** Additions only. Neovim never redefines an id it has already sent. */
  hlDefs: EditorHighlightDefinitions,
});

const EditorCmdline = Schema.Struct({
  content: Schema.String,
  pos: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** `:` for a command, `/` or `?` for a search. */
  firstc: Schema.String,
  prompt: Schema.String,
});
export type EditorCmdline = typeof EditorCmdline.Type;

const EditorCmdlineEvent = Schema.Struct({
  type: Schema.Literal("cmdline"),
  /** `null` when the command line closed. */
  cmdline: Schema.NullOr(EditorCmdline),
});

const EditorMessageEvent = Schema.Struct({
  type: Schema.Literal("message"),
  kind: Schema.String,
  text: Schema.String,
});

/**
 * Neovim asked for the buffer to be written, by `:w` or anything that writes.
 *
 * A request, not a write: Neovim never touches the file. The host holds the
 * text and saves it the same way the editor's own autosave does, so one path
 * writes the file and one set of rules decides when.
 */
const EditorWriteRequestedEvent = Schema.Struct({
  type: Schema.Literal("writeRequested"),
  relativePath: Schema.String.check(Schema.isNonEmpty()),
});

/**
 * `closed`: closed on purpose (thread archived), not reopened. `replaced`: a new session took over
 * because the project moved; attach again. `stopping`: server shutdown; the attach after reconnect
 * finds no session, which signals reopen. `gave-up`: Neovim kept exiting; reopening would repeat it.
 */
export const EditorSessionEndReason = Schema.Literals([
  "closed",
  "replaced",
  "stopping",
  "gave-up",
]);
export type EditorSessionEndReason = typeof EditorSessionEndReason.Type;

const EditorExitedEvent = Schema.Struct({
  type: Schema.Literal("exited"),
  code: Schema.NullOr(Schema.Int),
  reason: EditorSessionEndReason,
});

export const EditorSessionEvent = Schema.Union([
  EditorSnapshotEvent,
  EditorLinesEvent,
  EditorCursorEvent,
  EditorModeEvent,
  EditorViewportEvent,
  EditorVisualEvent,
  EditorDecorationsEvent,
  EditorHighlightDefinitionsEvent,
  EditorCmdlineEvent,
  EditorMessageEvent,
  EditorWriteRequestedEvent,
  EditorExitedEvent,
]);
export type EditorSessionEvent = typeof EditorSessionEvent.Type;

/**
 * The launch's own reasons, carried unchanged so the panel can say what to fix: a missing
 * configuration directory and a too-old Neovim are different problems.
 */
export class EditorSessionSpawnError extends Schema.TaggedError<EditorSessionSpawnError>()(
  "EditorSessionSpawnError",
  {
    threadId: Schema.String,
    reason: Schema.Literals([
      "binary-missing",
      "version",
      "config-missing",
      "spawn-failed",
      "runtime-unwritable",
    ]),
    detail: Schema.String,
  },
) {
  override get message() {
    return `Could not start Neovim for thread ${this.threadId}: ${this.detail}`;
  }
}

export class EditorSessionLookupError extends Schema.TaggedError<EditorSessionLookupError>()(
  "EditorSessionLookupError",
  {
    threadId: Schema.String,
  },
) {
  override get message() {
    return `No editor session for thread: ${this.threadId}`;
  }
}

export class EditorSessionRpcError extends Schema.TaggedError<EditorSessionRpcError>()(
  "EditorSessionRpcError",
  {
    threadId: Schema.String,
    method: Schema.String,
    detail: Schema.String,
  },
) {
  override get message() {
    return `Neovim refused ${this.method} for thread ${this.threadId}: ${this.detail}`;
  }
}

/**
 * A re-sent key batch the server cannot vouch for: the Neovim that accepted it
 * exited and was replaced, and accepting is not running, so the restored text
 * may or may not hold it. Sending it again could type it twice; the client
 * reports the keys lost instead.
 */
export class EditorSessionInputLostError extends Schema.TaggedError<EditorSessionInputLostError>()(
  "EditorSessionInputLostError",
  {
    threadId: Schema.String,
    detail: Schema.String,
  },
) {
  override get message() {
    return `Keys for thread ${this.threadId} may not have reached Neovim: ${this.detail}`;
  }
}

export const EditorSessionError = Schema.Union([
  EditorSessionSpawnError,
  EditorSessionLookupError,
  EditorSessionRpcError,
  EditorSessionInputLostError,
]);
export type EditorSessionError = typeof EditorSessionError.Type;
