import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The renderer's Content Security Policy, pinned.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Nothing asserted this policy at all, and a missing source in it cost a whole
 * feature. `img-src` had no `blob:`, so every embedded cover art was blocked by
 * Chromium before it decoded: the image reported zero natural width, the pane
 * quietly showed its placeholder, and the only trace was a console message
 * nobody was reading. It looked exactly like a file that carries no artwork.
 *
 * No unit test could have caught it — this policy lives in a `<meta>` tag in a
 * document happy-dom never loads — but a test CAN state what the policy must
 * contain, which is what would have made the removal of a source a failing
 * check rather than a silent regression.
 *
 * **These assertions are about the CONTRACT, not the formatting.** Each one
 * names a directive and a source together with the reason that source is there,
 * so a future edit that drops one fails with the reason attached.
 */

const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");

/** The policy's value, as one string. */
const policy = (() => {
  const match = /http-equiv="Content-Security-Policy"\s*\n?\s*content="([^"]+)"/.exec(html);
  if (match?.[1] === undefined)
    throw new Error("no Content-Security-Policy meta tag in index.html");
  return match[1];
})();

/** One directive's source list. */
function sourcesFor(directive: string): string[] {
  const found = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${directive} `) || part === directive);

  return found === undefined ? [] : found.split(/\s+/).slice(1);
}

describe("the policy exists at all", () => {
  it("is declared in the document the renderer loads", () => {
    // A renderer with no policy is a renderer with every default allowed, and
    // the failure mode is silence in exactly the opposite direction.
    expect(policy.length).toBeGreaterThan(0);
  });

  it("defaults to allowing only the application's own origin", () => {
    expect(sourcesFor("default-src")).toEqual(["'self'"]);
  });
});

describe("what each directive must keep allowing", () => {
  it("allows blob: images, or cover art silently disappears", () => {
    // The defect this whole file was written for. Cover art crosses from the
    // tag worker as BYTES and is turned into a blob URL in the renderer, so
    // without this source the image is blocked and the pane shows a
    // placeholder that looks like a correct answer.
    expect(sourcesFor("img-src")).toContain("blob:");
  });

  it("still allows data: images", () => {
    expect(sourcesFor("img-src")).toContain("data:");
  });

  it("allows blob: workers, which is how a bundled worker is started", () => {
    expect(sourcesFor("worker-src")).toContain("blob:");
  });

  it("allows WebAssembly to be compiled", () => {
    // Electron's own security guide recommends `script-src 'self'` and never
    // mentions WASM, so following it verbatim breaks any WASM decoder shipped
    // later — silently, when a preview goes blank.
    expect(sourcesFor("script-src")).toContain("'wasm-unsafe-eval'");
  });
});

describe("what it must NOT start allowing", () => {
  it("permits no remote origin anywhere", () => {
    // The renderer is sandboxed and offline by design: every byte it shows
    // arrives from the main process over the bridge or the app's own scheme.
    // A `http:` or `https:` source appearing here would mean a preview could
    // reach the network, which is a different application.
    expect(policy).not.toMatch(/https?:/);
  });

  it("permits no inline or evaluated script", () => {
    // `'unsafe-inline'` and `'unsafe-eval'` in `script-src` would undo the
    // reason this policy exists. `'wasm-unsafe-eval'` is a different, narrower
    // grant and is asserted as required above.
    const scripts = sourcesFor("script-src");
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
  });

  it("keeps the escape hatch closed on object-src", () => {
    expect(sourcesFor("object-src")).toEqual(["'self'"]);
  });
});
