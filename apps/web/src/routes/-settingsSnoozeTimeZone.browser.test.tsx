// Entry point: the real /settings/threads file route under SettingsScopeProvider.
import "../index.css";
import "../mesura.css";

import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { EnvironmentId } from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";

const fixture = vi.hoisted(() => ({
  settings: {} as UnifiedSettings,
  update: vi.fn(),
  listeners: new Set<() => void>(),
  projectGroups: [],
  providers: new Map(),
}));

vi.mock("~/components/settings/useScopedSettings", async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    fixture.listeners.add(listener);
    return () => {
      fixture.listeners.delete(listener);
    };
  };
  return {
    ...(await original<typeof import("~/components/settings/useScopedSettings")>()),
    useScopedSettings: (selector?: (settings: UnifiedSettings) => unknown) => {
      const settings = useSyncExternalStore(subscribe, () => fixture.settings);
      return selector ? selector(settings) : settings;
    },
    useScopedSettingsMixed: () => false,
    useUpdateScopedSettings: () => fixture.update,
    useScopedSettingsWriteAllowed: () => true,
  };
});
vi.mock("~/components/settings/useSettingsProjectGroups", () => ({
  useSettingsProjectGroups: () => fixture.projectGroups,
}));
vi.mock("~/state/environments", async (original) => ({
  ...(await original<typeof import("~/state/environments")>()),
  useEnvironments: () => ({ environments: [connectedEnvironment()], isReady: true }),
  usePrimaryEnvironmentId: () => null,
  usePrimaryEnvironment: () => null,
  useEnvironmentProviders: () => fixture.providers,
}));
vi.mock("~/state/session", async (original) => ({
  ...(await original<typeof import("~/state/session")>()),
  useEnvironmentsWithScope: () => new Set([EnvironmentId.make("snooze-settings-host")]),
  useEnvironmentScope: () => true,
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success", value: undefined }),
}));
vi.mock("~/hooks/useNowMinute", () => ({ useNowMinute: () => "2026-03-07T18:15" }));
vi.mock("~/hooks/useSettings", async (original) => ({
  ...(await original<typeof import("~/hooks/useSettings")>()),
  useClientSettings: (selector?: (settings: UnifiedSettings) => unknown) =>
    selector ? selector(fixture.settings) : fixture.settings,
  useClientSettingsHydrated: () => true,
  usePrimarySettingsAvailable: () => true,
}));

import { SettingsScopeProvider } from "~/components/settings/SettingsScopeContext";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { Route as ThreadsRoute } from "./_chat.settings.threads";

function connectedEnvironment() {
  return {
    environmentId: EnvironmentId.make("snooze-settings-host"),
    label: "Fence host",
    connection: { phase: "connected" },
    serverConfig: {
      settings: fixture.settings,
      providers: [],
      environment: { platform: { machine: "server" }, capabilities: {} },
    },
  } as unknown as ReturnType<
    typeof import("~/state/environments").useEnvironments
  >["environments"][number];
}

function setup() {
  fixture.settings = { ...DEFAULT_UNIFIED_SETTINGS, snoozeTimeZone: null };
  fixture.update.mockReset();
  fixture.listeners.clear();
}

async function mountThreadsSettings() {
  await using stack = new AsyncDisposableStack();
  const root = createRootRoute({ component: Outlet });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/settings",
    component: () => (
      <SettingsScopeProvider
        search={{ machine: "snooze-settings-host" }}
        singleEnvironment
        onChange={() => undefined}
      >
        <Outlet />
      </SettingsScopeProvider>
    ),
  });
  const threads = (ThreadsRoute as unknown as typeof settings).update({
    id: "/threads",
    path: "/threads",
    getParentRoute: () => settings,
  } as never);
  const router = createRouter({
    routeTree: root.addChildren([settings.addChildren([threads])]),
    history: createMemoryHistory({ initialEntries: ["/settings/threads"] }),
    disableGlobalCatchBoundary: true,
  });
  await router.load();
  const screen = stack.use(
    await render(
      <AppAtomRegistryProvider>
        <RouterProvider router={router} />
      </AppAtomRegistryProvider>,
      // The fixture mounts the real Threads file route in its own route tree.
      { router: false },
    ),
  );
  await expect
    .element(screen.getByRole("heading", { name: "Snooze", exact: true }))
    .toBeInTheDocument();
  const lifetime = stack.move();
  return { ...screen, router, [Symbol.asyncDispose]: () => lifetime.disposeAsync() };
}

it("snooze-zone AC5 web spec: Threads Snooze shows Device with the current Intl zone", async () => {
  setup();
  using _zone = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    ...new Intl.DateTimeFormat().resolvedOptions(),
    timeZone: "Asia/Kathmandu",
  });
  await using screen = await mountThreadsSettings();
  await expect
    .element(screen.getByRole("combobox", { name: /time zone/i }))
    .toHaveTextContent("Device (Asia/Kathmandu)");
});

it("snooze-zone AC5 web spec: Threads Snooze saves a named zone and can return to Device", async () => {
  setup();
  using _zone = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    ...new Intl.DateTimeFormat().resolvedOptions(),
    timeZone: "Asia/Kathmandu",
  });
  await using screen = await mountThreadsSettings();
  fixture.update.mockImplementation((patch) => {
    fixture.settings = { ...fixture.settings, ...patch };
    fixture.listeners.forEach((listener) => listener());
  });
  const picker = screen.getByRole("combobox", { name: /time zone/i });
  await userEvent.click(picker);
  await userEvent.click(page.getByRole("option", { name: "America/New_York", exact: true }));
  expect(fixture.update).toHaveBeenCalledWith({ snoozeTimeZone: "America/New_York" });
  await expect.element(picker).toHaveTextContent("America/New_York");
  await userEvent.click(picker);
  await userEvent.click(page.getByRole("option", { name: /^Device/ }));
  expect(fixture.update).toHaveBeenLastCalledWith({ snoozeTimeZone: null });
});

it("snooze-zone guard: Threads settings retain the existing editable snooze presets", async () => {
  setup();
  await using screen = await mountThreadsSettings();
  for (let index = 1; index <= DEFAULT_UNIFIED_SETTINGS.snoozePresets.length; index++) {
    await expect
      .element(screen.getByRole("group", { name: `Snooze option ${index}`, exact: true }))
      .toBeInTheDocument();
  }
  const before = fixture.settings.snoozePresets;
  await userEvent.click(
    screen.getByRole("button", { name: "Remove snooze option 1", exact: true }),
  );
  expect(fixture.update).toHaveBeenCalledWith(
    { snoozePresets: expect.any(Array) },
    expect.any(Object),
  );
  const patch = fixture.update.mock.calls[0]?.[0];
  expect(patch.snoozePresets).toHaveLength(before.length - 1);
  expect(
    patch.snoozePresets.every((preset: unknown) =>
      before.some((original) => JSON.stringify(original) === JSON.stringify(preset)),
    ),
  ).toBe(true);
});
