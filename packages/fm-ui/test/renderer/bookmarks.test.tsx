/**
 * @vitest-environment happy-dom
 *
 * The `g` jumps, driven through the composed application.
 *
 * The operator's own words about this feature: "esa feature sí que es muy
 * importante, la uso muchísimo". What that means for the tests is that the
 * fresh-machine case matters most — `gd` must reach Downloads on a computer
 * with no configuration file at all.
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

/**
 * Render, and wait for the store to arrive.
 *
 * The bookmarks are read over the bridge, so they are not there on the first
 * frame. Without the flush a `gd` pressed immediately finds nothing bound and
 * reports "No bookmark on d" — which is the correct answer to the wrong
 * question, and it would make these tests fail for a reason that has nothing to
 * do with what they are checking.
 */
async function opened(at = "/home/jc"): Promise<void> {
  render(<App startPath={at} />);
  await waitFor(() => expect(namesIn("column-current").length).toBeGreaterThan(0));
  await act(async () => undefined);
}

/** Press the `g` prefix and then a letter, as two separate keys. */
function go(letter: string): void {
  fireEvent.keyDown(window, { key: "g" });
  fireEvent.keyDown(window, { key: letter });
}

describe("jumping to a seeded bookmark", () => {
  it("reaches Downloads on a machine with no configuration file", async () => {
    await opened();

    go("d");

    await waitFor(() => expect(log.listed).toContain("/home/jc/Downloads"));
  });

  it("reaches Pictures and Videos, the two the operator asked for by name", async () => {
    await opened();
    go("p");
    await waitFor(() => expect(log.listed).toContain("/home/jc/Pictures"));

    go("v");
    await waitFor(() => expect(log.listed).toContain("/home/jc/Videos"));
  });

  it("reaches home itself", async () => {
    await opened("/home/jc/projects");
    expect(namesIn("column-current")).toContain("beta.md");

    go("h");

    await waitFor(() => expect(screen.getByTestId("crumb-current").textContent).toBe("jc"));
  });
});

describe("a letter with nothing on it", () => {
  it("says so rather than navigating somewhere", async () => {
    await opened();
    const before = [...log.listed];

    go("q");

    const message = await screen.findByTestId("pane-message");
    expect(message.textContent).toMatch(/no bookmark/i);
    expect(log.listed).toEqual(before);
  });
});

describe("the reserved letters keep their own meanings", () => {
  it("leaves gg as jump-to-top", async () => {
    // `g` is reserved precisely because `gg` already spends it. A bookmark on
    // `g` would be unreachable, so the store must never hold one.
    await opened();
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() =>
      expect(
        screen.getByTestId("column-current").querySelector('[data-cursor="true"]')?.textContent,
      ).toContain("notes.txt"),
    );
    const before = [...log.listed];

    go("g");

    await waitFor(() =>
      expect(
        screen.getByTestId("column-current").querySelector('[data-cursor="true"]')?.textContent,
      ).toContain("projects"),
    );
    expect(log.listed).toEqual(before);
  });

  it("does not treat gn or gx as a jump", async () => {
    await opened();
    const before = [...log.listed];

    go("n");
    expect(log.listed).toEqual(before);

    fireEvent.keyDown(window, { key: "Escape" });
    go("x");
    expect(log.listed).toEqual(before);
  });
});

describe("a bookmark whose directory is gone", () => {
  it("reports the failure", async () => {
    // The fixture has no `/home/jc/Music`, so listing it fails the way a
    // deleted directory would.
    await opened();

    go("m");

    const error = await screen.findByTestId("pane-error");
    expect(error.textContent).toMatch(/Music/);
  });

  it("leaves the pane where it was, rather than parking it on the broken path", async () => {
    // The defect this pins, found by verification and NOT by the first version
    // of this test — which asserted the crumb before the jump and never after,
    // so its name promised more than it checked.
    //
    // Navigation is optimistic: the path moves first and the listing arrives
    // second. Without a way back, a bookmark to a deleted directory left the
    // user standing in it with an empty column and only `h` to escape.
    await opened();
    expect(screen.getByTestId("crumb-current").textContent).toBe("jc");

    go("m");
    await screen.findByTestId("pane-error");

    await waitFor(() => expect(screen.getByTestId("crumb-current").textContent).toBe("jc"));
    expect(namesIn("column-current")).toContain("projects");
  });

  it("keeps the failure on screen after the pane has gone back", async () => {
    // The repair very nearly erased its own message. The failed load reports
    // the error, the revert re-lists the last good path, and that load
    // SUCCEEDS — which used to clear the error one render later, so the user
    // saw a flash and was told nothing about why they did not move.
    //
    // The earlier tests here did not catch it: `findByTestId` retries until the
    // node appears and is satisfied the moment it does, so a message that
    // vanishes immediately afterwards still passes.
    await opened();

    go("m");
    await screen.findByTestId("pane-error");
    await waitFor(() => expect(screen.getByTestId("crumb-current").textContent).toBe("jc"));

    // Back home, listing restored — and still told why.
    expect(namesIn("column-current")).toContain("projects");
    expect(screen.getByTestId("pane-error").textContent).toMatch(/Music/);
  });

  it("does the same for a directory entered by keyboard, not only by bookmark", async () => {
    // Not a bookmark problem. `locked` is in the listing and cannot be read,
    // which is what a directory removed between the scan and the keypress looks
    // like from here.
    await opened();
    fireEvent.keyDown(window, { key: "G", shiftKey: true });
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() =>
      expect(
        screen.getByTestId("column-current").querySelector('[data-cursor="true"]')?.textContent,
      ).toContain("locked"),
    );

    fireEvent.keyDown(window, { key: "l" });
    await screen.findByTestId("pane-error");

    await waitFor(() => expect(screen.getByTestId("crumb-current").textContent).toBe("jc"));
  });
});

describe("jumping to the directory you are already standing in", () => {
  it("leaves the listing alone rather than emptying it", async () => {
    await opened();
    expect(namesIn("column-current")).toContain("notes.txt");
    const before = [...log.listed];

    go("h");

    await act(async () => undefined);
    expect(namesIn("column-current")).toContain("notes.txt");
    // And it costs no disk read either. Surviving the jump would also be true
    // of a version that emptied the column and re-listed it, which flickers.
    expect(log.listed).toEqual(before);
  });
});
