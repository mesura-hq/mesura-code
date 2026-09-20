import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { build as esbuild } from "esbuild";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const out = `${appDir}/dist-electron`;

await rm(out, { recursive: true, force: true });

/**
 * What must not be bundled.
 *
 * `electron` is supplied by the runtime, and it is now the only entry. The list
 * also held `@parcel/watcher`, a native module whose CommonJS entry became an
 * unsupported dynamic require once bundled into ESM. That dependency is gone —
 * it has no non-recursive mode and exhausted the inotify budget on a home
 * directory, so `node:fs.watch` replaced it. The application now ships **no
 * native modules at all**, which is a packaging property worth keeping: adding
 * one back means rebuilding it per Electron ABI.
 */
const EXTERNAL = ["electron"];

/**
 * The main process, as ESM.
 */
await esbuild({
  entryPoints: [`${appDir}/src/main/index.ts`],
  outfile: `${out}/main/index.js`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: EXTERNAL,
  sourcemap: true,
  logLevel: "info",
});

/**
 * The search worker, beside the main bundle.
 *
 * Its own bundle rather than part of the main one, because it is the entry of
 * a SEPARATE process: `utilityProcess.fork` is handed this file's path, and a
 * path into the main bundle would start a second copy of the whole
 * application. `search.ts` resolves it as `searchWorker.js` next to itself, so
 * the name here and the join there move together.
 *
 * The native engine stays external for the same reason `electron` does — a
 * `.node` binary cannot be bundled into JavaScript.
 */
await esbuild({
  entryPoints: [`${appDir}/../packages/fm-search/src/main/worker-entry-electron.ts`],
  outfile: `${out}/main/searchWorker.js`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: [...EXTERNAL, "@ff-labs/fff-node"],
  sourcemap: true,
  logLevel: "info",
});

/**
 * The preload, as CommonJS with a `.cjs` extension.
 *
 * This is not a style choice. A preload script is loaded by Electron outside
 * the module graph of the page, and the ESM preload path carries restrictions
 * this project has no reason to take on. `window.ts` points at `index.cjs`, so
 * the extension here and the path there must move together.
 */
await esbuild({
  entryPoints: [`${appDir}/src/preload/index.ts`],
  outfile: `${out}/preload/index.cjs`,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: EXTERNAL,
  sourcemap: true,
  logLevel: "info",
});
