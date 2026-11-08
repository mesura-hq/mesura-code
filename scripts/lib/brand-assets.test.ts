import { describe, expect, it } from "vite-plus/test";

import {
  BRAND_ASSET_PATHS,
  DESKTOP_LINUX_IDENTITY,
  DESKTOP_USER_DATA_IDENTITY,
  resolveDesktopLinuxIdentity,
  resolveDesktopUserDataIdentity,
  resolveWebIconOverrides,
} from "./brand-assets.ts";

describe("brand-assets", () => {
  it("keeps the Mesura desktop Linux identity separate from installed T3 Code", () => {
    expect(resolveDesktopLinuxIdentity(true)).toBe(DESKTOP_LINUX_IDENTITY.development);
    expect(resolveDesktopLinuxIdentity(false)).toBe(DESKTOP_LINUX_IDENTITY.production);
    expect(DESKTOP_LINUX_IDENTITY).toEqual({
      development: {
        desktopEntryName: "mesura-code-dev.desktop",
        executableName: "mesura-code-dev",
        wmClass: "mesura-code-dev",
      },
      production: {
        desktopEntryName: "mesura-code.desktop",
        executableName: "mesura-code",
        wmClass: "mesura-code",
      },
    });
  });

  it("keeps the Mesura desktop userData directory separate from installed T3 Code", () => {
    expect(resolveDesktopUserDataIdentity(true)).toBe(DESKTOP_USER_DATA_IDENTITY.development);
    expect(resolveDesktopUserDataIdentity(false)).toBe(DESKTOP_USER_DATA_IDENTITY.production);
    expect(DESKTOP_USER_DATA_IDENTITY).toEqual({
      development: {
        userDataDirName: "mesura-code-dev",
        legacyUserDataDirName: "mesura-code-dev",
      },
      production: {
        userDataDirName: "mesura-code",
        legacyUserDataDirName: "mesura-code",
      },
    });
  });

  it("uses the Mesura desktop artwork", () => {
    expect(BRAND_ASSET_PATHS.desktopMasterPng).toBe("assets/mesura-code/desktop-master.png");
    expect(BRAND_ASSET_PATHS.productionLinuxIconPng).toBe("assets/prod/black-linux-1024.png");
    expect(BRAND_ASSET_PATHS.productionUniversalIconPng).toBe(
      "assets/prod/black-universal-1024.png",
    );
  });

  it("copies each channel's 192 and 512 pixel web icons over a built web app", () => {
    const targets = new Map(
      resolveWebIconOverrides("production", "apps/server/dist/client").map((override) => [
        override.targetRelativePath,
        override.sourceRelativePath,
      ]),
    );

    expect(targets.get("apps/server/dist/client/icon-192.png")).toBe(
      BRAND_ASSET_PATHS.productionWebIcon192Png,
    );
    expect(targets.get("apps/server/dist/client/icon-512.png")).toBe(
      BRAND_ASSET_PATHS.productionWebIcon512Png,
    );
    expect(
      resolveWebIconOverrides("nightly", "dist").map((override) => override.sourceRelativePath),
    ).toEqual(
      expect.arrayContaining([
        BRAND_ASSET_PATHS.nightlyWebIcon192Png,
        BRAND_ASSET_PATHS.nightlyWebIcon512Png,
      ]),
    );
  });
});
