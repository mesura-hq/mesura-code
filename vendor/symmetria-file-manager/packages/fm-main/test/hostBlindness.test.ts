import { readdirSync, readFileSync, statSync } from "node:fs";
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

describe("the privileged half is host-blind", () => {
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
