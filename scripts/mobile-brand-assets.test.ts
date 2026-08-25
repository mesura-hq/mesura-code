// @effect-diagnostics nodeBuiltinImport:off - Mobile asset contracts inspect Expo config and exact host-side image bytes.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";
import sharp from "sharp";

const REPOSITORY_ROOT = NodePath.resolve(import.meta.dirname, "..");
const MOBILE_ROOT = NodePath.join(REPOSITORY_ROOT, "apps/mobile");
/**
 * `CHANNEL_WORDMARK_BAND_TOP` from `brand-icon-source.test.ts`, expressed in
 * the 256px raster this test scans: 1097 of 1254 rounds to 224.
 */
const ADAPTIVE_WORDMARK_BAND_TOP = 224;

type AppVariant = "development" | "preview" | "production";

interface MobileConfig {
  readonly name?: string;
  readonly scheme?: string | ReadonlyArray<string>;
  readonly icon?: string;
  readonly android?: {
    readonly package?: string;
    readonly adaptiveIcon?: {
      readonly foregroundImage?: string;
      readonly backgroundColor?: string;
    };
  };
  readonly plugins?: ReadonlyArray<string | readonly [string, Record<string, unknown>]>;
}

async function loadMobileConfig(appVariant: AppVariant): Promise<MobileConfig> {
  const previousVariant = process.env.APP_VARIANT;
  process.env.APP_VARIANT = appVariant;
  try {
    switch (appVariant) {
      case "development":
        // @ts-expect-error -- Vite uses the query suffix to load one config instance per variant.
        return (await import("../apps/mobile/app.config.ts?asset-test=development")).default;
      case "preview":
        // @ts-expect-error -- Vite uses the query suffix to load one config instance per variant.
        return (await import("../apps/mobile/app.config.ts?asset-test=preview")).default;
      case "production":
        // @ts-expect-error -- Vite uses the query suffix to load one config instance per variant.
        return (await import("../apps/mobile/app.config.ts?asset-test=production")).default;
    }
    throw new Error(`Unsupported app variant: ${appVariant satisfies never}`);
  } finally {
    if (previousVariant === undefined) delete process.env.APP_VARIANT;
    else process.env.APP_VARIANT = previousVariant;
  }
}

function pluginOptions(config: MobileConfig, pluginName: string): Record<string, unknown> {
  const plugin = config.plugins?.find((entry) => Array.isArray(entry) && entry[0] === pluginName);
  expect(plugin).toBeDefined();
  expect(Array.isArray(plugin)).toBe(true);
  return plugin![1] as Record<string, unknown>;
}

function resolveMobileAsset(assetPath: string): string {
  return NodePath.resolve(MOBILE_ROOT, assetPath);
}

async function renderMonochromeTemplate(size: number): Promise<Buffer> {
  const source = NodeFS.readFileSync(
    NodePath.join(REPOSITORY_ROOT, "assets/mesura-code/monochrome.svg"),
    "utf8",
  ).replaceAll("currentColor", "#ffffff");
  return sharp(Buffer.from(source))
    .resize(size, size, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .png({ adaptiveFiltering: true, compressionLevel: 9 })
    .toBuffer();
}

describe("mobile brand assets", () => {
  it("selects each detailed channel icon without changing app identities", async () => {
    const expectations = {
      development: {
        name: "Mesura Code Dev",
        scheme: "t3code-dev",
        package: "com.t3tools.t3code.dev",
        icon: "../../assets/dev/blueprint-ios-1024.png",
        adaptive: "../../assets/dev/blueprint-universal-1024.png",
      },
      preview: {
        name: "Mesura Code Preview",
        scheme: "t3code-preview",
        package: "com.t3tools.t3code.preview",
        icon: "../../assets/nightly/nightly-ios-1024.png",
        adaptive: "../../assets/nightly/nightly-universal-1024.png",
      },
      production: {
        name: "Mesura Code",
        scheme: "t3code",
        package: "com.t3tools.t3code",
        icon: "../../assets/prod/black-ios-1024.png",
        adaptive: "../../assets/prod/black-universal-1024.png",
      },
    } as const;

    for (const appVariant of Object.keys(expectations) as ReadonlyArray<AppVariant>) {
      const config = await loadMobileConfig(appVariant);
      const expected = expectations[appVariant];
      expect(config.name).toBe(expected.name);
      expect(config.scheme).toBe(expected.scheme);
      expect(config.android?.package).toBe(expected.package);
      expect(config.icon).toBe(expected.icon);
      expect(config.android?.adaptiveIcon?.foregroundImage).toBe(expected.adaptive);
    }
  });

  it("keeps the realistic cube inside the adaptive-icon safe zone", async () => {
    for (const appVariant of ["development", "preview", "production"] as const) {
      const config = await loadMobileConfig(appVariant);
      const foreground = config.android?.adaptiveIcon?.foregroundImage;
      expect(typeof foreground).toBe("string");
      const { data, info } = await sharp(resolveMobileAsset(foreground as string))
        .resize(256, 256)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const visibleMetalPixels: Array<readonly [number, number]> = [];
      const wordmarkPixels: Array<readonly [number, number]> = [];
      for (let y = 0; y < info.height; y += 1) {
        for (let x = 0; x < info.width; x += 1) {
          const offset = (y * info.width + x) * info.channels;
          const red = data[offset]!;
          const green = data[offset + 1]!;
          const blue = data[offset + 2]!;
          const brightness = (red + green + blue) / 3;
          const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
          if (brightness > 95 && chroma < 55) {
            // The channel wordmark is metal-coloured too, so split it out by
            // the band it is pinned to. This test is about the cube.
            (y < ADAPTIVE_WORDMARK_BAND_TOP ? visibleMetalPixels : wordmarkPixels).push([x, y]);
          }
        }
      }
      const xs = visibleMetalPixels.map(([x]) => x);
      const ys = visibleMetalPixels.map(([, y]) => y);
      expect(visibleMetalPixels.length).toBeGreaterThan(0);
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(38);
      expect(Math.max(...xs)).toBeLessThanOrEqual(217);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(38);
      expect(Math.max(...ys)).toBeLessThanOrEqual(217);
      // Only development and preview carry a wordmark, and it sits in the
      // margin an adaptive launcher masks away. That is not a regression: the
      // coloured frame it replaced sat further out still, at y≈4 of 256.
      expect(wordmarkPixels.length > 0).toBe(appVariant !== "production");
    }
  });

  it("uses the Mesura Code monochrome cube for themed Android launchers", async () => {
    const expected = await renderMonochromeTemplate(432);
    const actual = NodeFS.readFileSync(NodePath.join(MOBILE_ROOT, "assets/android-icon-mark.png"));
    expect(actual).toEqual(expected);
  });

  it("uses a white Mesura Code template for Android notifications", async () => {
    const expected = await renderMonochromeTemplate(96);
    const actual = NodeFS.readFileSync(
      NodePath.join(MOBILE_ROOT, "assets/android-notification-icon.png"),
    );
    expect(actual).toEqual(expected);
    const { channels, width, height } = await sharp(actual).metadata();
    expect({ channels, width, height }).toEqual({ channels: 4, width: 96, height: 96 });
  });

  it("keeps Android shortcuts aligned with each adaptive launcher", async () => {
    for (const appVariant of ["development", "preview", "production"] as const) {
      const config = await loadMobileConfig(appVariant);
      const quickActions = pluginOptions(config, "expo-quick-actions");
      const shortcut = (quickActions.androidIcons as Record<string, Record<string, unknown>>)
        .shortcut_icon;
      expect(shortcut?.foregroundImage).toBe(config.android?.adaptiveIcon?.foregroundImage);
      expect(shortcut?.backgroundColor).toBe(config.android?.adaptiveIcon?.backgroundColor);
    }
  });

  it("uses the container-free cube in light and dark splash screens", async () => {
    for (const appVariant of ["development", "preview", "production"] as const) {
      const config = await loadMobileConfig(appVariant);
      const splash = pluginOptions(config, "expo-splash-screen");
      expect(splash.image).toMatch(/assets[/\\]mesura-code[/\\]splash-mark\.png$/);
      expect((splash.dark as Record<string, unknown>).image).toBe(splash.image);
      // The launcher icon carries an opaque field, so borrowing it here would
      // cut a square out of both splash backgrounds. Light mode is the worst
      // case: a near-black tile on #ffffff.
      expect(splash.image).not.toBe(config.icon);
    }

    const { channels, width, height } = await sharp(
      NodePath.join(REPOSITORY_ROOT, "assets/mesura-code/splash-mark.png"),
    ).metadata();
    expect({ channels, width, height }).toEqual({ channels: 4, width: 1024, height: 1024 });
  });

  it("ships the Mesura Code template to the Apple widget", () => {
    const central = NodeFS.readFileSync(
      NodePath.join(REPOSITORY_ROOT, "assets/mesura-code/monochrome.svg"),
    );
    const widget = NodeFS.readFileSync(NodePath.join(MOBILE_ROOT, "assets/widget/T3Mark.svg"));
    const plugin = NodeFS.readFileSync(
      NodePath.join(MOBILE_ROOT, "plugins/withWidgetLogoAsset.cjs"),
      "utf8",
    );

    expect(widget).toEqual(central);
    expect(plugin).toContain("Ships the Mesura Code template mark");
    expect(plugin).not.toContain("branded T3 mark");
  });
});
