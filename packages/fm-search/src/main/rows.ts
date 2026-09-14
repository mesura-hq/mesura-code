/**
 * One engine item, as a row the finder can render.
 *
 * The shape is modelled on the Qt struct at
 * `plugin/src/Symmetria/FileManager/Models/fuzzyfinder.hpp`, which is the
 * reference for this port. Same fields, same names where the language allows.
 *
 * Two fields the engine does NOT give us, derived here exactly as Qt derives
 * them: `fullPath`, which is the search root joined to the relative path, and
 * `isDir`, which is the discriminant of the item union.
 */

import { join } from "node:path";
import type { MixedItem, Score } from "@ff-labs/fff-node";

import { matchIndices } from "./match.ts";

export interface SearchRow {
  /** Relative to the search root. A directory keeps its trailing separator. */
  readonly relativePath: string;
  /** The display name: the bare last segment, WITHOUT a trailing separator. */
  readonly name: string;
  /** Absolute. A directory keeps its trailing separator here too. */
  readonly fullPath: string;
  readonly isDir: boolean;
  readonly score: number;
  readonly size: number;
  /** Milliseconds. The engine reports SECONDS; the conversion happens here. */
  readonly modifiedMs: number;
  /** The engine's own string: "clean", "modified", "untracked", and so on. */
  readonly gitStatus: string;
  /** Recomputed, because the engine's file results carry none. */
  readonly matchIndices: readonly number[];
}

export function toRow(
  item: MixedItem,
  score: Score | undefined,
  searchPath: string,
  query: string,
): SearchRow {
  const relativePath = item.item.relativePath;

  // A DIRECTORY carries far less than a file. `DirItem` has only
  // `relativePath`, `dirName` and `maxAccessFrecency` — no size, no
  // modification time, no git status — so those read as zero and empty rather
  // than being invented. `dirName` includes the trailing separator
  // ("components/"), and the display name must not, so it is stripped.
  if (item.type === "directory") {
    return {
      relativePath,
      name: withoutTrailingSeparator(item.item.dirName),
      fullPath: join(searchPath, relativePath),
      isDir: true,
      score: score?.total ?? 0,
      size: 0,
      modifiedMs: 0,
      gitStatus: "",
      matchIndices: matchIndices(relativePath, query),
    };
  }

  const file = item.item;
  return {
    relativePath,
    name: file.fileName,
    // `join` PRESERVES a trailing separator, so nothing has to put it back —
    // an earlier version of this appended one and produced a doubled slash.
    // The separator is load-bearing for a directory: CLAUDE.md records it as
    // the marker the overlay reads.
    fullPath: join(searchPath, relativePath),
    isDir: false,
    // `scores` is a parallel array and can be shorter than `items`. A missing
    // entry scores zero rather than producing NaN, which would sort
    // unpredictably and render blank.
    score: score?.total ?? 0,
    size: file.size,
    // The engine reports Unix SECONDS; the rest of this application speaks
    // milliseconds, and a row mixing the two is wrong by a factor of 1000.
    modifiedMs: file.modified * 1000,
    gitStatus: file.gitStatus,
    matchIndices: matchIndices(relativePath, query),
  };
}

/** The engine's `dirName` keeps a trailing separator; a display name must not. */
function withoutTrailingSeparator(name: string): string {
  return name.endsWith("/") ? name.slice(0, -1) : name;
}
