/**
 * The search pool, wired to Electron's utility processes.
 *
 * The pool's lifetime rules live in `@symmetria/fm-search`, and so does the
 * parent's half of the worker protocol (`createWorkerClient`). This file is
 * only the adapter between them and Electron: it turns "spawn a worker for this
 * directory" into a real `utilityProcess` and expresses that process as a
 * `WorkerChannel`. It is the one file in the search path that imports
 * `electron`, and it is deliberately the thinnest — everything here is
 * unreachable from a test, because a `utilityProcess` exists only inside an
 * Electron main process.
 *
 * **One index per process is not a preference.** The engine's store refuses a
 * second open inside one program, so a pool that kept two indices in the main
 * process would fail on the second directory the user opened.
 *
 * **Nothing here outlives the application.** The sweep timer is `unref`'d so it
 * cannot hold the process open on its own, and `closeAllSearchIndices` kills
 * every child. A leaked worker is the failure that takes the resident daemon
 * with it.
 */
import { fileURLToPath } from "node:url";
import { createWorkerClient, type WorkerChannel } from "@symmetria/fm-search/main/client";
import { createIndexPool, type IndexPool, type IndexWorker } from "@symmetria/fm-search/main/pool";
import type { WorkerMessage } from "@symmetria/fm-search/main/worker";
import { type UtilityProcess, utilityProcess } from "electron";

/** How often idle indices are swept. Far coarser than the timeout itself. */
const SWEEP_EVERY_MS = 60_000;

/**
 * Where the bundled worker entry lands beside this file after bundling.
 *
 * `import.meta.url` and NOT `__dirname`. The main process is bundled as ESM —
 * `app/package.json` declares `"type": "module"` and `build.mjs` emits
 * `format: "esm"` — and esbuild does not shim the CommonJS globals into an ESM
 * output. `__dirname` therefore stood in the built bundle as an unresolved
 * reference that threw the moment this line ran, which is the first search of
 * a session. Nothing caught it: the source type-checks, the bundle builds, and
 * no test loads this module because it imports `electron`. Independent
 * verification found it by driving the real window.
 *
 * `app/test/workerBundle.test.ts` now refuses a CommonJS global anywhere in the
 * ESM bundles, which is the check that holds the whole class.
 */
function workerEntry(): string {
  return fileURLToPath(new URL("./searchWorker.js", import.meta.url));
}

function spawnWorker(directory: string): IndexWorker {
  const child: UtilityProcess = utilityProcess.fork(workerEntry(), [directory], {
    serviceName: "symmetria-fm-search",
    stdio: "pipe",
  });

  // Forwarded, not left on the pipe. `stdio: "pipe"` means nothing reads the
  // child's output unless someone does, and a worker that dies during startup
  // writes its reason there — so without this the daemon's journal shows an
  // index that failed for no stated cause.
  child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));

  const channel: WorkerChannel = {
    post: (request) => child.postMessage(request),
    // SAFETY: the only writer on this channel is the worker this function just
    // forked, and `serve` sends nothing but a `WorkerMessage`. The assertion
    // restates that, because `child.on` types its listener as `(...args: any[])`.
    onMessage: (handler) => child.on("message", handler as (message: WorkerMessage) => void),
    onExit: (handler) => {
      child.on("exit", (code) => handler(`the search worker exited with code ${code}`));
    },
    kill: () => {
      child.kill();
    },
  };
  return createWorkerClient(directory, channel);
}

let pool: IndexPool | undefined;
let sweeper: NodeJS.Timeout | undefined;

export function searchPool(): IndexPool {
  if (pool === undefined) {
    pool = createIndexPool({ spawn: spawnWorker });
    sweeper = setInterval(() => pool?.sweep(), SWEEP_EVERY_MS);
    // Unref'd so an idle sweep timer can never be the reason the process stays
    // alive.
    sweeper.unref();
  }
  return pool;
}

export function closeAllSearchIndices(): void {
  if (sweeper !== undefined) clearInterval(sweeper);
  sweeper = undefined;
  pool?.closeAll();
  pool = undefined;
}
