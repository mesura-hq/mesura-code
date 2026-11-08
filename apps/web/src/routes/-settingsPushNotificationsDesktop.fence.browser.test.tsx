/**
 * The desktop shell is `window.desktopBridge`, set before any app module loads because
 * `env.ts` reads it once at load. The bridge carries only what the settings page reads
 * while mounting.
 */
import { expect, it, vi } from "vite-plus/test";

import { act } from "../../test/render";
import {
  installPushBrowser,
  pushRpcCalls,
  pushSettingsFence as browser,
} from "../test/pushSettingsFenceMocks";

vi.hoisted(() => {
  Object.defineProperty(window, "desktopBridge", {
    value: { getLocalEnvironmentBootstraps: () => [] },
    configurable: true,
    writable: true,
  });
});

const fenceMocks = vi.hoisted(() => () => import("../test/pushSettingsFenceMocks"));
vi.mock("~/state/use-atom-command", async () => (await fenceMocks()).mockUseAtomCommand());
vi.mock("~/state/pushNotifications", async (original) =>
  (await fenceMocks()).mockPushNotificationsState(original),
);
vi.mock("~/localApi", async (original) => (await fenceMocks()).mockLocalApi(original));
vi.mock("~/components/settings/useSettingsProjectGroups", async () =>
  (await fenceMocks()).mockSettingsProjectGroups(),
);
vi.mock("~/state/environments", async (original) =>
  (await fenceMocks()).mockEnvironments(original),
);
vi.mock("~/state/primaryEnvironment", async () => (await fenceMocks()).mockPrimaryEnvironment());

import {
  isSwitchDisabled,
  isSwitchOn,
  mountNotificationSettings,
  textOf,
  UNSUPPORTED_STATUS,
} from "../test/pushSettingsFenceApp";

it("push to this device spec: the desktop shell shows the switch disabled as unsupported and never registers the service worker", async () => {
  // Chromium in Electron has the whole push stack; only the shell rules it out.
  await using _browser = installPushBrowser({ permission: "granted" });
  await using settings = await mountNotificationSettings();

  await vi.waitFor(() => {
    expect(isSwitchDisabled(settings.pushSwitch())).toBe(true);
    expect(textOf(settings.pushRow())).toMatch(UNSUPPORTED_STATUS);
  });
  await act(async () => settings.pushSwitch().click());

  expect(isSwitchOn(settings.pushSwitch())).toBe(false);
  expect(browser.register).not.toHaveBeenCalled();
  expect(browser.subscribe).not.toHaveBeenCalled();
  expect(pushRpcCalls("subscribe")).toHaveLength(0);
});

it("push to this device guard: the desktop shell keeps the Thread notifications select", async () => {
  await using _browser = installPushBrowser({ permission: "granted" });
  await using settings = await mountNotificationSettings();

  expect(settings.container.textContent).toContain(
    "System alerts when a thread finishes, fails, or needs input or approval.",
  );
});
