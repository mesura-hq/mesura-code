/** @vitest-environment happy-dom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../../src/App.tsx";
import { installBridge } from "./support.ts";

afterEach(cleanup);
function installedBridge() {
  const bridge = window.symmetriaFm;
  if (!bridge) throw new Error("Missing fixture bridge");
  return bridge;
}
async function open() {
  const log = installBridge();
  const reads = vi.spyOn(installedBridge(), "overview");
  render(<App startPath="/home/jc" />);
  fireEvent.keyDown(window, { key: "o", ctrlKey: true });
  await screen.findByText("beta.md");
  await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
  return { log, reads };
}
it("refreshes only a changed loaded branch and releases overview watches on close", async () => {
  const { log, reads } = await open();
  const watch = log.watched.find(
    (id) => id.startsWith("overview:") && id.endsWith(":/home/jc/projects"),
  );
  reads.mockClear();
  log.addEntry("/home/jc/projects", "fresh.txt");
  if (!watch) throw new Error("Missing projects overview watch");
  act(() => log.emitChange(watch));
  // The hidden Miller preview can show this name before the debounced overview read.
  // Observe the overview itself so the watch assertion cannot race that preview.
  await within(screen.getByRole("dialog", { name: "Folder overview" })).findByText("fresh.txt");
  expect(reads.mock.calls).toEqual([[expect.objectContaining({ path: "/home/jc/projects" })]]);
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() =>
    expect(log.unwatched).toEqual(
      expect.arrayContaining(log.watched.filter((id) => id.startsWith("overview:"))),
    ),
  );
});
it("paints cached rows before a deferred revalidation completes", async () => {
  await open();
  fireEvent.keyDown(window, { key: "Escape" });
  Object.assign(installedBridge(), { overview: () => new Promise(() => undefined) });
  fireEvent.keyDown(window, { key: "o", ctrlKey: true });
  expect(screen.getByText("beta.md")).toBeTruthy();
  expect(screen.getByText(/Refreshing/)).toBeTruthy();
});
it("shows failed watch coverage and an explicit refresh action", async () => {
  installBridge();
  Object.assign(installedBridge(), {
    watch: async () => ({
      ok: false,
      error: { code: "watch_failed", message: "watch unavailable" },
    }),
  });
  render(<App startPath="/home/jc" />);
  fireEvent.keyDown(window, { key: "o", ctrlKey: true });
  await screen.findByText(/Live updates unavailable/);
  expect(screen.getByRole("button", { name: "Refresh overview" })).toBeTruthy();
});
it("moves a deleted selection to the nearest surviving parent", async () => {
  const { log, reads } = await open();
  fireEvent.keyDown(window, { key: "/" });
  const input = screen.getByRole("textbox", { name: "Search loaded paths" });
  fireEvent.change(input, { target: { value: "beta.md" } });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.keyDown(input, { key: "Escape" });
  reads.mockResolvedValue({ ok: true, value: { entries: [], inspected: 0, truncated: false } });
  const watch = log.watched.find(
    (id) => id.startsWith("overview:") && id.endsWith(":/home/jc/projects"),
  );
  if (!watch) throw new Error("Missing projects overview watch");
  act(() => log.emitChange(watch));
  await waitFor(() =>
    expect(screen.getByTestId("connected-groups").dataset.selected).toBe("/home/jc/projects"),
  );
});
it("restores the cached camera before revalidation returns", async () => {
  await open();
  const viewport = screen.getByTestId("connected-groups");
  viewport.scrollLeft = 140;
  viewport.scrollTop = 90;
  fireEvent.scroll(viewport);
  fireEvent.keyDown(window, { key: "Escape" });
  Object.assign(window.symmetriaFm ?? {}, { overview: () => new Promise(() => undefined) });
  fireEvent.keyDown(window, { key: "o", ctrlKey: true });
  const restored = screen.getByTestId("connected-groups");
  expect(restored.scrollLeft).toBe(140);
  expect(restored.scrollTop).toBe(90);
});
it("Refresh retries an unreadable cached branch after permissions recover", async () => {
  const log = installBridge();
  const bridge = window.symmetriaFm;
  if (!bridge) throw new Error("Missing fixture bridge");
  const original = bridge.overview;
  const read = vi.spyOn(bridge, "overview").mockResolvedValue({
    ok: false,
    error: { code: "scan_failed", message: "EACCES" },
  });
  render(<App startPath="/home/jc" />);
  fireEvent.keyDown(window, { key: "o", ctrlKey: true });
  await screen.findByText("Unreadable: EACCES");
  read.mockImplementation(original);
  fireEvent.click(screen.getByRole("button", { name: "Refresh snapshot", hidden: true }));
  await screen.findByText("beta.md");
  fireEvent.keyDown(window, { key: "Escape" });
  read.mockResolvedValue({ ok: false, error: { code: "scan_failed", message: "EACCES" } });
  fireEvent.keyDown(window, { key: "o", ctrlKey: true });
  await waitFor(() => expect(screen.getAllByText("Unreadable: EACCES").length).toBeGreaterThan(1));
  read.mockImplementation(original);
  log.addEntry("/home/jc/projects", "recovered.txt");
  fireEvent.click(screen.getByRole("button", { name: "Refresh snapshot", hidden: true }));
  await screen.findByText("recovered.txt");
  await waitFor(() => expect(screen.queryByText("Unreadable: EACCES")).toBeNull());
  expect(log.watched.filter((id) => id.endsWith(":/home/jc/projects")).length).toBeGreaterThan(1);
});
