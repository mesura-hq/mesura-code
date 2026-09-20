import { type FSWatcher, type WatchListener, watch } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";

/** What changed, and what it is now. */
export interface ChangedEntry {
  readonly name: string;
  readonly size: number;
  /**
   * Whether the entry still exists.
   *
   * Without this a deleted file and a genuinely empty one are the same event —
   * both report `size: 0` — and a consumer cannot tell "remove this row" from
   * "this row is empty".
   */
  readonly kind: "changed" | "deleted";
}

/** Call to release the watch. Safe to call more than once. */
export type StopWatching = () => Promise<void>;

/**
 * How long to gather events before reporting them.
 *
 * A single write produces several inotify events, and an extraction produces
 * thousands. Coalescing them into one batch is what keeps a busy directory from
 * turning into a message per file across the process boundary. Short enough to
 * stay imperceptible, long enough to collapse a burst.
 */
const COALESCE_MS = 20;

/**
 * Watch one directory, non-recursively, and report what changed.
 *
 * **`node:fs.watch`, deliberately, and NOT `@parcel/watcher`.** The first
 * implementation used Parcel's watcher with a comment claiming it was
 * non-recursive — it is not, and it has no non-recursive mode: `subscribe()`
 * always walks the whole subtree, and the `ignore` option filters paths rather
 * than limiting depth. Filtering the *events* by `dirname` made it look correct
 * while the watch itself still descended. Opening the file manager on a home
 * directory therefore failed with
 * `inotify_add_watch ... failed: No space left on device` — the kernel's
 * per-user watch limit, exhausted at startup by a single pane. Miller columns
 * watch one directory at a time, so recursion buys nothing and costs the budget.
 *
 * **This replaces machinery rather than porting it.** Qt's directory watcher
 * omits `IN_MODIFY` from its inotify mask, so a file that grew on disk after it
 * was first listed emitted no event at all — a download streamed straight to its
 * final name sat at 0 bytes with no preview until the user navigated away and
 * back. The C++ worked around that with per-file watches, a `kMaxFileWatches`
 * cap to protect the inotify budget, and a debounced rescan. `fs.watch` reports
 * content writes as `change`, so all of it is deleted. `watch.test.ts` is what
 * proves the deletion was safe.
 *
 * The size is re-read per event because an entry is an immutable snapshot: a
 * changed file becomes a new entry, never a mutated one.
 */
export async function watchDirectory(
  path: string,
  onChange: (changed: ChangedEntry[]) => void,
  onError: (message: string) => void = () => undefined,
  createWatcher: (
    path: string,
    options: { recursive: false },
    listener: WatchListener<string>,
  ) => FSWatcher = watch,
): Promise<StopWatching> {
  // Canonicalise once. A directory reached through a symlink is watched at its
  // real location, so the names the watcher reports and the paths it stats
  // agree — comparing a raw string against a resolved one dropped every event
  // in silence.
  const root = await realpath(path).catch(() => path);

  let released = false;
  let failed = false;
  const pending = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  let timer: NodeJS.Timeout | null = null;

  const flush = () => {
    timer = null;
    if (released || failed || pending.size === 0) return;

    const names = [...pending];
    pending.clear();

    const work = Promise.all(names.map((name) => toChangedEntry(root, name)))
      .then((changed) => {
        // The read started before `stop()` and settled after it. Without this
        // check a closed tab still receives an update for a watcher its owner
        // believes is dead.
        if (!released && !failed) onChange(changed);
      })
      .catch(() => undefined);

    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  };

  const watcher: FSWatcher = createWatcher(root, { recursive: false }, (_event, name) => {
    // `filename` is documented as possibly null. An event with no name says
    // something changed but not what, and a rescan of the whole directory is
    // the honest response — which is what the consumer does with any batch.
    if (released || failed) return;
    if (name === null) {
      onChange([]);
      return;
    }

    pending.add(name);
    timer ??= setTimeout(flush, COALESCE_MS);
  });

  // Report lost coverage instead of leaving a consumer with a silent stale view.
  watcher.on("error", (error: Error) => {
    if (released || failed) return;
    failed = true;
    if (timer !== null) clearTimeout(timer);
    watcher.close();
    onError(error.message);
  });

  return async () => {
    if (released) return;
    released = true;

    if (timer !== null) clearTimeout(timer);
    watcher.close();

    // Let anything already dispatched settle, so a caller that awaits `stop()`
    // knows no further callback can arrive.
    await Promise.allSettled([...inFlight]);
  };
}

async function toChangedEntry(root: string, name: string): Promise<ChangedEntry> {
  const stats = await lstat(join(root, name)).catch(() => null);
  return {
    name,
    size: stats?.size ?? 0,
    kind: stats === null ? "deleted" : "changed",
  };
}
