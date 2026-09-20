import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The privileged half must not know which Electron application it is in.
 *
 * Acceptance criteria 1 and 3 of phase 3.
 *
 * **This property holds today by accident**, and that is the whole reason for
 * this file. `electronSurface.ts` is the only module here that names Electron's
 * IPC, and it exists because of an unrelated bug: `ipcMain.handle` invokes with
 * `(event, ...args)` while the registry declared one parameter, so every
 * handler was receiving the event. The adapter was the fix and host-blindness
 * was the side effect. A property that holds by accident is one edit from not
 * holding.
 *
 * The embedding this protects: inside Mesura Code there is no second process
 * and no second window — the file manager is a component in that application's
 * renderer, and this package registers its handlers in that application's main
 * process. A `BrowserWindow` reference here is the one thing an embedding host
 * could not satisfy.
 */
const root = fileURLToPath(new URL("../src", import.meta.url));

/** Every `.ts` file under a directory, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

/** Source with every comment line removed, so prose cannot fail a test. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

/**
 * Does this line import the part of Electron that belongs to ONE application?
 *
 * Not "does it import Electron at all", and the distinction is the plan's
 * rather than a softening of it. The criterion names `BrowserWindow` and the
 * `app` object, because those are what an embedding host already owns and
 * cannot hand over. `shell`, `clipboard` and `nativeImage` are process-wide
 * APIs available in ANY Electron main process — the operations use them, and
 * they tie this package to Electron without tying it to one application.
 *
 * The first draft of this test forbade the module outright and failed on
 * exactly those three. Forbidding them would have pushed the fix into
 * injecting three stable platform APIs through the host for no gain.
 *
 * `import type { IpcMain } from "electron"` is erased by the compiler and
 * creates no dependency at all, so it is allowed either way —
 * `electronSurface.ts` uses exactly that to describe the shape it adapts.
 */
function isHostBoundElectronImport(line: string): boolean {
  if (!/from\s+["']electron["']/.test(line)) return false;
  if (/^\s*import\s+type\b/.test(line)) return false;
  return /\b(BrowserWindow|app)\b/.test(line);
}

/**
 * Source with comments removed and every import statement on one line, so an
 * import split across lines is matched as the one statement it is.
 */
function flattenedImports(file: string): string[] {
  return code(file)
    .replace(/import\s+[^;]*?from\s+["'][^"']+["']/g, (statement) => statement.replace(/\s+/g, " "))
    .split("\n")
    .filter((line) => /^\s*import\b/.test(line));
}

/**
 * Relative VALUE imports of one file, resolved to paths under `src`.
 *
 * Only `./` and `../` specifiers: a bare specifier is a package, and packages
 * are what the walk below stops at. A type-only import is erased by the
 * compiler and creates no dependency, so it is not followed.
 */
function relativeImports(file: string): string[] {
  const dir = file.slice(0, file.lastIndexOf("/"));
  return flattenedImports(file)
    .filter((line) => !/^\s*import\s+type\b/.test(line))
    .flatMap((line) => {
      const match = /from\s+["'](\.{1,2}\/[^"']+)["']/.exec(line);
      return match?.[1] === undefined ? [] : [join(dir, match[1])];
    })
    .filter((path) => existsSync(path));
}

/** Every file reachable from `entry` through relative value imports, itself included. */
function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    pending.push(...relativeImports(file));
  }
  return [...seen];
}

/** Does this import statement bring a runtime value from Electron? Type imports are erased. */
function isElectronValueImport(line: string): boolean {
  return /from\s+["']electron["']/.test(line) && !/^\s*import\s+type\b/.test(line);
}

describe("the privileged half is host-blind", () => {
  it("lets a host with no Electron import the registry", () => {
    // The registry is what an embedding host imports to answer the bridge.
    // Every Electron-bound capability it uses (the operations, the clipboard,
    // the search pool) is injected by the host, so nothing on the registry's
    // own import graph may reach Electron at runtime.
    const offenders = reachable(join(root, "ipc/register.ts")).filter((file) =>
      flattenedImports(file).some(isElectronValueImport),
    );

    expect(offenders, `the registry reaches Electron through:\n${offenders.join("\n")}`).toEqual(
      [],
    );
  });

  it("has sources to check, so this suite cannot pass by finding nothing", () => {
    // The failure mode this exists to prevent: a wrong root directory makes
    // every assertion below iterate an empty list and pass.
    expect(sources(root).length).toBeGreaterThan(5);
  });

  it("imports no window and no application object from Electron", () => {
    const offenders = sources(root).filter((file) =>
      code(file).split("\n").some(isHostBoundElectronImport),
    );

    expect(offenders, `these import a host-bound Electron value:\n${offenders.join("\n")}`).toEqual(
      [],
    );
  });

  it("names no browser window and no application object", () => {
    // Named rather than inferred from the import, because a host could pass one
    // in as a parameter and the type annotation would name it here.
    const offenders = sources(root).filter((file) =>
      /\bBrowserWindow\b|\bapp\.(getPath|whenReady|quit|exit|on)\b/.test(code(file)),
    );

    expect(offenders, `these name a window or the app:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("names no window scheme, which belongs to whichever host serves the page", () => {
    // Comments stripped first. Two files EXPLAIN the scheme in prose — one
    // describes the traversal hole it would open, the other says why the URL
    // builder is injected rather than imported — and a test that failed on
    // those would have deleted the sentences that justify the design.
    const offenders = sources(root).filter((file) => code(file).includes("symmetria-fm://"));

    expect(offenders, `these name the host's scheme:\n${offenders.join("\n")}`).toEqual([]);
  });
});
