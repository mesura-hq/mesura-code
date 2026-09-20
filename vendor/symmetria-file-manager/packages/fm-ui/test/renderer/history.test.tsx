/**
 * @vitest-environment happy-dom
 *
 * Walking back and forward through where a tab has been.
 *
 * Four bindings reach two actions: `-` and `=` in the Miller view, and Shift+S
 * and Shift+D everywhere. They are one implementation and four keys, so the
 * tests below drive the pair the operator actually uses and assert the other
 * pair reaches the same place.
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

async function opened(at = "/home/jc"): Promise<void> {
  render(<App startPath={at} homePath="/home/jc" />);
  await waitFor(() => expect(namesIn("column-current").length).toBeGreaterThan(0));
  await act(async () => undefined);
}

function press(...keys: string[]): void {
  for (const key of keys) fireEvent.keyDown(window, { key });
}

/** Where the pane is, by the last segment of its path. */
function where(): string {
  return screen.getByTestId("crumb-current").textContent ?? "";
}

async function at(name: string): Promise<void> {
  await waitFor(() => expect(where()).toBe(name));

  // The breadcrumb changes as soon as the PATH does, and navigation here is
  // deliberately optimistic — the path moves first and the listing arrives
  // afterwards, which is what makes `l` feel instant. So the crumb alone is not
  // evidence that the pane has entries yet, and a key pressed on the strength
  // of it acts on an empty listing and does nothing at all.
  //
  // That is not hypothetical: without this flush, `l` `l` from the root reached
  // `/home` and then silently failed to enter `jc`, about one run in six.
  await act(async () => undefined);
}

describe("stepping back", () => {
  it("returns to the directory just left", async () => {
    await opened("/home/jc");
    press("l"); // into `projects`
    await at("projects");

    press("-");

    await at("jc");
  });

  it("keeps going back, one directory per press", async () => {
    // The property the whole phase turns on. If a backward step recorded
    // itself, the second press would return to `projects` and the cursor would
    // oscillate between two directories for ever.
    await opened("/");
    press("l"); // into `home`
    await at("home");
    press("l"); // into `jc`
    await at("jc");

    press("-");
    await at("home");

    press("-");

    await at("/");
  });

  it("does nothing at the start of the trail", async () => {
    await opened("/home/jc");
    const before = where();

    press("-");

    await act(async () => undefined);
    expect(where()).toBe(before);
  });
});

describe("stepping forward", () => {
  it("returns to the directory the step back left", async () => {
    await opened("/home/jc");
    press("l");
    await at("projects");
    press("-");
    await at("jc");

    press("=");

    await at("projects");
  });

  it("does nothing at the end of the trail", async () => {
    await opened("/home/jc");
    const before = where();

    press("=");

    await act(async () => undefined);
    expect(where()).toBe(before);
  });

  it("has nothing to return to once you go somewhere new", async () => {
    // The branch not taken is gone. Forward must never reach somewhere the
    // user did not choose.
    await opened("/home/jc");
    press("l");
    await at("projects");
    press("-");
    await at("jc");

    // Somewhere else entirely, which discards the forward trail.
    press("j");
    press("j");
    press("j");
    press("l"); // into `empty`
    await at("empty");

    press("=");

    await act(async () => undefined);
    expect(where()).toBe("empty");
  });
});

describe("Shift+S and Shift+D reach the same two actions", () => {
  it("steps back and forward like the minus and equals keys", async () => {
    await opened("/home/jc");
    press("l");
    await at("projects");

    fireEvent.keyDown(window, { key: "S", shiftKey: true });
    await at("jc");

    fireEvent.keyDown(window, { key: "D", shiftKey: true });
    await at("projects");
  });
});

describe("each tab keeps its own trail", () => {
  it("does not move another tab when one steps back", async () => {
    await opened("/home/jc");
    press("l"); // tab 1 into `projects`
    await at("projects");

    press("t"); // a second tab, opened on `projects`
    await act(async () => undefined);
    press("h"); // tab 2 up to `jc`
    await at("jc");

    // Back to tab 1, which should still be where it was.
    press("[");
    await at("projects");

    press("-");

    await at("jc");
  });
});

describe("a listing that failed", () => {
  it("leaves no phantom step in the trail", async () => {
    // A failed navigation records itself on the way IN — the pane's path moves
    // optimistically, which is what makes `l` feel instant — and then the pane
    // retreats to where it was. The visit is left behind pointing at the
    // directory the user is already standing in.
    //
    // It is invisible until you press `-`: the first press "succeeds" and moves
    // nowhere, and only the second one reaches the previous directory. One
    // wasted keystroke, with nothing on screen to explain it.
    await opened("/home/jc");
    press("l"); // into `projects`
    await at("projects");
    press("h"); // back out to `jc`
    await at("jc");

    // Onto `locked`, which is listed but cannot be read, and try to enter it.
    press("j");
    press("j");
    press("j");
    press("j");
    press("l");
    await at("jc");

    // ONE press must reach `projects`. Two would mean the failed navigation
    // left a step behind.
    press("-");

    await at("projects");
  });

  it("does not record the retreat it forces", async () => {
    // A failed listing sends the pane back to its last good path on its own.
    // That is a repair, not a place the user went — recording it would put a
    // phantom step in the trail and `=` would offer to return to a directory
    // that could not be read.
    await opened("/home/jc");
    const before = [...log.listed];

    press("j");
    press("j");
    press("j");
    press("j"); // onto `locked`, which is in the listing but cannot be read
    press("l");

    await waitFor(() => expect(log.listed.length).toBeGreaterThan(before.length));
    await act(async () => undefined);
    await at("jc");

    press("=");

    await act(async () => undefined);
    expect(where()).toBe("jc");
  });
});
