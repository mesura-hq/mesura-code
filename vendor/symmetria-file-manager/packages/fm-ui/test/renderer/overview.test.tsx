/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../../src/App.tsx";
import { cursorIn, installBridge, namesIn } from "./support.ts";

afterEach(cleanup);
async function open() {
  installBridge();
  render(<App startPath="/home/jc" />);
  await waitFor(() => expect(namesIn("column-current")).toContain("projects"));
  fireEvent.keyDown(window, { key: "o", ctrlKey: true });
  return screen.findByRole("dialog", { name: "Folder overview" });
}
it("opens the current Miller directory with Ctrl+O", async () => {
  const panel = await open();
  expect(panel.getAttribute("data-root")).toBe("/home/jc");
});
it("restores the same Miller cursor and mounted column on Escape", async () => {
  await open();
  const column = screen.getByTestId("column-current");
  const cursor = cursorIn("column-current");
  fireEvent.keyDown(window, { key: "j" });
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Folder overview" })).toBeNull());
  expect(screen.getByTestId("column-current")).toBe(column);
  expect(cursorIn("column-current")).toBe(cursor);
});
it("labels a truncated directory as a partial subset", async () => {
  installBridge();
  Object.assign(window.symmetriaFm ?? {}, {
    overview: vi.fn(async () => ({
      ok: true,
      value: { entries: [], inspected: 1000, truncated: true },
    })),
  });
  render(<App startPath="/home/jc" />);
  fireEvent.keyDown(window, { key: "o", ctrlKey: true });
  expect(await screen.findByText(/partial sorted subset/i)).toBeTruthy();
});
it("cancels only overview request IDs on close", async () => {
  installBridge();
  const cancel = vi.fn(async () => ({ ok: true, value: null }));
  Object.assign(window.symmetriaFm ?? {}, {
    cancel,
    overview: vi.fn(() => new Promise(() => undefined)),
  });
  render(<App startPath="/home/jc" />);
  fireEvent.keyDown(window, { key: "o", ctrlKey: true });
  await screen.findByRole("dialog", { name: "Folder overview" });
  fireEvent.keyDown(window, { key: "Escape" });
  expect(cancel).toHaveBeenCalledWith({ streamId: expect.stringMatching(/^overview:/) });
  expect(cancel).not.toHaveBeenCalledWith({ streamId: "all" });
});
it("does not offer or activate the overview in a picker", async () => {
  installBridge();
  render(
    <App
      startPath="/home/jc"
      picker={{
        fifo: "/tmp/picker",
        options: {
          title: "Choose",
          acceptLabel: "",
          directory: false,
          multiple: false,
          saveMode: false,
          suggestedName: "",
          currentFolder: "",
        },
      }}
    />,
  );
  fireEvent.keyDown(window, { key: "o", ctrlKey: true });
  expect(screen.queryByRole("dialog", { name: "Folder overview" })).toBeNull();
  // The normal browse entry point must exist, so an absent feature cannot pass this spec.
  cleanup();
  await open();
});
