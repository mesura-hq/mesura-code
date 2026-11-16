// @effect-diagnostics nodeBuiltinImport:off - reads the source tree to pin a disabled feature.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

/**
 * Upstream's GitHub star prompt asks users to star `pingdotgg/t3code`. Mesura
 * Code keeps the module so syncs merge cleanly, but no production code may
 * reach it: a sync that wires it back in fails here instead of shipping the ask.
 */

const thisFile = NodeURL.fileURLToPath(import.meta.url);
const webSource = NodePath.resolve(NodePath.dirname(thisFile), "..");

function productionSourceFiles(directory: string): string[] {
  return NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return productionSourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("the GitHub star prompt is disabled", () => {
  it("no production module imports it", () => {
    const files = productionSourceFiles(webSource);
    // A mis-rooted scan would find nothing to flag; known files prove the root.
    expect(files.some((file) => file.endsWith("/components/chat/useComposerSend.ts"))).toBe(true);
    expect(files.some((file) => file.endsWith("/components/GitHubStarPrompt.tsx"))).toBe(true);
    const importers = files.filter((file) =>
      /from ["'][^"']*\/GitHubStarPrompt["']|import\(["'][^"']*\/GitHubStarPrompt["']\)/.test(
        NodeFS.readFileSync(file, "utf8"),
      ),
    );
    expect(importers.map((file) => NodePath.relative(webSource, file))).toEqual([]);
  });
});
