/**
 * One index per directory, each in its own process, retired when it goes idle.
 *
 * **The topology is measured, not chosen.** Eight indices in eight processes
 * sharing one store all open cleanly; the same eight inside one process do not,
 * because the store refuses a second open in one program. So the unit of
 * isolation is the process and the key is the directory. The Qt build works
 * around the same constraint with a single process-wide engine whose base path
 * is swapped — a last-acquire-wins race across windows — and this is the one
 * place the port deliberately departs from it.
 *
 * **`spawn` is injected**, which is what lets the lifetime rules be tested
 * without a process. The Electron wiring passes a spawn that forks a utility
 * process; a test passes one that returns a recording double.
 *
 * **Time is injected and retirement is swept**, rather than each worker holding
 * its own timer. A timer per worker is a timer to cancel on every path out, and
 * one missed cancel is a process that outlives its owner — the failure that
 * takes the resident daemon with it.
 */
import type { SearchRow } from "./rows.ts";

/** The cap on returned rows, matching the Qt finder. */
export const MAX_RESULTS = 200;

/** How long an index survives with no search before it is retired. */
export const DEFAULT_IDLE_MS = 5 * 60 * 1000;

export interface SearchReply {
  readonly rows: readonly SearchRow[];
  /**
   * The query these rows answer.
   *
   * Present so a late reply can be discarded. Without it the highlighter runs
   * against half-typed input: the reply to "fo" arrives after the user has
   * typed "form" and is drawn against the newer query.
   */
  readonly matchedQuery: string;
  /** Whether the engine had more matches than `cap`. */
  readonly truncated: boolean;
  readonly cap: number;
}

export interface IndexWorker {
  readonly directory: string;
  /**
   * Settles when the index is open, and rejects with why it never opened.
   *
   * A caller that cannot tell "still scanning" from "never opened" reads an
   * empty result as "no matches", which is the wrong answer told confidently.
   */
  readonly ready: Promise<void>;
  search(query: string): Promise<SearchReply>;
  /**
   * Attribute a chosen file to the query that found it.
   *
   * Returns nothing and settles nothing: the engine's tracker write has no
   * outcome the caller can act on. See `SearchIndex.record` for what the write
   * buys, and why that is currently zero.
   */
  record(query: string, chosenPath: string): void;
  /** Ask the engine to re-scan. Returns nothing and blocks on nothing. */
  refresh(): void;
  close(): void;
}

export interface PoolOptions {
  readonly spawn: (directory: string) => IndexWorker;
  readonly idleMs?: number;
  readonly now?: () => number;
}

export interface IndexPool {
  /** The worker for this directory, spawning one if there is none. */
  acquire(directory: string): IndexWorker;
  /**
   * Acquire this directory's worker and wait for its index to open.
   *
   * Separate from `acquire` because acquiring is synchronous and opening is
   * not. A caller that only wants the index warming can acquire; a caller that
   * must report failure to a user has to wait for this.
   */
  start(directory: string): Promise<void>;
  search(directory: string, query: string): Promise<SearchReply>;
  /**
   * Attribute a chosen file to the query that found it.
   *
   * Silent when the directory has no open index. A record for a directory
   * nobody is searching would have to spawn a whole process to write a
   * statistic, which is a worse trade than losing the statistic.
   */
  record(directory: string, query: string, chosenPath: string): void;
  /** Retire this directory's worker now. Silent when there is none. */
  release(directory: string): void;
  /** Retire every worker idle for longer than the timeout. */
  sweep(): void;
  size(): number;
  /** Retire everything. The owner calls this on quit. */
  closeAll(): void;
}

interface Entry {
  readonly worker: IndexWorker;
  lastUsed: number;
}

export function createIndexPool(options: PoolOptions): IndexPool {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const now = options.now ?? Date.now;
  const open = new Map<string, Entry>();

  function acquire(directory: string): IndexWorker {
    const existing = open.get(directory);
    if (existing !== undefined) {
      existing.lastUsed = now();
      return existing.worker;
    }
    const worker = options.spawn(directory);
    open.set(directory, { worker, lastUsed: now() });
    // A worker whose index never opened must not stay in the map. Left there,
    // every later search for that directory rejects with the same stale reason
    // and nothing ever spawns a replacement — a transient failure (a directory
    // still being mounted, say) would look permanent until the daemon quit.
    //
    // The identity check matters: by the time this runs the entry may already
    // have been retired and a fresh worker put in its place, and retiring that
    // one would kill an index that is perfectly healthy.
    void worker.ready.catch(() => {
      if (open.get(directory)?.worker === worker) retire(directory);
    });
    return worker;
  }

  function retire(directory: string): void {
    const entry = open.get(directory);
    if (entry === undefined) return;
    open.delete(directory);
    entry.worker.close();
  }

  return {
    acquire,
    async start(directory) {
      // A worker that is ALREADY open scanned the tree whenever it opened,
      // which may be minutes ago and several edits back — closing the finder
      // deliberately does not release the index, so reopening reuses that
      // snapshot. A worker spawned just now has nothing to refresh; its scan is
      // the one `ready` is waiting for.
      const warm = open.get(directory) !== undefined;
      const worker = acquire(directory);
      await worker.ready;
      // Fired, not awaited. The user is opening a finder; making them wait on a
      // filesystem walk to see the first keystroke would trade a stale fact for
      // a frozen overlay. Measured in a real window: a file touched to 400 days
      // old read `just now` on a requery in the same open session and `1y ago`
      // after a close and reopen, so this is the call that closes the gap.
      if (warm) worker.refresh();
    },
    async search(directory, query) {
      const worker = acquire(directory);
      const reply = await worker.search(query);
      // Touched AFTER the search, not before: a slow search on a large tree
      // could otherwise outlive the timeout and be swept while it is still in
      // flight.
      const entry = open.get(directory);
      if (entry !== undefined) entry.lastUsed = now();
      return reply;
    },
    record(directory, query, chosenPath) {
      open.get(directory)?.worker.record(query, chosenPath);
    },
    release: retire,
    sweep() {
      const cutoff = now() - idleMs;
      for (const [directory, entry] of [...open]) {
        if (entry.lastUsed < cutoff) retire(directory);
      }
    },
    size: () => open.size,
    closeAll() {
      for (const directory of [...open.keys()]) retire(directory);
    },
  };
}
