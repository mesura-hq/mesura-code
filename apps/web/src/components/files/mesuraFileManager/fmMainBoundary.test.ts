// @effect-diagnostics nodeBuiltinImport:off - a source walk over the checkout, outside any Effect
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

/**
 * The web app may import only the channel table from `@symmetria/fm-main`, the file
 * manager's privileged half. Any other subpath pulls `node:fs` or Electron into the
 * browser bundle, and fails as a build or a blank page rather than a type error.
 */
const webSource = NodeURL.fileURLToPath(new URL("../../..", import.meta.url));
const ALLOWED = new Set(["@symmetria/fm-main/ipc/channels"]);

function sources(directory: string): string[] {
  return NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("the web app's use of the file manager's privileged half", () => {
  it("imports only the channel table from @symmetria/fm-main", () => {
    const files = sources(webSource);
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.flatMap((file) => {
      const source = NodeFS.readFileSync(file, "utf8");
      const imported = [...source.matchAll(/from\s+["'](@symmetria\/fm-main[^"']*)["']/g)].map(
        (match) => match[1] ?? "",
      );
      return imported
        .filter((specifier) => !ALLOWED.has(specifier))
        .map((specifier) => `${NodePath.relative(webSource, file)}: ${specifier}`);
    });
    expect(offenders).toEqual([]);
  });
});
