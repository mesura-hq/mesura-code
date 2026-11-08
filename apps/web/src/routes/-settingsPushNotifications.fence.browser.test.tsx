/**
 * Drives the real `/settings/general` route; `src/test/pushSettingsFenceMocks.ts` lists the
 * replaced boundaries. The desktop shell case lives in its own file
 * (`-settingsPushNotificationsDesktop.fence.browser.test.tsx`) because `env.ts` decides the
 * shell when the app's modules load.
 */
import { describe, expect, it, vi } from "vite-plus/test";

import { act } from "../../test/render";
import {
  installPushBrowser,
  PUSH_FENCE_DEVICE_KEYS,
  PUSH_FENCE_ENDPOINT,
  PUSH_FENCE_PRIMARY_ENVIRONMENT_ID,
  PUSH_FENCE_VAPID_KEY_BYTES,
  pushRpcCalls,
  pushSettingsFence as browser,
  setPrimaryConnectionPhase,
} from "../test/pushSettingsFenceMocks";

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

function bytesOf(source: unknown): number[] {
  if (source instanceof ArrayBuffer) return [...new Uint8Array(source)];
  if (ArrayBuffer.isView(source)) {
    return [...new Uint8Array(source.buffer, source.byteOffset, source.byteLength)];
  }
  throw new Error(`applicationServerKey must be bytes, got ${typeof source}`);
}

describe("push to this device guards", () => {
  it("push to this device guard: the Thread notifications select and the In-app notifications switch stay on the page", async () => {
    await using _browser = installPushBrowser();
    await using settings = await mountNotificationSettings();

    expect(settings.container.textContent).toContain(
      "System alerts when a thread finishes, fails, or needs input or approval.",
    );
    expect(settings.container.querySelector('[aria-label="In-app notifications"]')).not.toBeNull();
  });
});

describe("push to this device (criterion 1: four switch states)", () => {
  it("push to this device spec: a browser without the Push API shows the switch disabled as unsupported", async () => {
    await using _browser = installPushBrowser({ pushSupported: false });
    await using settings = await mountNotificationSettings();

    await vi.waitFor(() => {
      expect(isSwitchDisabled(settings.pushSwitch())).toBe(true);
      expect(isSwitchOn(settings.pushSwitch())).toBe(false);
      expect(textOf(settings.pushRow())).toMatch(UNSUPPORTED_STATUS);
    });
  });

  it("push to this device spec: notifications the browser blocked show the switch disabled as blocked", async () => {
    await using _browser = installPushBrowser({ permission: "denied" });
    await using settings = await mountNotificationSettings();

    await vi.waitFor(() => {
      expect(isSwitchDisabled(settings.pushSwitch())).toBe(true);
      expect(isSwitchOn(settings.pushSwitch())).toBe(false);
      expect(textOf(settings.pushRow())).toMatch(/blocked/i);
    });
  });

  it("push to this device spec: a supported device with no subscription shows the switch enabled and off", async () => {
    await using _browser = installPushBrowser();
    await using settings = await mountNotificationSettings();

    await vi.waitFor(() => {
      expect(isSwitchDisabled(settings.pushSwitch())).toBe(false);
      expect(isSwitchOn(settings.pushSwitch())).toBe(false);
    });
    expect(textOf(settings.pushRow())).not.toMatch(/blocked/i);
    expect(textOf(settings.pushRow())).not.toMatch(UNSUPPORTED_STATUS);
  });

  it("push to this device spec: a subscribed device shows the switch on and offers Send test notification", async () => {
    await using _browser = installPushBrowser({ permission: "granted", subscribed: true });
    await using settings = await mountNotificationSettings();

    await vi.waitFor(() => {
      expect(isSwitchDisabled(settings.pushSwitch())).toBe(false);
      expect(isSwitchOn(settings.pushSwitch())).toBe(true);
      expect(textOf(settings.pushRow())).toContain("Send test notification");
    });
  });
});

describe("push to this device (criterion 2: turning it on)", () => {
  it("push to this device spec: turning the switch on asks permission, registers /push-sw.js at scope /, subscribes with the server key and calls push.subscribe", async () => {
    await using _browser = installPushBrowser();
    await using settings = await mountNotificationSettings();
    await vi.waitFor(() => expect(isSwitchDisabled(settings.pushSwitch())).toBe(false));

    await act(async () => settings.pushSwitch().click());

    await vi.waitFor(() => expect(pushRpcCalls("subscribe")).toHaveLength(1));
    expect(browser.requestPermission).toHaveBeenCalledTimes(1);
    expect(browser.register).toHaveBeenCalledWith(
      "/push-sw.js",
      expect.objectContaining({ scope: "/" }),
    );
    expect(pushRpcCalls("publicKey").length).toBeGreaterThan(0);
    expect(browser.subscribe).toHaveBeenCalledTimes(1);
    const options = browser.subscribe.mock.calls[0]![0] as PushSubscriptionOptionsInit;
    expect(options.userVisibleOnly).toBe(true);
    expect(bytesOf(options.applicationServerKey)).toEqual([...PUSH_FENCE_VAPID_KEY_BYTES]);
    const [subscribe] = pushRpcCalls("subscribe");
    expect(subscribe!.environmentId).toBe(PUSH_FENCE_PRIMARY_ENVIRONMENT_ID);
    expect(subscribe!.input).toMatchObject({
      endpoint: PUSH_FENCE_ENDPOINT,
      keys: PUSH_FENCE_DEVICE_KEYS,
    });
    expect(typeof (subscribe!.input as { label?: unknown }).label).toBe("string");
    await vi.waitFor(() => expect(isSwitchOn(settings.pushSwitch())).toBe(true));
  });

  it("push to this device spec: a permission prompt the user dismisses subscribes nothing and leaves the switch off", async () => {
    await using _browser = installPushBrowser();
    browser.permissionAnswer = "default";
    await using settings = await mountNotificationSettings();
    await vi.waitFor(() => expect(isSwitchDisabled(settings.pushSwitch())).toBe(false));

    await act(async () => settings.pushSwitch().click());

    await vi.waitFor(() => expect(browser.requestPermission).toHaveBeenCalledTimes(1));
    expect(browser.subscribe).not.toHaveBeenCalled();
    expect(pushRpcCalls("subscribe")).toHaveLength(0);
    expect(isSwitchOn(settings.pushSwitch())).toBe(false);
  });

  it("push to this device spec: Send test notification asks the server to push to this device's endpoint", async () => {
    await using _browser = installPushBrowser({ permission: "granted", subscribed: true });
    await using settings = await mountNotificationSettings();
    const button = await vi.waitFor(() => {
      const match = [...settings.pushRow().querySelectorAll<HTMLElement>("button")].find(
        (candidate) => candidate.textContent?.trim() === "Send test notification",
      );
      expect(match, `row: ${textOf(settings.pushRow())}`).toBeDefined();
      return match!;
    });

    await act(async () => button.click());

    await vi.waitFor(() => expect(pushRpcCalls("sendTest")).toHaveLength(1));
    expect(pushRpcCalls("sendTest")[0]).toMatchObject({
      environmentId: PUSH_FENCE_PRIMARY_ENVIRONMENT_ID,
      input: { endpoint: PUSH_FENCE_ENDPOINT },
    });
  });
});

describe("push to this device (criterion 3: turning it off)", () => {
  it("push to this device spec: turning the switch off unsubscribes the browser and calls push.unsubscribe, and it shows off after a reload", async () => {
    await using _browser = installPushBrowser({ permission: "granted", subscribed: true });
    const subscription = browser.subscription!;
    {
      await using settings = await mountNotificationSettings();
      await vi.waitFor(() => expect(isSwitchOn(settings.pushSwitch())).toBe(true));

      await act(async () => settings.pushSwitch().click());

      await vi.waitFor(() => expect(pushRpcCalls("unsubscribe")).toHaveLength(1));
      expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
      expect(pushRpcCalls("unsubscribe")[0]).toMatchObject({
        environmentId: PUSH_FENCE_PRIMARY_ENVIRONMENT_ID,
        input: { endpoint: PUSH_FENCE_ENDPOINT },
      });
      await vi.waitFor(() => expect(isSwitchOn(settings.pushSwitch())).toBe(false));
    }

    await using reloaded = await mountNotificationSettings();
    await vi.waitFor(() => expect(isSwitchDisabled(reloaded.pushSwitch())).toBe(false));
    expect(isSwitchOn(reloaded.pushSwitch())).toBe(false);
    expect(browser.subscription).toBeNull();
    expect(browser.serverSubscribed).toBe(false);
  });
});

function buttonInRow(row: HTMLElement, name: string): HTMLElement | undefined {
  return [...row.querySelectorAll<HTMLElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
}

// regression: phase 2 review P2-1 — a failed push.status read reported a live subscription as off.
it("push to this device regression: a failed status check is shown as unknown with Check again, never as off", async () => {
  await using _browser = installPushBrowser({ permission: "granted", subscribed: true });
  browser.failing.add("status");
  await using settings = await mountNotificationSettings();

  await vi.waitFor(() => {
    expect(textOf(settings.pushRow())).toMatch(/could not check/i);
    expect(buttonInRow(settings.pushRow(), "Check again")).toBeDefined();
  });
  expect(isSwitchDisabled(settings.pushSwitch())).toBe(true);
  expect(isSwitchOn(settings.pushSwitch())).toBe(false);
  expect(textOf(settings.pushRow())).not.toContain("even with Mesura Code closed");

  browser.failing.clear();
  await act(async () => buttonInRow(settings.pushRow(), "Check again")!.click());

  await vi.waitFor(() => expect(isSwitchOn(settings.pushSwitch())).toBe(true));
  expect(pushRpcCalls("status")).toHaveLength(2);
});

// regression: phase 2 review P2-2 — the controls ignored the push RPCs' permission.
it("push to this device regression: a connection without the settings scope disables the switch and asks the browser nothing", async () => {
  await using _browser = installPushBrowser();
  browser.canWriteSettings = false;
  await using settings = await mountNotificationSettings();

  await vi.waitFor(() => expect(textOf(settings.pushRow())).toMatch(/settings access/i));
  expect(isSwitchDisabled(settings.pushSwitch())).toBe(true);
  await act(async () => settings.pushSwitch().click());

  expect(browser.requestPermission).not.toHaveBeenCalled();
  expect(browser.register).not.toHaveBeenCalled();
  expect(browser.rpc).toEqual([]);
});

// regression: phase 2 review P2-2 — the test button ignored the push RPCs' permission.
it("push to this device regression: a subscribed device whose connection lost the settings scope cannot send a test", async () => {
  await using _browser = installPushBrowser({ permission: "granted", subscribed: true });
  browser.canWriteSettings = false;
  await using settings = await mountNotificationSettings();

  await vi.waitFor(() => expect(textOf(settings.pushRow())).toMatch(/settings access/i));
  const test = buttonInRow(settings.pushRow(), "Send test notification");
  if (test) await act(async () => test.click());

  expect(pushRpcCalls("sendTest")).toHaveLength(0);
});

// regression: phase 2 review P2-1 — a check that failed while the host was away stayed failed.
it("push to this device regression: a subscribed device checks again when the host reconnects and shows on", async () => {
  await using _browser = installPushBrowser({ permission: "granted", subscribed: true });
  setPrimaryConnectionPhase("disconnected");
  await using settings = await mountNotificationSettings();

  await vi.waitFor(() => expect(textOf(settings.pushRow())).toMatch(/could not check/i));
  expect(isSwitchOn(settings.pushSwitch())).toBe(false);
  expect(pushRpcCalls("status")).toHaveLength(0);

  await act(async () => setPrimaryConnectionPhase("connected"));

  await vi.waitFor(() => expect(isSwitchOn(settings.pushSwitch())).toBe(true));
  expect(pushRpcCalls("status")).toHaveLength(1);
  expect(textOf(settings.pushRow())).not.toMatch(/could not check/i);
});

it("push to this device regression: a status check that failed is retried when the host reconnects", async () => {
  await using _browser = installPushBrowser({ permission: "granted", subscribed: true });
  setPrimaryConnectionPhase("connected");
  browser.failing.add("status");
  await using settings = await mountNotificationSettings();
  await vi.waitFor(() => expect(textOf(settings.pushRow())).toMatch(/could not check/i));

  browser.failing.clear();
  await act(async () => setPrimaryConnectionPhase("reconnecting"));
  await act(async () => setPrimaryConnectionPhase("connected"));

  await vi.waitFor(() => expect(isSwitchOn(settings.pushSwitch())).toBe(true));
});
