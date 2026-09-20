/** @vitest-environment happy-dom */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { openTree, treeKey } from "./tree-support.ts";

afterEach(cleanup);

function activateTab(index: number) {
  const tab = screen.getAllByTestId("tab")[index];
  if (!tab) throw new Error(`Missing tab ${index}`);
  fireEvent.click(within(tab).getByRole("button", { name: "jc" }));
}

it("discards Miller flash across same-directory tree tab switches", async () => {
  await openTree();
  treeKey("t");
  treeKey("s");
  expect(screen.getByTestId("status-flash")).toBeTruthy();
  activateTab(0);
  await screen.findByRole("tree");
  activateTab(1);
  await waitFor(() => expect(screen.queryByTestId("status-flash")).toBeNull());
});

it("closes the finder when an external open selects a tree tab", async () => {
  const log = await openTree();
  treeKey("t");
  treeKey("f");
  await screen.findByTestId("finder");
  act(() => log.emitOpenPath("/home/jc"));
  await waitFor(() => expect(screen.queryByTestId("finder")).toBeNull());
  expect(screen.queryByRole("tree")).toBeNull();
});
