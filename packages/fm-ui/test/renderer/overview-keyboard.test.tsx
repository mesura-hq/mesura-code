/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { App } from "../../src/App.tsx";
import { cursorIn, installBridge, namesIn } from "./support.ts";

afterEach(cleanup);
async function open() {
  const log = installBridge();
  render(<App startPath="/home/jc" />);
  await waitFor(() => expect(namesIn("column-current")).toContain("projects"));
  fireEvent.keyDown(window, { key: "o", ctrlKey: true });
  await screen.findByTestId("connected-groups");
  return log;
}
it("searches loaded paths without a filesystem rescan", async () => {
  const log = await open();
  const reads = log.listed.length;
  fireEvent.keyDown(window, { key: "/" });
  const input = await screen.findByRole("textbox", { name: "Search loaded paths" });
  fireEvent.change(input, { target: { value: "beta" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByTestId("connected-groups").getAttribute("data-selected")).toBe(
    "/home/jc/projects/beta.md",
  );
  expect(log.listed).toHaveLength(reads);
});
it("reveals selected entries in Miller without external activation", async () => {
  const log = await open();
  fireEvent.keyDown(window, { key: "l" });
  for (let index = 0; index < 3; index++) fireEvent.keyDown(window, { key: "j" });
  fireEvent.keyDown(window, { key: "l" });
  fireEvent.keyDown(window, { key: "j" });
  fireEvent.keyDown(window, { key: "Enter" });
  await waitFor(() => expect(cursorIn("column-current")).toContain("beta.md"));
  expect(screen.queryByRole("dialog", { name: "Folder overview" })).toBeNull();
  expect(log.ops.filter((op) => op.startsWith("open "))).toEqual([]);
});
it("consumes overview movement without moving Miller", async () => {
  await open();
  const cursor = cursorIn("column-current");
  fireEvent.keyDown(window, { key: "l" });
  expect(screen.getByTestId("connected-groups").getAttribute("data-selected")).toBe(
    "/home/jc/empty",
  );
  expect(cursorIn("column-current")).toBe(cursor);
});
it("gives search and help Escape precedence over an open Details popover", async () => {
  await open();
  const details = screen.getByText("Details").closest("details");
  details?.setAttribute("open", "");
  fireEvent.keyDown(document.activeElement ?? window, { key: "/" });
  const input = await screen.findByRole("textbox", { name: "Search loaded paths" });
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(details?.hasAttribute("open")).toBe(true);
  expect(document.activeElement).toBe(screen.getByRole("dialog", { name: "Folder overview" }));
  fireEvent.keyDown(document.activeElement ?? window, { key: "?", shiftKey: true });
  const help = await screen.findByRole("dialog", { name: "Keyboard help" });
  expect(document.activeElement).toBe(help);
  expect(screen.queryByTestId("help-group-Chords")).toBeNull();
  fireEvent.keyDown(help, { key: "Escape" });
  expect(screen.queryByTestId("help-overlay")).toBeNull();
  expect(details?.hasAttribute("open")).toBe(true);
  expect(screen.getByRole("dialog", { name: "Folder overview" })).toBeTruthy();
});
it("ignores composition and navigates confirmed search backwards without dispatching file operations", async () => {
  const log = await open();
  const graph = screen.getByTestId("connected-groups");
  fireEvent.keyDown(window, { key: "l", isComposing: true });
  expect(graph.dataset.selected).toBe("/home/jc");
  fireEvent.keyDown(window, { key: "/", shiftKey: true });
  const input = await screen.findByRole("textbox", { name: "Search loaded paths" });
  fireEvent.change(input, { target: { value: "/home/jc/projects/" } });
  fireEvent.keyDown(input, { key: "d" });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(screen.getByRole("textbox", { name: "Search loaded paths" })).toBe(input);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(graph.dataset.selected).toBe("/home/jc/projects/alpha");
  fireEvent.keyDown(window, { key: "N", shiftKey: true });
  expect(graph.dataset.selected).toBe("/home/jc/projects/beta.md");
  fireEvent.keyDown(window, { key: "N", shiftKey: true });
  expect(graph.dataset.selected).toBe("/home/jc/projects/alpha");
  expect(log.ops).toEqual([]);
});
it("moves hidden descendant selection to a pointer-collapsed folder", async () => {
  await open();
  fireEvent.keyDown(window, { key: "/" });
  const input = await screen.findByRole("textbox", { name: "Search loaded paths" });
  fireEvent.change(input, { target: { value: "beta.md" } });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.click(screen.getByRole("button", { name: "Collapse projects" }));
  expect(screen.getByTestId("connected-groups").dataset.selected).toBe("/home/jc/projects");
  fireEvent.keyDown(window, { key: " " });
  expect(screen.getByRole("button", { name: "Collapse projects" })).toBeTruthy();
});
