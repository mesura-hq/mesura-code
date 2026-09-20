/**
 * @vitest-environment happy-dom
 *
 * The copy chord, from the keyboard to the request that leaves the renderer.
 *
 * What is proved here is the REQUEST. The clipboard belongs to the main
 * process — the renderer is sandboxed and may neither read a file nor reach the
 * platform — so the renderer's whole job is to decide what to send. The text
 * itself is derived by a pure function with its own tests, and the writing is
 * exercised against a real Electron by verification.
 */
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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

/** The most recent clipboard request, as the fixture recorded it. */
function lastCopy(): string | undefined {
  return [...log.ops].reverse().find((op) => op.startsWith("clipboard "));
}

describe("the four text destinations", () => {
  it("copies the whole path with c", async () => {
    await opened();

    press("c", "c");

    await waitFor(() => expect(lastCopy()).toBe("clipboard text /home/jc/projects"));
  });

  it("copies the filename with f", async () => {
    await opened();
    press("j"); // onto `notes.txt`

    press("c", "f");

    await waitFor(() => expect(lastCopy()).toBe("clipboard text notes.txt"));
  });

  it("copies the name without its extension with n", async () => {
    await opened();
    press("j");

    press("c", "n");

    await waitFor(() => expect(lastCopy()).toBe("clipboard text notes"));
  });

  it("copies the directory with d", async () => {
    await opened();

    press("c", "d");

    await waitFor(() => expect(lastCopy()).toBe("clipboard text /home/jc"));
  });
});

describe("a marked set", () => {
  it("copies every marked path, one per line", async () => {
    // Marking is what makes the chord worth pressing on more than one entry,
    // and the precedence — marked over cursor — is the rule every other file
    // operation already follows.
    await opened();
    press(" "); // mark `projects`, cursor moves on
    press(" "); // mark `notes.txt`

    press("c", "c");

    await waitFor(() =>
      expect(lastCopy()).toBe("clipboard text /home/jc/projects\n/home/jc/notes.txt"),
    );
  });
});

describe("at the root of the filesystem", () => {
  it("does not double the leading slash", async () => {
    // `/` is the one directory whose path already ends in a separator, so the
    // obvious `${path}/${name}` yields `//home`. `joinPath` knows that and the
    // template literal does not, and both were in use one file apart — review
    // found the split, and the root is the only place it shows.
    //
    // It is reachable: `~` goes home, and `h` from home reaches `/`.
    await opened("/");

    press("c", "c");

    await waitFor(() => expect(lastCopy()).toBe("clipboard text /home"));
  });

  it("copies the root itself as the directory", async () => {
    await opened("/");

    press("c", "d");

    await waitFor(() => expect(lastCopy()).toBe("clipboard text /"));
  });
});

describe("an image", () => {
  it("sends the image itself rather than its path", async () => {
    // `i` appears in the menu only over an image, and it sends a path for the
    // MAIN process to read — the renderer is sandboxed and cannot read a file.
    await opened("/home/jc/pictures");

    // Whether the cursor is on an image is the PREVIEW's answer, and the
    // preview is debounced by 150 ms so a fast j/k does not describe every row
    // it passes over. Pressing before it has answered is not a test of the
    // chord; it is a test of the debounce.
    await waitFor(() => expect(log.described).toContain("/home/jc/pictures/shot.png"));
    await act(async () => undefined);

    press("c", "i");

    await waitFor(() => expect(lastCopy()).toBe("clipboard image /home/jc/pictures/shot.png"));
  });

  it("says so rather than copying nothing when the cursor is not an image", async () => {
    await opened();
    press("j"); // onto `notes.txt`

    press("c", "i");

    await waitFor(() => expect(document.body.textContent).toMatch(/not an image/i));
    expect(lastCopy()).toBeUndefined();
  });
});
