import type { Unsubscribe } from "@symmetria/fm-core/bridge";
import { isFailure } from "@symmetria/fm-core/contract";
import type { FsEntry } from "@symmetria/fm-core/entry";
import type { ListingOptions } from "@symmetria/fm-core/listingOptions";
import {
  clearSelection,
  enterDirectory,
  goToPath,
  leaveDirectory,
  moveCursor,
  type PaneState,
  parentOf,
  rememberCursorAt,
  setEntries,
  toggleSelection,
} from "@symmetria/fm-core/pane";
import type { SortMode } from "@symmetria/fm-core/sort";
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { hideWindow, listDirectory, watchDirectory } from "./bridge.ts";
import { useNavigationGenerations } from "./hooks/useNavigationGenerations.ts";
import {
  activateTab,
  activePane,
  closeTab,
  createTabs,
  navigateActivePane,
  nextTab,
  openOrActivateTab,
  openTab,
  previousTab,
  revertPaneById,
  showTabBar,
  stepActiveHistory,
  type TabsState,
  updateActivePane,
  updatePaneById,
} from "./state/tabs.ts";
import { useListingOptions } from "./useListingOptions.ts";

interface TabErrors {
  /** The message for one tab, or none. `undefined` for no active tab. */
  errorFor(id: string | undefined): string | null;
  reportError: ReportError;
}

/**
 * Which tabs failed to list, and why. One entry per failing tab.
 *
 * A map rather than a single message: an error belongs to the directory that
 * would not open, so the bar shows the ACTIVE tab's — switching away hides it
 * and switching back shows it again, with nothing cleared and nothing re-read.
 *
 * Its own hook because `useTabs` is measured as one function and the complexity
 * gate failed when this went inline, which is the same pressure that produced
 * `useDirectoryLoader` below it.
 */
function useTabErrors(): TabErrors {
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());

  const reportError = useCallback<ReportError>((id, message) => {
    setErrors((previous) => {
      if (message === null) {
        if (!previous.has(id)) return previous;
        const next = new Map(previous);
        next.delete(id);
        return next;
      }

      // The same message again is not a change, and returning the map itself
      // keeps a repeated failure from re-rendering the window.
      if (previous.get(id) === message) return previous;
      return new Map(previous).set(id, message);
    });
  }, []);

  const errorFor = useCallback(
    (id: string | undefined) => (id === undefined ? null : (errors.get(id) ?? null)),
    [errors],
  );

  return { errorFor, reportError };
}

/**
 * How a listing is asked for. One of these per WINDOW, not per tab.
 *
 * Per tab was the better fit for the structure here — a tab already carries its
 * own path, cursor and selection — and the operator chose against it: an order
 * is how you want to read, not where you are. So switching tabs never changes
 * the order, and changing the order applies to every tab.
 *
 * **Imported, not aliased, and no longer redeclared anywhere.** This file used
 * to alias `listDirectory`'s own `ListOptions`, with a comment warning that two
 * structurally identical shapes would drift the moment a field was added to
 * one. The stored preference then became a THIRD shape with the same fields,
 * and the assignment between them compiled by structural coincidence alone —
 * exactly what that comment predicted. `ListOptions` is now this same type.
 */

/**
 * The fields that decide what a listing CONTAINS, as one comparable value.
 *
 * **`renderDocuments` is deliberately absent, and this is the only place that
 * omission is stated.** It lives in the same store as the other three and
 * decides how a file is DRAWN in the preview column, not which entries a
 * listing holds. Anything that re-reads a directory when it changes is doing a
 * disk read for a key that has nothing to do with the directory — and in the
 * parent column that read is visible as a flicker.
 *
 * Both consumers below go through here rather than each naming the three
 * fields, so a fourth field that DOES affect a listing is added in one place.
 */
function listingIdentity(options: ListingOptions): string {
  return `${options.sort}|${options.reverse}|${options.showHidden}`;
}

/** Whether two option sets would produce the same listing. */
function sameOptions(a: ListingOptions, b: ListingOptions): boolean {
  return listingIdentity(a) === listingIdentity(b);
}

/** What the tab bar draws. */
export interface TabView {
  readonly id: string;
  readonly path: string;
  /** The directory's own name, which is what a tab is called. */
  readonly name: string;
}

export interface Tabs {
  readonly pane: PaneState;
  readonly parentEntries: readonly FsEntry[];
  readonly parentCursorName: string;
  readonly views: readonly TabView[];
  readonly activeIndex: number;
  readonly showBar: boolean;
  readonly sort: SortMode;
  readonly reverse: boolean;
  readonly showHidden: boolean;
  /** Whether a file with a rendered form shows it, or shows its source. */
  readonly renderDocuments: boolean;
  readonly error: string | null;
  readonly loading: boolean;

  setSort(sort: SortMode, reverse: boolean): void;
  toggleHidden(): void;
  toggleRenderDocuments(): void;

  historyBack(): void;
  historyForward(): void;

  moveBy(delta: number): void;
  moveTo(index: number): void;
  enter(): void;
  leave(): void;
  navigate(path: string): void;
  reveal(path: string): void;
  /**
   * Go to a path AND land the cursor on a named entry there.
   *
   * Distinct from `navigate`, which lands at the top. Its caller is a flash
   * jump into another column: the user pressed a label drawn on a specific
   * row, so arriving anywhere else would be arriving somewhere they did not
   * point at.
   *
   * **A destination equal to the pane's own path lands nowhere.** `goToPath`
   * returns the pane by reference for that case — deliberately, see its own
   * comment — so nothing re-lists and the recorded name is never consumed. No
   * caller can reach it today: a previewed directory is always a strict
   * subdirectory, and the parent column is empty at the root, so it offers no
   * label to press. A future caller that could reach it must move the cursor
   * itself rather than expect this to.
   */
  navigateTo(path: string, name: string): void;
  toggleMark(): void;
  clearMarks(): void;

  open(path?: string): void;
  navigationGeneration(): number;
  pendingRevealPath(): string | null;
  /**
   * Show a path, reusing a tab already on it.
   *
   * Distinct from `open`, which duplicates wherever the cursor is. This one
   * takes a destination, because its caller is the daemon relaying a request
   * from another program rather than the user pressing a key.
   */
  openAt(path: string): void;
  close(index?: number): void;
  goNext(): void;
  goPrevious(): void;
  activate(index: number): void;
}

/**
 * One running watch: where it points, and how to release it.
 *
 * `stop` is mutable because the slot is claimed BEFORE the watch finishes
 * starting — claiming late would let a second reconciler pass in the same frame
 * start a duplicate watch on the same directory.
 */
interface WatchSlot {
  readonly path: string;
  stop: Unsubscribe;
}

/**
 * The separators the tab topology is encoded with.
 *
 * Control characters, because a path may contain anything a filesystem allows —
 * including every printable character one might otherwise reach for.
 */
const FIELD = "\u0000";
const RECORD = "\u0001";

/** Read the tab topology back out of its encoded form. */
function parseTopology(topology: string): Map<string, string> {
  const pairs = topology.split(RECORD).map((record) => record.split(FIELD));
  return new Map(pairs.map(([id, path]) => [id ?? "", path ?? ""]));
}

/** The last segment of a path. */
function nameOf(path: string): string {
  return (
    path
      .split("/")
      .filter((segment) => segment !== "")
      .pop() ?? "/"
  );
}

/** What a tab needs remembered about its own reads. */
interface PendingReveal {
  readonly path: string;
  readonly name: string;
  readonly generation: number;
}
function revealMatches(
  focus: PendingReveal | undefined,
  path: string,
  generation: number | undefined,
): boolean {
  return focus === undefined || (focus.path === path && focus.generation === generation);
}

interface DirectoryLoader {
  /** Read one tab's directory and put the result in its pane. */
  loadTab(id: string, path: string): void;
  prepareReveal(id: string, path: string, name: string): void;
  invalidate(id: string | undefined): void;
  /** Forget everything remembered about a tab, when it closes. */
  release(id: string): void;
  /**
   * Which options a tab's entries were actually listed under, or undefined
   * where it has never been listed at all.
   *
   * A function rather than the ref itself. Handing the ref out put a mutable
   * object in a caller's effect, which the exhaustive-dependencies rule reads —
   * correctly — as an undeclared dependency, and the fix it proposes for that
   * shape is meaningless. This is stable, so it is an ordinary dependency.
   */
  listedOptionsFor(id: string): ListingOptions | undefined;
  pendingPath(id: string | undefined): string | null;
}

/**
 * Reading a directory into a tab, and the four things it has to remember.
 *
 * Extracted from `useTabs` rather than living in it: every map here exists for
 * a race or a recovery in this one operation, and none of them is any business
 * of the tab collection, the watches or the keyboard actions that share that
 * hook. Each map's own reason is on its declaration.
 */
/**
 * Record a tab's failure, or clear it. `null` clears.
 *
 * Per TAB and not per window, and that distinction is the whole of it: an error
 * describes one directory that would not open, so showing it over another tab
 * is a claim about a directory that is fine. Window-level state also cannot be
 * cleared safely on a switch — doing that made an unreadable directory read as
 * "0 entries" the moment you came back to it, because returning to a tab that
 * already has a recorded listing does not re-attempt the read.
 */
type ReportError = (id: string, message: string | null) => void;

function useDirectoryLoader(
  optionsRef: RefObject<ListingOptions>,
  setState: Dispatch<SetStateAction<TabsState>>,
  reportError: ReportError,
): DirectoryLoader {
  // Which read is the current one, per tab.
  //
  // Navigating faster than the disk answers is normal with a held key, and
  // without this a slow read of a directory already left behind would land on
  // top of a fast read of the directory the user is now in. The Qt version
  // solved the same race with a generation counter, for the same reason.
  const generation = useRef(new Map<string, number>());
  const pendingReveal = useRef(new Map<string, PendingReveal>());
  const navigationGeneration = useRef(new Map<string, number>());
  const revealFailures = useRef(new Set<string>());
  const invalidate = useCallback((id: string | undefined, force = false) => {
    // Invalidating every navigation cancelled an initial listing on repeated
    // Left at root, where no path change starts a replacement. Only a pending
    // reveal needs synchronous cancellation; prepareReveal forces a new generation.
    if (id === undefined) return;
    revealFailures.current.delete(id);
    if (!force && !pendingReveal.current.has(id)) return;
    navigationGeneration.current.set(id, (navigationGeneration.current.get(id) ?? 0) + 1);
    generation.current.set(id, (generation.current.get(id) ?? 0) + 1);
    pendingReveal.current.delete(id);
  }, []);

  /**
   * The last path each tab actually managed to list.
   *
   * Navigation is optimistic — the pane's path changes first and the listing
   * arrives afterwards — which is what makes `l` feel instant. The cost is that
   * a path which turns out not to be readable would otherwise leave the tab
   * parked on it with an empty column: the error is shown, but the user is
   * standing somewhere that does not exist and `h` is their only way out.
   *
   * Verification found this through a bookmark pointing at a deleted directory.
   * It is not specific to bookmarks: entering a directory that vanished between
   * the listing and the keypress does the same thing, and so does a stale
   * breadcrumb.
   */
  const lastGood = useRef(new Map<string, string>());

  /**
   * Tabs whose next load is a revert's own recovery.
   *
   * Without this the repair erased its own message: the failed load reports the
   * error, the revert re-lists the last good path, and THAT load succeeds and
   * clears the error one render later. The user saw a flash and was told
   * nothing. Review caught it; the tests did not, because they only asserted
   * the error appeared, never that it stayed.
   */
  const reverting = useRef(new Set<string>());

  /**
   * Which options each tab's entries were actually listed under.
   *
   * A background tab keeps showing what it last read, so changing the order
   * would otherwise leave one window holding two orders at once — the thing
   * the operator chose against. Recording it here rather than re-listing every
   * open tab on each keystroke means one directory scan per change instead of
   * one per tab; a tab that was not looking gets its new order on the way in.
   */
  const listedUnder = useRef(new Map<string, ListingOptions>());

  /** What a failed listing puts in the pane, and whether it is a retreat. */
  const failed = useCallback(
    (id: string, attempted: string, message: string) => {
      reportError(id, message);
      reverting.current.delete(id);

      // Go back to the last place that worked. Changing the path here feeds
      // the reconciler, which re-lists it and re-arms its watch — the same
      // route any other navigation takes, so there is no second code path for
      // "navigating backwards".
      const previousPath = lastGood.current.get(id);
      if (previousPath === undefined || previousPath === attempted) {
        // Nowhere to go back TO — the window opened here. Staying with an empty
        // listing and the error is the honest answer.
        setState((previous) => updatePaneById(previous, id, (p) => setEntries(p, [])));
        return;
      }

      reverting.current.add(id);
      setState((previous) => revertPaneById(previous, id, previousPath));
    },
    [reportError, setState],
  );

  const failedRead = useCallback(
    (id: string, path: string, message: string, isReveal: boolean) => {
      if (isReveal) revealFailures.current.add(id);
      // A failed same-parent reveal must retain the valid pane, cursor and marks.
      if (isReveal && lastGood.current.get(id) === path) reportError(id, message);
      else failed(id, path, message);
    },
    [failed, reportError],
  );

  const clearSuccessfulReadError = useCallback(
    (id: string) => {
      // Recovery and watch refreshes must retain the failure that caused them.
      if (reverting.current.delete(id)) return;
      if (revealFailures.current.has(id)) return;
      reportError(id, null);
    },
    [reportError],
  );

  const loadTab = useCallback(
    (id: string, path: string) => {
      // An old directory watch can fire before navigation replaces it. It must
      // not consume or supersede the pending reveal for the new parent.
      const pending = pendingReveal.current.get(id);
      if (pending && pending.path !== path) return;
      const mine = (generation.current.get(id) ?? 0) + 1;
      generation.current.set(id, mine);

      const focus = pendingReveal.current.get(id);
      const asked = optionsRef.current;
      listedUnder.current.set(id, asked);

      void listDirectory(path, asked).then((reply) => {
        if (generation.current.get(id) !== mine) return;

        if (isFailure(reply)) {
          pendingReveal.current.delete(id);
          failedRead(id, path, reply.error.message, focus !== undefined);
          return;
        }

        if (!revealMatches(focus, path, navigationGeneration.current.get(id))) return;
        if (pendingReveal.current.get(id) === focus) pendingReveal.current.delete(id);
        const focusIndex = focus
          ? reply.value.entries.findIndex((entry) => entry.name === focus.name)
          : -1;
        if (focus && focusIndex < 0) {
          failedRead(id, path, `Entry no longer exists: ${focus.name}`, true);
          return;
        }
        clearSuccessfulReadError(id);
        lastGood.current.set(id, path);
        setState((previous) =>
          updatePaneById(previous, id, (p) => {
            const next = setEntries(p, reply.value.entries);
            return focusIndex < 0 ? next : moveCursor(next, focusIndex - next.cursorIndex);
          }),
        );
      });
    },
    [failedRead, optionsRef, clearSuccessfulReadError, setState],
  );

  // Four maps keyed by tab id, and none of them was pruned — so every tab a
  // session ever opened stayed in all of them for the life of the window.
  // Bounded in practice and still wrong; the watch reconciler releases its own
  // slot this way, and these are the same kind of thing.
  const release = useCallback((id: string) => {
    generation.current.delete(id);
    navigationGeneration.current.delete(id);
    revealFailures.current.delete(id);
    pendingReveal.current.delete(id);
    lastGood.current.delete(id);
    reverting.current.delete(id);
    listedUnder.current.delete(id);
  }, []);

  const listedOptionsFor = useCallback((id: string) => listedUnder.current.get(id), []);

  return {
    loadTab,
    invalidate,
    release,
    listedOptionsFor,
    pendingPath: (id) => {
      const target = pendingReveal.current.get(id ?? "");
      return target ? `${target.path === "/" ? "" : target.path}/${target.name}` : null;
    },
    prepareReveal: (id: string, path: string, name: string) => {
      invalidate(id, true);
      pendingReveal.current.set(id, {
        path,
        name,
        generation: navigationGeneration.current.get(id) ?? 0,
      });
    },
  };
}

/**
 * One watch per tab, kept in step with where the tabs point.
 *
 * It compares what is running against what the tabs now are, so a closed tab
 * releases its watch and a navigated tab swaps its own — without any caller
 * knowing that watches exist. `live` outlives each run, which is what makes
 * "release what is gone" expressible at all.
 *
 * `topology` is a STRING of tab ids and paths rather than the tab array,
 * because every cursor move rebuilds that array and would re-run all of this on
 * every keystroke. The reconciler reads its tabs back out of the string, so
 * what it depends on and what it uses are the same thing.
 */
function useWatchReconciler(topology: string, loadTab: (id: string, path: string) => void): void {
  const live = useRef(new Map<string, WatchSlot>());

  useEffect(() => {
    const wanted = parseTopology(topology);

    for (const [id, running] of live.current) {
      if (wanted.get(id) === running.path) continue;
      running.stop();
      live.current.delete(id);
    }

    for (const [id, path] of wanted) {
      if (live.current.has(id)) continue;

      // Claim the slot before the watch resolves, so a second pass in the same
      // frame does not start a duplicate watch on the same directory.
      const slot: WatchSlot = { path, stop: () => undefined };
      live.current.set(id, slot);

      loadTab(id, path);
      void watchDirectory(path, `${id}:${path}`, () => loadTab(id, path)).then((unsubscribe) => {
        // The tab may have closed or navigated while the watch was starting.
        if (live.current.get(id) === slot) slot.stop = unsubscribe;
        else unsubscribe();
      });
    }
  }, [topology, loadTab]);

  // Release every watch when the window goes. Separate from the reconciler so
  // it does not run on each change of the tab list.
  useEffect(() => {
    const running = live.current;
    return () => {
      for (const { stop } of running.values()) stop();
      running.clear();
    };
  }, []);
}

/**
 * Several locations open at once, each keeping its own cursor and selection.
 *
 * Every tab reads and watches its own directory, including the ones in the
 * background — switching to a tab must show what is there now, not what was
 * there when it was last looked at.
 *
 * **Watcher lifetime is the leak this can introduce.** A tab that closes must
 * release its watch, and a tab that navigates must release the old one before
 * taking the new. Both are handled by one reconciler keyed on tab identity, so
 * neither depends on a caller remembering to clean up.
 */
/** What the parent column draws, and whether it is still arriving. */
interface ParentColumn {
  readonly parentEntries: readonly FsEntry[];
  readonly loading: boolean;
}

/**
 * The parent column's entries, and whether its listing is still arriving.
 *
 * Its own hook because it is a self-contained lifecycle — one listing, one
 * loading flag, and nothing else in `useTabs` reads either — and because
 * `useTabs` is measured as one function by the complexity gate and had reached
 * its bound. The same pressure produced `useDirectoryLoader` above,
 * `useTabErrors` beside it, and `usePicker` next door.
 *
 * The parent column belongs to the ACTIVE tab only: no background tab shows
 * one, so reading it for all of them would be work nobody sees.
 */
function useParentColumn(activePath: string, options: ListingOptions): ParentColumn {
  const [parentEntries, setParentEntries] = useState<readonly FsEntry[]>([]);
  const [loading, setLoading] = useState(true);

  /**
   * The stored order, narrowed to the fields a listing actually depends on.
   *
   * Memoised on those fields alone, so its identity does not change when the
   * render mode does — which is what stops this column re-reading the directory
   * for a key that changes nothing about the directory. See `listingIdentity`
   * for the same omission, stated once.
   */
  const forListing = useMemo(
    () => ({ sort: options.sort, reverse: options.reverse, showHidden: options.showHidden }),
    [options.sort, options.reverse, options.showHidden],
  );

  useEffect(() => {
    const parentPath = parentOf(activePath);
    if (parentPath === activePath) {
      setParentEntries([]);
      return;
    }

    let current = true;
    setLoading(true);
    void listDirectory(parentPath, forListing).then((reply) => {
      if (!current) return;
      setLoading(false);
      setParentEntries(isFailure(reply) ? [] : reply.value.entries);
    });

    return () => {
      current = false;
    };
    // A listing like any other, so it re-reads when the ORDER does — without
    // that the two columns would disagree, which is more confusing than either
    // order on its own.
  }, [activePath, forListing]);

  return { parentEntries, loading };
}

export function useTabs(initialPath: string): Tabs {
  const [state, setState] = useState<TabsState>(() => createTabs(initialPath));
  const activeId = state.tabs[state.activeIndex]?.id;
  const {
    current: navigationGeneration,
    note: noteNavigation,
    release: releaseNavigation,
  } = useNavigationGenerations(activeId);
  const { errorFor, reportError } = useTabErrors();
  const stored = useListingOptions();
  const options = stored.options;

  // Read by `loadTab`, which must not depend on the options.
  //
  // `loadTab` is the callback a watcher holds for the life of its watch. If it
  // closed over the options it would keep whichever ones were in force when the
  // watch was armed, so a file appearing in a directory would silently re-list
  // it in the previous order. The ref is what makes every load — first, watched
  // or re-listed — read the same current answer.
  //
  // Assigned in an effect and not in the render body. React's contract says a
  // ref is not written during rendering, and a render that is discarded or
  // replayed would leave a value from it behind. This effect is declared BEFORE
  // every effect that calls `loadTab`, and effects run in declaration order
  // within a commit — so the ordering guarantee the render-body write gave is
  // unchanged. The initial value comes from `useRef`, which covers the first
  // load before any effect has run.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const pane = activePane(state);
  if (pane === null) {
    // Unreachable by construction: `closeTab` reports the last close by
    // returning null rather than by emptying the list, so the collection is
    // never empty. Stated rather than papered over with a fallback pane, which
    // would render an empty directory and look like a filesystem problem.
    throw new Error("the tab collection is empty, which closeTab never produces");
  }
  const activePath = pane.path;

  // What the reconciler below actually cares about: which tabs exist and where
  // each one points. Every cursor move rebuilds `state.tabs`, so depending on
  // the array itself would re-run the reconciler on every keystroke. The
  // reconciler reads its tabs back OUT of this string rather than from a ref,
  // so what it depends on and what it uses are the same thing.
  const topology = state.tabs.map((tab) => `${tab.id}${FIELD}${tab.pane.path}`).join(RECORD);

  const { loadTab, release, listedOptionsFor, prepareReveal, invalidate, pendingPath } =
    useDirectoryLoader(optionsRef, setState, reportError);

  useWatchReconciler(topology, loadTab);

  const { parentEntries, loading } = useParentColumn(activePath, options);

  /**
   * Bring the visible tab's listing up to date with the current options.
   *
   * One rule covers two situations that look different and are not: the order
   * changed while this tab was on screen, and the user switched to a tab that
   * was in the background when it changed. Both are "what is in front of me was
   * listed under different options", and both are answered by re-listing it.
   */
  useEffect(() => {
    if (activeId === undefined) return;

    const under = listedOptionsFor(activeId);
    // Never listed at all is the reconciler's job, not this one. Claiming it
    // here would start a second read of the same directory on every open.
    if (under === undefined || sameOptions(under, options)) return;

    loadTab(activeId, activePath);
  }, [activeId, activePath, options, loadTab, listedOptionsFor]);

  /** A cursor move or a selection change: the pane changes, the trail does not. */
  const changeActive = useCallback((change: (p: PaneState) => PaneState) => {
    setState((previous) => updateActivePane(previous, change));
  }, []);

  /** A deliberate move to another directory, which the trail remembers. */
  const goTo = useCallback(
    (change: (p: PaneState) => PaneState) => {
      noteNavigation(activeId);
      invalidate(activeId);
      setState((previous) => navigateActivePane(previous, change));
    },
    [activeId, invalidate, noteNavigation],
  );

  const close = useCallback(
    (index?: number) => {
      setState((previous) => {
        // Release the per-tab bookkeeping with the tab. The errors map is
        // keyed by tab id too, so it goes the same way — otherwise a closed
        // tab's failure outlives it for the life of the window.
        const closing = previous.tabs[index ?? previous.activeIndex]?.id;
        if (closing !== undefined) {
          releaseNavigation(closing);
          release(closing);
          reportError(closing, null);
        }

        const next = closeTab(previous, index ?? previous.activeIndex);
        if (next !== null) return next;

        // The last tab is gone, so the window is put away — NOT closed.
        //
        // This used to call `window.close()`, and verification found what that
        // costs. Page code closing the window DESTROYS it, and does so without
        // ever raising the window's own `close` event (measured on Electron
        // 41), so the main process cannot intercept it: every tab, cursor and
        // scroll position went, and the daemon then answered every `open` with
        // success while having no window to open anything in.
        //
        // The collection is deliberately left untouched. "Close the last tab"
        // in a resident one-window application means "put the file manager
        // away", and coming back to an empty window would be a worse answer
        // than coming back to where you were.
        void hideWindow();
        return previous;
      });
    },
    [release, reportError, releaseNavigation],
  );

  return {
    navigationGeneration,
    pendingRevealPath: pendingPath.bind(null, activeId),
    pane,
    parentEntries,
    parentCursorName: nameOf(activePath),
    views: state.tabs.map((tab) => ({
      id: tab.id,
      path: tab.pane.path,
      name: nameOf(tab.pane.path),
    })),
    activeIndex: state.activeIndex,
    showBar: showTabBar(state),
    sort: options.sort,
    reverse: options.reverse,
    showHidden: options.showHidden,
    renderDocuments: options.renderDocuments,
    error: errorFor(activeId),
    loading,

    historyBack: () => {
      noteNavigation(activeId);
      invalidate(activeId);
      setState((previous) => stepActiveHistory(previous, "back"));
    },
    historyForward: () => {
      noteNavigation(activeId);
      invalidate(activeId);
      setState((previous) => stepActiveHistory(previous, "forward"));
    },

    // The next value is computed here and not inside a state updater. React
    // may call an updater more than once and at a time of its choosing, so a
    // write started from inside one is a side effect with no guarantee about
    // how often it runs — which is exactly what it must not be.
    setSort: (sort, reverse) => stored.set({ ...options, sort, reverse }),
    toggleHidden: () => stored.set({ ...options, showHidden: !options.showHidden }),
    toggleRenderDocuments: () =>
      stored.set({ ...options, renderDocuments: !options.renderDocuments }),

    moveBy: (delta) => changeActive((p) => moveCursor(p, delta)),
    moveTo: (index) => changeActive((p) => moveCursor(p, index - p.cursorIndex)),
    enter: () => goTo(enterDirectory),
    leave: () => goTo(leaveDirectory),
    navigate: (path) => goTo((p) => goToPath(p, path)),
    navigateTo: (path, name) => goTo((p) => goToPath(rememberCursorAt(p, path, name), path)),
    reveal: (path) =>
      revealInTab(path, activeId, pane.path, {
        noteNavigation,
        prepareReveal,
        loadTab,
        setState,
      }),
    toggleMark: () => changeActive(toggleSelection),
    clearMarks: () => changeActive(clearSelection),

    open: (path) => appendTab(setState, activePath, path),
    // A fresh arrow, like every other action here except `close` — which is a
    // callback only because effects in this file depend on it. Its ONE
    // subscriber holds it through a ref instead, so the identity never
    // matters; see the note in App.
    openAt: (path) => {
      noteNavigation(activeId);
      invalidate(activeId);
      setState((previous) => openOrActivateTab(previous, path));
    },
    close,
    // None of these touches the errors, and that is the fix rather than an
    // omission. Clearing on a switch was tried: it hid the stale message and
    // ALSO wiped the live one, so coming back to an unreadable directory showed
    // "0 entries" with nothing to say why — returning to a tab that already has
    // a recorded listing does not re-attempt the read. The map is keyed by tab,
    // so switching shows the right message with no clearing at all.
    goNext: () => setState(nextTab),
    goPrevious: () => setState(previousTab),
    activate: (index) => setState((previous) => activateTab(previous, index)),
  };
}

function appendTab(
  setState: Dispatch<SetStateAction<TabsState>>,
  currentPath: string,
  requestedPath?: string,
) {
  setState((previous) => openTab(previous, requestedPath ?? currentPath));
}

function revealInTab(
  path: string,
  id: string | undefined,
  currentPath: string,
  actions: {
    noteNavigation(id: string | undefined): void;
    prepareReveal: DirectoryLoader["prepareReveal"];
    loadTab: DirectoryLoader["loadTab"];
    setState: Dispatch<SetStateAction<TabsState>>;
  },
) {
  actions.noteNavigation(id);
  if (id === undefined) return;
  const parent = parentOf(path);
  actions.prepareReveal(id, parent, nameOf(path));
  if (parent === currentPath) actions.loadTab(id, parent);
  else
    actions.setState((previous) =>
      navigateActivePane(previous, (pane) => ({
        ...pane,
        path: parent,
        entries: [],
        cursorIndex: 0,
      })),
    );
}
