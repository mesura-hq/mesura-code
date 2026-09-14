/**
 * Guards — behaviour that already works and has to keep working.
 *
 * One per defect a review of this phase found and the triage fixed. A defect
 * worth fixing is worth being unable to reintroduce, and every one of these
 * passed the moment it was written, which is what separates a guard from a
 * spec.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createIndex, type SearchIndex } from "../src/main/index.ts";
import { resolveStorePaths } from "../src/main/store.ts";

describe("the store path is always absolute", () => {
  /**
   * ── The defect this guard exists to prevent ─────────────────────────────
   * With HOME and XDG_DATA_HOME both unset, this returned `.local/share/...`
   * — a RELATIVE path. Since the engine creates the directory itself, the
   * store then landed silently under whatever the process's working directory
   * happened to be, with no error and no log. A utility process with a
   * stripped environment is exactly the case the next phase introduces, so
   * this is not a hypothetical.
   */
  it("resolves absolutely even when the environment carries no home at all", () => {
    const paths = resolveStorePaths({});
    expect(paths.frecencyDbPath.startsWith("/")).toBe(true);
    expect(paths.historyDbPath.startsWith("/")).toBe(true);
  });

  it("still prefers an explicit home over the process's own", () => {
    // Paired with the case above, so "absolute" cannot be satisfied by simply
    // ignoring the environment and always using the process's home.
    const paths = resolveStorePaths({ HOME: "/home/elsewhere" });
    expect(paths.frecencyDbPath).toBe("/home/elsewhere/.local/share/symmetria/fff/frecency");
  });
});

describe("the aggregate entry point exposes one way in per symbol", () => {
  /**
   * ── The defect this guard exists to prevent ─────────────────────────────
   * `./main` re-exported `matchIndices` and `resolveStorePaths`, which are
   * also reachable at `./main/match` and `./main/store`. Two import paths for
   * one symbol is two things to keep in step, and every sibling package in
   * this repository uses exactly one.
   */
  it("does not re-export what the granular entry points already own", async () => {
    const entry = await import("../src/main/index.ts");
    expect(Object.keys(entry).sort()).toEqual(["createIndex"]);
  });
});

describe("an index that has been created is ready to search", () => {
  let root: string;
  let store: string;
  let index: SearchIndex;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "fm-search-guard-tree-"));
    store = mkdtempSync(join(tmpdir(), "fm-search-guard-store-"));
    process.env["SYMMETRIA_FM_FRECENCY_DIR"] = store;
    writeFileSync(join(root, "guarded.ts"), "export const guarded = 1;\n");
    index = await createIndex(root);
  }, 40_000);

  afterAll(() => {
    index?.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  });

  /**
   * ── The defect this guard exists to prevent ─────────────────────────────
   * `createIndex` awaited the scan and then DISCARDED its result, so a timeout
   * or an engine error resolved as success and the first search ran against a
   * partial index — a partial answer presented as a complete one, which is the
   * exact failure the await exists to avoid.
   */
  it("answers the very first search, with no polling or retry", () => {
    expect(index.search("guarded").map((row) => row.name)).toContain("guarded.ts");
  });

  /**
   * ── The defect this guard exists to prevent ─────────────────────────────
   * `close()` called `destroy()` unguarded. A consumer that closes on
   * window-close AND on process exit would have released the native handle
   * twice, and what that does is not something this package should discover in
   * production.
   */
  it("survives being closed twice", () => {
    expect(() => {
      index.close();
      index.close();
    }).not.toThrow();
  });
});
