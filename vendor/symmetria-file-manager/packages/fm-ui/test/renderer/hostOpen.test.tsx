/**
 * @vitest-environment happy-dom
 *
 * A host that embeds the interface opens files itself.
 *
 * `onOpenFile` used to reach only the tree view; Enter on a file in the
 * columns still went to the desktop's `open`, so an embedding host's editor
 * never saw it. Every activation — Enter, `l`, a double click — goes through
 * one seam in `useFileOps`, and this is what keeps it that way.
 */
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../src/App.tsx";
import { type BridgeLog, installBridge, namesIn } from "./support.ts";

let log: BridgeLog;

beforeEach(() => {
  log = installBridge();
});
afterEach(cleanup);

describe("a host's open callback", () => {
  it("receives the file activated in the columns, and the desktop's open is never asked", async () => {
    const onOpenFile = vi.fn();
    render(<App startPath="/home/jc" homePath="/home/jc" onOpenFile={onOpenFile} />);
    await waitFor(() => expect(namesIn("column-current").length).toBeGreaterThan(0));
    await act(async () => undefined);

    const index = namesIn("column-current").indexOf("notes.txt");
    expect(index).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < index; i++) fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "Enter" });
    await act(async () => undefined);

    expect(onOpenFile).toHaveBeenCalledWith("/home/jc/notes.txt");
    expect(log.ops.filter((op) => op.startsWith("open "))).toEqual([]);
  });
});
