// @effect-diagnostics nodeBuiltinImport:off - Branding contracts inspect repository-owned package assets and documentation.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

const REPOSITORY_ROOT = NodePath.resolve(import.meta.dirname, "..");

function readRepositoryFile(relativePath: string): string {
  return NodeFS.readFileSync(NodePath.join(REPOSITORY_ROOT, relativePath), "utf8");
}

describe("application branding residuals", () => {
  it("uses Mesura Code labels in both desktop installer backgrounds", () => {
    const expectations = [
      ["apps/desktop/resources/dmg/dmg-background-latest.svg", "LATEST RELEASE"],
      ["apps/desktop/resources/dmg/dmg-background-nightly.svg", "NIGHTLY BUILD"],
    ] as const;

    for (const [relativePath, releaseLabel] of expectations) {
      const source = readRepositoryFile(relativePath);
      expect(source).toContain(">MESURA CODE</text>");
      expect(source).toContain(releaseLabel);
      expect(source).not.toContain(">T3 CODE</text>");
    }
  });

  it("keeps visible application vectors free of textual T3 artwork", () => {
    for (const relativePath of [
      "apps/desktop/resources/dmg/dmg-background-latest.svg",
      "apps/desktop/resources/dmg/dmg-background-nightly.svg",
      "assets/mesura-code/monochrome.svg",
      "assets/prod/logo.svg",
    ]) {
      expect(readRepositoryFile(relativePath)).not.toMatch(
        /(?:>\s*T3(?: CODE)?\s*<|aria-label=["']T3)/i,
      );
    }
  });

  it("documents the repository source family and Arch export commands", () => {
    const readme = readRepositoryFile("assets/README.md");

    expect(readme).toContain("assets/mesura-code/production-master.png");
    expect(readme).toContain("assets/mesura-code/development-master.png");
    expect(readme).toContain("assets/mesura-code/nightly-master.png");
    expect(readme).toContain("assets/mesura-code/monochrome.svg");
    expect(readme).toContain("assets/mesura-code/desktop-master.png");
    expect(readme).toContain("vp run icons:export");
    expect(readme).toContain("vp run icons:check");
    expect(readme).toMatch(/Arch Linux/i);
    expect(readme).not.toContain("Each project uses `text.svg` for the T3 mark");
  });

  it("documents the exact deferred native macOS handoff", () => {
    const readme = readRepositoryFile("assets/README.md");

    for (const mapping of [
      "assets/dev/app-icon.icon` -> `assets/dev/blueprint-macos-1024.png",
      "assets/nightly/app-icon.icon` -> `assets/nightly/nightly-macos-1024.png",
      "assets/prod/app-icon.icon` -> `assets/prod/black-macos-1024.png",
    ]) {
      expect(readme).toContain(mapping);
    }
    expect(readme).toContain("Icon Composer 2");
    expect(readme).toContain("macOS pre-Tahoe");
    expect(readme).toContain("Appearance: `Default`");
    expect(readme).toContain("Size: `1024pt`");
    expect(readme).toContain("Scale: `1×`");
    expect(readme).toContain("824×824");
    expect(readme).toMatch(/remain stale until/i);
  });

  it("keeps web entry points wired to generated application icons", () => {
    const html = readRepositoryFile("apps/web/index.html");
    const manifest = JSON.parse(readRepositoryFile("apps/web/public/manifest.webmanifest")) as {
      readonly icons: ReadonlyArray<{ readonly src: string }>;
    };

    expect(html).toContain('href="/favicon.ico"');
    expect(html).toContain('href="/apple-touch-icon.png"');
    expect(html).toContain('href="/manifest.webmanifest"');
    // The boot splash draws the container-free mark, not a launcher icon: an
    // icon's opaque field cuts a square out of the splash background.
    expect(html).toContain('src="/splash-mark.png"');
    expect(html).toContain('href="/splash-mark.png"');
    expect(
      NodeFS.existsSync(NodePath.join(REPOSITORY_ROOT, "apps/web/public/splash-mark.png")),
    ).toBe(true);
    expect(manifest.icons.map(({ src }) => src)).toEqual([
      "/favicon-32x32.png",
      "/apple-touch-icon.png",
    ]);
    for (const { src } of manifest.icons) {
      expect(NodeFS.existsSync(NodePath.join(REPOSITORY_ROOT, "apps/web/public", src))).toBe(true);
    }
  });
});
