// @effect-diagnostics nodeBuiltinImport:off - These black-box tests create disposable host files around the exported raster helpers.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  assertPinnedImageRenderer,
  collectGeneratedBrandAssets,
  findStaleGeneratedAssetPaths,
  ICON_VARIANTS,
  IconExportRenditionError,
  macOsDeferredExportMappings,
  renderBrandIconVariant,
  renderRasterIcon,
} from "./export-brand-icons.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import { readPngDimensions, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const REPOSITORY_ROOT = NodePath.resolve(import.meta.dirname, "..");

function readIcoSizes(contents: Buffer): ReadonlyArray<number> {
  const imageCount = contents.readUInt16LE(4);
  return Array.from({ length: imageCount }, (_, index) => {
    const encodedSize = contents.readUInt8(6 + index * 16);
    return encodedSize === 0 ? 256 : encodedSize;
  });
}

describe("cross-platform brand icon export", () => {
  it("uses the pinned image renderer", () => {
    expect(() => assertPinnedImageRenderer()).not.toThrow();
  });

  it("keeps the deferred macOS handoff free of an unreachable native exporter", () => {
    const exporterSource = NodeFS.readFileSync(
      NodePath.join(REPOSITORY_ROOT, "scripts/export-brand-icons.ts"),
      "utf8",
    );

    expect(exporterSource).not.toMatch(/(?:resolveIconComposerTool|renderIconComposerVariant)/);
  });

  it("reports raster rendering failures without blaming Icon Composer", () => {
    const error = new IconExportRenditionError({
      sourcePath: "assets/mesura-code/production-master.png",
      outputPath: "generated icon family",
      expectedSize: 1024,
    });

    expect(error.message).toContain("Icon renderer produced an invalid PNG");
    expect(error.message).not.toContain("Icon Composer");
  });

  it("renders every non-macOS output from repository masters", async () => {
    for (const variant of ICON_VARIANTS) {
      const generated = await renderBrandIconVariant(REPOSITORY_ROOT, variant);
      expect([...generated.keys()].sort()).toEqual(
        [
          variant.composerAsset,
          variant.outputs.ios,
          variant.outputs.universal,
          variant.outputs.appleTouch,
          variant.outputs.favicon16,
          variant.outputs.favicon32,
          variant.outputs.faviconIco,
          variant.outputs.windowsIco,
        ].sort(),
      );
    }
  });

  it("reports stale outputs without changing their bytes", async () => {
    const temporaryRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mesura-icon-check-"));
    try {
      NodeFS.writeFileSync(NodePath.join(temporaryRoot, "existing.bin"), "old");
      const generated = new Map<string, Buffer>([
        ["existing.bin", Buffer.from("new")],
        ["missing.bin", Buffer.from("new")],
      ]);

      await expect(findStaleGeneratedAssetPaths(temporaryRoot, generated)).resolves.toEqual([
        "existing.bin",
        "missing.bin",
      ]);
      expect(NodeFS.readFileSync(NodePath.join(temporaryRoot, "existing.bin"), "utf8")).toBe("old");
      expect(NodeFS.existsSync(NodePath.join(temporaryRoot, "missing.bin"))).toBe(false);
    } finally {
      NodeFS.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("owns every generated mobile system asset", async () => {
    const generated = await collectGeneratedBrandAssets(REPOSITORY_ROOT);
    const mobilePaths = [
      BRAND_ASSET_PATHS.mobileAndroidMonochromeIconPng,
      BRAND_ASSET_PATHS.mobileAndroidNotificationIconPng,
      BRAND_ASSET_PATHS.mobileWidgetMarkSvg,
    ];
    expect([...generated.keys()]).toHaveLength(32);
    expect(mobilePaths.every((relativePath) => generated.has(relativePath))).toBe(true);

    const temporaryRoot = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "mesura-mobile-icons-"),
    );
    try {
      await expect(findStaleGeneratedAssetPaths(temporaryRoot, generated)).resolves.toEqual(
        expect.arrayContaining(mobilePaths),
      );
    } finally {
      NodeFS.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("renders the approved rounded master only for the production Linux desktop", async () => {
    const generated = await collectGeneratedBrandAssets(REPOSITORY_ROOT);
    const expected = await renderRasterIcon(
      NodePath.join(REPOSITORY_ROOT, BRAND_ASSET_PATHS.desktopMasterPng),
      1024,
    );

    expect(generated.get(BRAND_ASSET_PATHS.productionLinuxIconPng)).toEqual(expected);
    expect(BRAND_ASSET_PATHS.productionLinuxIconPng).not.toBe(
      BRAND_ASSET_PATHS.productionUniversalIconPng,
    );
  });

  it("uses direct realistic renders for favicon sizes", async () => {
    const production = ICON_VARIANTS.find((variant) => variant.label === "production")!;
    const generated = await renderBrandIconVariant(REPOSITORY_ROOT, production);

    for (const [size, outputPath] of [
      [16, production.outputs.favicon16],
      [32, production.outputs.favicon32],
    ] as const) {
      const expected = await renderRasterIcon(
        NodePath.join(REPOSITORY_ROOT, production.master),
        size,
      );
      expect(generated.get(outputPath)).toEqual(expected);
      expect(readPngDimensions(expected)).toEqual({ width: size, height: size });
    }
  });

  it("encodes every expected ICO rendition exactly once", async () => {
    for (const variant of ICON_VARIANTS) {
      const generated = await renderBrandIconVariant(REPOSITORY_ROOT, variant);
      for (const outputPath of [variant.outputs.faviconIco, variant.outputs.windowsIco]) {
        expect(readIcoSizes(generated.get(outputPath)!)).toEqual(WINDOWS_ICON_SIZES);
      }
    }
  });

  it("keeps every Icon Composer project free of T3 artwork", () => {
    for (const relativePath of [
      BRAND_ASSET_PATHS.developmentIconComposerProject,
      BRAND_ASSET_PATHS.nightlyIconComposerProject,
      BRAND_ASSET_PATHS.productionIconComposerProject,
    ]) {
      const project = NodeFS.readFileSync(
        NodePath.join(REPOSITORY_ROOT, relativePath, "icon.json"),
        "utf8",
      );
      expect(project).toContain('"image-name": "mesura-code.png"');
      expect(project).not.toMatch(/(?:T3|text\.svg)/);
      expect(
        readPngDimensions(
          NodeFS.readFileSync(
            NodePath.join(REPOSITORY_ROOT, relativePath, "Assets/mesura-code.png"),
          ),
        ),
      ).toEqual({ width: 1024, height: 1024 });
    }
  });

  it("keeps channel masters and output families separate", () => {
    expect(new Set(ICON_VARIANTS.map((variant) => variant.master)).size).toBe(3);
    expect(new Set(ICON_VARIANTS.map((variant) => variant.source)).size).toBe(3);
    expect(ICON_VARIANTS.map((variant) => variant.label)).toEqual([
      "development",
      "preview",
      "production",
    ]);
  });

  it("reports the exact three deferred macOS exports", () => {
    expect(macOsDeferredExportMappings()).toEqual([
      {
        source: "assets/dev/app-icon.icon",
        destination: "assets/dev/blueprint-macos-1024.png",
      },
      {
        source: "assets/nightly/app-icon.icon",
        destination: "assets/nightly/nightly-macos-1024.png",
      },
      {
        source: "assets/prod/app-icon.icon",
        destination: "assets/prod/black-macos-1024.png",
      },
    ]);
  });
});
