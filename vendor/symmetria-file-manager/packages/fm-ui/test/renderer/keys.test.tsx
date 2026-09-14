/**
 * @vitest-environment happy-dom
 *
 * The ported registry, driven through the real window listener.
 *
 * `dispatch.test.ts` proves the table routes correctly against a stub. This
 * proves the application is actually WIRED to it — the same class of gap that
 * left phase 5's components mounted by nothing.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../../src/App.tsx";
import { cursorIn, HOME_LAST_ENTRY, installBridge, namesIn } from "./support.ts";

beforeEach(installBridge);
afterEach(cleanup);

async function openedAtHome(): Promise<void> {
  render(<App startPath="/home/jc" />);
  await waitFor(() => expect(namesIn("column-current")).toContain("projects"));
}

describe("navigation comes from the registry now", () => {
  it("moves with j and with the arrow key the same row declares", async () => {
    await openedAtHome();

    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(cursorIn("column-current")).toContain("notes.txt"));

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() => expect(cursorIn("column-current")).toContain("todo.txt"));
  });

  it("jumps to the bottom with Shift+G", async () => {
    await openedAtHome();

    fireEvent.keyDown(window, { key: "G", shiftKey: true });

    await waitFor(() => expect(cursorIn("column-current")).toContain(HOME_LAST_ENTRY));
  });

  it("jumps to the top with the gg chord, one key at a time", async () => {
    await openedAtHome();
    fireEvent.keyDown(window, { key: "G", shiftKey: true });
    await waitFor(() => expect(cursorIn("column-current")).toContain(HOME_LAST_ENTRY));

    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "g" });

    await waitFor(() => expect(cursorIn("column-current")).toContain("projects"));
  });
});

describe("the which-key overlay", () => {
  it("appears the moment a prefix is pending, and lists what resolves it", async () => {
    await openedAtHome();

    fireEvent.keyDown(window, { key: "c" });

    const hud = await screen.findByTestId("which-key");
    expect(hud.textContent).toContain("copy to clipboard");
    expect(within(hud).getAllByTestId("which-key-row").length).toBeGreaterThan(0);
  });

  it("disappears when the chord resolves, because there is no timeout to wait out", async () => {
    // The documentation claims a 500 ms chord timer twice. There is none, and
    // there never was: a prefix persists until the next key resolves it.
    await openedAtHome();
    fireEvent.keyDown(window, { key: "c" });
    await screen.findByTestId("which-key");

    fireEvent.keyDown(window, { key: "f" });

    await waitFor(() => expect(screen.queryByTestId("which-key")).toBeNull());
  });

  it("disappears on Escape, without acting", async () => {
    await openedAtHome();
    fireEvent.keyDown(window, { key: "g" });
    await screen.findByTestId("which-key");

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(screen.queryByTestId("which-key")).toBeNull());
    expect(screen.queryByTestId("pane-message")).toBeNull();
  });
});

describe("the help overlay", () => {
  it("opens on ? and lists rows read from the registry", async () => {
    // `?` is an ordinary registry row, not a special case, and the sheet reads
    // the same table the dispatcher does.
    await openedAtHome();

    fireEvent.keyDown(window, { key: "?", shiftKey: true });

    const help = await screen.findByTestId("help-overlay");
    expect(within(help).getAllByTestId("help-row").length).toBeGreaterThan(30);
    expect(help.textContent).toContain("Move down");
    expect(help.textContent).toContain("Fuzzy finder");
  });

  it("renders the chord groups as menus rather than as bare prefix rows", async () => {
    await openedAtHome();
    fireEvent.keyDown(window, { key: "?", shiftKey: true });

    const help = await screen.findByTestId("help-overlay");
    expect(within(help).getByTestId("chord-group-,").textContent).toContain("sort by");
  });

  it("closes on Escape, which the modal handles itself", async () => {
    await openedAtHome();
    fireEvent.keyDown(window, { key: "?", shiftKey: true });
    await screen.findByTestId("help-overlay");

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(screen.queryByTestId("help-overlay")).toBeNull());
  });

  it("swallows other keys while it is open", async () => {
    await openedAtHome();
    fireEvent.keyDown(window, { key: "?", shiftKey: true });
    await screen.findByTestId("help-overlay");

    fireEvent.keyDown(window, { key: "j" });

    expect(cursorIn("column-current")).toContain("projects");
  });
});

describe("implemented browsing operations", () => {
  it("opens the tree instead of reporting an unbuilt operation", async () => {
    await openedAtHome();
    fireEvent.keyDown(window, { key: "e", ctrlKey: true });
    expect(await screen.findByRole("tree")).toBeDefined();
    expect(screen.queryByText(/is not built yet/)).toBeNull();
  });

  it("opens the finder for an operation that now exists", async () => {
    // The graduation, asserted rather than merely described above.
    await openedAtHome();

    fireEvent.keyDown(window, { key: "f" });

    expect(await screen.findByTestId("finder")).toBeDefined();
  });

  it("opens the trash dialog for an operation that now exists", async () => {
    await openedAtHome();

    fireEvent.keyDown(window, { key: "d" });

    expect(await screen.findByTestId("modal-delete")).toBeDefined();
  });
});

describe("Ctrl+P, the audio transport", () => {
  it("no longer reports that audio playback is not built", async () => {
    // The binding and its help metadata were ported in the registry phase and
    // have answered "Audio playback is not built yet" ever since. Reaching the
    // row was never in doubt; doing something was.
    await openedAtHome();

    fireEvent.keyDown(window, { key: "p", ctrlKey: true });

    await waitFor(() => {
      const message = screen.queryByTestId("pane-message");
      expect(message?.textContent ?? "").not.toMatch(/not built/i);
    });
  });

  it("leaves Space marking the entry, which is the key it must never become", async () => {
    // Space is the mark key. A transport that took it would break the one
    // binding a file manager uses more than any other, and "play/pause is
    // Space" is the reflex that makes that an easy mistake.
    await openedAtHome();

    fireEvent.keyDown(window, { key: " " });

    await waitFor(() =>
      expect(screen.getAllByTestId("row").some((row) => row.dataset.marked === "true")).toBe(true),
    );
  });
});

describe("the Latin-American layout, through the real listener", () => {
  it("reaches a symbol binding that arrives with Shift held", async () => {
    // On this operator's layout `/` is Shift+7, so the binding declares
    // `mods: "*"`. A `mods: ""` row silently never fires for them, which is how
    // slash-search broke in the Qt build after its own registry migration.
    //
    // This used to prove the binding was reached by watching for the message
    // "Search is not built yet". Search is built now, so the proof moved to
    // what the binding actually does — which is a stronger statement, not a
    // weaker one: the key reaches its row AND the row does its work.
    await openedAtHome();

    fireEvent.keyDown(window, { key: "/", shiftKey: true });

    expect(await screen.findByTestId("search-field")).toBeDefined();
  });
});
