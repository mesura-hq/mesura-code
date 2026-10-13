// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { closeHostsSheet, hostsSheetOpenAtom, requestHostsSheet } from "../../state/hostsSurface";
import { installWorkloadViewport } from "../../state/workloads.testkit";
import { HostsSheet } from "./HostsSheet";

let root: Root;
let container: HTMLDivElement;
let viewport: ReturnType<typeof installWorkloadViewport>;
let router: ReturnType<typeof createRouter>;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  closeHostsSheet();
  viewport = installWorkloadViewport(true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <button data-slot="sidebar-trigger">Sidebar</button>
        <HostsSheet />
        <Outlet />
      </>
    ),
  });
  const index = createRoute({ getParentRoute: () => rootRoute, path: "/" });
  const settings = createRoute({ getParentRoute: () => rootRoute, path: "/settings" });
  router = createRouter({
    routeTree: rootRoute.addChildren([index, settings]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <RouterProvider router={router} />
      </RegistryContext.Provider>,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  closeHostsSheet();
  viewport.restore();
  container.remove();
  vi.unstubAllGlobals();
});
async function open() {
  await act(async () => requestHostsSheet());
  expect(appAtomRegistry.get(hostsSheetOpenAtom)).toBe(true);
  expect(document.querySelector("[data-hosts-panel]")).not.toBeNull();
}
function noLivePanel() {
  expect(appAtomRegistry.get(hostsSheetOpenAtom)).toBe(false);
  expect(document.querySelector("[data-hosts-panel]")).toBeNull();
}

describe("phone Hosts sheet lifecycle", () => {
  it.each(["button", "escape", "outside"] as const)(
    "closes by %s and immediately unmounts live content",
    async (path) => {
      await open();
      await act(async () => {
        if (path === "button")
          document
            .querySelector<HTMLButtonElement>(
              '[data-slot="sheet-popup"] button[aria-label="Close"]',
            )!
            .click();
        else if (path === "escape")
          document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
          );
        else {
          const backdrop = document.querySelector('[data-slot="sheet-backdrop"]')!;
          backdrop.dispatchEvent(
            new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", button: 0 }),
          );
          backdrop.dispatchEvent(
            new PointerEvent("pointerup", { bubbles: true, pointerType: "touch", button: 0 }),
          );
          backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
          backdrop.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
          backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
        }
      });
      noLivePanel();
    },
  );
  it("closes on navigation, can reopen on a utility page, and drops the request when the viewport grows", async () => {
    await open();
    await act(async () => router.navigate({ to: "/settings" }));
    noLivePanel();
    await open();
    await act(async () => viewport.setMobile(false));
    noLivePanel();
    await act(async () => requestHostsSheet());
    expect(document.querySelector("[data-hosts-panel]")).toBeNull();
    await act(async () => viewport.setMobile(true));
    expect(document.querySelector("[data-hosts-panel]")).toBeNull();
  });
  it("clears a pending request on unmount", async () => {
    await open();
    await act(async () => root.render(null));
    noLivePanel();
  });
});
