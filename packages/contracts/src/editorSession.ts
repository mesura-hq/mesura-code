import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The wire shape of one editor session: an embedded Neovim driving a file that
 * a client has open.
 *
 * One session per thread, not one per file. A session is a whole Neovim, so it
 * is expensive to start and it carries state — registers, marks, jumplist, undo
 * — that the developer expects to survive moving between files in the same
 * piece of work. Opening a second file in a thread switches the window to
 * another buffer inside the session it already has.
 *
 * Every bound in this file is a refusal made early. An editor session carries
 * whole files and whole screens over a link that may be a phone on mobile
 * data, so a field with no cap is a message with no cap.
 */

const EditorLineSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const EditorColumnSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const EditorRowsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(500),
);
const EditorColsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(1000),
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

export const EditorSessionInputInput = Schema.Struct({
  ...EditorSessionThreadInput.fields,
  /** Neovim key notation: `<C-w>v`, `<Esc>`, plain text. */
  keys: Schema.String.check(Schema.isMaxLength(1024)),
});
export type EditorSessionInputInput = Schema.Codec.Encoded<typeof EditorSessionInputInput>;

export const EditorSessionViewportInput = Schema.Struct({
  ...EditorSessionThreadInput.fields,
  topline: EditorLineSchema,
  rows: EditorRowsSchema,
  cols: EditorColsSchema,
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
 * One highlight Neovim has defined, as the client needs it to paint.
 *
 * `groups` carries the highlight group names `ext_hlstate` reports. The client
 * needs them to tell a decoration it should draw from one the host already
 * draws itself — a visual selection painted twice, in two disagreeing colours,
 * is the failure this field exists to prevent.
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
 * One change to the text, and which file it is a change to.
 *
 * `relativePath` is not decoration. A delta is meaningless without knowing
 * what it is a delta *to*, and this event used to carry only the range and the
 * text — so a change to one buffer applied to another file was undetectable by
 * construction, on both sides of the wire. Three separate defects reached disk
 * that way, each one a different route to the same thing: the panel rendered
 * another file's text as the open file, and the save that followed wrote it.
 * Each was fixed with a guard reconstructed out of band, and none of those
 * guards made the next route impossible.
 *
 * With the path on the event the client drops a mismatch outright, whatever
 * route produced it. The guards remain as the cheaper first line; this is what
 * makes the mistake unrepresentable rather than merely caught.
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
 * The selection Neovim is showing.
 *
 * Both ends, because neither is "the start": a selection made upwards has its
 * anchor below its cursor. `kind` is the mode itself, so `v`, `V` and the
 * literal Ctrl-V of a block stay distinguishable, and the client draws each as
 * the selection Monaco has for it rather than as a decoration.
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
 * Everything drawn over the buffer that is not the buffer's own text.
 *
 * `rows` names the rows this event replaces, so the client can drop what it
 * had for those rows and take these instead. Without it a decoration that went
 * away would have no way of being removed, because nothing is sent for a row
 * that now has nothing on it.
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
 * The session is gone, and this attachment's stream ends after it.
 *
 * `reason` says what a client should do about it. `closed` is a session that
 * went for an ordinary reason — the thread was closed, the server is stopping —
 * and opening the file again starts a new one. `gave-up` is a Neovim that kept
 * exiting until the server stopped replacing it, which reopening would repeat.
 */
export const EditorSessionEndReason = Schema.Literals(["closed", "gave-up"]);
export type EditorSessionEndReason = typeof EditorSessionEndReason.Type;

const EditorExitedEvent = Schema.Struct({
  type: Schema.Literal("exited"),
  code: Schema.NullOr(Schema.Int),
  reason: Schema.optionalKey(EditorSessionEndReason),
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
 * Neovim could not be started, and why.
 *
 * The reasons are the launch's own, carried to the client unchanged so the
 * panel can say what to fix — a configuration directory that is not there is a
 * different problem from a Neovim that is too old, and telling the developer
 * "the editor did not start" for both is telling them nothing.
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

export const EditorSessionError = Schema.Union([
  EditorSessionSpawnError,
  EditorSessionLookupError,
  EditorSessionRpcError,
]);
export type EditorSessionError = typeof EditorSessionError.Type;
