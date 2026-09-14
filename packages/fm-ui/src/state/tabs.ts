import {
  emptyHistory,
  type History,
  stepBack,
  stepForward,
  visit,
} from "@symmetria/fm-core/history";
import { createPane, goToPath, type PaneState } from "@symmetria/fm-core/pane";

/**
 * The tab collection, as pure transitions.
 *
 * Tabs are the primary navigation model rather than a per-window detail
 * (decision D3): a tool that makes it easy to scatter twenty windows
 * encourages scattering twenty windows. There is one window, and anything that
 * would spawn a second is out of scope.
 *
 * ── What is per tab and what is shared ──────────────────────────────────────
 * Per tab: everything navigational — location, cursor, cursor memory,
 * selection. All of it already lives in `PaneState`, so a tab IS a pane plus an
 * identity, and nothing has to be kept in step by hand.
 *
 * Shared: the clipboard, the theme, and anything the main process owns. The Qt
 * original drew the line in the same place, with the clipboard and picker mode
 * global and everything navigational per window.
 */

interface Tab {
  /**
   * Stable across reordering, unlike an index.
   *
   * The watcher reconciler keys on this. With an index, closing tab 0 would
   * renumber every tab after it and the reconciler would tear down and rebuild
   * watches for directories nobody left.
   */
  readonly id: string;
  readonly pane: PaneState;
  /**
   * Where this tab has been. Per tab, unlike the listing options.
   *
   * A tab is a browsing context and its trail belongs to it: switching tabs
   * must not change where `-` goes, any more than opening a second browser tab
   * changes the first one's Back button. The order a listing is in is a
   * different kind of thing — that is how you want to read, not where you are,
   * and the operator chose to make it one setting for the window.
   */
  readonly history: History;
  /**
   * The trail as it was before the move now in flight.
   *
   * Navigation is optimistic: the pane's path changes and the trail is recorded
   * before the listing answers, because waiting for the disk is what would make
   * entering a directory feel slow. So by the time a directory turns out to be
   * unreadable, the move is already in the trail — and putting the PANE back is
   * only half of putting things back.
   *
   * A snapshot rather than an undo operation, because the two ways to arrive
   * somewhere unreadable damage the trail differently. A normal navigation
   * discards the forward trail on the way in, and popping the back entry does
   * not bring it back. A step backward records nothing at all, so there is no
   * entry to pop — and it still leaves the trail one press out of position.
   * Restoring the whole thing answers both without knowing which happened.
   */
  readonly historyBeforeMove: History;
}

export interface TabsState {
  readonly tabs: readonly Tab[];
  readonly activeIndex: number;
  /** Where the next id comes from. Monotonic, never reused. */
  readonly nextId: number;
}

export function createTabs(path: string): TabsState {
  return {
    tabs: [
      {
        id: "tab-0",
        pane: createPane(path),
        history: emptyHistory(),
        historyBeforeMove: emptyHistory(),
      },
    ],
    activeIndex: 0,
    nextId: 1,
  };
}

function activeTab(state: TabsState): Tab | null {
  return state.tabs[state.activeIndex] ?? null;
}

export function activePane(state: TabsState): PaneState | null {
  return activeTab(state)?.pane ?? null;
}

/** True once there is more than one tab, which is when the bar earns its space. */
export function showTabBar(state: TabsState): boolean {
  return state.tabs.length > 1;
}

/**
 * Open a tab, and make it the active one.
 *
 * Inserted immediately after the active tab rather than at the end, which is
 * what the original did and what every browser does: a tab opened from here
 * belongs beside here.
 */
export function openTab(state: TabsState, path: string): TabsState {
  const at = state.activeIndex + 1;
  // A fresh trail. The new tab did not come from anywhere the old one had
  // been, and inheriting the trail would let `-` in it walk somewhere it never
  // was.
  const tab: Tab = {
    id: `tab-${state.nextId}`,
    pane: createPane(path),
    history: emptyHistory(),
    historyBeforeMove: emptyHistory(),
  };

  return {
    tabs: [...state.tabs.slice(0, at), tab, ...state.tabs.slice(at)],
    activeIndex: at,
    nextId: state.nextId + 1,
  };
}

/**
 * Go to a path, reusing a tab already showing it.
 *
 * What the daemon calls when the command-line tool asks for a directory. With
 * one resident window every such request lands in this collection, so opening a
 * fresh tab each time would turn a tool built to keep few things open into one
 * that accumulates duplicates faster than the many-windows design it replaced.
 *
 * The FIRST matching tab wins, and that is a decision rather than an accident of
 * `findIndex`. Two tabs can genuinely hold one path — the user can open one by
 * hand — and without a stated rule the same command would land somewhere
 * different depending on which tab happened to be active.
 */
export function openOrActivateTab(state: TabsState, path: string): TabsState {
  const existing = state.tabs.findIndex((tab) => tab.pane.path === path);
  if (existing !== -1) return activateTab(state, existing);
  return openTab(state, path);
}

/**
 * Close a tab, or report that the window should close.
 *
 * `null` means the last tab is gone. The window closing is the caller's to do —
 * this module knows about tabs, not about windows.
 */
export function closeTab(state: TabsState, index: number): TabsState | null {
  if (index < 0 || index >= state.tabs.length) return state;

  const tabs = [...state.tabs.slice(0, index), ...state.tabs.slice(index + 1)];
  if (tabs.length === 0) return null;

  // Closing a tab to the LEFT of the active one shifts the active one down, so
  // the same tab stays active. Closing the active one moves to what took its
  // place, or to the new last tab when it was the last.
  const activeIndex =
    index < state.activeIndex
      ? state.activeIndex - 1
      : Math.min(state.activeIndex, tabs.length - 1);

  return { ...state, tabs, activeIndex };
}

export function activateTab(state: TabsState, index: number): TabsState {
  if (index < 0 || index >= state.tabs.length || index === state.activeIndex) return state;
  return { ...state, activeIndex: index };
}

/** Wraps, unlike cursor movement: a tab strip is a ring and reads as one. */
export function nextTab(state: TabsState): TabsState {
  if (state.tabs.length <= 1) return state;
  return activateTab(state, (state.activeIndex + 1) % state.tabs.length);
}

export function previousTab(state: TabsState): TabsState {
  if (state.tabs.length <= 1) return state;
  const count = state.tabs.length;
  return activateTab(state, (state.activeIndex - 1 + count) % count);
}

/**
 * Apply a pane transition to one tab by id, whichever tab that is now.
 *
 * By id and not by index, because this is what a background listing and a
 * background watcher call back into: by the time a slow read of tab 3 lands,
 * tab 1 may have closed and the answer would be written into the wrong tab.
 */
export function updatePaneById(
  state: TabsState,
  id: string,
  change: (pane: PaneState) => PaneState,
): TabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  const current = state.tabs[index];
  // A tab that closed while its read was in flight. Dropping the answer is
  // right: there is nothing left to show it in.
  if (current === undefined) return state;

  const pane = change(current.pane);
  if (pane === current.pane) return state;

  const tabs = [...state.tabs];
  tabs[index] = { ...current, pane };
  return { ...state, tabs };
}

/**
 * Apply a pane transition to the active tab, leaving every other tab alone.
 *
 * The single way navigation reaches a pane, so "a key press changes exactly one
 * tab" is a property of this function rather than a rule every caller has to
 * remember.
 */
export function updateActivePane(
  state: TabsState,
  change: (pane: PaneState) => PaneState,
): TabsState {
  const current = state.tabs[state.activeIndex];
  if (current === undefined) return state;

  const pane = change(current.pane);
  if (pane === current.pane) return state;

  return withActiveTab(state, { ...current, pane });
}

/**
 * Replace the active tab, leaving every other one alone.
 *
 * Four transitions end this way and three of them had written it out. The copy
 * inside `navigateActivePane` was byte-identical to the whole of
 * `updateActivePane`, which is the shape a duplication check exists to find.
 */
function withActiveTab(state: TabsState, tab: Tab): TabsState {
  const tabs = [...state.tabs];
  tabs[state.activeIndex] = tab;
  return { ...state, tabs };
}

/**
 * Navigate the active tab, recording where it came from.
 *
 * The one route a deliberate move takes, so "a navigation is remembered" is a
 * property of this function rather than a rule every caller has to remember.
 * Two things deliberately do NOT come through here and so leave no trace:
 *
 * - a step back or forward, which would otherwise put the place it just left
 *   back on the stack and oscillate;
 * - the pane's own retreat after a listing fails, which is a repair rather than
 *   a place the user went.
 */
export function navigateActivePane(
  state: TabsState,
  change: (pane: PaneState) => PaneState,
): TabsState {
  // A navigation IS an ordinary pane update that also remembers. Built on top
  // of one rather than beside it: the two had the same four opening lines, and
  // a second copy of "apply a change to the active tab, or do nothing" is a
  // place for the two to disagree about what "nothing" means.
  const moved = updateActivePane(state, change);
  if (moved === state) return state;

  const before = state.tabs[state.activeIndex];
  const after = moved.tabs[state.activeIndex];
  if (before === undefined || after === undefined) return moved;

  // A move that stays in the same directory is a cursor move, not a
  // navigation. `enterDirectory` on a file returns exactly that.
  if (after.pane.path === before.pane.path) return moved;

  return withActiveTab(moved, {
    ...after,
    history: visit(before.history, before.pane.path),
    historyBeforeMove: before.history,
  });
}

/** Which way along the trail. */
export type HistoryDirection = "back" | "forward";

/**
 * Walk the active tab's trail one step, or leave everything alone.
 *
 * It goes through `goToPath`, the same transition every other jump takes, so
 * the listing that arrives replaces nothing and the cursor memory puts the
 * cursor back where it was left in that directory. Sharing the transition is
 * what keeps a step subject to its same-path rule: a trail entry that names the
 * directory we are already in would otherwise empty the column and never
 * re-list it, and the step is refused outright rather than half-taken.
 *
 * It also DROPS the selection, which the hand-rolled step used to carry. A step
 * lands in a different directory, and a mark is a NAME that can match a
 * different file there — the same rule, and the same reason, as
 * `enterDirectory`.
 */
export function stepActiveHistory(state: TabsState, direction: HistoryDirection): TabsState {
  const current = state.tabs[state.activeIndex];
  if (current === undefined) return state;

  const step =
    direction === "back"
      ? stepBack(current.history, current.pane.path)
      : stepForward(current.history, current.pane.path);
  if (step === null) return state;

  const pane = goToPath(current.pane, step.path);
  // Nowhere to go, so the trail must not move either — consuming the entry
  // would spend a step that never happened.
  //
  // The cost of that choice, stated so it is a decision and not an oversight:
  // the offending entry stays on the stack, so `back` would be inert for that
  // tab rather than wrong once. Refusing is still preferred, because a step
  // that moved the trail without moving the pane puts the two out of step, and
  // every later step then compounds the error. The state is unreachable through
  // the trail the pane builds for itself — `navigateActivePane` never records a
  // move that did not move — so this is defence, and it should fail loudly
  // rather than quietly limp.
  if (pane === current.pane) return state;

  return withActiveTab(state, {
    ...current,
    pane,
    history: step.history,
    // A step is as optimistic as any other move, and the directory it returns
    // to may have stopped being readable since it was last seen.
    historyBeforeMove: current.history,
  });
}

/**
 * Send a tab back to a path that worked, after a listing failed.
 *
 * Distinct from `updatePaneById`, which this used to be, because putting the
 * PANE back is only half of putting things back: the move was recorded on the
 * way in, so the trail has to be restored too. It is restored wholesale from
 * the snapshot the move itself left — see `historyBeforeMove` for why an undo
 * operation could not do it.
 *
 * The caller only reaches it where the attempted path differs from the last good
 * one, so a watcher refresh that fails on the directory the pane is already in
 * cannot undo a move the user really made. That guard is now held HERE as well,
 * through `goToPath`. It used to be the caller's alone, and this function wrote
 * the pane out by hand — the one shape left in the codebase that could empty a
 * listing nothing would re-fetch, kept safe only by a condition a reader had to
 * go and find in another file.
 *
 * By id and not on the active tab, because a background tab's listing can fail
 * too and the answer must reach the tab that asked.
 */
export function revertPaneById(state: TabsState, id: string, path: string): TabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  const current = state.tabs[index];
  // The tab closed while its read was in flight. Nothing to put back.
  if (current === undefined) return state;

  // Already where the retreat would put it, so there is nothing to put back and
  // emptying the listing would be pure loss.
  const pane = goToPath(current.pane, path);
  if (pane === current.pane) return state;

  const tabs = [...state.tabs];
  tabs[index] = {
    ...current,
    pane,
    history: current.historyBeforeMove,
  };
  return { ...state, tabs };
}
