/**
 * Two indices, two processes, one store.
 *
 * Acceptance criterion 2, and the one thing in this phase a single-process test
 * cannot prove. The store refuses a second open inside ONE program, so the
 * claim "a second index over a different directory starts while the first is
 * alive" is only meaningful across a real process boundary.
 *
 * These are Node forks rather than Electron utility processes, because vitest
 * runs under Node and `utilityProcess` exists only inside an Electron main
 * process. What is being proved is the STORE's behaviour under two openers,
 * which is a property of the engine and not of Electron's process wrapper —
 * the spike that measured this used Electron and got the same answer at N = 2,
 * 4 and 8.
 */
import { type ChildProcess, fork } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { WorkerMessage, WorkerRequest } from "../src/main/worker.ts";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "main", "worker-entry.ts");

let store: string;
let rootA: string;
let rootB: string;
const spawned: ChildProcess[] = [];

/** Fork a worker over `directory` and resolve once it says it is ready. */
function startWorker(directory: string): Promise<ChildProcess> {
  // No loader flag: Node 26 strips types natively, and this repository has no
  // `tsx`. `execArgv: []` rather than inheriting, because the parent here is
  // vitest and its own flags have no business in the child.
  const child = fork(ENTRY, [directory], {
    execArgv: [],
    env: { ...process.env, SYMMETRIA_FM_FRECENCY_DIR: store, ELECTRON_RUN_AS_NODE: undefined },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  spawned.push(child);
  // Surfaced, not swallowed: a child that dies during startup would otherwise
  // present as a bare readiness timeout with its reason on an unread pipe.
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[worker ${directory}] ${chunk.toString()}`);
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`worker for ${directory} never became ready`)),
      60_000,
    );
    child.on("message", (message: WorkerMessage) => {
      if (!("ready" in message)) return;
      clearTimeout(timer);
      if (message.ready) resolve(child);
      else reject(new Error(`worker for ${directory} failed: ${message.reason}`));
    });
    child.on("error", (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
  });
}

/** Ask a live worker for one search and wait for the matching reply. */
function ask(child: ChildProcess, id: number, query: string): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no reply")), 30_000);
    const listener = (message: WorkerMessage) => {
      if (!("id" in message) || message.id !== id) return;
      clearTimeout(timer);
      child.off("message", listener);
      resolve(message);
    };
    child.on("message", listener);
    const request: WorkerRequest = { id, kind: "search", query };
    child.send(request);
  });
}

beforeAll(() => {
  store = mkdtempSync(join(tmpdir(), "fm-search-topology-store-"));
  rootA = mkdtempSync(join(tmpdir(), "fm-search-topology-a-"));
  rootB = mkdtempSync(join(tmpdir(), "fm-search-topology-b-"));
  mkdirSync(join(rootA, "src"), { recursive: true });
  writeFileSync(join(rootA, "src", "alpha.ts"), "export const alpha = 1;\n");
  writeFileSync(join(rootB, "bravo.ts"), "export const bravo = 1;\n");
});

afterAll(() => {
  for (const child of spawned) child.kill("SIGKILL");
  for (const path of [store, rootA, rootB]) rmSync(path, { recursive: true, force: true });
});

describe("two indices over different directories, sharing one store", () => {
  it("both start, both stay alive, and both answer their own tree", async () => {
    const workerA = await startWorker(rootA);
    const workerB = await startWorker(rootB);

    // Both alive at the same moment: B was started while A was still running,
    // and A is asked AFTER B exists.
    expect(workerA.killed).toBe(false);
    expect(workerB.killed).toBe(false);

    const fromB = await ask(workerB, 1, "bravo");
    const fromA = await ask(workerA, 2, "alpha");

    expect(fromB).toMatchObject({ id: 1, ok: true });
    expect(fromA).toMatchObject({ id: 2, ok: true });
    if (!("reply" in fromA) || !("reply" in fromB)) throw new Error("expected replies");

    // Each answers from its OWN tree, which is what proves they are two
    // independent indices rather than one shared engine whose path was swapped.
    expect(fromA.reply.rows.map((row) => row.name)).toContain("alpha.ts");
    expect(fromB.reply.rows.map((row) => row.name)).toContain("bravo.ts");
    expect(fromA.reply.rows.map((row) => row.name)).not.toContain("bravo.ts");
  }, 120_000);
});

describe("the reply the worker sends", () => {
  it("echoes the query it answered and reports the cap", async () => {
    const worker = await startWorker(rootA);
    const message = await ask(worker, 7, "alpha");
    if (!("reply" in message)) throw new Error("expected a reply");
    expect(message.reply.matchedQuery).toBe("alpha");
    expect(message.reply.cap).toBe(200);
    expect(message.reply.truncated).toBe(false);
  }, 120_000);
});
