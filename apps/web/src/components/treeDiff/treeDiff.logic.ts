/**
 * Pure helpers for the Diff surface's Tree diff mode: the per-file status the server reports,
 * shaped for the tree, the row accessory and the summary rows.
 *
 * The letters and the three summary rows follow Symmetria IDE's Active Changes
 * panel. Two axes, kept apart on purpose:
 * - the row letter is the operation (added, modified, deleted, renamed),
 * - the summary rows are the side (staged ●, unstaged ○, untracked ✦).
 * Colour belongs to the operation axis only; the side glyphs stay neutral.
 */
import type { GitStatus } from "@pierre/trees";
import type { GitWorkingTreeChange } from "@t3tools/contracts";

import { resolveDiffPathForWorkspace } from "../../diffFileActions";
import type { DiffFileTreeEntry } from "../diffs/diffFileTree.logic";

export interface GitChangeBucket {
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
}

export interface GitChangesSummary {
  readonly total: number;
  readonly staged: GitChangeBucket;
  readonly unstaged: GitChangeBucket;
  readonly untracked: GitChangeBucket;
  readonly conflicted: number;
}

const isUntracked = (file: GitWorkingTreeChange) => file.index === "?";
const isConflicted = (file: GitWorkingTreeChange) => file.index === "U" || file.worktree === "U";

export function summarizeGitChanges(files: ReadonlyArray<GitWorkingTreeChange>): GitChangesSummary {
  const staged = { files: 0, insertions: 0, deletions: 0 };
  const unstaged = { files: 0, insertions: 0, deletions: 0 };
  const untracked = { files: 0, insertions: 0, deletions: 0 };
  let conflicted = 0;
  for (const file of files) {
    if (isConflicted(file)) conflicted += 1;
    if (isUntracked(file)) {
      untracked.files += 1;
      untracked.insertions += file.unstaged.insertions;
      continue;
    }
    if (file.index !== ".") {
      staged.files += 1;
      staged.insertions += file.staged.insertions;
      staged.deletions += file.staged.deletions;
    }
    if (file.worktree !== ".") {
      unstaged.files += 1;
      unstaged.insertions += file.unstaged.insertions;
      unstaged.deletions += file.unstaged.deletions;
    }
  }
  return { total: files.length, staged, unstaged, untracked, conflicted };
}

/**
 * The one letter a row shows. The working tree side wins when both sides
 * changed, because that is the state on disk; a conflict outranks both.
 */
export function gitChangeLetter(file: GitWorkingTreeChange): string {
  if (isConflicted(file)) return "U";
  if (isUntracked(file)) return "?";
  const side = file.worktree !== "." ? file.worktree : file.index;
  return side === "T" ? "M" : side;
}

const LETTER_TO_TREE_STATUS: Record<string, GitStatus> = {
  "?": "untracked",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "renamed",
  M: "modified",
  // Pierre has no conflict state; the row decoration carries the conflict.
  U: "modified",
};

export function gitChangeTreeStatus(file: GitWorkingTreeChange): GitStatus {
  return LETTER_TO_TREE_STATUS[gitChangeLetter(file)] ?? "modified";
}

const LETTER_TITLES: Record<string, string> = {
  "?": "Untracked",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  M: "Modified",
  U: "Conflicted",
};

export function gitChangeTitle(file: GitWorkingTreeChange): string {
  const sides = [
    file.index !== "." && !isUntracked(file) ? "staged" : null,
    file.worktree !== "." && !isUntracked(file) ? "unstaged" : null,
  ].filter((side) => side !== null);
  const letterTitle = LETTER_TITLES[gitChangeLetter(file)] ?? "Changed";
  return sides.length > 0 ? `${letterTitle} (${sides.join(" and ")})` : letterTitle;
}

/** Staged and unstaged lines together: what the file differs from `HEAD` by. */
export function gitChangeLineDelta(file: GitWorkingTreeChange): {
  insertions: number;
  deletions: number;
} {
  return {
    insertions: file.staged.insertions + file.unstaged.insertions,
    deletions: file.staged.deletions + file.unstaged.deletions,
  };
}

/** The row accessory: `+12 −3`, `bin`, or nothing for a pure rename. */
export function formatGitChangeDecoration(file: GitWorkingTreeChange): string | null {
  if (isConflicted(file)) return "conflict";
  if (file.binary) return "bin";
  const { insertions, deletions } = gitChangeLineDelta(file);
  const parts = [
    insertions > 0 ? `+${insertions}` : null,
    deletions > 0 ? `−${deletions}` : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" ") : null;
}

export interface GitChangeRow {
  /**
   * Repository-relative, as the server sent it: the tree's identifier. Paths
   * relative to a nested project's cwd would collide with paths outside it
   * (`apps/web/shared/x.ts` and `shared/x.ts` both reading `shared/x.ts`).
   */
  readonly path: string;
  /** Relative to the thread's cwd, for opening the file; null for a file outside it. */
  readonly workspacePath: string | null;
  readonly change: GitWorkingTreeChange;
}

export function gitChangeRows(
  files: ReadonlyArray<GitWorkingTreeChange>,
  repositoryRoot: string | null,
  cwd: string,
): ReadonlyArray<GitChangeRow> {
  return files.map((change) => ({
    path: change.path,
    workspacePath: resolveDiffPathForWorkspace({
      filePath: change.path,
      workspaceRoot: cwd,
      repositoryRoot: repositoryRoot ?? undefined,
    }),
    change,
  }));
}

export function gitChangeTreeEntries(
  rows: ReadonlyArray<GitChangeRow>,
): ReadonlyArray<DiffFileTreeEntry> {
  return rows.map((row) => ({ path: row.path, status: gitChangeTreeStatus(row.change) }));
}

/**
 * True when `cwd` lies inside `repositoryRoot`. The dev-server fallback asks
 * git from another folder; its answer only belongs to this thread when that
 * folder is in the same repository.
 */
export function isPathInsideRepository(repositoryRoot: string | null, cwd: string): boolean {
  if (repositoryRoot === null) return false;
  const root = repositoryRoot.replace(/\/+$/, "");
  const base = cwd.replace(/\/+$/, "");
  return base === root || base.startsWith(`${root}/`);
}

/**
 * True when the server refused the cwd for lying outside its workspace root.
 * The same text `DiffPanel` matches for its own fallback to the server's cwd.
 */
export function isWorkspaceRootRefusal(error: string | null): boolean {
  return error?.includes("configured workspace root") === true;
}

/** What Tree diff says for a request error: a refusal in plain words, anything else as sent. */
export function treeDiffErrorMessage(error: string): string {
  return isWorkspaceRootRefusal(error) ? "This server can't read this project's folder." : error;
}

/**
 * Files diff's tree entries with every file git reports as untracked marked
 * `untracked`. Both sides use repository-relative paths.
 */
export function markUntrackedTreeEntries(
  entries: ReadonlyArray<DiffFileTreeEntry>,
  files: ReadonlyArray<GitWorkingTreeChange>,
): ReadonlyArray<DiffFileTreeEntry> {
  const untrackedPaths = new Set(files.filter(isUntracked).map((file) => file.path));
  if (untrackedPaths.size === 0) return entries;
  return entries.map((entry) =>
    untrackedPaths.has(entry.path) ? { ...entry, status: "untracked" } : entry,
  );
}
