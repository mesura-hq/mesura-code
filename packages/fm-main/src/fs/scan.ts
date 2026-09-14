import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { EntryKind, FsEntry } from "@symmetria/fm-core/entry";

export interface ScanOptions {
  /** Aborts the scan for real: checked between batches, not only at the ends. */
  readonly signal?: AbortSignal;
}

/**
 * How many entries are stat'd at once.
 *
 * Not unbounded, and not one. Dispatching all six thousand `lstat` calls in a
 * single `Promise.all` gives the event loop no seam to notice an abort, and
 * floods the thread pool besides. A batch is the seam: concurrency inside it,
 * an abort check between them.
 */
const BATCH = 512;

/**
 * List a directory.
 *
 * Two measurements shape this, both taken on this machine:
 *
 * - `readdir` with `withFileTypes` costs under 5 ms even on a six-thousand-entry
 *   directory, and already carries the file-or-directory distinction. That is
 *   the first paint.
 * - The `lstat` per entry is where the time goes. Run concurrently it measured
 *   53.5 ms for `/usr/lib` (5938 entries) against 94.4 ms serial. **Never write
 *   the serial loop.**
 *
 * `lstat`, not `stat`, for the entry itself: a dangling symlink makes `stat`
 * throw `ENOENT` and takes the whole listing down with it, while `lstat`
 * describes the link. A symlink that resolves is then stat'd a second time, so
 * that a link to a directory reports `directory` and the user can walk into it.
 * A link that does not resolve stays `other` and stays visible.
 */
export async function scanDirectory(path: string, options: ScanOptions = {}): Promise<FsEntry[]> {
  options.signal?.throwIfAborted();

  const dirents = await readdir(path, { withFileTypes: true });
  options.signal?.throwIfAborted();

  const entries: FsEntry[] = [];

  for (let offset = 0; offset < dirents.length; offset += BATCH) {
    // The abort seam. Checked before every batch, so an abandoned scan stops
    // dispatching further syscalls instead of running to completion and
    // throwing the answer away — which is what the Qt version's generation
    // counters did.
    options.signal?.throwIfAborted();

    const batch = dirents.slice(offset, offset + BATCH);
    entries.push(...(await Promise.all(batch.map((dirent) => describe(path, dirent)))));
  }

  options.signal?.throwIfAborted();
  return entries;
}

/** What `stat` or `lstat` gave back, and whether the link resolved. */
interface Resolved {
  readonly stats: { size: number; mtimeMs: number } | null;
  readonly target: { isDirectory(): boolean; isFile(): boolean } | null;
}

/**
 * Stat one entry, with ONE syscall in the common case.
 *
 * A symlink-heavy directory is where this was measured to regress: doing
 * `lstat` for the size and `stat` for the target kind doubled the syscalls, and
 * verification caught 6000 links at 84-117 ms against a 100 ms budget. A file
 * manager shows a link's TARGET size anyway, not the link's own handful of
 * bytes, so `stat` answers both questions at once. `lstat` is needed only when
 * `stat` throws, which means the link is broken — and then only to prove the
 * entry exists so it stays listed rather than silently missing.
 */
async function statEntry(full: string, isSymlink: boolean): Promise<Resolved> {
  if (!isSymlink) {
    const stats = await lstat(full).catch(() => null);
    return { stats, target: null };
  }

  const resolved = await stat(full).catch(() => null);
  if (resolved !== null) return { stats: resolved, target: resolved };

  return { stats: await lstat(full).catch(() => null), target: null };
}

async function describe(
  path: string,
  dirent: { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean },
): Promise<FsEntry> {
  const isSymlink = dirent.isSymbolicLink();
  const { stats, target } = await statEntry(join(path, dirent.name), isSymlink);

  return {
    name: dirent.name,
    kind: kindOf(isSymlink ? target : dirent),
    size: stats?.size ?? 0,
    modifiedMs: stats?.mtimeMs ?? 0,
    isSymlink,
    isHidden: dirent.name.startsWith("."),
    // A stat that failed is reported, not disguised. Permission denied and a
    // legitimately empty 1970 file are otherwise the same row.
    ...(stats === null ? { unreadable: true } : {}),
  };
}

/**
 * A link that resolves to nothing is `other`, and stays listed. Dropping a
 * broken link would make it invisible, which is the opposite of what a file
 * manager is for.
 */
export function kindOf(source: { isDirectory(): boolean; isFile(): boolean } | null): EntryKind {
  if (source === null) return "other";
  if (source.isDirectory()) return "directory";
  if (source.isFile()) return "file";
  return "other";
}
