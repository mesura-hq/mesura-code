import { goToPath } from "@symmetria/fm-core/pane";
import { describe, expect, it } from "vitest";

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
} from "../src/state/tabs.ts";

/**
 * The index arithmetic, on its own.
 *
 * No DOM: this file is pure collection logic, and it is where a subtly wrong
 * index hides best — closing a tab to the left of the active one, closing the
 * active one when it is last, wrapping at either end.
 */

function paths(state: TabsState): string[] {
  return state.tabs.map((tab) => tab.pane.path);
}

/** Four tabs at /a … /d, with the third one active. */
function four(): TabsState {
  let state = createTabs("/a");
  state = openTab(state, "/b");
  state = openTab(state, "/c");
  state = openTab(state, "/d");
  return activateTab(state, 2);
}

describe("opening", () => {
  it("starts with one tab, and no bar to show it", () => {
    const state = createTabs("/home");

    expect(paths(state)).toEqual(["/home"]);
    expect(showTabBar(state)).toBe(false);
  });

  it("inserts beside the active tab rather than at the end", () => {
    // A tab opened from here belongs beside here, which is what the original
    // did and what every browser does.
    const state = openTab(activateTab(four(), 0), "/new");

    expect(paths(state)).toEqual(["/a", "/new", "/b", "/c", "/d"]);
    expect(state.activeIndex).toBe(1);
  });

  it("never reuses an id, even after a close", () => {
    // The watcher reconciler keys on the id. A reused id would inherit the
    // closed tab's watch and never start its own.
    const opened = openTab(createTabs("/a"), "/b");
    const closed = closeTab(opened, 1);
    const again = openTab(closed as TabsState, "/c");

    expect(again.tabs.map((t) => t.id)).toEqual(["tab-0", "tab-2"]);
  });
});

describe("closing", () => {
  it("keeps the same tab active when one to its left closes", () => {
    const state = closeTab(four(), 0);

    expect(paths(state as TabsState)).toEqual(["/b", "/c", "/d"]);
    expect(activePane(state as TabsState)?.path).toBe("/c");
  });

  it("keeps the same tab active when one to its right closes", () => {
    const state = closeTab(four(), 3);

    expect(activePane(state as TabsState)?.path).toBe("/c");
  });

  it("moves to what took the closed tab's place", () => {
    const state = closeTab(four(), 2);

    expect(paths(state as TabsState)).toEqual(["/a", "/b", "/d"]);
    expect(activePane(state as TabsState)?.path).toBe("/d");
  });

  it("falls back to the new last tab when the active one was last", () => {
    const state = closeTab(activateTab(four(), 3), 3);

    expect(activePane(state as TabsState)?.path).toBe("/c");
  });

  it("reports that the window should close when the last tab goes", () => {
    expect(closeTab(createTabs("/a"), 0)).toBeNull();
  });

  it("ignores an index that is not a tab", () => {
    const state = four();
    expect(closeTab(state, 9)).toBe(state);
    expect(closeTab(state, -1)).toBe(state);
  });
});

describe("cycling", () => {
  it("wraps forward and backward", () => {
    // A tab strip is a ring and reads as one — unlike the cursor, which stops.
    const last = activateTab(four(), 3);
    expect(nextTab(last).activeIndex).toBe(0);
    expect(previousTab(activateTab(four(), 0)).activeIndex).toBe(3);
  });

  it("does nothing with a single tab", () => {
    const one = createTabs("/a");
    expect(nextTab(one)).toBe(one);
    expect(previousTab(one)).toBe(one);
  });

  it("ignores activating the tab that is already active", () => {
    const state = four();
    expect(activateTab(state, 2)).toBe(state);
  });
});

describe("updating one tab", () => {
  it("changes the active tab and leaves every other one alone", () => {
    const before = four();
    const after = updateActivePane(before, (pane) => ({ ...pane, cursorIndex: 7 }));

    expect(after.tabs[2]?.pane.cursorIndex).toBe(7);
    expect(after.tabs[0]?.pane).toBe(before.tabs[0]?.pane);
    expect(after.tabs[1]?.pane).toBe(before.tabs[1]?.pane);
  });

  it("returns the same state when the transition changed nothing", () => {
    // Reference equality is the convention `pane.ts` uses for "nowhere to go",
    // and it must survive the tab layer or a no-op key would re-render.
    const state = four();
    expect(updateActivePane(state, (pane) => pane)).toBe(state);
  });

  it("writes a background answer into the tab that asked, by id", () => {
    const before = four();
    const after = updatePaneById(before, "tab-1", (pane) => ({ ...pane, cursorIndex: 4 }));

    expect(after.tabs.find((t) => t.id === "tab-1")?.pane.cursorIndex).toBe(4);
    expect(after.activeIndex).toBe(2);
  });

  it("drops an answer for a tab that closed while its read was in flight", () => {
    // Otherwise a slow read of a closed tab writes into whatever now occupies
    // its index.
    const state = closeTab(four(), 1) as TabsState;

    expect(updatePaneById(state, "tab-1", (pane) => ({ ...pane, cursorIndex: 9 }))).toBe(state);
  });
});

/**
 * Move the active pane to a path, the way a deliberate navigation does.
 *
 * Through `goToPath` and not a transition written out here: a helper with its
 * own copy of the shape would keep passing after the real one changed, which is
 * exactly how the same-path defect below stayed invisible at this level.
 */
function goTo(state: TabsState, path: string): TabsState {
  return navigateActivePane(state, (pane) => goToPath(pane, path));
}

/** Where the active tab is. */
function at(state: TabsState): string {
  return activePane(state)?.path ?? "";
}

describe("a navigation that goes nowhere", () => {
  it("changes nothing at all, rather than emptying the pane it is already in", () => {
    // The state must come back BY REFERENCE. Anything else is a render whose
    // only effect is to blank a column that nothing will re-list — the watch
    // reconciler starts a read when the PATH changes, and this one did not.
    let state = createTabs("/a");
    state = goTo(state, "/b");

    expect(goTo(state, "/b")).toBe(state);
  });

  it("does not spend a history step on it", () => {
    // A jump that recorded itself would put `/b` on the back stack while still
    // standing in `/b`, and the next back press would go nowhere too.
    let state = createTabs("/a");
    state = goTo(state, "/b");
    state = goTo(state, "/b");

    state = stepActiveHistory(state, "back");
    expect(at(state)).toBe("/a");
  });

  it("refuses a revert to the path the pane is already on", () => {
    // The retreat after a failed listing was the last transition writing the
    // pane out by hand. Its guard lived in the caller, so this state was
    // unreachable only for as long as that one call site stayed correct.
    let state = createTabs("/a");
    state = goTo(state, "/b");

    expect(revertPaneById(state, "tab-0", "/b")).toBe(state);
  });

  it("refuses a trail step that names the directory the pane is in", () => {
    // Not reachable through the trail the pane builds for itself, which never
    // records a move that did not move. It is pinned because the step used to
    // write the pane out by hand: whatever the trail said, the pane obeyed, and
    // one wrong entry would have emptied the column with no way back.
    let state = createTabs("/a");
    state = goTo(state, "/b");
    state = updateActivePane(state, (pane) => ({ ...pane, path: "/a" }));

    expect(stepActiveHistory(state, "back")).toBe(state);
  });
});

/**
 * A navigation that fails, and what it must leave behind.
 *
 * The pane's path moves BEFORE the listing answers — that is what makes
 * entering a directory feel instant — so a navigation that turns out to be
 * unreadable has already been recorded by the time anyone finds out. Putting
 * the pane back is not enough: the trail has to go back to exactly what it was,
 * or the failed attempt keeps costing keystrokes afterwards.
 */
describe("a navigation that fails", () => {
  it("leaves no step behind for a later back press to waste itself on", () => {
    let state = createTabs("/a");
    state = goTo(state, "/b");

    // Into a directory that turns out not to be readable.
    state = goTo(state, "/b/locked");
    state = revertPaneById(state, "tab-0", "/b");
    expect(at(state)).toBe("/b");

    // ONE step must reach `/a`. Two would mean the failure left a step.
    state = stepActiveHistory(state, "back");

    expect(at(state)).toBe("/a");
  });

  it("does not destroy a forward trail it never touched", () => {
    // The user stepped back, so there is somewhere to go forward TO. A failed
    // attempt in between must not take that away: they ended up exactly where
    // they started, and `=` still means the same thing it did before.
    let state = createTabs("/a");
    state = goTo(state, "/b");
    state = stepActiveHistory(state, "back");
    expect(at(state)).toBe("/a");

    state = goTo(state, "/a/locked");
    state = revertPaneById(state, "tab-0", "/a");
    expect(at(state)).toBe("/a");

    state = stepActiveHistory(state, "forward");

    expect(at(state)).toBe("/b");
  });

  it("puts the trail back when the unreadable directory was reached by a back step", () => {
    // A history step does not record anything, so there is no visit to undo —
    // and the trail still has to end up as it was, or `=` returns to the
    // directory the pane is already standing in and the press does nothing.
    let state = createTabs("/a");
    state = goTo(state, "/b");

    // Back to `/a`, which has since become unreadable.
    state = stepActiveHistory(state, "back");
    state = revertPaneById(state, "tab-0", "/b");
    expect(at(state)).toBe("/b");

    // The trail is what it was before that press: back to `/a` is available
    // again, and forward is empty.
    state = stepActiveHistory(state, "forward");
    expect(at(state)).toBe("/b");

    state = stepActiveHistory(state, "back");
    expect(at(state)).toBe("/a");
  });
});

describe("the trail belongs to one tab", () => {
  it("gives a new tab a trail of its own", () => {
    let state = createTabs("/a");
    state = goTo(state, "/b");
    state = openTab(state, "/b");

    // The new tab came from nowhere, so it has nowhere to go back to.
    const stepped = stepActiveHistory(state, "back");

    expect(at(stepped)).toBe("/b");
  });
});

/**
 * Acceptance criteria 5 and 6 of phase 1.
 *
 * A resident daemon is asked to open a path many times over a session, and the
 * one-window rule means every one of those lands in this collection. Opening a
 * fresh tab each time would turn a tool built to hold few things open into a
 * tool that accumulates duplicates faster than the old many-windows design did.
 */
describe("opening a path the daemon was asked for", () => {
  it("opens a new tab when nothing is showing that path", () => {
    const state = createTabs("/a");

    const opened = openOrActivateTab(state, "/b");

    expect(paths(opened)).toEqual(["/a", "/b"]);
    expect(at(opened)).toBe("/b");
  });

  it("activates the tab already showing that path instead of making a second", () => {
    let state = createTabs("/a");
    state = openTab(state, "/b");
    state = openTab(state, "/c");

    const opened = openOrActivateTab(state, "/b");

    expect(paths(opened)).toEqual(["/a", "/b", "/c"]);
    expect(at(opened)).toBe("/b");
  });

  it("stays put when the active tab is already the one asked for", () => {
    // No new tab, and no reordering either: asking for where you already are
    // should be the cheapest thing the daemon ever does.
    let state = createTabs("/a");
    state = openTab(state, "/b");

    const opened = openOrActivateTab(state, "/b");

    expect(paths(opened)).toEqual(["/a", "/b"]);
    expect(at(opened)).toBe("/b");
  });

  it("matches the first tab on that path when two of them are", () => {
    // Two tabs can hold one path — the user can open one by hand. Picking the
    // first is arbitrary but it must be deterministic, or the same command
    // lands somewhere different depending on which tab was active.
    let state = createTabs("/a");
    state = openTab(state, "/b");
    state = openTab(state, "/b");
    state = activateTab(state, 0);

    const opened = openOrActivateTab(state, "/b");

    expect(opened.activeIndex).toBe(1);
    expect(paths(opened)).toEqual(["/a", "/b", "/b"]);
  });
});
