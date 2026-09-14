/**
 * The built search worker must be able to load what it does not bundle.
 *
 * This exists because of a defect that every other test was structurally blind
 * to. `@ff-labs/fff-node` is a native module, so `build.mjs` marks it EXTERNAL —
 * correct, a `.node` binary cannot be bundled into JavaScript. But pnpm's
 * `node_modules` is strict: a package is linked only into the workspace package
 * that DECLARES it. `@ff-labs/fff-node` was declared by `packages/fm-search`
 * alone, and Node resolves from the importing FILE's location — so the bundle
 * at `app/dist-electron/main/` walked up through `app/` and the repository root
 * and found nothing.
 *
 * Every unit test passed throughout, because they import the TypeScript source
 * from inside `packages/fm-search`, where resolution has always worked. Only
 * the built artefact, run from where it ships, was broken. Independent
 * verification found it by forking the real bundle; nothing in the suite could.
 *
 * The check is a real resolution from the real directory, in a real process.
 * `createRequire(...).resolve` is NOT usable here: the package is
 * ESM-exports-only, so a CommonJS resolve reports `ERR_PACKAGE_PATH_NOT_EXPORTED`
 * for a package it found perfectly well — an error that has to be told apart
 * from a genuine miss, which is precisely the distinction worth not guessing at.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const bundleDir = fileURLToPath(new URL("../dist-electron/main", import.meta.url));
const bundle = `${bundleDir}/searchWorker.js`;

/**
 * The bundles built as ES modules.
 *
 * The preload is deliberately absent: it is emitted as CommonJS (`index.cjs`),
 * where `__dirname` is not only legal but correct.
 */
const ESM_BUNDLES = [bundle, `${bundleDir}/index.js`];

/** The globals that exist in CommonJS and do not exist in an ES module. */
const COMMONJS_GLOBALS = /(?<![\w$.])(__dirname|__filename|module\.exports|exports\.)/;

/** Every bare specifier the bundle imports, builtins excluded. */
function externalImports(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/^import\s[^;]*?\sfrom\s"([^"]+)";$/gm)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    if (specifier.startsWith("node:") || specifier.startsWith(".")) continue;
    found.add(specifier);
  }
  return [...found];
}

/** Whether `specifier` resolves as ESM from the bundle's own directory. */
function resolvesFromBundleDir(specifier: string): boolean {
  try {
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(specifier)})`],
      { cwd: bundleDir, stdio: "pipe", timeout: 30_000 },
    );
    return true;
  } catch {
    return false;
  }
}

describe("the built search worker", () => {
  it("leaves the native engine external rather than bundling a .node binary", () => {
    // The premise of the test below. If this ever stops holding, the resolution
    // check underneath it would pass for the uninteresting reason.
    expect(externalImports(readFileSync(bundle, "utf8"))).toContain("@ff-labs/fff-node");
  });

  it("can load every package it left external, from where it ships", () => {
    const specifiers = externalImports(readFileSync(bundle, "utf8"));
    const unresolvable = specifiers.filter((specifier) => !resolvesFromBundleDir(specifier));
    expect(unresolvable).toEqual([]);
  });

  it("reports a package that genuinely is not there", () => {
    // Paired with the assertion above so a resolver that answered "yes" to
    // everything could not pass it for free.
    expect(resolvesFromBundleDir("@ff-labs/not-a-real-package")).toBe(false);
  });
});

describe("the ESM bundles", () => {
  it("reference no CommonJS global", () => {
    // `__dirname` in an ES module is not a compile error, not a bundling error
    // and not a boot error. It is a `ReferenceError` thrown the first time the
    // line runs — which for the search worker's path was the first search of a
    // session, weeks of green tests after it was written. esbuild does not shim
    // the CommonJS globals into an ESM output, and nothing else in this
    // repository would have noticed.
    const offences: string[] = [];
    for (const file of ESM_BUNDLES) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (COMMONJS_GLOBALS.test(line)) offences.push(`${file}:${index + 1}: ${line.trim()}`);
        });
    }
    expect(offences).toEqual([]);
  });

  it("resolve their sibling files through `import.meta.url` instead", () => {
    // Paired with the assertion above, so a check that simply found nothing —
    // an empty file list, a regex that matches nothing — could not pass it for
    // free. This is the form the same problem has to be solved in.
    const main = readFileSync(`${bundleDir}/index.js`, "utf8");
    expect(main).toContain("import.meta.url");
  });
});
