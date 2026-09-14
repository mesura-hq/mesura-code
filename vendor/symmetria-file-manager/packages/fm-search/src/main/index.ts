/**
 * Creating a search index over a directory, and searching it.
 *
 * The privileged half of the finder. It runs in a Node process — a main
 * process, or the utility process the next phase gives it — and knows nothing
 * about Electron or React.
 *
 * **One index per process, and that is measured rather than chosen.** The
 * store refuses a second open inside one program, so N indices in N processes
 * works and N indices in one process does not. The Qt build works around this
 * with a single process-wide engine whose base path is swapped, which is a
 * last-acquire-wins race across windows; do not reproduce that here. Nothing in
 * this module enforces the rule — it cannot, from inside one process — so the
 * owner of the process boundary is the one that has to respect it.
 */
import { FileFinder } from "@ff-labs/fff-node";

import { type SearchRow, toRow } from "./rows.ts";
import { resolveStorePaths } from "./store.ts";

/** How long to wait for the first scan before searching. */
const SCAN_TIMEOUT_MS = 30_000;

export interface SearchIndex {
  /** Search this index. Synchronous: the engine answers from memory. */
  search(query: string): readonly SearchRow[];
  /**
   * Record which file a query ended up choosing.
   *
   * **This does NOT teach frecency, and the name is chosen to avoid implying
   * it.** The write lands in the engine's query tracker: one record per
   * project-and-query pair holding the selected file and an open count. A later
   * search whose query matches that record adds the open count times a
   * multiplier to the score.
   *
   * In this application that multiplier is currently zero, so the gain is
   * currently zero too. It is written anyway because it is the parity behaviour
   * and because the record accumulates for whenever the multiplier is raised —
   * an empty tracker on the day it is turned on would learn nothing.
   */
  record(query: string, chosenPath: string): void;
  /**
   * Ask the engine to re-scan the tree.
   *
   * **Load-bearing, and measured to be.** An index is a snapshot taken when it
   * opens, and the finder deliberately does not release its index when it
   * closes — reopening would otherwise pay for a whole fresh scan of the tree.
   * So without this call, reopening a finder shows facts from whenever the
   * index first opened, which can be minutes and several edits ago.
   *
   * The engine also keeps its own background watcher, and a probe under plain
   * Node showed that watcher picking an `mtime` change up within 400 ms with no
   * refresh at all — which suggested this call was redundant. **It is not.**
   * Verification inside a real Electron utility process measured the four
   * steps: a file touched to 400 days old still read `just now` two seconds
   * later on a fresh query in the SAME open session, and only read `1y ago`
   * after the finder was closed and reopened. The watcher does not close the
   * gap in the process this actually runs in; this call does.
   *
   * **What is still true, and is not a defect to fix here:** an edit made while
   * the finder is OPEN is not reflected until it is reopened. Refreshing per
   * search would put a filesystem walk on every keystroke, which is a far worse
   * trade than a fact that is one reopen behind. The research records the same
   * shape in the Qt build for git status — "open the finder after editing a
   * file and the info pane still says clean" — there because `opts.watch` is
   * false and no refresh is ever called at all.
   *
   * Returns nothing and blocks on nothing. The scan lands when it lands; the
   * caller is opening a finder, not waiting on a filesystem walk.
   */
  refresh(): void;
  /** Release the native handle. The caller owns the process boundary. */
  close(): void;
}

/**
 * Build an index over `directory` and wait for its first scan.
 *
 * The wait is the reason this is async. A search issued before the scan
 * completes returns whatever has been indexed so far, which for a large tree is
 * a partial answer presented as a complete one.
 */
export async function createIndex(directory: string): Promise<SearchIndex> {
  const store = resolveStorePaths();
  const created = FileFinder.create({
    basePath: directory,
    frecencyDbPath: store.frecencyDbPath,
    historyDbPath: store.historyDbPath,
  });
  if (!created.ok) throw new Error(`Could not index ${directory}: ${String(created.error)}`);

  const finder = created.value;

  // The scan result is CHECKED, not discarded. This wait is the whole reason
  // `createIndex` is async — a search issued before the scan finishes returns a
  // partial answer presented as a complete one — so swallowing its outcome
  // would defeat the point of waiting at all. `createIndex` resolves only when
  // the index is genuinely ready; the caller owns the retry.
  const scanned = await finder.waitForScan(SCAN_TIMEOUT_MS);
  if (!scanned.ok) {
    finder.destroy();
    throw new Error(`Could not scan ${directory}: ${String(scanned.error)}`);
  }
  if (!scanned.value) {
    finder.destroy();
    throw new Error(`Scanning ${directory} did not finish within ${SCAN_TIMEOUT_MS} ms.`);
  }

  return {
    search(query: string): readonly SearchRow[] {
      // `mixedSearch`, never `fileSearch`: the files-only call returns no
      // directories, and directory navigation in the overlay depends on them.
      const result = finder.mixedSearch(query);
      if (!result.ok) return [];
      // An empty query supplies the initial suggestions. mixedSearch also
      // returns the index root with an empty name; it is not a useful result.
      return result.value.items
        .map((item, at) => toRow(item, result.value.scores[at], directory, query))
        .filter((row) => row.relativePath !== "");
    },
    record(query: string, chosenPath: string): void {
      if (query === "") return;
      // The result is deliberately dropped. Nothing the user does next depends
      // on it, and the caller has no repair to offer for a tracker write that
      // failed — reporting it would be a dialog about a statistic.
      finder.trackQuery(query, chosenPath);
    },
    refresh(): void {
      // The result is dropped: a rescan is a hint, not a request. There is
      // nothing a caller could do about one that failed except show the user
      // slightly older data, which is what they would have had anyway.
      finder.scanFiles();
    },
    close(): void {
      // Guarded: a consumer may well close on window-close AND on process
      // exit, and the behaviour of a second destroy against a released native
      // handle is not something this package should be discovering.
      if (!finder.isDestroyed) finder.destroy();
    },
  };
}

// Deliberately NOT re-exported: `matchIndices` and `resolveStorePaths` are
// reachable at `./main/match` and `./main/store`. Every sibling package uses
// exactly one import path per symbol, and a second way in is a second thing to
// keep in step. `SearchRow` is re-exported only because it is this entry's own
// return type.
export type { SearchRow } from "./rows.ts";
