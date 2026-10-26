/**
 * Entry point: AppRoot, the component `main.tsx` mounts around the app's
 * router, here with a memory router that has the thread route
 * `/$environmentId/$threadId`. The push service worker's `notificationclick`
 * focuses an open window and posts `{ type: "mesura-push-open", url }` to it;
 * each spec dispatches that message on the page's real
 * `navigator.serviceWorker`, the `ServiceWorkerContainer` a worker's
 * `client.postMessage` reaches.
 *
 * Boundaries the fixture replaces, and nothing else: AppRoot's chrome that
 * needs the desktop shell or a live server (`ElectronBrowserHost`,
 * `BrowserProfileReporter`, `QuitHoldOverlay`).
 *
 * Phone push phase 2, criterion 5, the app's half: the focused window
 * navigates to the thread route the notification carries.
 */
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { expect, it, vi } from "vite-plus/test";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { act, render as renderBrowser } from "../test/render";
import type { AppRouter } from "./router";

vi.mock("./browser/ElectronBrowserHost", () => ({ ElectronBrowserHost: () => null }));
vi.mock("./browser/BrowserProfileReporter", () => ({ BrowserProfileReporter: () => null }));
vi.mock("./components/QuitHoldOverlay", () => ({ QuitHoldOverlay: () => null }));
const openSearch = vi.hoisted(() => vi.fn());
vi.mock("./components/searches/agentSearchNotification", async (original) => ({
  ...(await original<typeof import("./components/searches/agentSearchNotification")>()),
  openAgentSearch: openSearch,
}));

const { AppRoot } = await import("./AppRoot");

function createPushOpenRouter(initialPath: string) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const home = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <p>Home</p>,
  });
  const thread = createRoute({
    getParentRoute: () => root,
    path: "/$environmentId/$threadId",
    component: () => <p>Thread route</p>,
  });
  return createRouter({
    routeTree: root.addChildren([home, thread]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    disableGlobalCatchBoundary: true,
  });
}

async function mountApp(initialPath = "/") {
  openSearch.mockClear();
  await using stack = new AsyncDisposableStack();
  const router = createPushOpenRouter(initialPath);
  await router.load();
  const screen = stack.use(
    // AppRoot owns this fixture's memory router.
    await renderBrowser(<AppRoot router={router as unknown as AppRouter} />, { router: false }),
  );
  await expect
    .element(screen.getByText(initialPath === "/" ? "Home" : "Thread route", { exact: true }))
    .toBeInTheDocument();
  const lifetime = stack.move();
  return { router, screen, [Symbol.asyncDispose]: () => lifetime.disposeAsync() };
}

async function postFromWorker(data: unknown) {
  expect(navigator.serviceWorker, "this page needs a ServiceWorkerContainer").toBeDefined();
  await act(async () => {
    navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data }));
  });
}

it("push open spec: a mesura-push-open message from the service worker navigates the app to the thread route", async () => {
  await using app = await mountApp();

  await postFromWorker({ type: "mesura-push-open", url: "/push-env/push-thread" });

  await vi.waitFor(() => expect(app.router.state.location.pathname).toBe("/push-env/push-thread"));
  await expect.element(app.screen.getByText("Thread route", { exact: true })).toBeInTheDocument();
});

it("push open guard: a service worker message of another type leaves the route alone", async () => {
  await using app = await mountApp();

  await postFromWorker({ type: "something-else", url: "/push-env/push-thread" });
  await postFromWorker("not an object");

  expect(app.router.state.location.pathname).toBe("/");
});

// regression: phase 2 review P1-3 — a worker notification for an agent search opened the thread route.
it("push open regression: a mesura-push-open message for an agent search opens the search popup and stays on the route", async () => {
  await using app = await mountApp();

  await postFromWorker({
    type: "mesura-push-open",
    url: "/push-env/push-search?open=agent-search",
  });

  expect(openSearch).toHaveBeenCalledWith(
    scopeThreadRef(EnvironmentId.make("push-env"), ThreadId.make("push-search")),
  );
  expect(app.router.state.location.pathname).toBe("/");
});

it("push open regression: a window opened at an agent search target opens the search popup", async () => {
  await using _app = await mountApp("/push-env/push-search?open=agent-search");

  expect(openSearch).toHaveBeenCalledWith(
    scopeThreadRef(EnvironmentId.make("push-env"), ThreadId.make("push-search")),
  );
});
