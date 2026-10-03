// @effect-diagnostics nodeBuiltinImport:off
/**
 * Follows a file that only grows, such as a Software Factory run's `events.jsonl`
 * or a role's output: complete lines, read from a byte offset, so a file of
 * megabytes is read once and then only by its new bytes.
 *
 * The file may not exist yet. A partial last line waits for its newline, and a
 * file that shrank, or another file now at its path, is read again from the
 * start and reported as truncated.
 *
 * @module appendOnlyFileTail
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { isHostWindows } from "@t3tools/shared/hostProcess";

/** The most bytes one read takes; a caller loops while `more` is set. */
export const TAIL_READ_MAX_BYTES = 1024 * 1024;

/** Writers emit several events per append, and the watch fires before the bytes land. */
const WATCH_DEBOUNCE = Duration.millis(100);

/**
 * How often to check the watch: that the directory is still the one watched,
 * and whether a missing file has appeared. A directory that does not exist yet
 * cannot be watched at all.
 */
const RECHECK_INTERVAL = Duration.seconds(3);

const NEWLINE = 0x0a;

/**
 * The most of a file's first line kept to tell it from a file that replaced it.
 * An inode number alone does not: ext4 gives a new file the number its deleted
 * predecessor freed, often at once. The first line, because an append-only
 * file never changes it once complete, while later lines may be rewritten in
 * place without making it another file.
 */
const IDENTITY_PREFIX_BYTES = 1024;

export class AppendOnlyFileTailError extends Schema.TaggedError<AppendOnlyFileTailError>()(
  "AppendOnlyFileTailError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not read ${this.path}.`;
  }
}

export interface TailRead {
  /** Complete lines appended since the last read, without their newline; blank lines dropped. */
  readonly lines: ReadonlyArray<string>;
  /**
   * The file was shorter than what was already read, or another file now has its
   * path; the lines start again from its beginning.
   */
  readonly truncated: boolean;
  readonly missing: boolean;
  /** More bytes are waiting than one read takes. */
  readonly more: boolean;
}

export interface AppendOnlyFileTail {
  readonly path: string;
  /** Reads the next complete lines. Reads are serialized. */
  readonly read: Effect.Effect<TailRead, AppendOnlyFileTailError>;
  /** Whether the last read found no file (true before the first read). */
  readonly isMissing: () => boolean;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right;
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left, 0);
  joined.set(right, left.byteLength);
  return joined;
}

const isMissingError = (cause: unknown) => {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/** A tail of an absolute path, positioned at the file's start. */
export function makeAppendOnlyFileTail(filePath: string): AppendOnlyFileTail {
  let offset = 0;
  // Bytes after the last newline, kept as bytes so a character split across
  // two reads decodes whole.
  let pending: Uint8Array = new Uint8Array(0);
  let missing = true;
  // The file's identity, its inode number and first line: a file replaced at
  // the same path is read from its start.
  let inode: number | null = null;
  let prefix: Uint8Array = new Uint8Array(0);
  const decoder = new TextDecoder();
  const permit = Semaphore.makeUnsafe(1);

  /** Whether the open file begins with the bytes the followed file began with. */
  const startsWithPrefix = async (handle: NodeFSP.FileHandle, size: number) => {
    // A file shorter than the prefix is shorter than the offset, and read again anyway.
    if (prefix.byteLength === 0 || size < prefix.byteLength) return true;
    const start = new Uint8Array(prefix.byteLength);
    const { bytesRead } = await handle.read(start, 0, start.byteLength, 0);
    return bytesEqual(start.subarray(0, bytesRead), prefix);
  };

  const readOnce = async (): Promise<TailRead> => {
    let handle: NodeFSP.FileHandle;
    try {
      handle = await NodeFSP.open(filePath, "r");
    } catch (cause) {
      if (!isMissingError(cause)) throw cause;
      missing = true;
      return { lines: [], truncated: false, missing: true, more: false };
    }
    missing = false;
    try {
      const { size, ino } = await handle.stat();
      let truncated = false;
      const replaced = inode !== null && (ino !== inode || !(await startsWithPrefix(handle, size)));
      inode = ino;
      if (replaced || size < offset) {
        offset = 0;
        pending = new Uint8Array(0);
        prefix = new Uint8Array(0);
        truncated = true;
      }
      const length = Math.min(size - offset, TAIL_READ_MAX_BYTES);
      if (length <= 0) return { lines: [], truncated, missing: false, more: false };
      const buffer = new Uint8Array(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      const read = buffer.subarray(0, bytesRead);
      const prefixComplete =
        prefix.byteLength >= IDENTITY_PREFIX_BYTES || prefix.at(-1) === NEWLINE;
      if (!prefixComplete) {
        const newline = read.indexOf(NEWLINE);
        const firstLine = newline === -1 ? read : read.subarray(0, newline + 1);
        prefix = concatBytes(prefix, firstLine.slice(0, IDENTITY_PREFIX_BYTES - prefix.byteLength));
      }
      offset += bytesRead;
      const bytes = concatBytes(pending, read);
      const lines: Array<string> = [];
      let start = 0;
      for (let index = 0; index < bytes.byteLength; index += 1) {
        if (bytes[index] !== NEWLINE) continue;
        const line = decoder.decode(bytes.subarray(start, index)).replace(/\r$/, "");
        if (line.trim() !== "") lines.push(line);
        start = index + 1;
      }
      pending = bytes.slice(start);
      return { lines, truncated, missing: false, more: offset < size };
    } finally {
      await handle.close();
    }
  };

  return {
    path: filePath,
    read: permit.withPermits(1)(
      Effect.tryPromise({
        try: readOnce,
        catch: (cause) => new AppendOnlyFileTailError({ path: filePath, cause }),
      }),
    ),
    isMissing: () => missing,
  };
}

/**
 * Signals when the file may have grown. The parent directory is watched,
 * non-recursively, and the watch is acquired HERE, before the caller's first
 * read: a stream that only watched once pulled would miss an append landing
 * between that read and the watch. Watching the directory rather than the file
 * also sees a file that does not exist yet. The order and the recheck follow
 * `workspace/WorkspaceFileWatcher.ts`, which only resolves workspace-relative
 * paths.
 *
 * A watch on a deleted directory goes inert without an error, so every recheck
 * also compares the directory's identity with the one watched, and watches it
 * again, and signals, when the directory is gone, new, or its watch died. The
 * watch holds the directory open, because ext4 gives a directory created
 * again the inode number of the one deleted unless something still holds it.
 */
export const watchAppendOnlyFile = Effect.fn("watchAppendOnlyFile")(function* (
  tail: AppendOnlyFileTail,
  options: { readonly recheckInterval?: Duration.Duration } = {},
): Effect.fn.Return<Stream.Stream<void>, never, Scope.Scope> {
  const directory = NodePath.dirname(tail.path);
  const fileName = NodePath.basename(tail.path);
  const triggers = yield* Queue.unbounded<void, Cause.Done>();
  let watcher: NodeFS.FSWatcher | null = null;
  let watchedInode: number | null = null;
  // Keeps the watched directory's inode number from passing to its successor.
  // Not on Windows, where an open directory can hold up its deletion and NTFS
  // does not reuse file IDs promptly.
  const holdsDirectory = !(yield* isHostWindows);
  let heldDirectory: number | null = null;

  const directoryInode = () => {
    try {
      return NodeFS.statSync(directory).ino;
    } catch {
      return null;
    }
  };

  const closeWatch = () => {
    watcher?.close();
    watcher = null;
    if (heldDirectory !== null) NodeFS.closeSync(heldDirectory);
    heldDirectory = null;
  };

  /** Opens the directory now at the path and returns its inode number; null when there is none. */
  const holdDirectory = () => {
    if (!holdsDirectory) return directoryInode();
    try {
      heldDirectory = NodeFS.openSync(directory, "r");
    } catch {
      return null;
    }
    return NodeFS.fstatSync(heldDirectory).ino;
  };

  /** Replaces the watch with one on the directory now at the path; null when there is none. */
  const watchDirectory = () => {
    closeWatch();
    watchedInode = holdDirectory();
    if (watchedInode === null) return;
    try {
      const next = NodeFS.watch(directory, { recursive: false }, (_event, name) => {
        if (name === null || name === fileName) Queue.offerUnsafe(triggers, undefined);
      });
      next.on("error", () => {
        if (watcher === next) watcher = null;
      });
      watcher = next;
    } catch {
      watchedInode = null;
    }
  };

  /** True when the caller should read: the watch was renewed, or the file is still missing. */
  const recheck = Effect.sync(() => {
    const inode = directoryInode();
    if (watcher === null || inode === null || inode !== watchedInode) {
      watchDirectory();
      return true;
    }
    return tail.isMissing();
  });

  yield* Effect.acquireRelease(Effect.sync(watchDirectory), () => Effect.sync(closeWatch));

  const rechecks = Stream.fromSchedule(
    Schedule.spaced(options.recheckInterval ?? RECHECK_INTERVAL),
  ).pipe(
    Stream.mapEffect(() => recheck),
    Stream.filter((shouldRead) => shouldRead),
  );
  return Stream.merge(
    Stream.fromQueue(triggers).pipe(Stream.debounce(WATCH_DEBOUNCE)),
    rechecks,
  ).pipe(Stream.map((): void => undefined));
});
