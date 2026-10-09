/**
 * Fork addition: the working tree's per-file git status, split by side.
 *
 * `vcs.status` already reports which files changed and their combined line
 * counts, but it folds the index and the working tree into one number and keeps
 * no status letter. The Git status surface needs both: the letter for the row's
 * badge and the staged / unstaged / untracked split for the summary. It is a
 * separate request, not a wider status payload, because status is broadcast to
 * every client on every refresh and only an open Git status surface needs this.
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A filesystem path exactly as git printed it. Not `TrimmedNonEmptyString`:
 * that trims on decode, and `" spaced.txt "` is a valid, different file.
 */
const GitPath = Schema.NonEmptyString;

/**
 * One side of a porcelain v2 `XY` pair. `.` means unchanged on that side, `?`
 * marks an untracked file, and `U` an unmerged (conflicted) one.
 */
export const GitChangeCode = Schema.Literals([".", "M", "T", "A", "D", "R", "C", "U", "?"]);
export type GitChangeCode = typeof GitChangeCode.Type;

export const GitLineDelta = Schema.Struct({
  insertions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type GitLineDelta = typeof GitLineDelta.Type;

export const GitWorkingTreeChange = Schema.Struct({
  /** Repository-relative path, after any rename. */
  path: GitPath,
  /** The path before a staged rename or copy. */
  originalPath: Schema.optional(GitPath),
  index: GitChangeCode,
  worktree: GitChangeCode,
  /** `HEAD` to index. Zero for an untracked file. */
  staged: GitLineDelta,
  /** Index to working tree. For an untracked file, its line count. */
  unstaged: GitLineDelta,
  binary: Schema.Boolean,
});
export type GitWorkingTreeChange = typeof GitWorkingTreeChange.Type;

export const GitWorkingTreeChangesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type GitWorkingTreeChangesInput = typeof GitWorkingTreeChangesInput.Type;

export const GitWorkingTreeChangesResult = Schema.Struct({
  isRepo: Schema.Boolean,
  /** Absolute repository root, which every `path` is relative to. */
  repositoryRoot: Schema.NullOr(GitPath),
  refName: Schema.NullOr(TrimmedNonEmptyString),
  files: Schema.Array(GitWorkingTreeChange),
  /** True when the list stopped at the file cap. */
  truncated: Schema.Boolean,
});
export type GitWorkingTreeChangesResult = typeof GitWorkingTreeChangesResult.Type;
