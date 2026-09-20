import { cp, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type { TransferMode } from "@symmetria/fm-core/contract";

/**
 * Copying, moving, creating and renaming — in this process, not through a shell.
 *
 * The Qt build shelled out for all of it: `cp -r`, `mv`, `touch`, `mkdir -p`,
 * each through a `QProcess` wrapper, with the result inferred from an exit code.
 * Doing it here is what makes real progress and real cancellation possible at
 * all, and it makes a conflict something to ask about rather than something
 * `cp` silently resolves.
 *
 * **What a hand-rolled copy gives up, recorded rather than discovered.**
 * `cp -a` preserves hard links between copied files and keeps sparse files
 * sparse. `fs.cp` does neither. For a file manager's copy that is an acceptable
 * trade for progress and cancellation; if it ever bites, the fallback is
 * delegating large copies back to the system tool.
 */

/** How a transfer reports what it has done so far. */
type OnProgress = (done: number, total: number) => void;

export interface TransferOptions {
  readonly sources: readonly string[];
  readonly destination: string;
  readonly mode: TransferMode;
  readonly overwrite: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: OnProgress;
}

export interface TransferOutcome {
  readonly moved: number;
  readonly conflicts: readonly string[];
}

/** Does anything exist at this path? A broken symlink counts: it is in the way. */
async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Would this transfer put a directory inside itself?
 *
 * `cp -r a a/b` is an infinite tree, and `mv` refuses it outright. Checking the
 * resolved prefix catches the whole family — including a destination several
 * levels down inside the source.
 */
function wouldRecurse(source: string, destination: string): boolean {
  const from = resolve(source);
  const into = resolve(destination);
  return into === from || into.startsWith(`${from}/`);
}

function refuseRecursion(
  sources: readonly string[],
  destination: string,
  mode: TransferMode,
): void {
  for (const source of sources) {
    if (wouldRecurse(source, destination)) {
      throw new Error(`cannot ${mode} ${basename(source)} into itself`);
    }
  }
}

/** Every source whose name is already taken at the destination. */
async function collisions(sources: readonly string[], destination: string): Promise<string[]> {
  const taken: string[] = [];
  for (const source of sources) {
    if (await exists(join(destination, basename(source)))) taken.push(basename(source));
  }
  return taken;
}

/**
 * Copy or move entries into a directory.
 *
 * **Conflicts stop the whole operation before it starts.** Transferring three
 * files and asking about the fourth leaves the user reasoning about a partial
 * result; naming every collision up front lets them answer once.
 */
export async function transfer(options: TransferOptions): Promise<TransferOutcome> {
  const { sources, destination, mode, overwrite, signal, onProgress } = options;

  refuseRecursion(sources, destination, mode);

  if (!overwrite) {
    const conflicts = await collisions(sources, destination);
    if (conflicts.length > 0) return { moved: 0, conflicts };
  }

  let moved = 0;
  onProgress?.(0, sources.length);

  for (const source of sources) {
    // Checked between entries rather than mid-copy: a cancelled transfer leaves
    // whole entries behind, never a half-written file.
    if (signal?.aborted === true) break;

    const target = join(destination, basename(source));
    if (mode === "copy") {
      await cp(source, target, { recursive: true, force: overwrite, errorOnExist: !overwrite });
    } else {
      await moveEntry(source, target, overwrite);
    }

    moved += 1;
    onProgress?.(moved, sources.length);
  }

  return { moved, conflicts: [] };
}

/**
 * Move one entry, across filesystems if it has to.
 *
 * `rename` is atomic and instant, and it fails with `EXDEV` when the two paths
 * are on different mounts — which is the ordinary case for a move from a home
 * directory to a USB stick. Copy-then-delete is the documented fallback, and it
 * must not run for any other error: a failed rename for permission reasons
 * would otherwise turn into a copy that succeeds and a delete that does not.
 */
async function moveEntry(source: string, target: string, overwrite: boolean): Promise<void> {
  try {
    if (overwrite) await rm(target, { recursive: true, force: true });
    await rename(source, target);
  } catch (error) {
    // SAFETY: `rename` rejects with an `ErrnoException`, on which `code` is
    // optional — so a rejection of any other shape reads as `undefined`, fails
    // this test and is rethrown, which is the conservative direction.
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;

    await cp(source, target, { recursive: true, force: overwrite });
    await rm(source, { recursive: true, force: true });
  }
}

/**
 * Create an empty file or a directory.
 *
 * Parents are created too, which is what `mkdir -p` gave the Qt build and what
 * makes typing `notes/2026/august.md` into the create dialog do what it looks
 * like it does.
 */
export async function createEntry(path: string, kind: "file" | "directory"): Promise<void> {
  if (kind === "directory") {
    await mkdir(path, { recursive: true });
    return;
  }

  await mkdir(dirname(path), { recursive: true });
  // `wx` fails when the file is already there rather than truncating it. An
  // accidental second Enter on the create dialog must not empty a file.
  await writeFile(path, "", { flag: "wx" });
}

/**
 * Rename an entry in place, refusing a name that is already taken.
 *
 * `rename` would silently replace the other entry, and the other entry may be
 * the only copy of something. Checking first is a race — the name could appear
 * between the check and the rename — but it is the race every file manager
 * accepts, and losing the check loses the file.
 */
export async function renameEntry(path: string, name: string): Promise<string> {
  const target = join(dirname(path), name);
  if (target === path) return path;

  if (await exists(target)) throw new Error(`${name} already exists`);

  await rename(path, target);
  return target;
}
