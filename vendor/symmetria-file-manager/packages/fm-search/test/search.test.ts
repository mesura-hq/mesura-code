/**
 * Creating an index and searching it, against a real tree on disk.
 *
 * Acceptance criteria 2 and 7. This drives the actual engine rather than a
 * fake, because the thing worth proving is that the wrapper's contract with
 * `@ff-labs/fff-node` holds — a fake would only prove the wrapper agrees with
 * my idea of the engine.
 *
 * The store is isolated into a temp directory through `SYMMETRIA_FM_FRECENCY_DIR`
 * so the run cannot touch the operator's real one.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createIndex, type SearchIndex } from "../src/main/index.ts";

let root: string;
let store: string;
let index: SearchIndex;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "fm-search-tree-"));
  store = mkdtempSync(join(tmpdir(), "fm-search-store-"));
  process.env["SYMMETRIA_FM_FRECENCY_DIR"] = store;

  mkdirSync(join(root, "src", "components"), { recursive: true });
  writeFileSync(join(root, "src", "format.ts"), "export const format = 1;\n");
  writeFileSync(join(root, "src", "components", "Button.tsx"), "export const Button = 1;\n");
  writeFileSync(join(root, "README.md"), "# readme\n");

  index = await createIndex(root);
}, 30_000);

afterAll(() => {
  index?.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(store, { recursive: true, force: true });
});

describe("createIndex and search", () => {
  it("returns named suggestions from the index for an empty query", () => {
    const rows = index.search("");
    expect(rows.map((row) => row.name)).toContain("README.md");
    expect(rows.some((row) => row.isDir)).toBe(true);
    expect(rows.every((row) => row.relativePath !== "" && row.name !== "")).toBe(true);
    expect(rows.every((row) => row.matchIndices.length === 0)).toBe(true);
  });

  it("finds a file by a fuzzy fragment of its name", () => {
    const rows = index.search("format");
    expect(rows.map((row) => row.name)).toContain("format.ts");
  });

  it("returns the file's absolute path, rooted at the indexed directory", () => {
    const row = index.search("format").find((candidate) => candidate.name === "format.ts");
    expect(row?.fullPath).toBe(join(root, "src", "format.ts"));
  });

  it("returns directories as well as files", () => {
    // The mixed search is what makes directory navigation possible in the
    // overlay. The files-only call would return none of these.
    const rows = index.search("components");
    expect(rows.some((row) => row.isDir)).toBe(true);
  });

  it("ranks the rows, best first", () => {
    const rows = index.search("t");
    // Ordering over fewer than two rows is vacuous, so require the sample
    // before asserting the order.
    expect(rows.length).toBeGreaterThan(1);
    const scores = rows.map((row) => row.score);
    expect(scores).toEqual([...scores].sort((left, right) => right - left));
  });

  it("returns an empty list for a query nothing matches", () => {
    // Paired with a query that DOES match, so an engine returning nothing at
    // all cannot pass this test.
    expect(index.search("format").length).toBeGreaterThan(0);
    expect(index.search("zzzznothingmatchesthis")).toEqual([]);
  });

  it("carries matched positions on each returned row", () => {
    const row = index.search("format").find((candidate) => candidate.name === "format.ts");
    expect(row?.matchIndices.length).toBeGreaterThan(0);
  });
});
