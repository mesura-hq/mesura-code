// @effect-diagnostics nodeBuiltinImport:off - Source integrity tests inspect exact repository bytes without an Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";
import { PNG } from "pngjs";

import { CHANNEL_WORDMARK_BAND_TOP, MASTER_RASTER_SIZE } from "./brand-assets.ts";

const REPOSITORY_ROOT = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
const APPROVED_PRODUCTION_SHA256 =
  "122d1c2349cf004c0d38e6d4a5b1b2f21783b25cf459af91b66ce9561a0f40d4";
const APPROVED_LOGO_128_SHA256 = "80d36634edb03a42044cc5a6199467c2a0764d5060dc6015ea64af304bffac00";
const APPROVED_DESKTOP_SHA256 = "b16b7c50c80d41571e35f7e6b18b698baa06c6f3f33f9682bc65f8b6d81c405f";
const APPROVED_SPLASH_MARK_SHA256 =
  "8d3d493c764ad3aa2372d0fd2eb93996023c808b79a1f77d1e5ad3f9ca36994f";
const EXPECTED_RASTER_SIZE = MASTER_RASTER_SIZE;
const EXPECTED_SPLASH_MARK_SIZE = 1024;
/**
 * Floors for how much of the wordmark band a channel treatment has to cover.
 * Measured at 2076 differing pixels for development against production, 4118
 * for nightly, and 5099 between the two. These stay floors, never exact
 * counts, so re-rendering the wordmark does not break the guard.
 */
const MIN_WORDMARK_PIXELS_VS_PRODUCTION = 1000;
const MIN_WORDMARK_PIXELS_BETWEEN_CHANNELS = 2000;

const sourcePath = (relativePath: string) => `${REPOSITORY_ROOT}/${relativePath}`;
const readSource = (relativePath: string) => NodeFS.readFileSync(sourcePath(relativePath));
const readSvg = (relativePath: string) => readSource(relativePath).toString("utf8");
const readPng = (relativePath: string) => PNG.sync.read(readSource(relativePath));

function rgbaAt(image: PNG, x: number, y: number): ReadonlyArray<number> {
  const offset = (image.width * y + x) * 4;
  return [
    image.data[offset]!,
    image.data[offset + 1]!,
    image.data[offset + 2]!,
    image.data[offset + 3]!,
  ];
}

/**
 * Both pixel walkers below address `actual` and `expected` through
 * `expected.width`. On mismatched sizes that reads the wrong pixels, and
 * `subarray` clamps at the end of the buffer so two short slices compare
 * equal and the walk reports a false pass. Assert the shapes first.
 */
function expectMatchingDimensions(actual: PNG, expected: PNG): void {
  expect({ width: actual.width, height: actual.height }).toEqual({
    width: expected.width,
    height: expected.height,
  });
}

function expectPixelRegionToEqual(
  actual: PNG,
  expected: PNG,
  region: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
): void {
  expectMatchingDimensions(actual, expected);
  let everyRowMatches = true;
  for (let y = region.y; y < region.y + region.height; y += 1) {
    const rowStart = (expected.width * y + region.x) * 4;
    const rowEnd = rowStart + region.width * 4;
    everyRowMatches &&= actual.data
      .subarray(rowStart, rowEnd)
      .equals(expected.data.subarray(rowStart, rowEnd));
  }
  expect(everyRowMatches).toBe(true);
}

function countDifferingPixels(
  actual: PNG,
  expected: PNG,
  region: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
): number {
  expectMatchingDimensions(actual, expected);
  let differingPixels = 0;
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      const offset = (expected.width * y + x) * 4;
      const isEqual = actual.data
        .subarray(offset, offset + 4)
        .equals(expected.data.subarray(offset, offset + 4));
      if (!isEqual) differingPixels += 1;
    }
  }
  return differingPixels;
}

function expectWellFormedSvgWithOnlyPaths(svg: string): void {
  const elementNames = [...svg.matchAll(/<\/?([a-z][\w:-]*)\b[^>]*\/?>/gi)].map(
    (match) => match[1]!,
  );
  expect(new Set(elementNames)).toEqual(new Set(["svg", "path"]));

  const openElements: string[] = [];
  for (const match of svg.matchAll(/<(\/)?([a-z][\w:-]*)\b[^>]*?(\/?)>/gi)) {
    const [, closing, elementName, selfClosing] = match;
    if (closing) {
      expect(openElements.pop()).toBe(elementName);
    } else if (!selfClosing) {
      openElements.push(elementName!);
    }
  }
  expect(openElements).toEqual([]);
}

describe("Mesura Code icon sources", () => {
  it("keeps the approved production master byte-identical", () => {
    const master = readSource("assets/mesura-code/production-master.png");
    const png = PNG.sync.read(master);

    expect(NodeCrypto.createHash("sha256").update(master).digest("hex")).toBe(
      APPROVED_PRODUCTION_SHA256,
    );
    expect({ width: png.width, height: png.height }).toEqual({
      width: EXPECTED_RASTER_SIZE,
      height: EXPECTED_RASTER_SIZE,
    });
  });

  it("keeps the approved cube unchanged while channel treatments stay peripheral", () => {
    const production = readPng("assets/mesura-code/production-master.png");
    const development = readPng("assets/mesura-code/development-master.png");
    const nightly = readPng("assets/mesura-code/nightly-master.png");
    const wordmarkBand = {
      x: 0,
      y: CHANNEL_WORDMARK_BAND_TOP,
      width: EXPECTED_RASTER_SIZE,
      height: EXPECTED_RASTER_SIZE - CHANNEL_WORDMARK_BAND_TOP,
    };

    for (const channel of [development, nightly]) {
      expect({ width: channel.width, height: channel.height }).toEqual({
        width: production.width,
        height: production.height,
      });
      // Everything above the wordmark band is production's artwork verbatim,
      // which is what rules out a channel frame around the cube.
      expectPixelRegionToEqual(channel, production, {
        x: 0,
        y: 0,
        width: EXPECTED_RASTER_SIZE,
        height: CHANNEL_WORDMARK_BAND_TOP,
      });
      expect(countDifferingPixels(channel, production, wordmarkBand)).toBeGreaterThan(
        MIN_WORDMARK_PIXELS_VS_PRODUCTION,
      );
    }

    // A frame would tint the corners; a wordmark leaves them alone.
    expect(rgbaAt(development, 32, 32)).toEqual(rgbaAt(production, 32, 32));
    expect(rgbaAt(nightly, 32, 32)).toEqual(rgbaAt(production, 32, 32));
    // DEV and NIGHTLY are different words, so the band cannot be shared art.
    expect(countDifferingPixels(development, nightly, wordmarkBand)).toBeGreaterThan(
      MIN_WORDMARK_PIXELS_BETWEEN_CHANNELS,
    );
  });

  it("draws the boot splash mark as a container-free transparent cube", () => {
    const source = readSource("assets/mesura-code/splash-mark.png");
    const splashMark = PNG.sync.read(source);

    expect(NodeCrypto.createHash("sha256").update(source).digest("hex")).toBe(
      APPROVED_SPLASH_MARK_SHA256,
    );
    expect({ width: splashMark.width, height: splashMark.height }).toEqual({
      width: EXPECTED_SPLASH_MARK_SIZE,
      height: EXPECTED_SPLASH_MARK_SIZE,
    });
    // No field and no container: the corners and the full margin are clear, so
    // the mark reads on a light splash background as well as a dark one.
    for (const [x, y] of [
      [0, 0],
      [EXPECTED_SPLASH_MARK_SIZE - 1, 0],
      [0, EXPECTED_SPLASH_MARK_SIZE - 1],
      [EXPECTED_SPLASH_MARK_SIZE - 1, EXPECTED_SPLASH_MARK_SIZE - 1],
      [EXPECTED_SPLASH_MARK_SIZE / 2, 0],
    ]) {
      expect(rgbaAt(splashMark, x!, y!)[3]).toBe(0);
    }
    expect(
      rgbaAt(splashMark, EXPECTED_SPLASH_MARK_SIZE / 2, EXPECTED_SPLASH_MARK_SIZE / 2)[3],
    ).toBe(255);
  });

  it("keeps the realistic master as the only full-color source at small sizes", () => {
    const master = readSource("assets/mesura-code/production-master.png");

    expect(NodeFS.existsSync(sourcePath("assets/mesura-code/reduced.svg"))).toBe(false);
    expect(NodeCrypto.createHash("sha256").update(master).digest("hex")).toBe(
      APPROVED_PRODUCTION_SHA256,
    );
  });

  it("keeps the approved rounded desktop icon exact", () => {
    const desktopMaster = readSource("assets/mesura-code/desktop-master.png");
    const png = PNG.sync.read(desktopMaster);

    expect(NodeCrypto.createHash("sha256").update(desktopMaster).digest("hex")).toBe(
      APPROVED_DESKTOP_SHA256,
    );
    expect({ width: png.width, height: png.height }).toEqual({ width: 1024, height: 1024 });
    expect(rgbaAt(png, 0, 0)[3]).toBe(0);
    expect(rgbaAt(png, 512, 64)).toEqual([37, 37, 39, 255]);
    expect(rgbaAt(png, 512, 512)[3]).toBe(255);
  });

  it("defines a transparent single-color template mark", () => {
    const monochrome = readSvg("assets/mesura-code/monochrome.svg");

    expectWellFormedSvgWithOnlyPaths(monochrome);
    expect(monochrome).toContain('viewBox="0 0 128 128"');
    expect(monochrome.match(/<path\b/g)).toHaveLength(3);
    expect(monochrome.match(/fill="currentColor"/g)).toHaveLength(3);
    expect(monochrome).not.toMatch(/<(?:rect|filter|image|text)\b/);
    expect(monochrome).not.toMatch(/(?:gradient|mask|#[0-9a-f]{3,8})/i);
    for (const paint of monochrome.matchAll(/\b(?:fill|stroke)="([^"]+)"/g)) {
      expect(["currentColor", "none"]).toContain(paint[1]);
    }
  });

  it("replaces the production T3 logo SVG with the realistic cube", () => {
    const logo = readSvg("assets/prod/logo.svg");
    const markupWithoutImagePayload = logo.replace(/base64,[^"]+/, "base64,");
    const encodedImage = logo.match(/href="data:image\/png;base64,([^"]+)"/)?.[1];
    expect(encodedImage).toBeDefined();
    const image = Buffer.from(encodedImage!, "base64");
    const png = PNG.sync.read(image);

    expect(logo).toContain('aria-label="Mesura Code"');
    expect(logo).toContain('viewBox="0 0 128 128"');
    expect(logo).toContain('href="data:image/png;base64,');
    expect(logo).not.toContain("<path");
    expect(markupWithoutImagePayload).not.toContain("T3");
    expect({ width: png.width, height: png.height }).toEqual({ width: 128, height: 128 });
    expect(NodeCrypto.createHash("sha256").update(image).digest("hex")).toBe(
      APPROVED_LOGO_128_SHA256,
    );
  });

  it("keeps the complete icon source contract structurally valid", () => {
    for (const relativePath of [
      "assets/mesura-code/production-master.png",
      "assets/mesura-code/development-master.png",
      "assets/mesura-code/nightly-master.png",
      "assets/mesura-code/desktop-master.png",
      "assets/mesura-code/splash-mark.png",
    ]) {
      const png = readPng(relativePath);
      const expectedSize =
        relativePath.endsWith("desktop-master.png") || relativePath.endsWith("splash-mark.png")
          ? 1024
          : EXPECTED_RASTER_SIZE;
      expect({ width: png.width, height: png.height }).toEqual({
        width: expectedSize,
        height: expectedSize,
      });
    }

    expect(readSvg("assets/mesura-code/monochrome.svg")).toContain('viewBox="0 0 128 128"');
  });
});
