import type { Bookmark } from "./bookmarks.ts";
import type { EntrySummary, FsEntry } from "./entry.ts";
import { decodeListingOptions, type ListingOptions } from "./listingOptions.ts";
import { isSortMode, SORT_MODES, type SortMode } from "./sort.ts";

/**
 * The wire contract between the two processes.
 *
 * Pure, and shared by both sides, so a change to a shape is a compile error in
 * the renderer and in the main process at once rather than a runtime surprise
 * in one of them.
 *
 * **Every failure is a value, never a thrown error.** An exception crossing the
 * IPC boundary arrives as an opaque string with no code, so the renderer cannot
 * branch on it and the user gets "something went wrong". A tagged result keeps
 * the reason.
 */

export interface Failure {
  readonly code: FailureCode;
  readonly message: string;
}

export type FailureCode =
  | "invalid_request"
  | "scan_failed"
  | "read_failed"
  | "watch_failed"
  | "cancelled"
  /** The operation would have destroyed something that is already there. */
  | "conflict"
  /** A mutation the filesystem refused: permission, a read-only mount, ENOSPC. */
  | "write_failed"
  /**
   * A reply did not have the shape its channel promises.
   *
   * Distinct from `invalid_request`, which travels the other way. The renderer
   * cannot fix a malformed reply by asking differently, so conflating the two
   * would tell the user to correct input that was never theirs.
   */
  | "invalid_reply";

export interface Succeeded<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Failed {
  readonly ok: false;
  readonly error: Failure;
}

/**
 * Named arms, not inline object types.
 *
 * `isFailure` could not narrow the negative branch while the arms were written
 * inline: `Exclude` needs the guard's type to be exactly a union member, and a
 * structurally identical anonymous type is not the same type. Every
 * `result.value` after a successful guard was a compile error.
 */
export type Result<T> = Succeeded<T> | Failed;

export function success<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function failure<T>(code: FailureCode, message: string): Result<T> {
  return { ok: false, error: { code, message } };
}

export function isFailure<T>(result: Result<T>): result is Failed {
  return !result.ok;
}

/** Decodes an untrusted payload, or explains why it will not. */
export type Decoder<T> = (raw: unknown) => Result<T>;

// ── requests ──────────────────────────────────────────────────────────────

export interface ListRequest {
  readonly path: string;
  readonly showHidden: boolean;
  readonly sort: SortMode;
  /**
   * Largest, newest or last first.
   *
   * A property of the COMPARISON and not of the answer. `sortEntries` reverses
   * the directory group and the file group separately, so directories stay
   * above files in every order; reversing the finished listing would lift the
   * files above them, which is the one rule every mode holds.
   */
  readonly reverse: boolean;
  readonly stream: boolean;
  /**
   * The caller's name for this request, so it can cancel it.
   *
   * The first draft generated the id in the main process and returned it in the
   * reply — which arrives only once the scan has already finished. Per-request
   * cancellation was therefore structurally unreachable, and `"all"` was the
   * only lever that ever worked. The caller naming the stream up front is what
   * makes cancelling a running scan possible at all.
   */
  readonly streamId: string | null;
}

export interface WatchRequest {
  readonly path: string;
  readonly subscriptionId: string;
}

export interface ReadTextRequest {
  readonly path: string;
  readonly maxBytes: number;
}

export interface CancelRequest {
  readonly streamId: string;
}

/** Everything the preview router needs about one entry, in one round trip. */
export interface DescribeRequest {
  readonly path: string;
}

/** What a paste does with what it took. */
export type TransferMode = "copy" | "move";

export interface TransferRequest {
  readonly sources: readonly string[];
  /** The directory the sources land in. */
  readonly destination: string;
  readonly mode: TransferMode;
  /**
   * Replace what is already there.
   *
   * False on the first attempt, always. The reply then names the collisions and
   * the caller asks — silently overwriting is how a file manager loses work.
   */
  readonly overwrite: boolean;
  /** The caller's name for this transfer, so it can cancel it and follow it. */
  readonly transferId: string;
}

export interface CreateRequest {
  readonly path: string;
  readonly kind: "file" | "directory";
}

export interface RenameRequest {
  readonly path: string;
  /** The new NAME, not a path. Renaming never moves an entry. */
  readonly name: string;
}

export interface TrashRequest {
  readonly paths: readonly string[];
}

export interface OpenRequest {
  readonly path: string;
}

export interface CancelTransferRequest {
  readonly transferId: string;
}

/** Ask for a URL the renderer may load this file from. */
export interface PreviewUrlRequest {
  readonly path: string;
}

/**
 * Ask for the URL a file's OWN DIRECTORY is served under.
 *
 * The path names a file, never a directory, and the main process takes its
 * parent. The renderer naming its own root is the one shape that would let a
 * bug in the panel grant more than the document deserves.
 */
export interface PreviewDirectoryUrlRequest {
  readonly path: string;
}

/** `unwatch` needs only the id; requiring a path was an accident of reuse. */
export interface UnwatchRequest {
  readonly subscriptionId: string;
}

// ── replies ───────────────────────────────────────────────────────────────

export interface ListReply {
  readonly entries: readonly FsEntry[];
  readonly total: number;
  readonly streamId: string | null;
}

export interface ListBatch {
  readonly streamId: string;
  readonly entries: readonly FsEntry[];
  readonly done: boolean;
}

export interface ReadTextReply {
  readonly text: string;
  readonly bytesRead: number;
  /** The file is longer than what was read. */
  readonly truncated: boolean;
}

export interface DescribeReply {
  readonly name: string;
  readonly path: string;
  readonly isDirectory: boolean;
  /** How many entries a directory holds. Zero for a file. */
  readonly entryCount: number;
  /**
   * The first entries, capped. Empty for a file.
   *
   * Capped rather than complete, and reported beside the true `entryCount`
   * rather than instead of it: a directory of ten thousand names would
   * otherwise cross the boundary in full every time the cursor settled on it.
   * The difference between the two numbers is what lets the pane say how many
   * it is not showing.
   */
  readonly entries: readonly EntrySummary[];
  readonly size: number;
  readonly mime: string | null;
  /**
   * The first bytes, for the content sniff.
   *
   * Sent as a typed array rather than as a string: a UTF-8 decode of arbitrary
   * bytes is lossy, and the sniff is looking for a NUL that a lossy decode
   * would have replaced.
   */
  readonly head: Uint8Array;
}

/**
 * The frecent directories zoxide knows, as they cross the boundary.
 *
 * A failure is a value here as everywhere else, and one distinction earns its
 * place: "zoxide is not installed" is something the user can fix in one
 * command, and an empty list is simply how a fresh database looks. A popup
 * showing nothing cannot tell them apart.
 */
export interface FrecentReply {
  readonly entries: readonly { readonly score: number; readonly path: string }[];
}

/**
 * The listing order, as it crosses the boundary.
 *
 * Wrapped in an object with one field rather than sent bare, so a second thing
 * about a listing can be added later without every caller changing shape.
 */
export interface ListingOptionsReply {
  readonly options: ListingOptions;
}

export interface ListingOptionsWriteRequest {
  readonly options: ListingOptions;
}

/**
 * The bookmark store, as it crosses the boundary.
 *
 * A list of pairs rather than a `Map`: structured clone carries a `Map`, but
 * every other reply on this boundary is plain data and one exception would be
 * a thing to remember. The two ends convert at their own edges.
 */
export interface BookmarksReply {
  readonly bookmarks: readonly { readonly letter: string; readonly bookmark: Bookmark }[];
}

export interface BookmarksWriteRequest {
  readonly bookmarks: readonly { readonly letter: string; readonly bookmark: Bookmark }[];
}

export interface PreviewUrlReply {
  readonly url: string;
}

export interface TransferReply {
  /** How many top-level sources landed. */
  readonly moved: number;
  /**
   * The names already present at the destination.
   *
   * Non-empty means NOTHING was transferred: the whole operation stops before
   * it starts rather than doing half of it and asking about the rest.
   */
  readonly conflicts: readonly string[];
}

export interface RenameReply {
  readonly path: string;
}

/** How far a transfer has got. Pushed, not polled. */
export interface TransferProgress {
  readonly transferId: string;
  readonly done: number;
  readonly total: number;
}

/**
 * Everything a handler may reply with.
 *
 * Named rather than `Result<unknown>`, because a boundary that returns
 * `unknown` hands its caller the parsing problem it was supposed to solve —
 * which is exactly what the type-evidence policy flags. `null` is the reply for
 * the channels whose whole answer is "it worked".
 */
export type IpcReply =
  | Result<import("./overview/contract.ts").OverviewReply>
  | Result<ListReply>
  | Result<ReadTextReply>
  | Result<DescribeReply>
  | Result<PreviewUrlReply>
  | Result<TransferReply>
  | Result<RenameReply>
  | Result<BookmarksReply>
  | Result<ListingOptionsReply>
  | Result<FrecentReply>
  | Result<SearchReply>
  | Result<null>;

// ── decoding ──────────────────────────────────────────────────────────────

/**
 * The largest read the renderer may ask for.
 *
 * A cap it can name is a cap it can abuse; this is the ceiling regardless.
 */
const MAX_READ_BYTES = 64 * 1024 * 1024;

export function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

/**
 * The longest path the renderer may name.
 *
 * Linux caps a path at 4096 bytes, so anything beyond it cannot name a real
 * file — but nothing stopped a multi-megabyte string reaching `readdir`, which
 * verification noticed. A boundary that accepts input no syscall could use is
 * not validating, it is forwarding.
 */
const MAX_PATH_LENGTH = 4096;

/**
 * An absolute path with no NUL byte.
 *
 * Relative is refused because the renderer never learns a working directory, so
 * a relative path can only be a mistake or an attempt to reach somewhere it was
 * not given. A NUL is refused because it terminates the path at the syscall
 * boundary — a string check can approve one thing and the kernel open another.
 *
 * Exported because the daemon socket needs exactly these rules and must not
 * grow a second copy of them. Two validators for one concept is how one of them
 * silently stops matching the other, and the looser one becomes the hole.
 */
export function decodePath(raw: unknown): Result<string> {
  if (typeof raw !== "string") return failure("invalid_request", "path must be a string");
  if (raw === "") return failure("invalid_request", "path must not be empty");
  if (raw.length > MAX_PATH_LENGTH) {
    return failure("invalid_request", `path must be at most ${MAX_PATH_LENGTH} characters`);
  }
  if (raw.includes("\0")) return failure("invalid_request", "path must not contain a NUL byte");
  if (!raw.startsWith("/")) return failure("invalid_request", "path must be absolute");
  return success(raw);
}

export const decodeListRequest: Decoder<ListRequest> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_request", "request must be an object");

  const path = decodePath(raw.path);
  if (isFailure(path)) return path;

  const sort = raw.sort ?? "alphabetical";
  // No `typeof` test beside this one: `isSortMode` takes `unknown` and proves
  // the whole thing, so the string check it used to need is now redundant.
  if (!isSortMode(sort)) {
    return failure("invalid_request", `sort must be one of ${SORT_MODES.join(", ")}`);
  }

  const streamId = decodeStreamId(raw.streamId);
  if (isFailure(streamId)) return streamId;

  // Unknown keys are ignored rather than refused, so an older main process
  // survives a newer renderer sending a field it has never heard of.
  return success({
    path: path.value,
    showHidden: raw.showHidden === true,
    sort,
    // Absent means not reversed, the same shape `showHidden` takes. A main
    // process that predates this field is what the comment above describes,
    // and a renderer that predates it simply never sends it.
    reverse: raw.reverse === true,
    stream: raw.stream === true,
    streamId: streamId.value,
  });
};

/** An optional caller-supplied identifier. Absent is fine; empty is not. */
function decodeStreamId(raw: unknown): Result<string | null> {
  if (raw === undefined || raw === null) return success(null);
  if (typeof raw !== "string" || raw === "") {
    return failure("invalid_request", "streamId must be a non-empty string when given");
  }
  return success(raw);
}

export const decodeWatchRequest: Decoder<WatchRequest> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_request", "request must be an object");

  const path = decodePath(raw.path);
  if (isFailure(path)) return path;

  if (typeof raw.subscriptionId !== "string" || raw.subscriptionId === "") {
    return failure("invalid_request", "subscriptionId is required to route events back");
  }

  return success({ path: path.value, subscriptionId: raw.subscriptionId });
};

export const decodeReadTextRequest: Decoder<ReadTextRequest> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_request", "request must be an object");

  const path = decodePath(raw.path);
  if (isFailure(path)) return path;

  const requested = raw.maxBytes ?? MAX_READ_BYTES;
  if (typeof requested !== "number" || !Number.isInteger(requested) || requested <= 0) {
    return failure("invalid_request", "maxBytes must be a positive integer");
  }

  return success({ path: path.value, maxBytes: Math.min(requested, MAX_READ_BYTES) });
};

/**
 * A request whose whole content is one path.
 *
 * Three channels ask exactly this — describe, preview-url and open — and they
 * had three identical decoders. One definition means a rule added to path
 * validation reaches all of them, which is the point: the next rule will be a
 * security rule.
 */
const decodePathOnly: Decoder<{ readonly path: string }> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_request", "request must be an object");

  const path = decodePath(raw["path"]);
  return isFailure(path) ? path : success({ path: path.value });
};

export const decodeDescribeRequest: Decoder<DescribeRequest> = decodePathOnly;

export const decodePreviewUrlRequest: Decoder<PreviewUrlRequest> = decodePathOnly;

export const decodePreviewDirectoryUrlRequest: Decoder<PreviewDirectoryUrlRequest> = decodePathOnly;

function decodePathList(raw: unknown): Result<string[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return failure("invalid_request", "sources must be a non-empty array");
  }

  const paths: string[] = [];
  for (const item of raw) {
    const path = decodePath(item);
    if (isFailure(path)) return path;
    paths.push(path.value);
  }
  return success(paths);
}

export const decodeTransferRequest: Decoder<TransferRequest> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_request", "request must be an object");

  const sources = decodePathList(raw["sources"]);
  if (isFailure(sources)) return sources;

  const destination = decodePath(raw["destination"]);
  if (isFailure(destination)) return destination;

  const mode = raw["mode"];
  if (mode !== "copy" && mode !== "move") {
    return failure("invalid_request", "mode must be copy or move");
  }

  const transferId = stringField(raw, "transferId");
  if (transferId === null) return failure("invalid_request", "transferId must be a string");

  return success({
    sources: sources.value,
    destination: destination.value,
    mode,
    overwrite: raw["overwrite"] === true,
    transferId,
  });
};

export const decodeCreateRequest: Decoder<CreateRequest> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_request", "request must be an object");

  const path = decodePath(raw["path"]);
  if (isFailure(path)) return path;

  const kind = raw["kind"];
  if (kind !== "file" && kind !== "directory") {
    return failure("invalid_request", "kind must be file or directory");
  }
  return success({ path: path.value, kind });
};

export const decodeRenameRequest: Decoder<RenameRequest> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_request", "request must be an object");

  const path = decodePath(raw["path"]);
  if (isFailure(path)) return path;

  const name = stringField(raw, "name");
  if (name === null || name === "") return failure("invalid_request", "name must be a string");

  // A rename takes a NAME. A separator would move the entry somewhere else
  // while calling itself a rename, and `..` would move it somewhere the user
  // cannot see from here.
  if (name.includes("/") || name === "." || name === "..") {
    return failure("invalid_request", "a name may not contain a path separator");
  }
  return success({ path: path.value, name });
};

export const decodeTrashRequest: Decoder<TrashRequest> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_request", "request must be an object");

  const paths = decodePathList(raw["paths"]);
  return isFailure(paths) ? paths : success({ paths: paths.value });
};

export const decodeOpenRequest: Decoder<OpenRequest> = decodePathOnly;

/**
 * Put something on the system clipboard.
 *
 * ONE channel with a discriminant rather than two channels, because every name
 * on the privileged surface is a thing the sandboxed renderer can reach and the
 * smoke test asserts that list exactly. Two destinations that differ only in
 * what they carry do not earn two doors.
 */
export type ClipboardRequest =
  | { readonly kind: "text"; readonly text: string }
  /** A path for the MAIN process to read. The renderer cannot open a file. */
  | { readonly kind: "image"; readonly path: string };

/**
 * The frecent list, as the renderer receives it.
 *
 * Parsed rather than trusted, like every other reply on this boundary. A row
 * missing either half is dropped rather than failing the whole list: one
 * unreadable entry should not cost the user the other forty.
 */
export const decodeFrecentReply: Decoder<FrecentReply> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_reply", "reply must be an object");

  const listed = raw["entries"];
  if (!Array.isArray(listed)) return failure("invalid_reply", "reply.entries must be an array");

  const entries: { score: number; path: string }[] = [];
  for (const row of listed) {
    if (!isRecord(row)) continue;
    const score = row["score"];
    const path = row["path"];
    // `typeof NaN === "number"`, so the type test alone lets a NaN through —
    // and a NaN score sorts unpredictably and renders as nothing.
    if (typeof score !== "number" || !Number.isFinite(score)) continue;
    if (typeof path !== "string") continue;
    if (!path.startsWith("/")) continue;
    entries.push({ score, path });
  }

  return success({ entries });
};

export const decodeClipboardRequest: Decoder<ClipboardRequest> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_request", "request must be an object");

  const kind = raw["kind"];
  if (kind === "text") {
    const text = stringField(raw, "text");
    // An empty string is a legitimate copy — it is what an empty selection
    // yields — so the check is the TYPE, never the length.
    return text === null
      ? failure("invalid_request", "text must be a string")
      : success({ kind, text });
  }

  if (kind === "image") {
    const path = decodePath(raw["path"]);
    return isFailure(path) ? path : success({ kind, path: path.value });
  }

  return failure("invalid_request", "kind must be text or image");
};

export const decodeCancelTransferRequest: Decoder<CancelTransferRequest> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_request", "request must be an object");

  const transferId = stringField(raw, "transferId");
  return transferId === null
    ? failure("invalid_request", "transferId must be a string")
    : success({ transferId });
};

export const decodeUnwatchRequest: Decoder<UnwatchRequest> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_request", "request must be an object");
  if (typeof raw.subscriptionId !== "string" || raw.subscriptionId === "") {
    return failure("invalid_request", "subscriptionId is required");
  }
  return success({ subscriptionId: raw.subscriptionId });
};

export const decodeCancelRequest: Decoder<CancelRequest> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_request", "request must be an object");
  if (typeof raw.streamId !== "string" || raw.streamId === "") {
    return failure("invalid_request", "streamId is required");
  }
  return success({ streamId: raw.streamId });
};

// ── decoding replies ──────────────────────────────────────────────────────

/**
 * The renderer parses what crosses the boundary too, not only the main process.
 *
 * The bridge hands page code `Result<unknown>`, and turning that into a typed
 * reply with an assertion would move the parsing problem rather than solve it:
 * a main process that changed its reply shape would then produce a `TypeError`
 * deep inside a React render, blaming the component instead of the boundary.
 * These decoders make a shape mismatch a value the interface can show.
 */

function stringField(raw: Record<string, unknown>, field: string): string | null {
  const value = raw[field];
  return typeof value === "string" ? value : null;
}

function finiteField(raw: Record<string, unknown>, field: string): number | null {
  const value = raw[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const ENTRY_KINDS = ["file", "directory", "other"] as const;

function isEntryKind(value: string): value is FsEntry["kind"] {
  // SAFETY: widens the const tuple to compare an arbitrary string against it.
  // It loosens the element type and asserts nothing about `value`, which is
  // what the predicate above then establishes.
  return (ENTRY_KINDS as readonly string[]).includes(value);
}

export const decodeFsEntry: Decoder<FsEntry> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_reply", "entry must be an object");

  const name = stringField(raw, "name");
  if (name === null) return failure("invalid_reply", "entry.name must be a string");

  const kind = stringField(raw, "kind");
  if (kind === null || !isEntryKind(kind)) {
    return failure("invalid_reply", `entry.kind is not a kind: ${String(raw["kind"])}`);
  }

  const size = finiteField(raw, "size");
  const modifiedMs = finiteField(raw, "modifiedMs");
  if (size === null || modifiedMs === null) {
    return failure("invalid_reply", "entry.size and entry.modifiedMs must be finite numbers");
  }

  const entry: FsEntry = {
    name,
    kind,
    size,
    modifiedMs,
    isSymlink: raw["isSymlink"] === true,
    isHidden: raw["isHidden"] === true,
  };
  return success(raw["unreadable"] === true ? { ...entry, unreadable: true } : entry);
};

function decodeEntries(raw: unknown): Result<FsEntry[]> {
  if (!Array.isArray(raw)) return failure("invalid_reply", "entries must be an array");

  const entries: FsEntry[] = [];
  for (const item of raw) {
    const decoded = decodeFsEntry(item);
    // One bad entry fails the whole listing rather than being skipped. A
    // silently shortened directory is indistinguishable from a correct one, and
    // the user would act on a listing that is missing something.
    if (isFailure(decoded)) return decoded;
    entries.push(decoded.value);
  }
  return success(entries);
}

export const decodeListReply: Decoder<ListReply> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_reply", "reply must be an object");

  const entries = decodeEntries(raw["entries"]);
  if (isFailure(entries)) return entries;

  const total = finiteField(raw, "total");
  if (total === null) return failure("invalid_reply", "reply.total must be a finite number");

  const streamId = raw["streamId"];
  if (streamId !== null && typeof streamId !== "string") {
    return failure("invalid_reply", "reply.streamId must be a string or null");
  }

  return success({ entries: entries.value, total, streamId });
};

export const decodeListBatch: Decoder<ListBatch> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_reply", "batch must be an object");

  const streamId = stringField(raw, "streamId");
  if (streamId === null) return failure("invalid_reply", "batch.streamId must be a string");

  const entries = decodeEntries(raw["entries"]);
  if (isFailure(entries)) return entries;

  return success({ streamId, entries: entries.value, done: raw["done"] === true });
};

/** What a watched directory reports. The changed paths are not needed yet. */
export interface ChangedEvent {
  readonly subscriptionId: string;
  readonly error?: string;
}

export const decodeChangedEvent: Decoder<ChangedEvent> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_reply", "event must be an object");

  const subscriptionId = stringField(raw, "subscriptionId");
  if (subscriptionId === null) {
    return failure("invalid_reply", "event.subscriptionId must be a string");
  }
  if (raw["error"] === undefined) return success({ subscriptionId });
  const error = stringField(raw, "error");
  return error === null
    ? failure("invalid_reply", "event.error must be a string")
    : success({ subscriptionId, error });
};

/**
 * One listed entry, decoded.
 *
 * Reuses `isEntryKind`, the same predicate `decodeFsEntry` validates a full
 * entry with — one definition of what a kind is, so the two decoders cannot
 * come to disagree about `other`.
 *
 * Returns `null` for anything malformed rather than dropping it, so a single
 * bad element fails the whole reply. Dropping would leave the pane rendering a
 * listing shorter than the one the main process sent, with nothing saying so.
 */
function entrySummary(raw: unknown): EntrySummary | null {
  if (!isRecord(raw)) return null;

  const name = stringField(raw, "name");
  const kind = stringField(raw, "kind");
  if (name === null || kind === null || !isEntryKind(kind)) return null;

  return { name, kind };
}

export const decodeDescribeReply: Decoder<DescribeReply> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_reply", "reply must be an object");

  const name = stringField(raw, "name");
  const path = stringField(raw, "path");
  const size = finiteField(raw, "size");
  const entryCount = finiteField(raw, "entryCount");
  if (name === null || path === null || size === null || entryCount === null) {
    return failure("invalid_reply", "reply is missing a required field");
  }

  const rawEntries = raw["entries"];
  if (!Array.isArray(rawEntries)) {
    return failure("invalid_reply", "reply.entries must be an array");
  }
  const entries: EntrySummary[] = [];
  for (const element of rawEntries) {
    const summary = entrySummary(element);
    if (summary === null) {
      return failure("invalid_reply", "reply.entries holds a malformed entry");
    }
    entries.push(summary);
  }

  // The listing is a capped PREFIX of the directory, so it can never be longer
  // than the count. Without this the pane computes `count - listed` for its
  // "and N more" line and would render "and -3 more" — a broken invariant
  // presented as a fact, rather than a failure at the boundary that exists to
  // catch one.
  if (entries.length > entryCount) {
    return failure("invalid_reply", "reply.entries is longer than reply.entryCount");
  }

  const mime = raw["mime"];
  if (mime !== null && typeof mime !== "string") {
    return failure("invalid_reply", "reply.mime must be a string or null");
  }

  const head = raw["head"];
  if (!(head instanceof Uint8Array)) {
    return failure("invalid_reply", "reply.head must be a byte array");
  }

  return success({
    name,
    path,
    isDirectory: raw["isDirectory"] === true,
    entryCount,
    entries,
    size,
    mime,
    head,
  });
};

export const decodePreviewUrlReply: Decoder<PreviewUrlReply> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_reply", "reply must be an object");

  const url = stringField(raw, "url");
  return url === null ? failure("invalid_reply", "reply.url must be a string") : success({ url });
};

export const decodeReadTextReply: Decoder<ReadTextReply> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_reply", "reply must be an object");

  const text = stringField(raw, "text");
  const bytesRead = finiteField(raw, "bytesRead");
  if (text === null || bytesRead === null) {
    return failure("invalid_reply", "reply.text and reply.bytesRead are required");
  }
  return success({ text, bytesRead, truncated: raw["truncated"] === true });
};

export const decodeTransferReply: Decoder<TransferReply> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_reply", "reply must be an object");

  const moved = finiteField(raw, "moved");
  const conflicts = raw["conflicts"];
  if (moved === null || !Array.isArray(conflicts)) {
    return failure("invalid_reply", "reply.moved and reply.conflicts are required");
  }
  return success({ moved, conflicts: conflicts.map(String) });
};

export const decodeRenameReply: Decoder<RenameReply> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_reply", "reply must be an object");

  const path = stringField(raw, "path");
  return path === null
    ? failure("invalid_reply", "reply.path must be a string")
    : success({ path });
};

export const decodeTransferProgress: Decoder<TransferProgress> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_reply", "event must be an object");

  const transferId = stringField(raw, "transferId");
  const done = finiteField(raw, "done");
  const total = finiteField(raw, "total");
  if (transferId === null || done === null || total === null) {
    return failure("invalid_reply", "progress is missing a required field");
  }
  return success({ transferId, done, total });
};

/**
 * One letter-and-bookmark pair, decoded.
 *
 * The renderer is sandboxed and this reply reaches it, so the shape is checked
 * rather than trusted — the same rule every other reply on this boundary
 * follows. A malformed pair fails the whole reply: a partly-decoded bookmark
 * list would leave the overlays advertising a letter that goes nowhere.
 */
function decodeBookmarkPair(raw: unknown): { letter: string; bookmark: Bookmark } | null {
  if (!isRecord(raw)) return null;

  const letter = stringField(raw, "letter");
  const bookmark = raw["bookmark"];
  if (letter === null || !isRecord(bookmark)) return null;

  const path = stringField(bookmark, "path");
  const label = stringField(bookmark, "label");
  if (path === null || label === null) return null;

  return { letter, bookmark: { path, label } };
}

/**
 * The bookmark list, decoded once for both directions.
 *
 * The two channels differ only in which failure code they report and what they
 * call the payload — a reply cannot be fixed by asking differently, a request
 * can, and the codes say so. Everything else about the shape is identical, so
 * it is written once.
 */
function decodeBookmarkList(
  code: FailureCode,
  noun: string,
  raw: unknown,
): Result<{ bookmarks: { letter: string; bookmark: Bookmark }[] }> {
  if (!isRecord(raw)) return failure(code, `${noun} must be an object`);

  const list = raw["bookmarks"];
  if (!Array.isArray(list)) return failure(code, `${noun}.bookmarks must be an array`);

  const bookmarks: { letter: string; bookmark: Bookmark }[] = [];
  for (const element of list) {
    const pair = decodeBookmarkPair(element);
    if (pair === null) return failure(code, `${noun}.bookmarks holds a malformed entry`);
    bookmarks.push(pair);
  }
  return success({ bookmarks });
}

/**
 * A stored listing order, on the way IN.
 *
 * `decodeListingOptions` never fails — it repairs field by field and falls back
 * to the default — so the only thing to reject here is a payload that is not an
 * object at all. Shape is checked here; MEANING is `fm-core/listingOptions`'s,
 * and the write handler runs both, so a caller cannot persist a sort mode the
 * next load would silently discard.
 *
 * Its reply-direction twin is below, with `invalid_reply` rather than
 * `invalid_request`: that code exists precisely so a malformed ANSWER is never
 * reported to the renderer as if the renderer had sent bad input.
 */
export const decodeListingOptionsWriteRequest: Decoder<ListingOptionsWriteRequest> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_request", "request must be an object");
  if (!isRecord(raw["options"])) return failure("invalid_request", "options must be an object");
  return success({ options: decodeListingOptions(raw["options"]) });
};

/** The same shape coming back, and a failure code that says which way it went. */
export const decodeListingOptionsReply: Decoder<ListingOptionsReply> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_reply", "reply must be an object");
  if (!isRecord(raw["options"])) return failure("invalid_reply", "options must be an object");
  return success({ options: decodeListingOptions(raw["options"]) });
};

export const decodeBookmarksReply: Decoder<BookmarksReply> = (raw) =>
  decodeBookmarkList("invalid_reply", "reply", raw);

export const decodeBookmarksWriteRequest: Decoder<BookmarksWriteRequest> = (raw) =>
  decodeBookmarkList("invalid_request", "request", raw);

// ── search ────────────────────────────────────────────────────────────────

export interface SearchReplyRow {
  readonly relativePath: string;
  readonly name: string;
  readonly fullPath: string;
  readonly isDir: boolean;
  readonly score: number;
  readonly size: number;
  readonly modifiedMs: number;
  readonly gitStatus: string;
  readonly matchIndices: readonly number[];
}

export interface SearchReply {
  readonly rows: readonly SearchReplyRow[];
  readonly matchedQuery: string;
  readonly truncated: boolean;
  readonly cap: number;
}

/**
 * The search reply, parsed rather than trusted.
 *
 * The rows arrive from a separate process that itself talks to a native
 * library, which is about the least trustworthy sender on this boundary.
 *
 * **A bad ROW is dropped; a bad REPLY fails.** That asymmetry is the same
 * judgement `decodeFrecentReply` makes and it is deliberate: one unreadable
 * entry should not cost the user the other forty, but a reply with no answered
 * query cannot be used at all — the caller has no way to tell whether it is
 * stale.
 *
 * ⚠ `SearchReplyRow` duplicates `SearchRow` from `@symmetria/fm-search` on
 * purpose. Importing it would either invert the dependency direction or make a
 * host take two git-pinned packages to get the finder. `searchRowShape.test.ts`
 * asserts the two stay structurally identical, so the duplication is checked
 * rather than hoped at.
 */
export const decodeSearchReply: Decoder<SearchReply> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_reply", "reply must be an object");
  if (!Array.isArray(raw["rows"])) return failure("invalid_reply", "reply.rows must be an array");
  if (typeof raw["matchedQuery"] !== "string") {
    return failure("invalid_reply", "reply.matchedQuery must be a string");
  }

  const rows: SearchReplyRow[] = [];
  for (const candidate of raw["rows"]) {
    const row = decodeSearchRow(candidate);
    if (row !== null) rows.push(row);
  }

  return success({
    rows,
    matchedQuery: raw["matchedQuery"],
    truncated: raw["truncated"] === true,
    cap: typeof raw["cap"] === "number" && Number.isFinite(raw["cap"]) ? raw["cap"] : 0,
  });
};

/** One row, or `null` when it cannot be read. */
function decodeSearchRow(raw: unknown): SearchReplyRow | null {
  if (!isRecord(raw)) return null;
  const required = requiredRowFields(raw);
  if (required === null) return null;

  return {
    ...required,
    isDir: raw["isDir"] === true,
    size: numberOr(raw["size"], 0),
    modifiedMs: numberOr(raw["modifiedMs"], 0),
    gitStatus: typeof raw["gitStatus"] === "string" ? raw["gitStatus"] : "",
    matchIndices: matchIndicesOf(raw["matchIndices"]),
  };
}

/**
 * The four fields a row cannot be read without, or `null`.
 *
 * Split out because the optional fields all fall back to a default and the
 * required ones all reject the row — two different jobs that read as one long
 * chain of guards when they share a function.
 */
function requiredRowFields(
  raw: Record<string, unknown>,
): Pick<SearchReplyRow, "relativePath" | "name" | "fullPath" | "score"> | null {
  const relativePath = raw["relativePath"];
  const name = raw["name"];
  const fullPath = raw["fullPath"];
  const score = raw["score"];
  if (typeof relativePath !== "string" || typeof name !== "string") return null;
  // Absolute, or the renderer would resolve it against whatever it thinks its
  // working directory is — not a decision this boundary leaves open.
  if (typeof fullPath !== "string" || !fullPath.startsWith("/")) return null;
  // `typeof NaN === "number"`, so the type test alone lets a NaN through, and a
  // NaN score sorts unpredictably and renders as nothing.
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  return { relativePath, name, fullPath, score };
}

function matchIndicesOf(value: unknown): readonly number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((at): at is number => typeof at === "number" && Number.isInteger(at));
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Which directory to index, or to search, or to let go. */
export interface SearchDirectoryRequest {
  readonly directory: string;
}

/** A search: which index, and what to look for. */
export interface SearchQueryRequest extends SearchDirectoryRequest {
  readonly query: string;
}

export const decodeSearchDirectoryRequest: Decoder<SearchDirectoryRequest> = (raw) => {
  if (!isRecord(raw)) return failure("invalid_request", "request must be an object");
  // `decodePath` and not a local check. This string becomes the pool's map key
  // AND an `argv` entry handed to a forked process, so it needs the same length
  // cap and NUL refusal every other path on this boundary gets — a NUL
  // truncates at the exec boundary, approving one directory and opening
  // another. A hand-rolled check here was the second copy of those rules, and
  // the looser copy is always the hole.
  const directory = decodePath(raw["directory"]);
  if (isFailure(directory)) return directory;
  return success({ directory: directory.value });
};

export const decodeSearchQueryRequest: Decoder<SearchQueryRequest> = (raw) => {
  const base = decodeSearchDirectoryRequest(raw);
  if (isFailure(base)) return base;
  if (!isRecord(raw) || typeof raw["query"] !== "string") {
    return failure("invalid_request", "request.query must be a string");
  }
  return success({ directory: base.value.directory, query: raw["query"] });
};

/** Which file a query ended up choosing, in the index it was found in. */
export interface SearchRecordRequest extends SearchQueryRequest {
  readonly chosenPath: string;
}

export const decodeSearchRecordRequest: Decoder<SearchRecordRequest> = (raw) => {
  const base = decodeSearchQueryRequest(raw);
  if (isFailure(base)) return base;
  // The chosen path gets the full path rules, not a laxer set: it reaches the
  // engine as a key in a store on disk, and this boundary does not get to
  // decide that a key is a safer place for a NUL byte than a filename is.
  const chosenPath = decodePath(isRecord(raw) ? raw["chosenPath"] : undefined);
  if (isFailure(chosenPath)) return chosenPath;
  return success({ ...base.value, chosenPath: chosenPath.value });
};
