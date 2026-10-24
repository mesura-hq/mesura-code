import type { BrowserLinkTarget } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { resolveBrowserLinkTargetPreference, resolveLinkTarget } from "./browserLinkTarget";
import { ensureClientSettingsHydrated } from "~/hooks/useSettings";

const settings = vi.hoisted(() => ({ browserLinkTarget: "system" as BrowserLinkTarget }));

vi.mock("~/hooks/useSettings", () => ({
  ensureClientSettingsHydrated: vi.fn(async () => undefined),
  getClientSettings: () => settings,
}));

const desktop = { viewportWidth: 1280, primaryPointerCoarse: false };

const click = { metaKey: false, ctrlKey: false };

describe("resolveLinkTarget", () => {
  it("keeps the system browser unless the user asked for in-app", () => {
    expect(
      resolveLinkTarget({
        url: "https://example.com/",
        event: click,
        preference: "system",
        canOpenInApp: true,
        linkClient: desktop,
      }),
    ).toBe("system");
  });

  it("opens in-app when asked and the runtime can", () => {
    expect(
      resolveLinkTarget({
        url: "https://example.com/",
        event: click,
        preference: "app",
        canOpenInApp: true,
        linkClient: desktop,
      }),
    ).toBe("app");
  });

  it("falls back to the system browser where there is no in-app browser", () => {
    expect(
      resolveLinkTarget({
        url: "https://example.com/",
        event: click,
        preference: "app",
        canOpenInApp: false,
        linkClient: desktop,
      }),
    ).toBe("system");
  });

  it("treats a modifier click as the way out of the in-app default", () => {
    expect(
      resolveLinkTarget({
        url: "https://example.com/",
        event: { metaKey: true, ctrlKey: false },
        preference: "app",
        canOpenInApp: true,
        linkClient: desktop,
      }),
    ).toBe("system");
    expect(
      resolveLinkTarget({
        url: "https://example.com/",
        event: { metaKey: false, ctrlKey: true },
        preference: "app",
        canOpenInApp: true,
        linkClient: desktop,
      }),
    ).toBe("system");
  });

  it("leaves non-web schemes to the shell", () => {
    for (const url of ["mailto:someone@example.com", "vscode://file/x", "not a url"]) {
      expect(
        resolveLinkTarget({
          url,
          event: click,
          preference: "app",
          canOpenInApp: true,
          linkClient: desktop,
        }),
      ).toBe("system");
    }
  });
});

describe("resolveBrowserLinkTargetPreference", () => {
  it.each(["system", "app"] as const)(
    "rejects failed reads instead of using the current %s preference",
    async (preference) => {
      settings.browserLinkTarget = preference;
      const failure = new Error("Settings read failed");
      vi.mocked(ensureClientSettingsHydrated).mockRejectedValueOnce(failure);

      await expect(resolveBrowserLinkTargetPreference()).rejects.toBe(failure);
      await expect(resolveBrowserLinkTargetPreference()).resolves.toBe(preference);
    },
  );
});

it.each([
  [767, false, "system"],
  [1280, true, "system"],
  [768, false, "app"],
] as const)(
  "link policy boundary: width %s coarse %s chooses %s",
  (viewportWidth, primaryPointerCoarse, target) => {
    expect(
      resolveLinkTarget({
        url: "https://example.com",
        event: click,
        preference: "app",
        canOpenInApp: true,
        linkClient: { viewportWidth, primaryPointerCoarse },
      }),
    ).toBe(target);
  },
);

it("link policy hydration: reads the saved choice only after hydration completes", async () => {
  settings.browserLinkTarget = "system";
  let release = () => {};
  vi.mocked(ensureClientSettingsHydrated).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const reading = resolveBrowserLinkTargetPreference();
  settings.browserLinkTarget = "app";
  release();
  await expect(reading).resolves.toBe("app");
});

it("keeps middle-click in the system browser", () => {
  expect(
    resolveLinkTarget({
      url: "https://example.com/",
      event: { ...click, button: 1 },
      preference: "app",
      canOpenInApp: true,
      linkClient: desktop,
    }),
  ).toBe("system");
});
