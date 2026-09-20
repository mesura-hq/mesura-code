/**
 * @vitest-environment happy-dom
 *
 * The file operations, driven from the keys that invoke them.
 *
 * `ops.test.ts` proves the mutations against a real filesystem. This proves the
 * application reaches them: which entries an operation acts on, which dialog
 * gates it, and what the clipboard does afterwards.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../../src/App.tsx";
import { type BridgeLog, cursorIn, installBridge, namesIn } from "./support.ts";

let log: BridgeLog;

beforeEach(() => {
  log = installBridge();
});
afterEach(cleanup);

async function opened(): Promise<void> {
  render(<App startPath="/home/jc" />);
  await waitFor(() => expect(namesIn("column-current")).toContain("projects"));
}

/** Move the cursor onto `notes.txt`, the first plain file. */
async function onNotes(): Promise<void> {
  fireEvent.keyDown(window, { key: "j" });
  await waitFor(() => expect(cursorIn("column-current")).toContain("notes.txt"));
}

describe("what an operation acts on", () => {
  it("uses the entry under the cursor when nothing is marked", async () => {
    await opened();
    await onNotes();

    fireEvent.keyDown(window, { key: "y" });

    await waitFor(() => expect(screen.getByTestId("pane-message").textContent).toContain("yanked"));
  });

  it("prefers the marked entries over the cursor", async () => {
    // The precedence that makes marking worth doing, and the rule the Qt build
    // used for every clipboard and delete operation.
    await opened();
    await onNotes();
    fireEvent.keyDown(window, { key: " " });
    fireEvent.keyDown(window, { key: " " });
    await waitFor(() =>
      expect(screen.getByTestId("status-bar").textContent).toContain("2 selected"),
    );

    fireEvent.keyDown(window, { key: "y" });
    fireEvent.keyDown(window, { key: "p" });

    await waitFor(() =>
      expect(log.ops.some((op) => op.startsWith("copy /home/jc/notes.txt,/home/jc/todo.txt"))).toBe(
        true,
      ),
    );
  });
});

describe("the clipboard", () => {
  it("copies with y and pastes into the current directory", async () => {
    await opened();
    await onNotes();

    fireEvent.keyDown(window, { key: "y" });
    fireEvent.keyDown(window, { key: "p" });

    await waitFor(() => expect(log.ops).toContain("copy /home/jc/notes.txt -> /home/jc"));
  });

  it("keeps a yank so it can be pasted into several directories", async () => {
    await opened();
    await onNotes();
    fireEvent.keyDown(window, { key: "y" });
    fireEvent.keyDown(window, { key: "p" });
    await waitFor(() => expect(log.ops).toHaveLength(1));

    fireEvent.keyDown(window, { key: "p" });

    await waitFor(() => expect(log.ops).toHaveLength(2));
  });

  it("consumes a cut once it has been pasted", async () => {
    await opened();
    await onNotes();
    fireEvent.keyDown(window, { key: "x" });
    fireEvent.keyDown(window, { key: "p" });
    await waitFor(() => expect(log.ops).toContain("move /home/jc/notes.txt -> /home/jc"));

    fireEvent.keyDown(window, { key: "p" });

    await waitFor(() =>
      expect(screen.getByTestId("pane-message").textContent).toBe("nothing to paste"),
    );
    expect(log.ops).toHaveLength(1);
  });

  it("says so when there is nothing to paste", async () => {
    await opened();

    fireEvent.keyDown(window, { key: "p" });

    await waitFor(() =>
      expect(screen.getByTestId("pane-message").textContent).toBe("nothing to paste"),
    );
  });
});

describe("conflicts", () => {
  it("prompts rather than overwriting, and names what is in the way", async () => {
    // A paste that silently overwrote was the sharpest edge the Qt build had.
    await opened();
    await onNotes();
    log.conflictNext(["notes.txt"]);

    fireEvent.keyDown(window, { key: "y" });
    fireEvent.keyDown(window, { key: "p" });

    const dialog = await screen.findByTestId("modal-conflict");
    expect(within(dialog).getByTestId("conflict-list").textContent).toContain("notes.txt");
  });

  it("retries with overwrite once the operator confirms", async () => {
    await opened();
    await onNotes();
    log.conflictNext(["notes.txt"]);
    fireEvent.keyDown(window, { key: "y" });
    fireEvent.keyDown(window, { key: "p" });
    const dialog = await screen.findByTestId("modal-conflict");

    fireEvent.click(within(dialog).getByTestId("dialog-confirm"));

    await waitFor(() => expect(log.ops.at(-1)).toBe("copy /home/jc/notes.txt -> /home/jc !"));
  });

  it("transfers nothing when the operator cancels", async () => {
    await opened();
    await onNotes();
    log.conflictNext(["notes.txt"]);
    fireEvent.keyDown(window, { key: "y" });
    fireEvent.keyDown(window, { key: "p" });
    await screen.findByTestId("modal-conflict");

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(screen.queryByTestId("modal-conflict")).toBeNull());
    expect(log.ops.filter((op) => op.endsWith("!"))).toEqual([]);
  });
});

describe("trash", () => {
  it("asks before trashing, and says it is recoverable", async () => {
    await opened();
    await onNotes();

    fireEvent.keyDown(window, { key: "d" });

    const dialog = await screen.findByTestId("modal-delete");
    expect(within(dialog).getByTestId("delete-list").textContent).toContain("notes.txt");
    expect(dialog.textContent).toMatch(/recoverable/i);
    expect(log.ops).toEqual([]);
  });

  it("trashes on confirmation", async () => {
    await opened();
    await onNotes();
    fireEvent.keyDown(window, { key: "d" });
    const dialog = await screen.findByTestId("modal-delete");

    fireEvent.click(within(dialog).getByTestId("dialog-confirm"));

    await waitFor(() => expect(log.ops).toContain("trash /home/jc/notes.txt"));
  });
});

describe("rename", () => {
  it("opens with the stem selected, not the extension", async () => {
    // The extension is almost never what changes, and skipping past it every
    // time is the friction `⇧R` exists to opt out of.
    await opened();
    await onNotes();

    fireEvent.keyDown(window, { key: "r" });

    const field = await screen.findByTestId("dialog-name");
    expect((field as HTMLInputElement).value).toBe("notes.txt");
    expect((field as HTMLInputElement).selectionEnd).toBe("notes".length);
  });

  it("selects the whole name for the with-extension rename", async () => {
    await opened();
    await onNotes();

    fireEvent.keyDown(window, { key: "R", shiftKey: true });

    const field = await screen.findByTestId("dialog-name");
    expect((field as HTMLInputElement).selectionEnd).toBe("notes.txt".length);
  });

  it("renames on Enter", async () => {
    await opened();
    await onNotes();
    fireEvent.keyDown(window, { key: "r" });
    const field = await screen.findByTestId("dialog-name");

    fireEvent.change(field, { target: { value: "renamed.txt" } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => expect(log.ops).toContain("rename /home/jc/notes.txt -> renamed.txt"));
  });

  it("reports a name that is already taken, and stays open", async () => {
    await opened();
    await onNotes();
    fireEvent.keyDown(window, { key: "r" });
    const field = await screen.findByTestId("dialog-name");

    fireEvent.change(field, { target: { value: "taken.txt" } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() =>
      expect(screen.getByTestId("pane-message").textContent).toContain("already exists"),
    );
    expect(screen.getByTestId("modal-rename")).toBeDefined();
  });
});

describe("create", () => {
  it("creates a file from a typed name", async () => {
    await opened();

    fireEvent.keyDown(window, { key: "a" });
    const field = await screen.findByTestId("dialog-name");
    fireEvent.change(field, { target: { value: "notes/2026/august.md" } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => expect(log.ops).toContain("create file /home/jc/notes/2026/august.md"));
  });

  it("reads a trailing separator as a folder", async () => {
    await opened();

    fireEvent.keyDown(window, { key: "a" });
    const field = await screen.findByTestId("dialog-name");
    fireEvent.change(field, { target: { value: "archive/" } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => expect(log.ops).toContain("create directory /home/jc/archive"));
  });
});

describe("opening", () => {
  it("enters a directory rather than handing it to the desktop", async () => {
    await opened();

    fireEvent.keyDown(window, { key: "Enter" });

    await waitFor(() => expect(namesIn("column-current")).toContain("beta.md"));
    expect(log.ops.filter((op) => op.startsWith("open"))).toEqual([]);
  });

  it("hands a file to whatever the desktop says opens it", async () => {
    await opened();
    await onNotes();

    fireEvent.keyDown(window, { key: "Enter" });

    await waitFor(() => expect(log.ops).toContain("open /home/jc/notes.txt"));
  });
});

describe("the modal gate", () => {
  it("stops the keyboard reaching the pane while a dialog is open", async () => {
    await opened();
    await onNotes();
    fireEvent.keyDown(window, { key: "d" });
    await screen.findByTestId("modal-delete");

    fireEvent.keyDown(window, { key: "j" });

    expect(cursorIn("column-current")).toContain("notes.txt");
  });

  it("lets only one dialog be open at a time", async () => {
    await opened();
    await onNotes();
    fireEvent.keyDown(window, { key: "d" });
    await screen.findByTestId("modal-delete");

    // `a` would open the create dialog if the gate were not there.
    fireEvent.keyDown(window, { key: "a" });

    expect(screen.queryByTestId("modal-create")).toBeNull();
    expect(screen.getByTestId("modal-delete")).toBeDefined();
  });
});

describe("a running transfer", () => {
  it("can be cancelled from where its progress is shown", async () => {
    // Verification found the whole cancellation path built and unreachable: an
    // `AbortController` per transfer, checked between entries, its own IPC
    // channel — and nothing in the interface ever calling it. Machinery with no
    // way in is machinery that does not exist.
    await opened();
    await onNotes();
    log.holdNextTransfer();

    fireEvent.keyDown(window, { key: "y" });
    fireEvent.keyDown(window, { key: "p" });

    const progress = await screen.findByTestId("transfer-progress");
    fireEvent.click(within(progress).getByTestId("cancel-transfer"));

    await waitFor(() => expect(log.ops).toContain(`cancel ${log.transferIds.at(-1)}`));
  });

  it("shows how far it has got, from the channel that pushes it", async () => {
    await opened();
    await onNotes();
    log.holdNextTransfer();
    fireEvent.keyDown(window, { key: "y" });
    fireEvent.keyDown(window, { key: "p" });
    await screen.findByTestId("transfer-progress");

    log.emitProgress(log.transferIds.at(-1) ?? "", 3, 7);

    await waitFor(() =>
      expect(screen.getByTestId("transfer-progress").textContent).toContain("3 of 7"),
    );
  });
});
