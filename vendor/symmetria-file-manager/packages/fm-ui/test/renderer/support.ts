import { seedBookmarks } from "@symmetria/fm-core/bookmarks";
import { BRIDGE_KEY, type Bridge } from "@symmetria/fm-core/bridge";
import type { SearchReplyRow } from "@symmetria/fm-core/contract";
import type { FsEntry } from "@symmetria/fm-core/entry";
import { DEFAULT_LISTING_OPTIONS, type ListingOptions } from "@symmetria/fm-core/listingOptions";
import { screen, within } from "@testing-library/react";

/**
 * The fixture both renderer suites drive the application through.
 *
 * Shared rather than copied: two divergent fake filesystems would eventually
 * disagree about what "the parent of /home/jc" contains, and the suite that
 * happened to be wrong would look like a product bug.
 */

function entry(name: string, kind: FsEntry["kind"] = "file"): FsEntry {
  return { name, kind, size: 3, modifiedMs: 0, isSymlink: false, isHidden: false };
}

/**
 * How many names a directory's describe reply carries.
 *
 * Mirrors `MAX_DIRECTORY_PREVIEW_ENTRIES` in the main process. Declared again
 * rather than imported, because importing it would pull a main-process module —
 * which compiles against Node and no DOM — into a renderer test.
 */
const PREVIEW_CAP = 500;

/**
 * More entries than the preview listing sends, so the cap is observable.
 *
 * Zero-padded so the order a reader expects is the order they get.
 */
const MANY = Array.from({ length: PREVIEW_CAP + 37 }, (_, i) =>
  entry(`f${String(i).padStart(4, "0")}.txt`),
);

/**
 * A filesystem, as a map from path to listing.
 *
 * The three directories at the end of the home listing are appended rather than
 * inserted: every test that navigates by key counts from the top, so a new
 * entry before `notes.txt` would move the cursor under all of them.
 *
 * `locked` is deliberately absent from this map while appearing in the home
 * listing — that is how a directory the process cannot read is expressed here.
 */
const TREE = new Map([
  // The root is listable. It was deliberately absent once, so that climbing to
  // it failed and a test could assert the pane reported why — but the pane now
  // RETURNS to its last good path when a listing fails, so that test was
  // asserting two things at once and caught the pane mid-revert about one run
  // in nine. Climbing is one property and a failed listing is another; they are
  // tested separately now.
  ["/", [entry("home", "directory"), entry("tmp", "directory")]],
  ["/home", [entry("jc", "directory"), entry("other", "directory")]],
  [
    "/home/jc",
    [
      entry("projects", "directory"),
      entry("notes.txt"),
      entry("todo.txt"),
      entry("empty", "directory"),
      entry("locked", "directory"),
      entry("many", "directory"),
    ],
  ],
  ["/home/jc/projects", [entry("alpha", "directory"), entry("beta.md")]],
  ["/home/jc/empty", []],
  // Reached only by opening a window on it directly. Deliberately NOT listed in
  // the home directory above: adding an entry there shifts every index after
  // it, and the whole suite counts `j` presses from the top.
  ["/home/jc/pictures", [entry("shot.png")]],
  ["/home/jc/many", MANY],
]);

/**
 * Facts about the fixture home that tests assert against.
 *
 * Derived rather than written down, because they are incidental: a phase that
 * needs a new fixture directory should not have to hunt down four assertions in
 * two other suites that happened to hardcode "3 entries" and "todo.txt". It
 * already happened once.
 */
const HOME = TREE.get("/home/jc") ?? [];
export const HOME_ENTRY_COUNT = HOME.length;
export const HOME_LAST_ENTRY = HOME[HOME.length - 1]?.name ?? "";

/**
 * What each fixture file contains, and what type it claims to be.
 *
 * The real answers come from the main process — a `stat`, the XDG database, a
 * head read. Here they are declared, so a renderer test can drive every preview
 * branch without a filesystem.
 */
const FILES = new Map<string, { readonly mime: string | null; readonly text: string }>([
  ["/home/jc/notes.txt", { mime: "text/plain", text: "plain notes\nsecond line\n" }],
  ["/home/jc/todo.txt", { mime: "text/plain", text: "todo\n" }],
  ["/home/jc/projects/beta.md", { mime: "text/markdown", text: "# beta\n\ntext\n" }],
  // A markdown file exercising every branch the rendered preview has: a
  // heading, a list, a table, a fenced block with a language, raw HTML that
  // must stay text, three images that must resolve differently, and a link.
  //
  // Deliberately NOT added to the TREE above. Every fixture directory's entry
  // order is counted in `j` presses by other suites, so a new row there shifts
  // assertions in files that have nothing to do with this one. The rendered
  // preview takes a path, so it never needs a listing to reach this.
  // Longer than the preview's read cap, so the truncation marker is reached by
  // the ordinary path rather than by a flag a test sets.
  [
    "/home/jc/projects/capped.md",
    { mime: "text/markdown", text: `# capped\n\n${"word ".repeat(200_000)}` },
  ],
  [
    "/home/jc/projects/rich.md",
    {
      mime: "text/markdown",
      text: [
        "# Title",
        "",
        "A paragraph with <b>raw html</b> in it.",
        "",
        "- first",
        "- second",
        "",
        "| column | other |",
        "| ------ | ----- |",
        "| a      | b     |",
        "",
        "```ts",
        "const x: number = 1;",
        "```",
        "",
        // A SECOND fenced block, in a different language. Not decoration: the
        // highlighter is one worker shared by every block on the page, and
        // with a single block a request id can only ever collide with itself.
        "```python",
        "def second(): return 2",
        "```",
        "",
        "![diagram](./assets/flow.png)",
        "![escaping](../../../etc/shadow)",
        "![remote](https://example.com/tracker.png)",
        // The three that verification found getting through. The markdown
        // pipeline percent-encodes a backslash before the component sees it,
        // and a leading space slips past every anchored check.
        String.raw`![back](..\..\etc\hostname)`,
        String.raw`![unc](\\host\share\x.png)`,
        "![lead](  http://example.com/a.png)",
        "",
        "[a link](https://example.com/page)",
        "",
      ].join("\n"),
    },
  ],
  // An image, for the copy chord's image row. Its bytes are irrelevant here:
  // what routes an entry to the image preview — and therefore what makes the
  // `i` row appear — is the MIME type the main process reports.
  ["/home/jc/pictures/shot.png", { mime: "image/png", text: "" }],
]);

/** What a capped read of a fixture file returned. */
interface Head {
  readonly text: string;
  readonly truncated: boolean;
}

/** A read request, as both read channels shape it. */
interface CappedRead {
  readonly path: string;
  readonly maxBytes: number;
}

function head(request: unknown): Head {
  // SAFETY: the request came from this renderer's own `bridge.ts`, which builds
  // it from typed arguments. A real preload receives it across a process
  // boundary and cannot make that assumption; this fixture stands in for the
  // main process, not for the preload.
  const { path, maxBytes } = request as CappedRead;
  const whole = FILES.get(path)?.text ?? "";
  const text = whole.slice(0, maxBytes);
  return { text, truncated: text.length < whole.length };
}

/**
 * A bridge that answers nothing, for the methods a test does not care about.
 *
 * Shared so a channel added to the surface is a one-line change here rather
 * than a compile error in every fixture that happened to build its own.
 */
export function inertBridge(): Bridge {
  const ok = () => Promise.resolve({ ok: true as const, value: null });
  return {
    version: "inert",
    overview: ok,
    list: ok,
    watch: ok,
    unwatch: ok,
    readText: ok,
    cancel: ok,
    searchStart: ok,
    searchQuery: ok,
    searchRecord: ok,
    searchRelease: ok,
    describe: ok,
    previewUrl: ok,
    previewDirectoryUrl: ok,
    transfer: ok,
    create: ok,
    rename: ok,
    trash: ok,
    open: ok,
    clipboard: ok,
    frecent: ok,
    cancelTransfer: ok,
    bookmarksRead: ok,
    bookmarksWrite: ok,
    listingRead: ok,
    listingWrite: ok,
    onListBatch: () => () => undefined,
    onChanged: () => () => undefined,
    onTransferProgress: () => () => undefined,
    onOpenPath: () => () => undefined,
    hideWindow: async () => ({ ok: true, value: null }),
    pickerConfirm: async () => ({ ok: true, value: null }),
    pickerCancel: async () => ({ ok: true, value: null }),
  };
}

/** What a listing was asked for, beyond its path. */
export interface ListAsk {
  readonly path: string;
  readonly sort: string;
  readonly reverse: boolean;
  readonly showHidden: boolean;
}

export interface BridgeLog {
  readonly listed: string[];
  /** Every directory the finder asked to open an index over. */
  readonly searchStarts: string[];
  /** Every query the finder actually sent, after its debounce. */
  readonly searchQueries: string[];
  /**
   * Every file attributed to the query that found it.
   *
   * Recorded because the write is fire-and-forget by design: nothing waits on
   * it and nothing on screen changes, so this log is the only thing that can
   * tell "it was sent" from "it was forgotten".
   */
  readonly searchRecords: { query: string; chosenPath: string }[];
  /** Let a held index finish opening. Does nothing when none is held. */
  releaseSearchStart(): void;
  /**
   * Every listing order written back to the store.
   *
   * Recorded rather than merely allowed, because "the window saves what you
   * chose" is the whole of what this preference is for, and a write that never
   * happens looks identical to one that did until the next restart.
   */
  readonly listingWrites: ListingOptions[];
  /** What the store would answer with now, after every write has settled. */
  storedListingNow(): ListingOptions | null;
  /**
   * Every directory a rendered document was granted.
   *
   * Recorded because "the grant is over the file's PARENT" is the safety
   * property of that channel, and a panel asking for the wrong root would
   * still render perfectly well until somebody looked here.
   */
  readonly directoryGrants: string[];
  /**
   * Every request to put the window away.
   *
   * Observable because it is the ONLY thing that proves the last-tab close
   * hides rather than destroys. The renderer used to call `window.close()`
   * there, which destroys the Electron window without raising its `close`
   * event at all — so the tabs, cursor and scroll all went, and nothing at
   * this level could see it happen.
   */
  readonly hidden: string[];
  /**
   * Every subscription to the daemon's open-path channel.
   *
   * Counted because the preload removes and re-adds a NATIVE IPC listener on
   * each subscribe, so an unstable handler identity turns one subscription
   * into one per render on the hot path. Review traced that; this is what
   * stops it coming back.
   */
  readonly openSubscriptions: string[];
  /**
   * Every answer the dialog sent, with the pipe it named.
   *
   * The pipe is recorded and not only the paths, because answering the WRONG
   * dialog is the failure that matters: a page that could name somebody else's
   * FIFO would cancel their save dialog.
   */
  readonly pickerConfirms: { fifo: string; paths: string[] }[];
  /** Every cancellation, by the pipe it named. */
  readonly pickerCancels: string[];
  /** Deliver a path on that channel, as the daemon would. */
  emitOpenPath(path: string): void;
  /**
   * Every listing request in full, not only its path.
   *
   * `listed` records paths, which is all any test needed while the listing
   * options were module constants. Ordering and hidden files are decided by the
   * MAIN process, so what the renderer can be held to is the request it sends —
   * and this is the only place that is observable.
   */
  readonly listAsks: ListAsk[];
  readonly unwatched: string[];
  readonly watched: string[];
  /** Every operation the renderer asked the main process to perform. */
  readonly ops: string[];
  /** Which paths the preview asked about, in order. Used to assert the debounce. */
  readonly described: string[];
  /** How many listeners the renderer attached to the change channel. */
  listenerCount(): number;
  /** Push a change for one subscription, as the main process would. */
  emitChange(subscriptionId: string): void;
  /** Add an entry to a directory, so a change has something to report. */
  addEntry(path: string, name: string): void;
  /**
   * Add an entry at the FRONT of a directory.
   *
   * Distinct from `addEntry` because it shifts every index after it, which is
   * what a real re-sort or an alphabetically-early new file does — and index
   * shifts are what stale index-keyed state gets wrong.
   */
  addEntryFirst(path: string, name: string): void;
  /**
   * Hold the next bookmark write open until the returned function is called.
   *
   * Lets a test put two writes in flight at once and release them, which is the
   * only way to observe whether they were serialised at all.
   */
  holdNextBookmarkWrite(): () => void;
  /**
   * Hold the next listing OF ONE PATH open, answering it with `names` when
   * released.
   *
   * Every other listing in this fixture resolves in the same tick, so a load
   * can never still be in flight when the next one starts — which is exactly
   * the window a stale reply would land in. Naming the entries the held reply
   * carries is what makes the staleness visible: a name that only the held
   * reply knows about either reaches the column or is correctly discarded.
   *
   * The path is required, and that is not convenience. A change of listing
   * options re-lists the parent column too, and its effect is declared first —
   * so a hold that took whichever listing came next took the PARENT's, left the
   * current column loading normally, and passed whether or not the thing it
   * claimed to test was there at all. It was written that way first.
   */
  holdNextList(path: string, names: readonly string[]): () => void;
  /** Make the next frecent-list request fail with this reason. */
  failNextZoxide(reason: string): void;
  /** The letters each bookmark write persisted, in COMPLETION order. */
  readonly bookmarkWrites: string[];
  /** Make the next transfer report these names as already present. */
  conflictNext(names: readonly string[]): void;
  /** Leave the next transfer unresolved, so a test can watch it running. */
  holdNextTransfer(): void;
  /** Push a progress tick, as the main process would. */
  emitProgress(transferId: string, done: number, total: number): void;
  /**
   * The ids of the transfers that have been asked for.
   *
   * The renderer numbers them from a module-level counter, so it carries across
   * tests in one file — a test that assumed `t0` would pass alone and fail in
   * company.
   */
  readonly transferIds: string[];
}

/**
 * Install a bridge that answers from `TREE`.
 *
 * Stubbed at the `window` global rather than by mocking the module, so the
 * renderer's own `bridge.ts` — its request shape, its reply decoding, its
 * missing-bridge handling — is exercised rather than replaced.
 */
export interface BridgeOptions {
  /**
   * What the store answers with. `null` is a first run — no file.
   *
   * Undefined means the same as `null`, so every existing caller keeps the
   * behaviour it had before this preference existed.
   */
  readonly storedListing?: ListingOptions | null;
  /**
   * What the fake engine answers for a query.
   *
   * A function rather than a fixed list, because a finder test is about what
   * happens as the query CHANGES — narrowing, missing, and answering late are
   * three different behaviours of the same call.
   */
  readonly search?: (query: string) => readonly SearchReplyRow[];
  /** Make opening the index fail, with this reason. */
  readonly searchStartFails?: string;
  /**
   * Hold the index open until the test releases it.
   *
   * The only way to observe the indexing state at all: the fixture otherwise
   * answers within a microtask, so the overlay is past it before a test can
   * look.
   */
  readonly searchStartHeld?: boolean;
  /** Make the read fail, which a missing preference must survive. */
  readonly listingReadFails?: boolean;
  /**
   * Make the FIRST write settle after the second.
   *
   * A real disk does not answer in the order it was asked, and two writes in
   * flight are decided by whichever finishes last.
   */
  readonly slowFirstListingWrite?: boolean;
}

export function installBridge(options: BridgeOptions = {}): BridgeLog {
  const listed: string[] = [];
  const searchStarts: string[] = [];
  const searchQueries: string[] = [];
  const searchRecords: { query: string; chosenPath: string }[] = [];
  let releaseHeldStart: (() => void) | null = null;
  const listingWrites: ListingOptions[] = [];
  let storedListing: ListingOptions | null = options.storedListing ?? null;
  const slowFirstWrite = options.slowFirstListingWrite === true;
  const hidden: string[] = [];
  const pickerConfirms: { fifo: string; paths: string[] }[] = [];
  const pickerCancels: string[] = [];
  const openSubscriptions: string[] = [];
  const openListeners = new Set<(payload: unknown) => void>();
  const listAsks: ListAsk[] = [];
  const unwatched: string[] = [];
  const watched: string[] = [];
  const described: string[] = [];
  const directoryGrants: string[] = [];
  const ops: string[] = [];
  let conflictOnce: readonly string[] = [];
  let holdOnce = false;
  const transferIds: string[] = [];
  const bookmarkWrites: string[] = [];
  let releaseNextWrite: (() => void) | null = null;
  /** Which path's next listing is held, and what it answers with. */
  let heldList: { readonly path: string; readonly names: readonly string[] } | null = null;
  let releaseHeldList: (() => void) | null = null;
  let zoxideFailure: string | null = null;
  const progressListeners = new Set<(payload: unknown) => void>();
  const listeners = new Set<(payload: unknown) => void>();
  const tree = new Map([...TREE].map(([path, entries]) => [path, [...entries]]));

  const bridge: Bridge = {
    ...inertBridge(),
    version: "test",
    overview: async (request) => {
      const { path, limit } = request as { path: string; limit: number };
      const entries = tree.get(path) ?? [];
      return {
        ok: true,
        value: {
          entries: entries.slice(0, limit),
          inspected: Math.min(limit, entries.length),
          truncated: entries.length >= limit,
        },
      };
    },
    searchStart: (request) => {
      const { directory } = request as { directory: string };
      searchStarts.push(directory);
      const answer =
        options.searchStartFails === undefined
          ? { ok: true as const, value: null }
          : {
              ok: false as const,
              error: { code: "read_failed" as const, message: options.searchStartFails },
            };
      if (options.searchStartHeld !== true) return Promise.resolve(answer);
      return new Promise((resolve) => {
        releaseHeldStart = () => resolve(answer);
      });
    },
    searchQuery: (request) => {
      const { query } = request as { directory: string; query: string };
      searchQueries.push(query);
      const rows = options.search?.(query) ?? [];
      // The reply echoes the query it answered, exactly as the real one does.
      // A fixture that dropped that field would let a stale-reply bug pass.
      return Promise.resolve({
        ok: true as const,
        value: { rows, matchedQuery: query, truncated: rows.length >= 200, cap: 200 },
      });
    },
    searchRecord: (request) => {
      const { query, chosenPath } = request as { query: string; chosenPath: string };
      searchRecords.push({ query, chosenPath });
      return Promise.resolve({ ok: true as const, value: null });
    },
    list: (request) => {
      const ask = request as {
        path: string;
        sort?: string;
        reverse?: boolean;
        showHidden?: boolean;
      };
      const path = ask.path;
      listed.push(path);
      listAsks.push({
        path,
        sort: ask.sort ?? "alphabetical",
        reverse: ask.reverse === true,
        showHidden: ask.showHidden === true,
      });
      // The stored order is returned verbatim, deliberately. Ordering and
      // hiding happen in the main process, and a stub that applied them here
      // would be a second implementation of them — one this fixture's own
      // listings do not even satisfy, since `/home/jc` puts files between
      // directories, which no real listing ever does. Ordering is proved
      // against the real handler in `app/test/ipc.test.ts` and against the
      // comparators in the shared package; what is proved here is the request.
      // A held listing answers with names the test chose, and only when the
      // test lets it. It is claimed here rather than in `holdNextList` so the
      // FIRST list after arming is the one held, whichever tab makes it.
      if (heldList !== null && heldList.path === path) {
        const names = heldList.names;
        heldList = null;
        return new Promise((resolve) => {
          releaseHeldList = () =>
            resolve({
              ok: true as const,
              value: {
                entries: names.map((name) => entry(name)),
                total: names.length,
                streamId: null,
              },
            });
        });
      }

      const entries = tree.get(path);
      return Promise.resolve(
        entries === undefined
          ? { ok: false as const, error: { code: "scan_failed" as const, message: `no ${path}` } }
          : { ok: true as const, value: { entries, total: entries.length, streamId: null } },
      );
    },
    watch: (request) => {
      watched.push((request as { subscriptionId: string }).subscriptionId);
      return Promise.resolve({ ok: true as const, value: null });
    },
    unwatch: (request) => {
      unwatched.push((request as { subscriptionId: string }).subscriptionId);
      return Promise.resolve({ ok: true as const, value: null });
    },
    readText: (request) => {
      const { text, truncated } = head(request);
      return Promise.resolve({
        ok: true as const,
        value: { text, bytesRead: text.length, truncated },
      });
    },
    frecent: () => {
      ops.push("zoxide");
      if (zoxideFailure !== null) {
        const reason = zoxideFailure;
        zoxideFailure = null;
        return Promise.resolve({
          ok: false as const,
          error: { code: "read_failed" as const, message: reason },
        });
      }
      // The order zoxide gives, which is by frecency and not alphabetical —
      // asserting "most frecent first" against an alphabetical fixture would
      // prove nothing.
      return Promise.resolve({
        ok: true as const,
        value: {
          entries: [
            { score: 4536, path: "/home/jc/Downloads" },
            { score: 446, path: "/home/jc/work/sales/bambin" },
            { score: 278, path: "/home/jc/.dotfiles" },
          ],
        },
      });
    },
    clipboard: (request) => {
      const ask = request as { kind: string; text?: string; path?: string };
      ops.push(`clipboard ${ask.kind} ${ask.kind === "text" ? ask.text : ask.path}`);
      return Promise.resolve({ ok: true as const, value: null });
    },
    cancel: () => Promise.resolve({ ok: true as const, value: null }),
    previewDirectoryUrl: (request) => {
      const path = (request as { path: string }).path;
      const directory = path.slice(0, path.lastIndexOf("/"));
      directoryGrants.push(directory);
      // An unreal scheme on purpose: a URL built any other way cannot pass a
      // test that asserts this prefix.
      return Promise.resolve({
        ok: true as const,
        value: { url: `test-grant://dir${directory}` },
      });
    },
    describe: (request) => {
      const path = (request as { path: string }).path;
      described.push(path);

      if (tree.has(path)) {
        const listing = tree.get(path) ?? [];
        return Promise.resolve({
          ok: true as const,
          value: {
            name: path.split("/").pop() ?? "/",
            path,
            isDirectory: true,
            entryCount: listing.length,
            // Capped like the main process: the count stays true, the payload
            // stays bounded.
            entries: listing.slice(0, PREVIEW_CAP).map((e) => ({ name: e.name, kind: e.kind })),
            size: 4096,
            mime: "inode/directory",
            head: new Uint8Array(),
          },
        });
      }

      const file = FILES.get(path);
      if (file === undefined) {
        return Promise.resolve({
          ok: false as const,
          error: { code: "read_failed" as const, message: `no ${path}` },
        });
      }
      return Promise.resolve({
        ok: true as const,
        value: {
          name: path.split("/").pop() ?? "",
          path,
          isDirectory: false,
          entryCount: 0,
          entries: [],
          size: file.text.length,
          mime: file.mime,
          head: Uint8Array.from(file.text.slice(0, 64), (c) => c.charCodeAt(0)),
        },
      });
    },
    previewUrl: (request) => {
      const { path } = request as { path: string };
      return Promise.resolve({
        ok: true as const,
        value: { url: `symmetria-fm://app/__preview/${encodeURIComponent(path)}` },
      });
    },
    transfer: (request) => {
      const { sources, destination, mode, overwrite, transferId } = request as {
        sources: string[];
        destination: string;
        mode: string;
        overwrite: boolean;
        transferId: string;
      };
      transferIds.push(transferId);
      ops.push(`${mode} ${sources.join(",")} -> ${destination}${overwrite ? " !" : ""}`);

      // Reported once, so a test can drive the conflict prompt and then watch
      // the confirmed retry go through.
      const conflicts = overwrite ? [] : conflictOnce;
      conflictOnce = [];

      if (holdOnce) {
        holdOnce = false;
        // Never settles: a transfer the test can observe mid-flight.
        return new Promise(() => undefined);
      }

      return Promise.resolve({
        ok: true as const,
        value: { moved: conflicts.length > 0 ? 0 : sources.length, conflicts },
      });
    },
    create: (request) => {
      const { path, kind } = request as { path: string; kind: string };
      ops.push(`create ${kind} ${path}`);
      return Promise.resolve({ ok: true as const, value: null });
    },
    rename: (request) => {
      const { path, name } = request as { path: string; name: string };
      ops.push(`rename ${path} -> ${name}`);
      if (name === "taken.txt") {
        return Promise.resolve({
          ok: false as const,
          error: { code: "write_failed" as const, message: `${name} already exists` },
        });
      }
      return Promise.resolve({ ok: true as const, value: { path: name } });
    },
    trash: (request) => {
      const { paths } = request as { paths: string[] };
      ops.push(`trash ${paths.join(",")}`);
      return Promise.resolve({ ok: true as const, value: null });
    },
    open: (request) => {
      ops.push(`open ${(request as { path: string }).path}`);
      return Promise.resolve({ ok: true as const, value: null });
    },
    // The seed, as the main process would answer it on a fresh machine: the
    // fixture home is `/home/jc`, and `readOrSeedBookmarks` would have written
    // this file before the first reply.
    bookmarksRead: () =>
      Promise.resolve({
        ok: true as const,
        value: {
          bookmarks: [...seedBookmarks("/home/jc")].map(([letter, bookmark]) => ({
            letter,
            bookmark,
          })),
        },
      }),
    listingRead: () => {
      if (options.listingReadFails === true) {
        return Promise.resolve({
          ok: false as const,
          error: { code: "read_failed" as const, message: "no store" },
        });
      }
      // The main process answers the DEFAULT when there is no file, exactly as
      // `register.ts` does — a missing preference is not a failure.
      return Promise.resolve({
        ok: true as const,
        value: { options: storedListing ?? DEFAULT_LISTING_OPTIONS },
      });
    },
    listingWrite: (request) => {
      const written = (request as { options: ListingOptions }).options;
      listingWrites.push(written);

      // Settling out of ORDER is what a real disk does, and it is the whole
      // reason the hook chains its writes. `slowFirstListingWrite` makes the
      // first call finish after the second, so a hook that fired both at once
      // would leave the EARLIER choice on disk.
      const delay = listingWrites.length === 1 && slowFirstWrite ? 20 : 0;
      return new Promise((resolve) => {
        setTimeout(() => {
          storedListing = written;
          resolve({ ok: true as const, value: null });
        }, delay);
      });
    },
    bookmarksWrite: (request) => {
      const { bookmarks } = request as {
        bookmarks: { letter: string; bookmark: { path: string } }[];
      };
      const letters = bookmarks
        .map((b) => b.letter)
        .sort()
        .join("");
      ops.push(`bookmarks ${letters}`);

      // `ops` records when a write was ASKED for; `bookmarkWrites` records when
      // it FINISHED. The two orders differ only when writes overlap, which is
      // the one thing worth pinning about serialisation.
      const settle = () => {
        bookmarkWrites.push(letters);
        return { ok: true as const, value: null };
      };

      if (releaseNextWrite === null) return Promise.resolve(settle());

      return new Promise<{ ok: true; value: null }>((resolve) => {
        releaseNextWrite = () => resolve(settle());
      });
    },
    cancelTransfer: (request) => {
      ops.push(`cancel ${(request as { transferId: string }).transferId}`);
      return Promise.resolve({ ok: true as const, value: null });
    },
    onTransferProgress: (listener) => {
      progressListeners.add(listener);
      return () => progressListeners.delete(listener);
    },
    onListBatch: () => () => undefined,
    onOpenPath: (listener) => {
      openSubscriptions.push("subscribe");
      openListeners.add(listener);
      return () => openListeners.delete(listener);
    },
    hideWindow: async () => {
      hidden.push("hide");
      return { ok: true, value: null };
    },
    pickerConfirm: async (request) => {
      const asked = request as { fifo: string; paths: string[] };
      pickerConfirms.push({ fifo: asked.fifo, paths: asked.paths });
      return { ok: true, value: null };
    },
    pickerCancel: async (request) => {
      pickerCancels.push((request as { fifo: string }).fifo);
      return { ok: true, value: null };
    },
    onChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  Object.defineProperty(window, BRIDGE_KEY, { value: bridge, configurable: true, writable: true });

  return {
    listed,
    searchStarts,
    searchQueries,
    searchRecords,
    releaseSearchStart: () => releaseHeldStart?.(),
    directoryGrants,
    listingWrites,
    storedListingNow: () => storedListing,
    hidden,
    openSubscriptions,
    pickerConfirms,
    pickerCancels,
    emitOpenPath: (path: string) => {
      for (const listener of openListeners) listener({ path });
    },
    listAsks,
    unwatched,
    watched,
    described,
    ops,
    conflictNext: (names) => {
      conflictOnce = names;
    },
    transferIds,
    bookmarkWrites,
    holdNextBookmarkWrite: () => {
      // Armed as a marker; the write itself replaces it with the real releaser.
      releaseNextWrite = () => undefined;
      return () => {
        const release = releaseNextWrite;
        releaseNextWrite = null;
        release?.();
      };
    },
    holdNextList: (path, names) => {
      heldList = { path, names };
      return () => {
        const release = releaseHeldList;
        releaseHeldList = null;
        release?.();
      };
    },
    failNextZoxide: (reason) => {
      zoxideFailure = reason;
    },
    holdNextTransfer: () => {
      holdOnce = true;
    },
    emitProgress: (transferId, done, total) => {
      for (const listener of progressListeners) listener({ transferId, done, total });
    },
    listenerCount: () => listeners.size,
    emitChange: (subscriptionId) => {
      for (const listener of listeners) listener({ subscriptionId, changed: [] });
    },
    addEntry: (path, name) => {
      tree.get(path)?.push(entry(name));
    },
    addEntryFirst: (path, name) => {
      tree.get(path)?.unshift(entry(name));
    },
  };
}

/** The names visible in one column, in order. */
export function namesIn(testId: string): string[] {
  return within(screen.getByTestId(testId))
    .queryAllByTestId("row")
    .map((row) => row.textContent ?? "");
}

export function cursorIn(testId: string): string {
  return screen.getByTestId(testId).querySelector('[data-cursor="true"]')?.textContent ?? "";
}
