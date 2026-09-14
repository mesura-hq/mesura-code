/**
 * The two halves of this package must not leak into each other.
 *
 * Acceptance criterion 4. The whole reason the finder ships as its own package
 * is that a host can mount the overlay WITHOUT the file manager — and that is a
 * property of the imports, not of anybody's good intentions. A convention asks;
 * this refuses.
 *
 * Modelled on `packages/fm-ui/test/originBlindness.test.ts`, which proves the
 * same shape of thing about the panel for the same reason.
 *
 * Three rules, and each has a way it would break silently:
 *
 * 1. **`src/ui` never imports Node.** The overlay runs in a sandboxed renderer
 *    with no filesystem. A `node:fs` import compiles in any host that happens
 *    to allow it and crashes in the one that does not.
 * 2. **`src/ui` never imports the file-manager panel.** That import would
 *    compile — the panel is right there in this workspace — and would quietly
 *    make the finder undeployable on its own, which nothing else would notice
 *    until a host tried it.
 * 3. **`src/main` never imports a DOM global or the panel either.** The engine
 *    runs in a utility process. `window` there is a `ReferenceError` waiting
 *    for the line to execute, which is exactly how `__dirname` shipped in an
 *    ESM bundle and stayed green through a whole phase.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const UI = fileURLToPath(new URL("../src/ui", import.meta.url));
const MAIN = fileURLToPath(new URL("../src/main", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/**
 * Every module specifier a file imports, in any of the three forms.
 *
 * The third form is the one that matters and the one an earlier version of this
 * missed: `import "node:process";` is valid ESM with no `from` clause at all,
 * so a pattern that requires one lets a Node side-effect import through and
 * reports a clean boundary. Review found that gap while nothing was exploiting
 * it, which is the only time it is cheap to find.
 */
function importsOf(file: string): string[] {
  return extractSpecifiers(readFileSync(file, "utf8"));
}

/** The extraction itself, so a test can hand it a literal rather than a file. */
function extractSpecifiers(source: string): string[] {
  const patterns = [
    /\bfrom\s+"([^"]+)"/g, // import x from "y"  /  export … from "y"
    /\bimport\s*\(\s*"([^"]+)"\s*\)/g, // import("y")
    /^\s*import\s+"([^"]+)"/gm, // import "y"
  ];
  return patterns.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1] ?? ""),
  );
}

function offenders(dir: string, forbidden: (specifier: string) => boolean): string[] {
  return sources(dir).flatMap((file) =>
    importsOf(file)
      .filter(forbidden)
      .map((specifier) => `${file} imports ${specifier}`),
  );
}

const isNodeModule = (specifier: string) => specifier.startsWith("node:");
const isPanel = (specifier: string) => specifier.startsWith("@symmetria/fm-ui");

describe("the panel half", () => {
  it("has sources to check, so this suite cannot pass by finding nothing", () => {
    // The failure this guards: a rename that empties `src/ui` would turn every
    // assertion below into a vacuous pass, and the boundary would be unguarded
    // with a green suite saying otherwise.
    expect(sources(UI).length).toBeGreaterThan(4);
  });

  it("imports no Node module, because it runs in a sandboxed renderer", () => {
    expect(offenders(UI, isNodeModule)).toEqual([]);
  });

  it("imports nothing from the file-manager panel, so a host can mount it alone", () => {
    expect(offenders(UI, isPanel)).toEqual([]);
  });

  it("would notice if either rule broke", () => {
    // Paired with the two assertions above: they check that a list is empty,
    // and this checks the checker can produce a non-empty one. Without it a
    // broken `importsOf` would satisfy both by finding no imports at all.
    expect(offenders(UI, (specifier) => specifier.startsWith("react"))).not.toEqual([]);
  });
});

describe("the privileged half", () => {
  it("has sources to check", () => {
    expect(sources(MAIN).length).toBeGreaterThan(4);
  });

  it("imports nothing from the file-manager panel either", () => {
    expect(offenders(MAIN, isPanel)).toEqual([]);
  });

  it("would notice if the panel rule broke here too", () => {
    // The UI half has this canary and this one did not, so a regression that
    // only affected matching in `src/main` would have had one fewer witness.
    // The extraction function is shared, but "shared today" is not a reason to
    // leave half of it unwatched.
    expect(offenders(MAIN, (specifier) => specifier.startsWith("./"))).not.toEqual([]);
  });

  it("catches a bare side-effect import, which has no `from` clause", () => {
    // The form that slipped past an earlier version of `importsOf`. Asserted on
    // a string rather than on a file, because the point is the EXTRACTION and
    // no source in the tree has one — which is exactly why the gap was silent.
    const probe = fileURLToPath(new URL("../src/ui/index.ts", import.meta.url));
    expect(importsOf(probe).length).toBeGreaterThan(0);
    expect(extractSpecifiers('import "node:fs";\n')).toEqual(["node:fs"]);
    expect(extractSpecifiers('import { a } from "b";\n')).toEqual(["b"]);
    expect(extractSpecifiers('await import("c");\n')).toEqual(["c"]);
  });

  it("names no DOM global, because it runs in a utility process", () => {
    // Not an import rule but the same class of fault, and the one that already
    // bit this package once in the other direction: `__dirname` in an ESM
    // bundle is not a compile error, not a bundling error and not a boot error
    // — it is a `ReferenceError` thrown the first time the line runs.
    const named = sources(MAIN).flatMap((file) => {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      return /(?<![\w$.])(window|document|localStorage)(?![\w$])/.test(code) ? [file] : [];
    });
    expect(named).toEqual([]);
  });
});
