import { describe, expect, it } from "vite-plus/test";

import {
  BRAND_ASSET_PATHS,
  DESKTOP_LINUX_IDENTITY,
  DESKTOP_USER_DATA_IDENTITY,
  DEVELOPMENT_ICON_OVERRIDES,
  DEVELOPMENT_PUBLIC_ICON_OVERRIDES,
  resolveWebAssetBrandForChannel,
  resolveWebAssetBrandForPackageVersion,
  resolveWebIconOverrides,
  resolveDesktopLinuxIdentity,
  resolveDesktopUserDataIdentity,
} from "./brand-assets.ts";

describe("brand-assets", () => {
  it("maps production web assets into the server package", () => {
    expect(resolveWebIconOverrides("production", "dist/client")).toEqual([
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebFaviconIco,
        targetRelativePath: "dist/client/favicon.ico",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebFavicon16Png,
        targetRelativePath: "dist/client/favicon-16x16.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebFavicon32Png,
        targetRelativePath: "dist/client/favicon-32x32.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
        targetRelativePath: "dist/client/apple-touch-icon.png",
      },
    ]);
  });

  it("maps server build web assets to development icons", () => {
    expect(DEVELOPMENT_ICON_OVERRIDES[0]).toEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFaviconIco,
      targetRelativePath: "dist/client/favicon.ico",
    });
  });

  it("maps development web assets to the public splash and favicon files", () => {
    expect(DEVELOPMENT_PUBLIC_ICON_OVERRIDES).toEqual([
      {
        sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFaviconIco,
        targetRelativePath: "apps/web/public/favicon.ico",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
        targetRelativePath: "apps/web/public/favicon-16x16.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
        targetRelativePath: "apps/web/public/favicon-32x32.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
        targetRelativePath: "apps/web/public/apple-touch-icon.png",
      },
    ]);
  });

  it("can target hosted web dist directly", () => {
    expect(resolveWebIconOverrides("production", "apps/web/dist")).toContainEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
      targetRelativePath: "apps/web/dist/apple-touch-icon.png",
    });
  });

  it("maps hosted nightly web assets to nightly icons", () => {
    expect(resolveWebIconOverrides("nightly", "apps/web/dist")).toContainEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
      targetRelativePath: "apps/web/dist/favicon.ico",
    });
  });

  it("maps hosted release channels to web asset brands", () => {
    expect(resolveWebAssetBrandForChannel("latest")).toBe("production");
    expect(resolveWebAssetBrandForChannel("nightly")).toBe("nightly");
  });

  it("maps package versions to web asset brands", () => {
    expect(resolveWebAssetBrandForPackageVersion("0.0.29")).toBe("production");
    expect(resolveWebAssetBrandForPackageVersion("0.0.29-nightly.20260723.882")).toBe("nightly");
  });

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

  // Electron scopes its single-instance lock to the userData directory, so a
  // directory name the installed T3 Code also claims makes Mesura Code quit
  // without a window. A weekly merge that resolves DesktopEnvironment.ts in
  // upstream's favor restores `t3code` with every other test still passing.
  it("never names the desktop userData directory after T3 Code", () => {
    for (const identity of Object.values(DESKTOP_USER_DATA_IDENTITY)) {
      for (const dirName of Object.values(identity)) {
        expect(dirName).toMatch(/^mesura-code(-dev)?$/);
      }
    }
  });

  it("keeps development, nightly, and production icon families separate", () => {
    expect([
      BRAND_ASSET_PATHS.developmentIconComposerProject,
      BRAND_ASSET_PATHS.nightlyIconComposerProject,
      BRAND_ASSET_PATHS.productionIconComposerProject,
    ]).toEqual([
      "assets/dev/app-icon.icon",
      "assets/nightly/app-icon.icon",
      "assets/prod/app-icon.icon",
    ]);
    expect(BRAND_ASSET_PATHS.developmentDesktopIconPng).toMatch(/^assets\/dev\/blueprint-/);
    expect(BRAND_ASSET_PATHS.nightlyMacIconPng).toMatch(/^assets\/nightly\/nightly-/);
    expect(BRAND_ASSET_PATHS.productionMacIconPng).toMatch(/^assets\/prod\/black-/);
    expect(BRAND_ASSET_PATHS.desktopMasterPng).toBe("assets/mesura-code/desktop-master.png");
    expect(BRAND_ASSET_PATHS.productionLinuxIconPng).toBe("assets/prod/black-linux-1024.png");
    expect(BRAND_ASSET_PATHS.productionUniversalIconPng).toBe(
      "assets/prod/black-universal-1024.png",
    );
  });
});
