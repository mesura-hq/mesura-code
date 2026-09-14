/**
 * @vitest-environment happy-dom
 *
 * Two jumps that skip over what is in between.
 *
 * Tab crosses the boundary between the directories and the files, which is
 * always a single line because directories sort first in every order. The tilde
 * goes home from wherever you are.
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

async function opened(at: string, home = "/home/jc"): Promise<void> {
  render(<App startPath={at} homePath={home} />);
  await waitFor(() => expect(namesIn("column-current").length).toBeGreaterThan(0));
  await act(async () => undefined);
}

function press(key: string): void {
  fireEvent.keyDown(window, { key });
}

/** The name of the row the cursor is on. */
function cursorName(): string {
  const row = screen.getByTestId("column-current").querySelector('[data-cursor="true"]');
  return row?.textContent ?? "";
}

describe("Tab crosses the directory / file boundary", () => {
  it("jumps from a directory to the first file", async () => {
    // The fixture home opens with the cursor on `projects`, a directory.
    await opened("/home/jc");
    expect(cursorName()).toContain("projects");

    press("Tab");

    await waitFor(() => expect(cursorName()).toContain("notes.txt"));
  });

  it("jumps from a file back to the first directory", async () => {
    await opened("/home/jc");
    press("j");
    await waitFor(() => expect(cursorName()).toContain("notes.txt"));

    press("Tab");

    await waitFor(() => expect(cursorName()).toContain("projects"));
  });

  it("leaves the cursor alone where there is no other kind to jump to", async () => {
    // `/home` holds two directories and nothing else.
    await opened("/home");
    const before = cursorName();

    press("Tab");

    await act(async () => undefined);
    expect(cursorName()).toBe(before);
  });
});

describe("the tilde goes home", () => {
  it("navigates to the home directory", async () => {
    await opened("/home/jc/projects");
    expect(screen.getByTestId("crumb-current").textContent).toBe("projects");

    press("~");

    await waitFor(() => expect(screen.getByTestId("crumb-current").textContent).toBe("jc"));
  });

  it("reaches home from a window that opened somewhere else", async () => {
    // The start path and the home path are two different things, and they
    // coincide only because nothing opens a window elsewhere yet. A window
    // opened on a project directory must still know where home is.
    await opened("/home/jc/projects", "/home/jc");

    press("~");

    await waitFor(() => expect(log.listed).toContain("/home/jc"));
    expect(screen.getByTestId("crumb-current").textContent).toBe("jc");
  });
});
