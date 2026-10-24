import { flushBrowserTasks } from "../test/browserTasks";
import { act, render as renderBrowser, type Screen } from "../../test/render";
/**
 * Entry point: the real `/settings/appearance` file route
 * (`settings.appearance.tsx`), mounted under a `/settings` parent the way
 * `routeTree.gen.ts` mounts it. The page renders the real `VimModeRow` from
 * real client settings: `useSettings` hydrates them from the client
 * persistence, which here holds nothing, as for a client that never changed
 * a setting.
 *
 * The fixture replaces the client persistence (empty), the settings scope,
 * the environment list (none connected) and the terminal font preview, which
 * needs a 2D canvas happy-dom does not have.
 *
 * Phase 4 of the modal keys production cycle, criterion 2: Settings shows the
 * Vim mode switch on, with no reset control, for a client that never changed it.
 */
import { createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";

import { describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  environmentId: "vim-mode-settings-laptop",
  /** What the client persistence returns: null is a client that never saved settings. */
  storedClientSettings: null as Record<string, unknown> | null,
}));

vi.mock("~/localApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/localApi")>()),
  ensureLocalApi: () => ({
    persistence: {
      getClientSettings: async () => fixture.storedClientSettings,
      setClientSettings: async () => undefined,
    },
  }),
}));
vi.mock("~/components/settings/SettingsScopeContext", () => {
  const environment = {
    environmentId: fixture.environmentId,
    label: "Laptop",
    connection: { phase: "connected" },
  };
  const scope = {
    scope: { kind: "environment", environmentId: fixture.environmentId, label: "Laptop" },
    search: {},
    environment,
    environments: [environment],
    target: null,
    connectedEnvironments: [environment],
    targets: [],
  };
  return { useSettingsScope: () => scope, useOptionalSettingsScope: () => scope };
});
vi.mock("~/state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/environments")>()),
  useEnvironments: () => ({ environments: [], isReady: true }),
  usePrimaryEnvironmentId: () => null,
  usePrimaryEnvironment: () => null,
}));

vi.mock("~/components/settings/SettingsFontPreviews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/components/settings/SettingsFontPreviews")>()),
  TerminalFontPreview: () => null,
}));

import { __resetClientSettingsPersistenceForTests } from "~/hooks/useSettings";

import { Route as SettingsAppearanceRoute } from "./settings.appearance";

const { Outlet, RouterProvider } = await import("@tanstack/react-router");
const { AppAtomRegistryProvider } = await import("~/rpc/atomRegistry");

function createSettingsRouter() {
  const root = createRootRoute({ component: () => <Outlet /> });
  const settings = createRoute({ getParentRoute: () => root, path: "/settings" });
  const appearance = (SettingsAppearanceRoute as unknown as typeof settings).update({
    id: "/appearance",
    path: "/appearance",
    getParentRoute: () => settings,
  } as never);
  return createRouter({
    routeTree: root.addChildren([settings.addChildren([appearance])]),
    history: createMemoryHistory({ initialEntries: ["/settings/appearance"] }),
  });
}

let root: Screen | undefined;
let container: HTMLDivElement | undefined;
let router: ReturnType<typeof createSettingsRouter> | undefined;

async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await flushBrowserTasks();
    });
  }
}

/**
 * The router plugin code-splits route components, so the first visit to a
 * page waits on a lazy import; a fixed number of ticks is not enough.
 */
async function settleRouter(): Promise<void> {
  await settle();
  for (let round = 0; round < 100 && router!.state.status !== "idle"; round += 1) {
    await settle();
  }
}

async function mountAppearanceSettings(): Promise<void> {

  __resetClientSettingsPersistenceForTests();
  container = document.createElement("div");
  document.body.append(container);
  router = createSettingsRouter();
  await router.load();
  await act(async () => {
    root = await renderBrowser(null, { container: container!, router: false });
    await root.rerender(
      <AppAtomRegistryProvider>
        <RouterProvider router={router!} />
      </AppAtomRegistryProvider>,
    );
  });
  await settleRouter();
}

async function setupBrowserFixture0() {


return {async [Symbol.asyncDispose]() {

  await act(async () => root?.[Symbol.asyncDispose]());
  root = undefined;
  container?.remove();
  container = undefined;
  fixture.storedClientSettings = null;
  vi.unstubAllGlobals();

}};
}

const VIM_SWITCH_SELECTOR = '[aria-label="Use Vim mode across the app"]';
const VIM_RESET_SELECTOR = '[aria-label="Reset vim mode to default"]';

function vimSwitch(): HTMLElement {
  const element = container!.querySelector<HTMLElement>(VIM_SWITCH_SELECTOR);
  expect(element, `Expected the Vim mode switch; page: ${container!.textContent}`).not.toBeNull();
  return element!;
}

function isSwitchOn(element: HTMLElement): boolean {
  return element.getAttribute("aria-checked") === "true" || element.hasAttribute("data-checked");
}

describe("vim mode settings fence: the default is on", () => {
  it("vim mode settings fence spec: a client that never changed it sees the Vim mode switch on with no reset", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

    await mountAppearanceSettings();
    expect(isSwitchOn(vimSwitch())).toBe(true);
    expect(container!.querySelector(VIM_RESET_SELECTOR)).toBeNull();
  });

  it("vim mode settings fence guard: a client that stored Vim mode off sees the switch off", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

    fixture.storedClientSettings = { vimMode: false };
    await mountAppearanceSettings();
    expect(isSwitchOn(vimSwitch())).toBe(false);
  });
});
