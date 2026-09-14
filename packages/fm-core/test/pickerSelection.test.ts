import { describe, expect, it } from "vitest";

import {
  type PickerSelectionContext,
  pickerAcceptEnabled,
  pickerAcceptLabel,
  resolvePickerSelection,
} from "../src/pickerSelection.ts";

/**
 * What a confirmed picker returns.
 *
 * Ported from `confirmPickerSelection` in the Qt build's
 * `FileManagerService.qml`, which is the single source of truth there for both
 * the Enter key and the Accept button. It is four branches in a LOAD-BEARING
 * order, and a pure function is what lets the whole truth table be a unit test
 * rather than four rendering tests.
 *
 * The order matters because save mode and multi-select are ORTHOGONAL: a save
 * dialog ignores marks entirely, so SAVE is checked first. That diverges from
 * the Qt code, which checks marks first — and agrees with the Qt comment
 * directly above it, which says save mode ignores marks. The comment describes
 * the intent; the order below it does something else. See `pickerSelection.ts`
 * for why following the intent is safe: the portal never sends both.
 */

const BASE: PickerSelectionContext = {
  multiple: false,
  directory: false,
  saveMode: false,
  currentPath: "/home/jc/Downloads",
  suggestedName: "",
  selected: [],
  cursorEntry: null,
};

const FILE = { path: "/home/jc/Downloads/report.pdf", isDirectory: false };
const DIRECTORY = { path: "/home/jc/Downloads/archive", isDirectory: true };

describe("a multi-select picker", () => {
  it("returns every marked path", () => {
    const out = resolvePickerSelection({
      ...BASE,
      multiple: true,
      selected: [
        { path: "/home/jc/a.txt", isDirectory: false },
        { path: "/home/jc/b.txt", isDirectory: false },
      ],
      cursorEntry: FILE,
    });

    expect(out).toEqual({ kind: "paths", paths: ["/home/jc/a.txt", "/home/jc/b.txt"] });
  });

  it("falls back to the entry under the cursor when nothing is marked", () => {
    // Pressing Enter without marking anything is the common case even in a
    // multi-select dialog, and it must not return an empty list.
    const out = resolvePickerSelection({ ...BASE, multiple: true, cursorEntry: FILE });

    expect(out).toEqual({ kind: "paths", paths: [FILE.path] });
  });

  it("is ignored by a save dialog, even with marks", () => {
    // Save mode and multi-select are orthogonal in the Qt original, and a save
    // dialog that returned marked files instead of the filename being typed
    // would write to the wrong place.
    const out = resolvePickerSelection({
      ...BASE,
      multiple: true,
      saveMode: true,
      suggestedName: "report.pdf",
      selected: [
        { path: "/home/jc/a.txt", isDirectory: false },
        { path: "/home/jc/b.txt", isDirectory: false },
      ],
    });

    expect(out).toEqual({ kind: "paths", paths: ["/home/jc/Downloads/report.pdf"] });
  });
});

describe("a save picker", () => {
  it("joins the current directory to the name in the field", () => {
    const out = resolvePickerSelection({
      ...BASE,
      saveMode: true,
      suggestedName: "notes.md",
    });

    expect(out).toEqual({ kind: "paths", paths: ["/home/jc/Downloads/notes.md"] });
  });

  it("does not double the separator when the directory already ends in one", () => {
    const out = resolvePickerSelection({
      ...BASE,
      saveMode: true,
      currentPath: "/",
      suggestedName: "notes.md",
    });

    expect(out).toEqual({ kind: "paths", paths: ["/notes.md"] });
  });

  it("returns the bare directory when no name has been given", () => {
    // The portal appends its own `current_name` in that case — see `SaveFile`
    // in `portal/symmetria_portal.py`, which joins when it gets a directory.
    const out = resolvePickerSelection({ ...BASE, saveMode: true, suggestedName: "" });

    expect(out).toEqual({ kind: "paths", paths: ["/home/jc/Downloads"] });
  });

  it("ignores what the cursor is on", () => {
    // The name in the field is the answer, not the row under the cursor. A save
    // dialog that returned the highlighted file would overwrite it.
    const out = resolvePickerSelection({
      ...BASE,
      saveMode: true,
      suggestedName: "notes.md",
      cursorEntry: FILE,
    });

    expect(out).toEqual({ kind: "paths", paths: ["/home/jc/Downloads/notes.md"] });
  });
});

describe("what each kind of picker will accept", () => {
  it("takes a file in a file picker", () => {
    expect(resolvePickerSelection({ ...BASE, cursorEntry: FILE })).toEqual({
      kind: "paths",
      paths: [FILE.path],
    });
  });

  it("refuses a directory in a file picker", () => {
    // Entering it is what a user means by pressing Enter on a directory, so
    // confirming has to decline rather than return the directory as the answer.
    const out = resolvePickerSelection({ ...BASE, cursorEntry: DIRECTORY });

    expect(out.kind).toBe("refused");
  });

  it("takes a directory in a directory picker", () => {
    expect(resolvePickerSelection({ ...BASE, directory: true, cursorEntry: DIRECTORY })).toEqual({
      kind: "paths",
      paths: [DIRECTORY.path],
    });
  });

  it("refuses a file in a directory picker", () => {
    expect(resolvePickerSelection({ ...BASE, directory: true, cursorEntry: FILE }).kind).toBe(
      "refused",
    );
  });

  it("refuses when the cursor is on nothing at all", () => {
    // An empty directory. There is no answer to give, and returning an empty
    // list would read to the portal as a confirmed selection of nothing.
    expect(resolvePickerSelection({ ...BASE, cursorEntry: null }).kind).toBe("refused");
  });
});

describe("the Accept button's label", () => {
  it("uses whatever the calling application asked it to say", () => {
    // The portal passes `accept_label`, and an application that asked for
    // "Attach" should not get a button that says something else.
    expect(pickerAcceptLabel({ ...BASE, saveMode: true }, "Attach")).toBe("Attach");
  });

  it("says Save in a save dialog", () => {
    expect(pickerAcceptLabel({ ...BASE, saveMode: true }, "")).toBe("Save");
  });

  it("counts the marks in a multi-select dialog", () => {
    expect(
      pickerAcceptLabel(
        {
          ...BASE,
          multiple: true,
          selected: [
            { path: "/a", isDirectory: false },
            { path: "/b", isDirectory: false },
            { path: "/c", isDirectory: false },
          ],
        },
        "",
      ),
    ).toBe("Select (3)");
  });

  it("counts only the marks the dialog would accept", () => {
    // A folder marked in a file dialog is not part of the answer, so it must
    // not be part of the count either — a button promising three when it
    // returns two is worse than one that says nothing.
    expect(
      pickerAcceptLabel(
        {
          ...BASE,
          multiple: true,
          selected: [FILE, DIRECTORY, { path: "/x", isDirectory: false }],
        },
        "",
      ),
    ).toBe("Select (2)");
  });

  it("says Select otherwise", () => {
    // The Qt build's word, and parity is the point of the phase. The plan said
    // "Open"; `StatusBar.qml` says "Select", and matching the application the
    // operator uses every day beats matching my own paraphrase of it.
    expect(pickerAcceptLabel({ ...BASE, cursorEntry: FILE }, "")).toBe("Select");
  });
});

describe("marks the dialog will not take", () => {
  it("are left out of the answer", () => {
    // Review found this: the marked branch was the ONE place the entry's kind
    // was never checked, so a caller that asked for files could be handed a
    // folder the user happened to mark.
    const out = resolvePickerSelection({
      ...BASE,
      multiple: true,
      selected: [FILE, DIRECTORY],
    });

    expect(out).toEqual({ kind: "paths", paths: [FILE.path] });
  });

  it("fall back to the cursor when they are all unusable", () => {
    const out = resolvePickerSelection({
      ...BASE,
      multiple: true,
      selected: [DIRECTORY],
      cursorEntry: FILE,
    });

    expect(out).toEqual({ kind: "paths", paths: [FILE.path] });
  });

  it("are the only ones counted in a folder dialog", () => {
    const out = resolvePickerSelection({
      ...BASE,
      multiple: true,
      directory: true,
      selected: [FILE, DIRECTORY],
    });

    expect(out).toEqual({ kind: "paths", paths: [DIRECTORY.path] });
  });
});

describe("whether the Accept button can be pressed", () => {
  it("is always available in a save dialog", () => {
    // Confirming saves to the current directory even with no name typed, which
    // the portal then completes with its own suggestion.
    expect(pickerAcceptEnabled({ ...BASE, saveMode: true })).toBe(true);
  });

  it("is available in a multi-select dialog once anything is marked", () => {
    expect(
      pickerAcceptEnabled({
        ...BASE,
        multiple: true,
        selected: [{ path: "/a", isDirectory: false }],
      }),
    ).toBe(true);
  });

  it("is unavailable when the cursor is on the wrong kind of thing", () => {
    expect(pickerAcceptEnabled({ ...BASE, cursorEntry: DIRECTORY })).toBe(false);
    expect(pickerAcceptEnabled({ ...BASE, directory: true, cursorEntry: FILE })).toBe(false);
  });

  it("is unavailable when there is nothing under the cursor", () => {
    expect(pickerAcceptEnabled({ ...BASE, cursorEntry: null })).toBe(false);
  });

  it("agrees with what confirming would actually do", () => {
    // The two used to be written separately in the Qt build and could disagree:
    // a button that looks pressable and then does nothing is worse than one
    // that is visibly disabled. Every combination is checked rather than a
    // sample, because the interesting cases are the corners.
    for (const multiple of [false, true]) {
      for (const directory of [false, true]) {
        for (const saveMode of [false, true]) {
          for (const cursorEntry of [null, FILE, DIRECTORY]) {
            for (const selected of [[], [{ path: "/a", isDirectory: false }]]) {
              const ctx = { ...BASE, multiple, directory, saveMode, cursorEntry, selected };
              const label = JSON.stringify({
                multiple,
                directory,
                saveMode,
                cursorEntry,
                selected,
              });
              expect(pickerAcceptEnabled(ctx), label).toBe(
                resolvePickerSelection(ctx).kind === "paths",
              );
            }
          }
        }
      }
    }
  });
});
