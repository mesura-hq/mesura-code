// @effect-diagnostics nodeBuiltinImport:off - Source integrity tests inspect exact repository bytes without an Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";
import { PNG } from "pngjs";

const REPOSITORY_ROOT = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
const APPROVED_PRODUCTION_SHA256 =
  "122d1c2349cf004c0d38e6d4a5b1b2f21783b25cf459af91b66ce9561a0f40d4";
const APPROVED_LOGO_128_SHA256 = "80d36634edb03a42044cc5a6199467c2a0764d5060dc6015ea64af304bffac00";
const APPROVED_DESKTOP_SHA256 = "b16b7c50c80d41571e35f7e6b18b698baa06c6f3f33f9682bc65f8b6d81c405f";
const EXPECTED_RASTER_SIZE = 1254;

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

    for (const channel of [development, nightly]) {
      expect({ width: channel.width, height: channel.height }).toEqual({
        width: production.width,
        height: production.height,
      });
      expectPixelRegionToEqual(channel, production, {
        x: 250,
        y: 157,
        width: 754,
        height: 940,
      });
    }
    expect(rgbaAt(development, 32, 32)).toEqual([0, 99, 155, 255]);
    expect(rgbaAt(nightly, 32, 32)).toEqual([117, 101, 199, 255]);
    expect(rgbaAt(development, 32, 32)).not.toEqual(rgbaAt(nightly, 32, 32));
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
    ]) {
      const png = readPng(relativePath);
      const expectedSize = relativePath.endsWith("desktop-master.png")
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
