#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Sharp and exported byte-level helpers operate on host file paths before the Effect command boundary.

import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import sharp from "sharp";

import { BRAND_ASSET_PATHS, DEVELOPMENT_PUBLIC_ICON_OVERRIDES } from "./lib/brand-assets.ts";
import { encodePngIco, readPngDimensions, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

export const PINNED_LIBVIPS_VERSION = "8.18.3";

export interface VariantOutputs {
  readonly ios: string;
  readonly macos: string;
  readonly universal: string;
  readonly appleTouch: string;
  readonly favicon16: string;
  readonly favicon32: string;
  readonly faviconIco: string;
  readonly windowsIco: string;
}

export interface IconVariant {
  readonly label: string;
  readonly master: string;
  readonly source: string;
  readonly composerAsset: string;
  readonly outputs: VariantOutputs;
}

export class IconExportFileSystemError extends Schema.TaggedErrorClass<IconExportFileSystemError>()(
  "IconExportFileSystemError",
  {
    operation: Schema.Literals([
      "resolve-repository-root",
      "check-path",
      "read-directory",
      "read-file",
      "make-directory",
      "make-temp-directory",
      "make-temp-file",
      "write-file",
      "rename-file",
    ]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Icon export file-system operation '${this.operation}' failed for ${this.path}.`;
  }
}

export class IconExportRenditionError extends Schema.TaggedErrorClass<IconExportRenditionError>()(
  "IconExportRenditionError",
  {
    sourcePath: Schema.String,
    outputPath: Schema.String,
    expectedSize: Schema.Int,
    actualWidth: Schema.optional(Schema.Int),
    actualHeight: Schema.optional(Schema.Int),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const actual =
      this.actualWidth === undefined || this.actualHeight === undefined
        ? "an invalid PNG"
        : `${this.actualWidth}x${this.actualHeight}`;
    return `Icon renderer produced ${actual}; expected ${this.expectedSize}x${this.expectedSize} for ${this.sourcePath}.`;
  }
}

export class IconExportAssetsStaleError extends Schema.TaggedErrorClass<IconExportAssetsStaleError>()(
  "IconExportAssetsStaleError",
  {
    paths: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Generated icon assets are stale:\n${this.paths.map((path) => `- ${path}`).join("\n")}`;
  }
}

export const ICON_VARIANTS = [
  {
    label: "development",
    master: BRAND_ASSET_PATHS.developmentMasterPng,
    source: BRAND_ASSET_PATHS.developmentIconComposerProject,
    composerAsset: `${BRAND_ASSET_PATHS.developmentIconComposerProject}/Assets/mesura-code.png`,
    outputs: {
      ios: BRAND_ASSET_PATHS.developmentIosIconPng,
      macos: BRAND_ASSET_PATHS.developmentDesktopIconPng,
      universal: BRAND_ASSET_PATHS.developmentUniversalIconPng,
      appleTouch: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
      favicon16: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
      favicon32: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
      faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
      windowsIco: BRAND_ASSET_PATHS.developmentWindowsIconIco,
    },
  },
  {
    label: "preview",
    master: BRAND_ASSET_PATHS.nightlyMasterPng,
    source: BRAND_ASSET_PATHS.nightlyIconComposerProject,
    composerAsset: `${BRAND_ASSET_PATHS.nightlyIconComposerProject}/Assets/mesura-code.png`,
    outputs: {
      ios: BRAND_ASSET_PATHS.nightlyIosIconPng,
      macos: BRAND_ASSET_PATHS.nightlyMacIconPng,
      universal: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      appleTouch: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
      favicon16: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
      favicon32: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
      faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
      windowsIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    },
  },
  {
    label: "production",
    master: BRAND_ASSET_PATHS.productionMasterPng,
    source: BRAND_ASSET_PATHS.productionIconComposerProject,
    composerAsset: `${BRAND_ASSET_PATHS.productionIconComposerProject}/Assets/mesura-code.png`,
    outputs: {
      ios: BRAND_ASSET_PATHS.productionIosIconPng,
      macos: BRAND_ASSET_PATHS.productionMacIconPng,
      universal: BRAND_ASSET_PATHS.productionLinuxIconPng,
      appleTouch: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
      favicon16: BRAND_ASSET_PATHS.productionWebFavicon16Png,
      favicon32: BRAND_ASSET_PATHS.productionWebFavicon32Png,
      faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
      windowsIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    },
  },
] as const satisfies ReadonlyArray<IconVariant>;

const MACOS_EXPORT_CODEX_PROMPT = [
  "Use [@Computer](plugin://computer-use@openai-bundled) and the Icon Composer app to export the three macOS app icons in this repository.",
  "For each project below, use Platform: macOS pre-Tahoe, Appearance: Default, Size: 1024pt, and Scale: 1×, then save the PNG to the exact destination:",
  ...ICON_VARIANTS.map((variant) => `- ${variant.source} -> ${variant.outputs.macos}`),
  "Do not resize, composite, or otherwise post-process the exported PNGs.",
  "Verify every result is 1024×1024 and has the classic macOS safe area: an 824×824 opaque body inset 100px on every side, with only Icon Composer's native shadow extending beyond it.",
];

const RepositoryRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
  Effect.mapError(
    (cause) =>
      new IconExportFileSystemError({
        operation: "resolve-repository-root",
        path: new URL("..", import.meta.url).pathname,
        cause,
      }),
  ),
);

export async function renderRasterIcon(sourcePath: string, size: number): Promise<Buffer> {
  const contents = await sharp(sourcePath, { failOn: "error" })
    .resize(size, size, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .png({ adaptiveFiltering: true, compressionLevel: 9 })
    .toBuffer();
  const dimensions = readPngDimensions(contents);
  if (dimensions.width !== size || dimensions.height !== size) {
    throw new Error(
      `Raster icon renderer produced ${dimensions.width}x${dimensions.height}; expected ${size}x${size}.`,
    );
  }
  return contents;
}

export function assertPinnedImageRenderer(): void {
  if (sharp.versions.vips !== PINNED_LIBVIPS_VERSION) {
    throw new Error(
      `Icon export requires bundled libvips ${PINNED_LIBVIPS_VERSION}, but Sharp loaded ${sharp.versions.vips}.`,
    );
  }
}

export async function renderBrandIconVariant(
  repositoryRoot: string,
  variant: IconVariant,
): Promise<Map<string, Buffer>> {
  const masterPath = NodePath.join(repositoryRoot, variant.master);
  await NodeFSP.access(masterPath);
  const renditionCache = new Map<number, Buffer>();
  const render = async (size: number): Promise<Buffer> => {
    const cached = renditionCache.get(size);
    if (cached) return cached;
    const contents = await renderRasterIcon(masterPath, size);
    renditionCache.set(size, contents);
    return contents;
  };

  const ios = await render(1024);
  const icoRenditions = await Promise.all(
    WINDOWS_ICON_SIZES.map(async (size) => ({ size, contents: await render(size) })),
  );
  const ico = encodePngIco(icoRenditions);

  return new Map<string, Buffer>([
    [variant.composerAsset, ios],
    [variant.outputs.ios, ios],
    [variant.outputs.universal, ios],
    [variant.outputs.appleTouch, await render(180)],
    [variant.outputs.favicon16, await render(16)],
    [variant.outputs.favicon32, await render(32)],
    [variant.outputs.faviconIco, ico],
    [variant.outputs.windowsIco, ico],
  ]);
}

export async function renderMobileSystemAssets(
  repositoryRoot: string,
): Promise<Map<string, Buffer>> {
  const monochromeSource = await NodeFSP.readFile(
    NodePath.join(repositoryRoot, BRAND_ASSET_PATHS.monochromeSourceSvg),
  );
  const whiteTemplateSource = monochromeSource
    .toString("utf8")
    .replaceAll("currentColor", "#ffffff");
  const renderTemplate = (size: number) =>
    sharp(Buffer.from(whiteTemplateSource))
      .resize(size, size, { fit: "fill", kernel: sharp.kernel.lanczos3 })
      .png({ adaptiveFiltering: true, compressionLevel: 9 })
      .toBuffer();

  return new Map<string, Buffer>([
    [BRAND_ASSET_PATHS.mobileAndroidMonochromeIconPng, await renderTemplate(432)],
    [BRAND_ASSET_PATHS.mobileAndroidNotificationIconPng, await renderTemplate(96)],
    [BRAND_ASSET_PATHS.mobileWidgetMarkSvg, monochromeSource],
  ]);
}

export async function collectGeneratedBrandAssets(
  repositoryRoot: string,
): Promise<Map<string, Buffer>> {
  assertPinnedImageRenderer();
  const generated = new Map<string, Buffer>();
  for (const variant of ICON_VARIANTS) {
    const variantAssets = await renderBrandIconVariant(repositoryRoot, variant);
    for (const [relativePath, contents] of variantAssets) {
      generated.set(relativePath, contents);
    }
  }

  for (const override of DEVELOPMENT_PUBLIC_ICON_OVERRIDES) {
    const sourceContents = generated.get(override.sourceRelativePath);
    if (sourceContents === undefined) {
      throw new Error(`Generated development web icon is missing: ${override.sourceRelativePath}`);
    }
    generated.set(override.targetRelativePath, sourceContents);
  }

  const mobileSystemAssets = await renderMobileSystemAssets(repositoryRoot);
  for (const [relativePath, contents] of mobileSystemAssets) {
    generated.set(relativePath, contents);
  }
  return generated;
}

export async function findStaleGeneratedAssetPaths(
  repositoryRoot: string,
  generated: ReadonlyMap<string, Buffer>,
): Promise<ReadonlyArray<string>> {
  const stalePaths: string[] = [];
  for (const [relativePath, expected] of generated) {
    try {
      const actual = await NodeFSP.readFile(NodePath.join(repositoryRoot, relativePath));
      if (!actual.equals(expected)) stalePaths.push(relativePath);
    } catch (cause) {
      if (
        cause instanceof Error &&
        "code" in cause &&
        (cause as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        stalePaths.push(relativePath);
        continue;
      }
      throw cause;
    }
  }
  return stalePaths;
}

export function macOsDeferredExportMappings(): ReadonlyArray<{
  readonly source: string;
  readonly destination: string;
}> {
  return ICON_VARIANTS.map((variant) => ({
    source: variant.source,
    destination: variant.outputs.macos,
  }));
}

const logManualMacOsExportInstructions = Effect.fn("iconExport.logManualMacOsExportInstructions")(
  function* () {
    yield* Console.warn(
      [
        "macOS icons require Icon Composer's GUI-only pre-Tahoe preset and were not changed.",
        "Export each source with Platform: macOS pre-Tahoe, Appearance: Default, Size: 1024pt, Scale: 1×:",
        ...macOsDeferredExportMappings().map(
          (mapping) => `- ${mapping.source} -> ${mapping.destination}`,
        ),
        "See assets/README.md for the complete workflow.",
        "",
        "Copy/paste this prompt into Codex to perform the native exports:",
        "---",
        ...MACOS_EXPORT_CODEX_PROMPT,
        "---",
      ].join("\n"),
    );
  },
);

const writeAtomically = Effect.fn("iconExport.writeAtomically")(function* (
  repositoryRoot: string,
  relativePath: string,
  contents: Buffer,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const targetPath = path.join(repositoryRoot, relativePath);
  const targetDirectory = path.dirname(targetPath);
  yield* fs.makeDirectory(targetDirectory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "make-directory",
          path: targetDirectory,
          cause,
        }),
    ),
  );
  const temporaryPath = yield* fs
    .makeTempFileScoped({
      directory: targetDirectory,
      prefix: ".t3-icon-export-",
      suffix: ".tmp",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new IconExportFileSystemError({
            operation: "make-temp-file",
            path: targetDirectory,
            cause,
          }),
      ),
    );
  yield* fs.writeFile(temporaryPath, contents).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "write-file",
          path: temporaryPath,
          cause,
        }),
    ),
  );
  yield* fs.rename(temporaryPath, targetPath).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "rename-file",
          path: targetPath,
          cause,
        }),
    ),
  );
});

export const exportBrandIcons = Effect.fn("exportBrandIcons")(function* (checkOnly: boolean) {
  const repositoryRoot = yield* RepositoryRoot;
  yield* Console.log("Exporting icons from Mesura Code raster masters.");

  for (const variant of ICON_VARIANTS) {
    yield* Console.log(`Rendering ${variant.label} from ${variant.master}...`);
  }
  const generated = yield* Effect.tryPromise({
    try: () => collectGeneratedBrandAssets(repositoryRoot),
    catch: (cause) =>
      new IconExportRenditionError({
        sourcePath: "Mesura Code icon sources",
        outputPath: "generated icon family",
        expectedSize: 1024,
        cause,
      }),
  });

  if (checkOnly) {
    const stalePaths = yield* Effect.tryPromise({
      try: () => findStaleGeneratedAssetPaths(repositoryRoot, generated),
      catch: (cause) =>
        new IconExportFileSystemError({
          operation: "read-file",
          path: repositoryRoot,
          cause,
        }),
    });
    if (stalePaths.length > 0) {
      return yield* new IconExportAssetsStaleError({
        paths: stalePaths,
      });
    }
    yield* Console.log(`All ${generated.size} generated icon assets are current.`);
    yield* logManualMacOsExportInstructions();
    return;
  }

  yield* Effect.forEach(
    generated,
    ([relativePath, contents]) => writeAtomically(repositoryRoot, relativePath, contents),
    { concurrency: 1, discard: true },
  );
  yield* Console.log(`Updated ${generated.size} generated icon assets.`);
  yield* logManualMacOsExportInstructions();
});

export const exportBrandIconsCommand = Command.make(
  "export-brand-icons",
  {
    check: Flag.boolean("check").pipe(
      Flag.withDescription("Verify generated icon assets without modifying files."),
      Flag.withDefault(false),
    ),
  },
  ({ check }) => exportBrandIcons(check).pipe(Effect.scoped),
).pipe(
  Command.withDescription(
    "Export development, preview, and production assets from raster masters.",
  ),
);

if (import.meta.main) {
  Command.run(exportBrandIconsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
