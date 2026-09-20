/**
 * @vitest-environment happy-dom
 *
 * The panel, when it is a file dialog rather than a file manager.
 *
 * A picker is the same panel with chrome added and some keys taken away. What
 * is guarded here is the difference: that the chrome appears only in a dialog,
 * that confirming sends what the user chose rather than what the cursor
 * happens to be on, and that the suppression ported with the keyboard registry
 * — inert since the phase that introduced it — is finally live.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../../src/App.tsx";
import { type BridgeLog, installBridge, namesIn } from "./support.ts";

let log: BridgeLog;

beforeEach(() => {
  log = installBridge();
});
afterEach(cleanup);

const FIFO = "/tmp/symmetria-picker-test.fifo";

const OPTIONS = {
  title: "Select a File",
  acceptLabel: "",
  multiple: false,
  directory: false,
  saveMode: false,
  suggestedName: "",
  currentFolder: "",
};

function requestFor(overrides: Partial<typeof OPTIONS> = {}) {
  return { fifo: FIFO, options: { ...OPTIONS, ...overrides } };
}

/** Render the panel as a dialog and wait for its listing. */
async function openPicker(overrides: Partial<typeof OPTIONS> = {}): Promise<void> {
  render(<App startPath="/home/jc" homePath="/home/jc" picker={requestFor(overrides)} />);
  await waitFor(() => expect(namesIn("column-current").length).toBeGreaterThan(0));
  await act(async () => undefined);
}

/** Render the ordinary browse panel. */
async function openBrowser(): Promise<void> {
  render(<App startPath="/home/jc" homePath="/home/jc" />);
  await waitFor(() => expect(namesIn("column-current").length).toBeGreaterThan(0));
  await act(async () => undefined);
}

/**
 * Put the cursor on the first FILE.
 *
 * The fixture home opens on `projects`, a DIRECTORY, and a file dialog will not
 * accept one — so the cursor has to move before confirming means anything. One
 * `j` reaches `notes.txt`.
 *
 * The fake bridge returns the listing in DECLARATION order: sorting is the main
 * process's job and there is no main process here. So the index is the
 * fixture's own order and not the sorted one, which is why this is one press
 * rather than four. The fixture's comment forbids inserting entries into that
 * listing for exactly this reason — the whole suite counts `j` from the top.
 */
async function moveToFirstFile(): Promise<void> {
  fireEvent.keyDown(window, { key: "j" });
  await act(async () => undefined);
}

describe("the chrome appears only in a dialog", () => {
  it("shows an Accept and a Cancel button in a picker", async () => {
    await openPicker();

    expect(screen.getByTestId("picker-accept")).toBeTruthy();
    expect(screen.getByTestId("picker-cancel")).toBeTruthy();
  });

  it("shows neither in the browse window", async () => {
    // The resident window must be untouched by this phase. It is the thing the
    // operator uses all day and it is not a dialog.
    await openBrowser();

    expect(screen.queryByTestId("picker-accept")).toBeNull();
    expect(screen.queryByTestId("picker-cancel")).toBeNull();
    expect(screen.queryByTestId("picker-save-name")).toBeNull();
  });

  it("shows the save-filename field only in a save dialog", async () => {
    await openPicker({ saveMode: true, suggestedName: "report.pdf" });

    const field = screen.getByTestId("picker-save-name") as HTMLInputElement;
    expect(field.value).toBe("report.pdf");
  });

  it("hides the save-filename field in an open dialog", async () => {
    await openPicker();

    expect(screen.queryByTestId("picker-save-name")).toBeNull();
  });

  it("labels the Accept button as the calling application asked", async () => {
    await openPicker({ acceptLabel: "Attach" });

    expect(screen.getByTestId("picker-accept").textContent).toBe("Attach");
  });
});

describe("confirming a picker", () => {
  it("sends the entry under the cursor, with its fifo", async () => {
    // The cursor starts on a DIRECTORY in this fixture, and a file dialog will
    // not accept one — so the cursor is moved to a file first. Discovering that
    // is the point of driving the real panel rather than the pure function:
    // the truth table is tested in `pickerSelection.test.ts`, and what is
    // tested here is that the panel feeds it the right thing.
    await openPicker();
    await moveToFirstFile();

    fireEvent.click(screen.getByTestId("picker-accept"));
    await act(async () => undefined);

    expect(log.pickerConfirms).toHaveLength(1);
    expect(log.pickerConfirms[0]?.fifo).toBe(FIFO);
    expect(log.pickerConfirms[0]?.paths[0]).toContain("/home/jc/");
  });

  it("sends the directory joined to the typed name in a save dialog", async () => {
    // What the user typed is the answer, not the row under the cursor. A save
    // dialog that returned the highlighted file would overwrite it.
    await openPicker({ saveMode: true, suggestedName: "old.txt" });

    const field = screen.getByTestId("picker-save-name");
    fireEvent.change(field, { target: { value: "new-name.txt" } });
    fireEvent.click(screen.getByTestId("picker-accept"));
    await act(async () => undefined);

    expect(log.pickerConfirms[0]?.paths).toEqual(["/home/jc/new-name.txt"]);
  });

  it("sends nothing when the cursor is on the wrong kind of thing", async () => {
    // A FILE in a directory dialog. `G` puts the cursor on the last entry,
    // which the fixture makes a file.
    await openPicker({ directory: true });
    await moveToFirstFile();

    fireEvent.click(screen.getByTestId("picker-accept"));
    await act(async () => undefined);

    expect(log.pickerConfirms).toEqual([]);
  });

  it("disables the Accept button when confirming would do nothing", async () => {
    // The button and the answer come from ONE function, so they cannot
    // disagree — and this is what pins that they do not.
    await openPicker({ directory: true });
    await moveToFirstFile();

    expect((screen.getByTestId("picker-accept") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("cancelling a picker", () => {
  it("sends the cancel with its fifo when the button is pressed", async () => {
    await openPicker();
    fireEvent.click(screen.getByTestId("picker-cancel"));
    await act(async () => undefined);

    expect(log.pickerCancels).toEqual([FIFO]);
  });

  it("sends the cancel when Escape reaches the dialog", async () => {
    await openPicker();
    fireEvent.keyDown(window, { key: "Escape" });
    await act(async () => undefined);

    expect(log.pickerCancels).toEqual([FIFO]);
  });
});

describe("the keys a dialog takes away", () => {
  it("does not paste in a picker", async () => {
    // The suppression pre-pass has been ported and inert since the registry
    // phase, because `PickerState.active` was hardcoded false. This is the
    // first thing that proves it runs.
    await openPicker();
    fireEvent.keyDown(window, { key: "p" });
    await act(async () => undefined);

    expect(log.transferIds).toEqual([]);
  });

  it("still pastes in the browse window", async () => {
    // The other half, and the one that catches over-suppression: a pre-pass
    // that ran everywhere would break the file manager the operator uses.
    await openBrowser();
    fireEvent.keyDown(window, { key: "y" });
    fireEvent.keyDown(window, { key: "p" });
    await act(async () => undefined);

    // `y` yanks and `p` pastes; with nothing yanked the paste is a no-op, so
    // what is asserted is that the key was DISPATCHED rather than swallowed.
    expect(screen.queryByTestId("status-strip")?.textContent ?? "").not.toContain(
      "is not built yet",
    );
  });

  it("keeps space marking usable in a multi-select dialog", async () => {
    // Space is suppressed in a picker EXCEPT under multi-select, where marking
    // before confirming is the whole point.
    // On a FILE, because a folder marked in a file dialog is deliberately not
    // counted — the button's number is the number of paths pressing it returns.
    await openPicker({ multiple: true });
    await moveToFirstFile();
    fireEvent.keyDown(window, { key: " " });
    await act(async () => undefined);

    expect(screen.getByTestId("picker-accept").textContent).toBe("Select (1)");
  });
});

describe("a mark the dialog will not take", () => {
  it("is not counted on the button", async () => {
    // The fixture opens on a directory, and this is a FILE dialog. Review found
    // the marked branch was the one place an entry's kind was never checked, so
    // a caller asking for files could be handed a folder the user had marked.
    await openPicker({ multiple: true });
    fireEvent.keyDown(window, { key: " " });
    await act(async () => undefined);

    expect(screen.getByTestId("picker-accept").textContent).toBe("Select");
  });
});

describe("Enter inside a dialog", () => {
  /**
   * The defect verification found, and the one with consequences outside this
   * process.
   *
   * Enter fell through to the ordinary "activate" action, which hands a file to
   * the desktop's default application. Driven for real under a virtual display,
   * it launched a terminal running an editor on `/etc/xattr.conf` — on the
   * operator's own session that window would have appeared on their desktop.
   *
   * The Qt build routes Enter through `confirmPickerSelection`, the same
   * function its Accept button uses, for exactly this reason.
   */
  it("confirms rather than handing the file to another application", async () => {
    await openPicker();
    await moveToFirstFile();

    fireEvent.keyDown(window, { key: "Enter" });
    await act(async () => undefined);

    expect(log.pickerConfirms).toHaveLength(1);
    expect(log.ops.filter((each) => each.startsWith("open "))).toEqual([]);
  });

  it("still enters a directory, because that is how you reach a file", async () => {
    // Browsing has to keep working: a dialog that confirmed the directory under
    // the cursor could never be navigated at all.
    await openPicker();
    fireEvent.keyDown(window, { key: "Enter" });
    await act(async () => undefined);

    expect(log.pickerConfirms).toEqual([]);
    expect(log.ops.filter((each) => each.startsWith("open "))).toEqual([]);
  });

  it("does nothing on a file the dialog will not accept", async () => {
    await openPicker({ directory: true });
    await moveToFirstFile();

    fireEvent.keyDown(window, { key: "Enter" });
    await act(async () => undefined);

    expect(log.pickerConfirms).toEqual([]);
    expect(log.ops.filter((each) => each.startsWith("open "))).toEqual([]);
  });

  it("still opens a file in the browse window", async () => {
    // The other half. Suppressing the external open everywhere would break the
    // file manager the operator uses all day.
    await openBrowser();
    await moveToFirstFile();

    fireEvent.keyDown(window, { key: "Enter" });
    await act(async () => undefined);

    expect(log.ops.filter((each) => each.startsWith("open "))).toHaveLength(1);
  });
});
