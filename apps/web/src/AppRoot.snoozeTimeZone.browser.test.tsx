// Entry point: AppRoot, which owns client-lifetime reporters, with a real RouterProvider.
import { EnvironmentId } from "@t3tools/contracts";
import { createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../test/render";
import type { AppRouter } from "./router";

const fixture = vi.hoisted(() => ({
  environments: [{ environmentId: "snooze-zone-host", connection: { phase: "connected" } }],
  listeners: new Set<() => void>(),
  calls: [] as Array<{ command: unknown; request: unknown }>,
  methods: new Map<unknown, string>(),
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (original) => {
  const runtime = await original<typeof import("@t3tools/client-runtime/state/runtime")>();
  const createEnvironmentRpcCommand: typeof runtime.createEnvironmentRpcCommand = (
    atomRuntime,
    options,
  ) => {
    const command = runtime.createEnvironmentRpcCommand(atomRuntime, options);
    fixture.methods.set(command, options.tag);
    return command;
  };
  return { ...runtime, createEnvironmentRpcCommand };
});
vi.mock("./state/environments", async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original<typeof import("./state/environments")>()),
    useEnvironments: () => ({
      environments: useSyncExternalStore(
        (listener) => {
          fixture.listeners.add(listener);
          return () => {
            fixture.listeners.delete(listener);
          };
        },
        () => fixture.environments,
      ),
      isReady: true,
    }),
  };
});
vi.mock("./state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => async (request: unknown) => {
    fixture.calls.push({ command, request });
    return { _tag: "Success", value: undefined };
  },
}));
vi.mock("./browser/ElectronBrowserHost", () => ({ ElectronBrowserHost: () => null }));
vi.mock("./components/QuitHoldOverlay", () => ({ QuitHoldOverlay: () => null }));
vi.mock("./pushNotifications/PresenceReporter", () => ({ PresenceReporter: () => null }));
vi.mock("./pushNotifications/notificationTarget", () => ({
  openPushTargets: () => () => undefined,
}));

import { AppRoot } from "./AppRoot";

it("snooze-zone AC4 web spec: AppRoot reports Intl zone on connect, zone change, and reconnect", async () => {
  fixture.environments = [
    { environmentId: "snooze-zone-host", connection: { phase: "connected" } },
  ];
  fixture.calls = [];
  const options = new Intl.DateTimeFormat().resolvedOptions();
  using zone = vi
    .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
    .mockReturnValue({ ...options, timeZone: "America/New_York" });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <p>Connected app</p> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  await using _screen = await render(
    <AppRoot router={router as unknown as AppRouter} />,
    // AppRoot supplies the application router.
    { router: false },
  );
  const reports = () =>
    fixture.calls.filter(
      ({ command, request }) =>
        fixture.methods.get(command) === "server.reportClientTimeZone" &&
        typeof request === "object" &&
        request !== null &&
        "input" in request &&
        typeof request.input === "object" &&
        request.input !== null &&
        "timeZone" in request.input,
    );
  await vi.waitFor(() =>
    expect(reports().map(({ request }) => request)).toEqual([
      {
        environmentId: EnvironmentId.make("snooze-zone-host"),
        input: { timeZone: "America/New_York" },
      },
    ]),
  );
  const beforeFocus = reports().length;
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  await vi.waitFor(() => expect(reports()).toHaveLength(beforeFocus + 1));
  const beforeVisible = reports().length;
  using visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(reports()).toHaveLength(beforeVisible);
  visibility.mockReturnValue("visible");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await vi.waitFor(() => expect(reports()).toHaveLength(beforeVisible + 1));
  zone.mockReturnValue({ ...options, timeZone: "Asia/Kathmandu" });
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await vi.waitFor(() =>
    expect(reports().at(-1)?.request).toEqual({
      environmentId: "snooze-zone-host",
      input: { timeZone: "Asia/Kathmandu" },
    }),
  );
  fixture.environments = [
    { environmentId: "snooze-zone-host", connection: { phase: "reconnecting" } },
  ];
  await act(async () => {
    fixture.listeners.forEach((listener) => listener());
  });
  const beforeReconnect = reports().length;
  // The zone can change while disconnected, before any focus or visibility event.
  zone.mockReturnValue({ ...options, timeZone: "Europe/Madrid" });
  fixture.environments = [
    { environmentId: "snooze-zone-host", connection: { phase: "connected" } },
  ];
  await act(async () => {
    fixture.listeners.forEach((listener) => listener());
  });
  await vi.waitFor(() => {
    expect(reports()).toHaveLength(beforeReconnect + 1);
    expect(reports().at(-1)?.request).toEqual({
      environmentId: "snooze-zone-host",
      input: { timeZone: "Europe/Madrid" },
    });
  });
});
