/**
 * @vitest-environment happy-dom
 *
 * A directory another program asked this window to show.
 *
 * The daemon relays a path over its socket and the interface has to act on it.
 * What is guarded here is the SUBSCRIPTION, because that is where the cost
 * hides: the preload removes and re-adds a native IPC listener on every
 * subscribe, so a handler whose identity changes each render turns one
 * subscription into one per cursor move.
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

async function opened(): Promise<void> {
  render(<App startPath="/home/jc" homePath="/home/jc" />);
  await waitFor(() => expect(namesIn("column-current").length).toBeGreaterThan(0));
  await act(async () => undefined);
}

describe("subscribing to the daemon's open requests", () => {
  it("subscribes once, not once per render", async () => {
    await opened();
    const afterMount = log.openSubscriptions.length;

    // Twenty cursor moves. Each one re-renders the whole component tree, which
    // is exactly the situation that used to re-register the listener: the
    // handler was a fresh arrow every render and the effect depended on it.
    for (let i = 0; i < 20; i++) fireEvent.keyDown(window, { key: "j" });
    await act(async () => undefined);

    expect(afterMount).toBe(1);
    expect(log.openSubscriptions).toHaveLength(1);
  });

  it("still routes a path that arrives after those renders", async () => {
    // The other half. Subscribing once is only correct if the ONE subscription
    // still calls the current handler — a stale closure would satisfy the count
    // above while quietly acting on a tab collection that no longer exists.
    await opened();
    for (let i = 0; i < 5; i++) fireEvent.keyDown(window, { key: "j" });
    await act(async () => undefined);

    await act(async () => {
      log.emitOpenPath("/home/jc/work");
    });

    await waitFor(() => expect(screen.getAllByTestId("tab")).toHaveLength(2));
    expect(log.listed).toContain("/home/jc/work");
  });
});
