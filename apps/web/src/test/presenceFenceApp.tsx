import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { expect, vi } from "vite-plus/test";

import { act, fakeTimers, render as renderBrowser } from "../../test/render";
import { AppRoot } from "../AppRoot";
import type { AppRouter } from "../router";
import { installPresencePage, type PresencePageOptions } from "./presenceFenceMocks";

/**
 * Installs fake timers and the fake page of `presenceFenceMocks.ts` before the first render,
 * because the presence report reads the page and starts its timer on mount.
 */
export async function mountPresenceApp(initialPage: PresencePageOptions = {}) {
  await using stack = new AsyncDisposableStack();
  const root = createRootRoute({ component: () => <Outlet /> });
  const home = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <p>Home</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([home]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    disableGlobalCatchBoundary: true,
  });
  await router.load();
  stack.use(installPresencePage(initialPage));
  stack.use(
    fakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
    }),
  );
  const screen = stack.use(
    // AppRoot owns this fixture's memory router.
    await renderBrowser(<AppRoot router={router as unknown as AppRouter} />, { router: false }),
  );
  await advance(0);
  expect(screen.container.textContent).toContain("Home");
  const lifetime = stack.move();
  return { screen, [Symbol.asyncDispose]: () => lifetime.disposeAsync() };
}

/** Moves the fake clock and runs whatever the app scheduled in between. */
export async function advance(ms: number): Promise<void> {
  await act(() => vi.advanceTimersByTimeAsync(ms));
}

/** Runs a page change or an input inside `act`, then lets its effects settle. */
export async function onPage(change: () => void): Promise<void> {
  await act(async () => change());
  await advance(0);
}
