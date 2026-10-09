// @effect-diagnostics nodeBuiltinImport:off
/**
 * Follows a file that only grows, such as a Software Factory run's `events.jsonl`
 * or a role's output: complete lines, read from a byte offset, so a file of
 * megabytes is read once and then only by its new bytes.
 *
 * The file may not exist yet. A partial last line waits for its newline, and a
 * file that shrank, or another file now at its path, is read again from the
 * start and reported as truncated. Content never decides which file it is:
 * equal bytes in another file are still another file.
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

/** An open file and its identity on its filesystem. */
interface OpenFile {
  readonly handle: NodeFSP.FileHandle;
  readonly dev: number;
  readonly ino: number;
}

/**
 * A tail of an absolute path, positioned at the file's start, for the life of
 * the scope.
 *
 * The tail holds the file it follows open until the scope closes. A file then
 * created at the path cannot get its inode number, which ext4 otherwise hands
 * to a new file as soon as the old one is deleted, so a different number at
 * the path is exactly a replaced file. A deleted file stays held, its disk
 * space included, until another file appears at the path or the scope closes.
 */
export const makeAppendOnlyFileTail = Effect.fn("makeAppendOnlyFileTail")(function* (
  filePath: string,
): Effect.fn.Return<AppendOnlyFileTail, never, Scope.Scope> {
  // Not on Windows, where an open file can hold up its replacement and NTFS
  // does not reuse file IDs promptly. Off too once the scope has closed.
  let holdsFile = !(yield* isHostWindows);
  let held: OpenFile | null = null;
  let offset = 0;
  // Bytes after the last newline, kept as bytes so a character split across
  // two reads decodes whole.
  let pending: Uint8Array = new Uint8Array(0);
  let missing = true;
  // The identity of the file last read: another file at the path is read from its start.
  let identity: { readonly dev: number; readonly ino: number } | null = null;
  const decoder = new TextDecoder();
  const permit = Semaphore.makeUnsafe(1);

  /** The file now at the path: the held one while it is still there, else a new handle. */
  const openAtPath = async (): Promise<OpenFile> => {
    if (held !== null) {
      const atPath = await NodeFSP.stat(filePath);
      if (atPath.dev === held.dev && atPath.ino === held.ino) return held;
    }
    const handle = await NodeFSP.open(filePath, "r");
    try {
      const { dev, ino } = await handle.stat();
      return { handle, dev, ino };
    } catch (cause) {
      await handle.close();
      throw cause;
    }
  };

  const release = async () => {
    const file = held;
    held = null;
    await file?.handle.close();
  };

  const readOnce = async (): Promise<TailRead> => {
    let file: OpenFile;
    try {
      file = await openAtPath();
    } catch (cause) {
      if (!isMissingError(cause)) throw cause;
      missing = true;
      return { lines: [], truncated: false, missing: true, more: false };
    }
    missing = false;
    if (file !== held) {
      await release();
      if (holdsFile) held = file;
    }
    try {
      const { size } = await file.handle.stat();
      let truncated = false;
      const replaced =
        identity !== null && (file.dev !== identity.dev || file.ino !== identity.ino);
      identity = { dev: file.dev, ino: file.ino };
      if (replaced || size < offset) {
        offset = 0;
        pending = new Uint8Array(0);
        truncated = true;
      }
      const length = Math.min(size - offset, TAIL_READ_MAX_BYTES);
      if (length <= 0) return { lines: [], truncated, missing: false, more: false };
      const buffer = new Uint8Array(length);
      const { bytesRead } = await file.handle.read(buffer, 0, length, offset);
      offset += bytesRead;
      const bytes = concatBytes(pending, buffer.subarray(0, bytesRead));
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
      if (file !== held) await file.handle.close();
    }
  };

  yield* Effect.addFinalizer(() =>
    permit.withPermits(1)(
      Effect.promise(() => {
        holdsFile = false;
        return release().catch(() => undefined);
      }),
    ),
  );

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
});

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
