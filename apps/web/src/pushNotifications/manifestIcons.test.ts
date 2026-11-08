// @effect-diagnostics nodeBuiltinImport:off - reads the shipped manifest and icons off the checkout, outside any Effect.
/**
 * Entry point: `apps/web/public/manifest.webmanifest`, the file the browser
 * reads to install the app, and the PNG files it lists, read from disk.
 *
 * Phone push phase 2, criterion 8: the manifest lists 192 and 512 pixel icons.
 */
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

const PUBLIC_DIR = NodeURL.fileURLToPath(new URL("../../public/", import.meta.url));

interface ManifestIcon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
}

function readManifest(): Record<string, unknown> & { icons: ManifestIcon[] } {
  return JSON.parse(NodeFS.readFileSync(`${PUBLIC_DIR}manifest.webmanifest`, "utf8"));
}

/** Width and height from a PNG's IHDR chunk, which always follows the 8-byte signature. */
function pngSize(path: string): { width: number; height: number } {
  const bytes = NodeFS.readFileSync(path);
  expect(bytes.subarray(1, 4).toString("ascii"), `${path} is a PNG`).toBe("PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("web app manifest icons", () => {
  it.each([192, 512])(
    "manifest icons spec: the manifest lists a %i pixel PNG icon whose file has that size",
    (size) => {
      const icon = readManifest().icons.find((entry) => entry.sizes === `${size}x${size}`);
      expect(icon, `Expected a ${size}x${size} icon in the manifest`).toBeDefined();
      expect(icon!.type).toBe("image/png");
      const file = `${PUBLIC_DIR}${icon!.src.replace(/^\//, "")}`;
      expect(NodeFS.existsSync(file), `Expected ${file} to exist`).toBe(true);
      expect(pngSize(file)).toEqual({ width: size, height: size });
    },
  );

  it("manifest icons guard: the existing 32 and 180 pixel icons and the install identity stay", () => {
    const manifest = readManifest();
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        { src: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
        { src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
      ]),
    );
    expect(manifest).toMatchObject({
      id: "/",
      name: "Mesura Code",
      start_url: "/",
      scope: "/",
      display: "standalone",
    });
  });
});
