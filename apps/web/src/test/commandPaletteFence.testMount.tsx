import { flushBrowserTasks } from "./browserTasks";
import { act, render as renderBrowser } from "../../test/render";
import "../index.css";
import "../mesura.css";
/**
 * Mounts the application entry point for the command palette suites:
 * `AppRoot` with a memory router whose root route renders the real
 * `CommandPalette` around an `Outlet` plus the `ConfirmDialogHost`, the same
 * shell `routes/__root.tsx` builds. The data it renders comes from
 * `commandPaletteFence.testFixtures.ts`, which the suites wire through `vi.mock`.
 *
 * Kept apart from the fixtures on purpose: the mock factories import the
 * fixtures while the application graph is loading, and a fixture module that
 * itself imported `CommandPalette` would deadlock on that circular import.
 */
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  useParams,
} from "@tanstack/react-router";
import { type ReactNode } from "react";

/** A route body with no props, as `createRoute` accepts it. */
type RouteComponent = () => ReactNode;
import { expect, vi } from "vite-plus/test";

import type { AppRouter } from "../router";
import { AppRoot } from "../AppRoot";
import { CommandPalette } from "../components/CommandPalette";
import { ConfirmDialogHost } from "../components/ConfirmDialogHost";

function ThreadRouteProbe() {
  const params = useParams({ strict: false }) as { environmentId?: string; threadId?: string };
  return (
    <div data-testid="thread-route">
      {params.environmentId}/{params.threadId}
    </div>
  );
}

export interface MountedApp {
  readonly container: HTMLDivElement;
  readonly router: ReturnType<typeof createAppRouter>;
  readonly unmount: () => Promise<void>;
}

function DefaultHomeRoute() {
  return <div data-testid="home-route">home</div>;
}

function createAppRouter(HomeRoute: RouteComponent = DefaultHomeRoute) {
  const root = createRootRoute({
    component: () => (
      <>
        <CommandPalette>
          <Outlet />
        </CommandPalette>
        <ConfirmDialogHost />
      </>
    ),
  });
  const index = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: HomeRoute,
  });
  const thread = createRoute({
    getParentRoute: () => root,
    path: "/$environmentId/$threadId",
    component: ThreadRouteProbe,
  });
  return createRouter({
    routeTree: root.addChildren([index, thread]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    disableGlobalCatchBoundary: true,
  });
}

export async function mountApp(
  options: { readonly homeRoute?: RouteComponent } = {},
): Promise<MountedApp> {
  await using resources = new AsyncDisposableStack();
  const container = document.createElement("div");
  document.body.append(container);
  resources.defer(() => {
    container.remove();
    vi.unstubAllGlobals();
  });
  const router = createAppRouter(options.homeRoute);
  await router.load();
  // AppRoot owns this fixture's memory router.
  resources.use(
    await renderBrowser(<AppRoot router={router as unknown as AppRouter} />, {
      container,
      router: false,
    }),
  );
  await vi.waitFor(() => expect(router.state.status).toBe("idle"));
  const mounted = resources.move();
  return {
    container,
    router,
    unmount: async () => {
      await mounted[Symbol.asyncDispose]();
    },
  };
}

/** Lets pending atom writes, effects, and router transitions settle. */
export async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await flushBrowserTasks();
    });
  }
  // Native CSS keeps closing popups mounted until Base UI restores focus and
  // unmounts their session observers. Observe that completion before continuing.
  await vi.waitFor(() =>
    expect(
      document.querySelector(
        '[data-testid="command-palette"][data-closed], [role="alertdialog"][data-closed]',
      ),
    ).toBeNull(),
  );
  await act(async () => {
    await flushBrowserTasks();
  });
}

export async function pressKey(
  target: EventTarget,
  key: string,
  modifiers: { ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean } = {},
  code?: string,
): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", {
    key,
    code: code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key),
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  await act(async () => {
    target.dispatchEvent(event);
  });
  await settle();
  return event;
}

export function openCommandPalette(): Promise<KeyboardEvent> {
  return toggleOverlay("command", "o", { ctrlKey: true });
}

async function toggleOverlay(
  mode: string,
  key: string,
  modifiers: { ctrlKey?: boolean; altKey?: boolean },
): Promise<KeyboardEvent> {
  const closing = paletteMode() === mode;
  const event = await pressKey(window, key, modifiers);
  await vi.waitFor(() => expect(paletteMode()).toBe(closing ? null : mode));
  return event;
}

export function paletteElement(): HTMLElement | null {
  // Base UI keeps an inert popup mounted while its CSS exit finishes.
  return document.querySelector<HTMLElement>('[data-testid="command-palette"][data-open]');
}

export function paletteMode(): string | null {
  return paletteElement()?.getAttribute("data-palette-mode") ?? null;
}

export async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await settle();
}

export function optionRows(): HTMLElement[] {
  return [...(paletteElement()?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
}

function accessibleName(element: Element): string {
  return (element.getAttribute("aria-label") ?? element.textContent ?? "").trim();
}

export function buttonIn(root: ParentNode, name: RegExp): HTMLElement {
  const match = [...root.querySelectorAll<HTMLElement>("button")].find((element) =>
    name.test(accessibleName(element)),
  );
  expect(
    match,
    `Expected a button named ${name}; rendered: ${(root as Element).textContent ?? ""}`,
  ).toBeDefined();
  return match!;
}
