import "../index.css";
import "../mesura.css";

/**
 * Mount the real General Settings file route with the real settings scope and
 * client settings persistence queue. Only the persistence adapter, project
 * groups and environment discovery are fixtures. No server is connected.
 */
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render as renderBrowser } from "../../test/render";

const fixture = vi.hoisted(() => ({
  projectGroups: [] as ReturnType<
    typeof import("~/components/settings/useSettingsProjectGroups").useSettingsProjectGroups
  >,
  storedClientSettings: null as Record<string, unknown> | null,
  saves: vi.fn(),
}));

vi.mock("~/localApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/localApi")>()),
  ensureLocalApi: () => ({
    persistence: {
      getClientSettings: async () => fixture.storedClientSettings,
      setClientSettings: async (settings: Record<string, unknown>) => {
        fixture.saves(settings);
        fixture.storedClientSettings = settings;
      },
    },
  }),
}));
vi.mock("~/components/settings/useSettingsProjectGroups", () => ({
  useSettingsProjectGroups: () => fixture.projectGroups,
}));
vi.mock("~/state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/environments")>()),
  useEnvironments: () => ({ environments: [], isReady: true }),
  usePrimaryEnvironmentId: () => null,
  usePrimaryEnvironment: () => null,
  useEnvironmentProviders: () => new Map(),
}));

import { SettingsScopeProvider } from "~/components/settings/SettingsScopeContext";
import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
} from "~/hooks/useSettings";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";

import { Route as SettingsGeneralRoute } from "./settings.general";

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

const VIM_SWITCH_SELECTOR = '[aria-label="Use Vim mode across the app"]';
const VIM_RESET_SELECTOR = '[aria-label="Reset vim mode to default"]';

async function mountGeneralSettings() {
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
    .element(screen.getByRole("switch", { name: "Use Vim mode across the app" }))
    .toBeInTheDocument();
  const lifetime = stack.move();
  return {
    container: screen.container,
    vimSwitch() {
      const element = screen.container.querySelector<HTMLElement>(VIM_SWITCH_SELECTOR);
      expect(
        element,
        `Expected the Vim mode switch; page: ${screen.container.textContent}`,
      ).not.toBeNull();
      return element!;
    },
    [Symbol.asyncDispose]: () => lifetime.disposeAsync(),
  };
}

function setup() {
  fixture.projectGroups = [];
  fixture.storedClientSettings = null;
  fixture.saves.mockClear();
}

function isSwitchOn(element: HTMLElement): boolean {
  return element.getAttribute("aria-checked") === "true" || element.hasAttribute("data-checked");
}

describe("vim mode settings fence: the default is on", () => {
  it("vim mode settings fence spec: a client that never changed it sees the Vim mode switch on with no reset", async () => {
    setup();
    await using settings = await mountGeneralSettings();

    expect(isSwitchOn(settings.vimSwitch())).toBe(true);
    expect(settings.container.querySelector(VIM_RESET_SELECTOR)).toBeNull();
  });

  it("vim mode settings fence guard: a client that stored Vim mode off sees the switch off", async () => {
    setup();
    fixture.storedClientSettings = { vimMode: false };
    await using settings = await mountGeneralSettings();

    expect(isSwitchOn(settings.vimSwitch())).toBe(false);
  });

  it("vim mode settings persists each switch choice and restores it when settings reopen", async () => {
    setup();
    for (const enabled of [false, true]) {
      {
        await using settings = await mountGeneralSettings();
        expect(isSwitchOn(settings.vimSwitch())).toBe(!enabled);
        await act(async () => settings.vimSwitch().click());
        await vi.waitFor(() => {
          expect(isSwitchOn(settings.vimSwitch())).toBe(enabled);
          expect(fixture.saves).toHaveBeenLastCalledWith(
            expect.objectContaining({ vimMode: enabled }),
          );
          expect(fixture.storedClientSettings?.vimMode).toBe(enabled);
        });
      }

      await using reopened = await mountGeneralSettings();
      expect(isSwitchOn(reopened.vimSwitch())).toBe(enabled);
      expect(reopened.container.querySelector(VIM_RESET_SELECTOR) === null).toBe(enabled);
    }
  });
});
