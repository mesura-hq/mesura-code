/**
 * Mapping one engine item into a row.
 *
 * Acceptance criteria 3 and 4. The row shape is modelled on the Qt struct at
 * `plugin/src/Symmetria/FileManager/Models/fuzzyfinder.hpp`, which is the
 * reference for this port.
 *
 * Two things the engine does NOT give us and this has to derive: `fullPath`,
 * which is the search root joined to the relative path, and `isDir`, which is
 * the discriminant of the item union. The Qt struct derives both the same way.
 */
import type { DirItem, FileItem, MixedItem, Score } from "@ff-labs/fff-node";
import { describe, expect, it } from "vitest";

import { toRow } from "../src/main/rows.ts";

const ROOT = "/home/jc/projects/app";

/** A file item as the engine reports one. `modified` is Unix SECONDS. */
function fileItem(relativePath: string, fileName: string): MixedItem {
  const item: FileItem = {
    relativePath,
    fileName,
    size: 4096,
    modified: 1_700_000_000,
    accessFrecencyScore: 0,
    modificationFrecencyScore: 0,
    totalFrecencyScore: 0,
    gitStatus: "modified",
  };
  return { type: "file", item };
}

/**
 * A directory item.
 *
 * `DirItem` carries far less than a file: no size, no modification time, no
 * git status. Its `dirName` INCLUDES the trailing separator, which is why the
 * display-name assertions below are worth making.
 */
function dirItem(relativePath: string, dirName: string): MixedItem {
  const item: DirItem = { relativePath, dirName, maxAccessFrecency: 0 };
  return { type: "directory", item };
}

const score: Score = {
  total: 142,
  baseScore: 100,
  filenameBonus: 42,
  specialFilenameBonus: 0,
  frecencyBoost: 0,
  distancePenalty: 0,
  currentFilePenalty: 0,
  comboMatchBoost: 0,
  exactMatch: false,
  matchType: "fuzzy",
};

describe("toRow, for a file", () => {
  it("carries every field the row contract names", () => {
    const row = toRow(fileItem("src/format.ts", "format.ts"), score, ROOT, "fmt");
    expect(row.relativePath).toBe("src/format.ts");
    expect(row.name).toBe("format.ts");
    expect(row.isDir).toBe(false);
    expect(row.score).toBe(142);
    expect(row.size).toBe(4096);
    expect(row.gitStatus).toBe("modified");
  });

  it("derives the absolute path by joining the search root", () => {
    const row = toRow(fileItem("src/format.ts", "format.ts"), score, ROOT, "");
    expect(row.fullPath).toBe("/home/jc/projects/app/src/format.ts");
  });

  it("converts the engine's Unix seconds into milliseconds", () => {
    // The engine reports SECONDS; the rest of this application speaks
    // milliseconds, and a row that mixes the two is off by a factor of 1000.
    const row = toRow(fileItem("a.ts", "a.ts"), score, ROOT, "");
    expect(row.modifiedMs).toBe(1_700_000_000_000);
  });

  it("carries the matched positions for the query it was given", () => {
    // Positions are into the RELATIVE PATH, which is what the row renders and
    // what the Qt build highlights — "src/format.ts", so f=4 m=7 t=9.
    const row = toRow(fileItem("src/format.ts", "format.ts"), score, ROOT, "fmt");
    expect(row.matchIndices).toEqual([4, 7, 9]);
  });
});

describe("toRow, for a directory", () => {
  /**
   * The trailing-separator rule is not cosmetic and CLAUDE.md records it: the
   * mixed search returns a directory with a trailing separator on BOTH path
   * forms, while the display name is the bare last segment without one.
   */
  it("keeps the engine's trailing separator on both path forms", () => {
    const row = toRow(dirItem("src/components/", "components/"), score, ROOT, "");
    expect(row.relativePath).toBe("src/components/");
    expect(row.fullPath).toBe("/home/jc/projects/app/src/components/");
  });

  it("leaves the trailing separator off the display name", () => {
    const row = toRow(dirItem("src/components/", "components/"), score, ROOT, "");
    expect(row.name).toBe("components");
  });

  it("is flagged as a directory", () => {
    expect(toRow(dirItem("src/", "src/"), score, ROOT, "").isDir).toBe(true);
  });
});

describe("toRow, when the engine reports no score", () => {
  it("scores zero rather than producing NaN", () => {
    // `scores` is a parallel array and can be shorter than `items`. A row that
    // reaches the renderer with NaN sorts unpredictably and renders as blank.
    //
    // Paired with the scored case, so zero here means "no score was given"
    // rather than "this always returns zero".
    expect(toRow(fileItem("a.ts", "a.ts"), score, ROOT, "").score).toBe(142);
    expect(toRow(fileItem("a.ts", "a.ts"), undefined, ROOT, "").score).toBe(0);
  });
});
