/**
 * @vitest-environment happy-dom
 *
 * A host that shows the interface as a layer closes it on a stray Escape.
 *
 * The standalone window swallows that Escape (`miller.escapeSwallow`) and
 * stays up, so `onDismiss` is optional and absent there. A host passes it,
 * and it must hear only the Escape the cascade had no other use for: one
 * that clears a selection is still the selection's.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../src/App.tsx";
import { installBridge, namesIn } from "./support.ts";

beforeEach(() => {
  installBridge();
});
afterEach(cleanup);

async function mount(onDismiss: () => void) {
  render(<App startPath="/home/jc" homePath="/home/jc" onDismiss={onDismiss} />);
  await waitFor(() => expect(namesIn("column-current").length).toBeGreaterThan(0));
  await act(async () => undefined);
}

describe("a host's dismiss callback", () => {
  it("hears a stray Escape in the columns", async () => {
    const onDismiss = vi.fn();
    await mount(onDismiss);

    fireEvent.keyDown(window, { key: "Escape" });
    await act(async () => undefined);

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does not hear the Escape that clears a selection, only the next one", async () => {
    const onDismiss = vi.fn();
    await mount(onDismiss);

    fireEvent.keyDown(window, { key: " " });
    await act(async () => undefined);
    fireEvent.keyDown(window, { key: "Escape" });
    await act(async () => undefined);
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    await act(async () => undefined);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does not hear the Escape that closes the overview, only the next one", async () => {
    const onDismiss = vi.fn();
    await mount(onDismiss);

    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    await screen.findByTestId("connected-groups");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("connected-groups")).toBeNull());
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    await act(async () => undefined);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
