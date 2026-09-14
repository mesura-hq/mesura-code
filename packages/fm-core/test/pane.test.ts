import { describe, expect, it } from "vitest";

import type { FsEntry } from "../src/entry.ts";
import {
  boundaryIndex,
  breadcrumbs,
  clearSelection,
  createPane,
  cursorEntry,
  didNavigate,
  enterDirectory,
  entryAt,
  goToPath,
  isDirectoryEntry,
  leaveDirectory,
  moveCursor,
  type PaneState,
  rememberCursorAt,
  setEntries,
  toggleSelection,
} from "../src/pane.ts";

function entry(name: string, kind: FsEntry["kind"] = "file"): FsEntry {
  return { name, kind, size: 0, modifiedMs: 0, isSymlink: false, isHidden: false };
}

const listing = [entry("src", "directory"), entry("a.txt"), entry("b.txt"), entry("c.txt")];

/** A pane at `path` already holding the named entries. */
function withEntries(pane: PaneState, names: readonly string[]): PaneState {
  return setEntries(
    pane,
    names.map((name) => entry(name)),
  );
}

describe("the cursor", () => {
  it("starts on the first entry", () => {
    const pane = setEntries(createPane("/home/jc"), listing);
    expect(cursorEntry(pane)?.name).toBe("src");
  });

  it("moves down and up", () => {
    let pane = setEntries(createPane("/home/jc"), listing);
    pane = moveCursor(pane, 1);
    expect(cursorEntry(pane)?.name).toBe("a.txt");
    pane = moveCursor(pane, -1);
    expect(cursorEntry(pane)?.name).toBe("src");
  });

  it("does NOT wrap past the last entry", () => {
    // Wrapping is disorienting in a list you navigate by feel: you hold `j`,
    // the cursor silently teleports to the top, and you act on the wrong file.
    let pane = setEntries(createPane("/home/jc"), listing);
    pane = moveCursor(pane, 99);
    expect(cursorEntry(pane)?.name).toBe("c.txt");
    pane = moveCursor(pane, 1);
    expect(cursorEntry(pane)?.name).toBe("c.txt");
  });

  it("does NOT wrap past the first entry", () => {
    let pane = setEntries(createPane("/home/jc"), listing);
    pane = moveCursor(pane, -99);
    expect(cursorEntry(pane)?.name).toBe("src");
  });

  it("survives an empty directory without a cursor to move", () => {
    const pane = moveCursor(setEntries(createPane("/tmp"), []), 1);
    expect(cursorEntry(pane)).toBeNull();
  });

  it("clamps the cursor when the listing shrinks under it", () => {
    // A file watched away while the cursor sat on it. The cursor must land
    // somewhere real rather than off the end.
    let pane = setEntries(createPane("/home/jc"), listing);
    pane = moveCursor(pane, 3);
    pane = setEntries(pane, listing.slice(0, 2));
    expect(cursorEntry(pane)?.name).toBe("a.txt");
  });

  it("keeps the cursor on the same NAME when the listing is re-sorted", () => {
    // A re-sort is not navigation. The user's attention is on a file, not on
    // an index, and moving it under them is how the wrong file gets deleted.
    let pane = setEntries(createPane("/home/jc"), listing);
    pane = moveCursor(pane, 2);
    expect(cursorEntry(pane)?.name).toBe("b.txt");

    pane = setEntries(pane, [...listing].reverse());
    expect(cursorEntry(pane)?.name).toBe("b.txt");
  });
});

describe("entering and leaving", () => {
  it("enters a directory and makes it current", () => {
    const pane = setEntries(createPane("/home/jc"), listing);
    const entered = enterDirectory(pane);

    expect(entered.path).toBe("/home/jc/src");
    expect(entered.entries).toEqual([]);
  });

  it("refuses to enter a file", () => {
    let pane = setEntries(createPane("/home/jc"), listing);
    pane = moveCursor(pane, 1);

    expect(enterDirectory(pane)).toBe(pane);
  });

  it("leaves to the parent", () => {
    const pane = createPane("/home/jc/projects");
    expect(leaveDirectory(pane).path).toBe("/home/jc");
  });

  it("stops at the root rather than climbing past it", () => {
    expect(leaveDirectory(createPane("/")).path).toBe("/");
  });

  it("restores the cursor to the entry that was entered", () => {
    // The behaviour that makes Miller columns navigable: go in, come back out,
    // and the cursor is where you left it — not reset to the top.
    let pane = setEntries(createPane("/home/jc"), listing);
    pane = moveCursor(pane, 0);
    const inside = setEntries(enterDirectory(pane), [entry("deep.txt")]);
    const back = setEntries(leaveDirectory(inside), listing);

    expect(back.path).toBe("/home/jc");
    expect(cursorEntry(back)?.name).toBe("src");
  });

  it("remembers a cursor per directory, not one globally", () => {
    let pane = setEntries(createPane("/home/jc"), listing);
    pane = moveCursor(pane, 2); // b.txt
    const inside = setEntries(enterDirectory(moveCursor(pane, -2)), [entry("x")]);
    const back = setEntries(leaveDirectory(inside), listing);

    expect(cursorEntry(back)?.name).toBe("src");
  });
});

describe("jumping to a path named outright", () => {
  it("goes there and empties the listing, ready for the one that arrives", () => {
    const pane = setEntries(createPane("/home/jc"), listing);
    const jumped = goToPath(pane, "/home/jc/Downloads");

    expect(jumped.path).toBe("/home/jc/Downloads");
    expect(jumped.entries).toEqual([]);
    expect(jumped.cursorIndex).toBe(0);
  });

  it("returns the very same pane when the jump goes nowhere", () => {
    // BY REFERENCE, which is the whole of the fix. Emptying a pane and
    // re-listing it are separate mechanisms joined only by the path changing,
    // so a jump that clears the entries without moving leaves a column that
    // nothing will ever fill: `gd` inside Downloads read "0 entries" against a
    // directory full of files, and only leaving and coming back repaired it.
    const pane = setEntries(createPane("/home/jc"), listing);

    expect(goToPath(pane, "/home/jc")).toBe(pane);
  });

  it("makes that refusal visible through didNavigate, like the other two", () => {
    const pane = setEntries(createPane("/home/jc"), listing);

    expect(didNavigate(pane, goToPath(pane, "/home/jc"))).toBe(false);
    expect(didNavigate(pane, goToPath(pane, "/home/jc/projects"))).toBe(true);
  });

  it("does not carry a selection to the destination", () => {
    // The same rule entering and leaving obey, and for the same reason. A jump
    // reached it late: it was the one location change that never became a named
    // transition, so it never inherited any of the rules the others share.
    const marked = toggleSelection(setEntries(createPane("/tmp"), [entry("a.txt")]));
    expect(marked.selection.size).toBe(1);

    expect(goToPath(marked, "/tmp/sub").selection.size).toBe(0);
  });

  it("keeps the cursor memory, so returning restores the cursor", () => {
    let pane = setEntries(createPane("/home/jc"), listing);
    pane = moveCursor(pane, 2); // b.txt
    const away = setEntries(goToPath(pane, "/tmp"), [entry("x")]);
    const back = setEntries(goToPath(away, "/home/jc"), listing);

    expect(cursorEntry(back)?.name).toBe("b.txt");
  });
});

describe("breadcrumbs", () => {
  it("splits a path into segments with their absolute paths", () => {
    expect(breadcrumbs("/home/jc/projects")).toEqual([
      { label: "/", path: "/" },
      { label: "home", path: "/home" },
      { label: "jc", path: "/home/jc" },
      { label: "projects", path: "/home/jc/projects" },
    ]);
  });

  it("gives the root a single segment", () => {
    expect(breadcrumbs("/")).toEqual([{ label: "/", path: "/" }]);
  });

  it("ignores a trailing slash", () => {
    expect(breadcrumbs("/home/jc/")).toEqual(breadcrumbs("/home/jc"));
  });
});

/** Put the cursor somewhere without going through a key. */
function setCursor(pane: PaneState, index: number): PaneState {
  return moveCursor(pane, index - pane.cursorIndex);
}

describe("selection", () => {
  const files = [entry("a.txt"), entry("b.txt"), entry("c.txt")];

  function loaded(): PaneState {
    return setEntries(createPane("/tmp"), files);
  }

  it("marks the entry under the cursor and steps past it", () => {
    // Advancing is what makes marking a run of files one repeated keystroke
    // rather than an alternation of two.
    const marked = toggleSelection(loaded());

    expect([...marked.selection]).toEqual(["a.txt"]);
    expect(marked.cursorIndex).toBe(1);
  });

  it("unmarks an entry that was already marked", () => {
    const twice = toggleSelection(setCursor(toggleSelection(loaded()), 0));

    expect([...twice.selection]).toEqual([]);
  });

  it("stops at the last entry rather than wrapping", () => {
    let pane = loaded();
    for (let i = 0; i < 10; i++) pane = toggleSelection(pane);

    expect(pane.cursorIndex).toBe(files.length - 1);
  });

  it("does nothing in an empty directory", () => {
    const empty = createPane("/tmp");
    expect(toggleSelection(empty)).toBe(empty);
  });

  it("clears every mark, and returns the same pane when there was none", () => {
    const marked = toggleSelection(loaded());

    expect(clearSelection(marked).selection.size).toBe(0);
    const clean = loaded();
    expect(clearSelection(clean)).toBe(clean);
  });

  it("drops a mark for an entry that disappeared from the listing", () => {
    // Otherwise the name stays marked and a later operation acts on whatever is
    // recreated under it.
    const marked = toggleSelection(loaded());
    const refreshed = setEntries(marked, [entry("b.txt"), entry("c.txt")]);

    expect([...refreshed.selection]).toEqual([]);
  });

  it("does not carry a selection into another directory", () => {
    // The names would still match, and an operation would act on entries that
    // merely share a name with what was marked.
    const marked = toggleSelection(setEntries(createPane("/tmp"), [entry("sub", "directory")]));

    expect(enterDirectory(setCursor(marked, 0)).selection.size).toBe(0);
    expect(leaveDirectory(marked).selection.size).toBe(0);
  });
});

/**
 * The two questions the pointer added.
 *
 * `entryAt` exists because a click asks about the row it landed on, which is
 * usually not the cursor; `isDirectoryEntry` exists because the keyboard and
 * the pointer both decide enter-versus-open and must decide it the same way.
 */
describe("asking about an entry by index", () => {
  const pane = setEntries(createPane("/home/jc"), [
    entry("projects", "directory"),
    entry("notes.txt"),
  ]);

  it("answers for a row that is not under the cursor", () => {
    expect(pane.cursorIndex).toBe(0);
    expect(entryAt(pane, 1)?.name).toBe("notes.txt");
  });

  it("answers null for an index that is not there, rather than clamping", () => {
    // Clamping would make a click on a row that vanished between the render and
    // the event act on whatever moved into its place.
    expect(entryAt(pane, 9)).toBeNull();
    expect(entryAt(pane, -1)).toBeNull();
  });

  it("is what the cursor question is built from", () => {
    expect(cursorEntry(pane)).toBe(entryAt(pane, pane.cursorIndex));
  });
});

describe("deciding whether something can be entered", () => {
  it("says yes for a directory and no for a file", () => {
    expect(isDirectoryEntry(entry("projects", "directory"))).toBe(true);
    expect(isDirectoryEntry(entry("notes.txt"))).toBe(false);
  });

  it("says no for nothing at all", () => {
    expect(isDirectoryEntry(null)).toBe(false);
  });

  it("says yes for a SYMLINK to a directory, which is why one definition exists", () => {
    // The scan reports a link by its target's kind precisely so a symlinked
    // directory can be walked into. Two copies of this predicate would
    // eventually disagree about exactly this case — the keyboard entering it
    // and the pointer opening it, or the reverse.
    const link: FsEntry = { ...entry("to-dir", "directory"), isSymlink: true };
    expect(isDirectoryEntry(link)).toBe(true);
  });

  it("says no for a broken link, which the scan reports as other", () => {
    const broken: FsEntry = { ...entry("to-nowhere", "other"), isSymlink: true };
    expect(isDirectoryEntry(broken)).toBe(false);
  });
});

describe("the directory / file boundary", () => {
  // Directories sort first in every order, so the two kinds are always
  // contiguous blocks and "the first entry of the opposite kind" is exactly
  // where one block ends and the other begins.
  it("goes from a directory to the first file", () => {
    const pane = setEntries(createPane("/home/jc"), listing);
    expect(cursorEntry(pane)?.name).toBe("src");

    expect(boundaryIndex(pane)).toBe(1);
  });

  it("goes from a file back to the first directory", () => {
    let pane = setEntries(createPane("/home/jc"), listing);
    pane = moveCursor(pane, 3);
    expect(cursorEntry(pane)?.name).toBe("c.txt");

    expect(boundaryIndex(pane)).toBe(0);
  });

  it("reports nowhere to go in a listing of one kind", () => {
    const filesOnly = setEntries(createPane("/tmp"), [entry("a.txt"), entry("b.txt")]);
    const dirsOnly = setEntries(createPane("/tmp"), [
      entry("one", "directory"),
      entry("two", "directory"),
    ]);

    expect(boundaryIndex(filesOnly)).toBe(-1);
    expect(boundaryIndex(dirsOnly)).toBe(-1);
  });

  it("reports nowhere to go in an empty listing", () => {
    expect(boundaryIndex(setEntries(createPane("/tmp"), []))).toBe(-1);
  });

  it("treats every non-directory kind as the file side", () => {
    // A socket, a device node or a broken symlink comes back as `other`. It is
    // not a directory, so it belongs to the block Tab jumps to from one — and
    // testing `kind === "file"` rather than "not a directory" would strand the
    // cursor when the first non-directory happened to be one of them.
    const pane = setEntries(createPane("/tmp"), [entry("d", "directory"), entry("sock", "other")]);
    expect(boundaryIndex(pane)).toBe(1);
  });
});

describe("remembering a cursor for somewhere else", () => {
  it("lands on the remembered name when the pane later goes there", () => {
    const pane = withEntries(createPane("/home/jc"), ["alpha", "beta", "gamma"]);

    const armed = rememberCursorAt(pane, "/home/jc/projects", "beta");
    const arrived = setEntries(goToPath(armed, "/home/jc/projects"), [
      entry("one"),
      entry("beta"),
      entry("three"),
    ]);

    expect(arrived.cursorIndex).toBe(1);
  });

  it("leaves the cursor remembered for the pane's own directory alone", () => {
    // A flash jump records the DESTINATION's cursor and then moves. The Qt
    // build had to warn that the two writes must happen in a particular order,
    // because both went into one cache under different keys; recording for a
    // named path rather than for "here" removes the hazard rather than
    // documenting it.
    const here = moveCursor(withEntries(createPane("/home/jc"), ["a", "b", "c"]), 2);
    expect(here.cursorMemory.get("/home/jc")).toBe("c");

    const armed = rememberCursorAt(here, "/home", "other");

    expect(armed.cursorMemory.get("/home/jc")).toBe("c");
    expect(armed.cursorMemory.get("/home")).toBe("other");
  });

  it("returns a new pane rather than writing into the one it was given", () => {
    const pane = withEntries(createPane("/home/jc"), ["a"]);

    const armed = rememberCursorAt(pane, "/elsewhere", "x");

    expect(armed).not.toBe(pane);
    expect(pane.cursorMemory.has("/elsewhere")).toBe(false);
  });
});
