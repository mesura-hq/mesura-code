import "../index.css";
import "../mesura.css";

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { expect } from "vite-plus/test";

import { SettingsScopeProvider } from "~/components/settings/SettingsScopeContext";
import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
} from "~/hooks/useSettings";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { Route as SettingsGeneralRoute } from "~/routes/_chat.settings.general";

import { render as renderBrowser } from "../../test/render";

/**
 * Mounts the real `/settings/general` file route under a `/settings` parent
 * with the real settings scope, as `-settingsVimMode.fence.browser.test.tsx`
 * does. Settings → Notifications is that page's Behavior section. The test
 * file wires `pushSettingsFenceMocks.ts` before importing this module.
 */
function createSettingsRouter() {
  const root = createRootRoute({ component: () => <Outlet /> });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/settings",
    component: () => (
      <SettingsScopeProvider search={{}} onChange={() => undefined}>
        <Outlet />
      </SettingsScopeProvider>
    ),
  });
  const general = (SettingsGeneralRoute as unknown as typeof settings).update({
    id: "/general",
    path: "/general",
    getParentRoute: () => settings,
  } as never);
  return createRouter({
    routeTree: root.addChildren([settings.addChildren([general])]),
    history: createMemoryHistory({ initialEntries: ["/settings/general"] }),
    disableGlobalCatchBoundary: true,
  });
}

const PUSH_SWITCH_SELECTOR = '[aria-label="Push to this device"]';

export async function mountNotificationSettings() {
  await using stack = new AsyncDisposableStack();
  __resetClientSettingsPersistenceForTests();
  await ensureClientSettingsHydrated();
  const router = createSettingsRouter();
  await router.load();
  const screen = stack.use(
    await renderBrowser(
      <AppAtomRegistryProvider>
        <RouterProvider router={router} />
      </AppAtomRegistryProvider>,
      // This fixture mounts its own file-route tree.
      { router: false },
    ),
  );
  await expect
    .element(screen.getByRole("combobox", { name: "Thread notifications" }))
    .toBeInTheDocument();
  const lifetime = stack.move();
  const pushSwitch = () => {
    const element = screen.container.querySelector<HTMLElement>(PUSH_SWITCH_SELECTOR);
    expect(
      element,
      `Expected a "Push to this device" switch; page: ${screen.container.textContent}`,
    ).not.toBeNull();
    return element!;
  };
  return {
    container: screen.container,
    pushSwitch,
    /** The settings row that holds the switch: its title, status line and buttons. */
    pushRow: () => {
      let row: HTMLElement = pushSwitch();
      while (row.parentElement && !/push to this device/i.test(textOf(row))) {
        row = row.parentElement;
      }
      // Climbing past the row reaches the section, which also holds the neighbouring rows.
      expect(
        textOf(row),
        `Expected a row titled "Push to this device"; reached: ${textOf(row)}`,
      ).not.toContain("In-app notifications");
      return row;
    },
    [Symbol.asyncDispose]: () => lifetime.disposeAsync(),
  };
}

export function textOf(element: HTMLElement): string {
  return element.textContent ?? "";
}

export function isSwitchOn(element: HTMLElement): boolean {
  return element.getAttribute("aria-checked") === "true" || element.hasAttribute("data-checked");
}

export function isSwitchDisabled(element: HTMLElement): boolean {
  return (
    element.hasAttribute("disabled") ||
    element.getAttribute("aria-disabled") === "true" ||
    element.hasAttribute("data-disabled")
  );
}

/** Matches the status line of a switch that cannot push from this client. */
export const UNSUPPORTED_STATUS = /not supported|unsupported|not available/i;
