/**
 * Fork addition: the working tree's per-file status for the Git status surface.
 *
 * Three git reads, run together: `status --porcelain=2` for each file's two
 * status letters, then `diff --cached --numstat` and `diff --numstat` for the
 * staged and unstaged line counts. Untracked files have no numstat, so their
 * line count is read from disk, bounded by `UNTRACKED_LINE_COUNT_MAX_BYTES`.
 *
 * Porcelain and numstat paths are relative to the repository root whatever the
 * cwd, so the result carries that root for the client to resolve against.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type {
  GitChangeCode,
  GitLineDelta,
  GitWorkingTreeChange,
  GitWorkingTreeChangesResult,
} from "@t3tools/contracts";

import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

/** A changeset past this is not reviewed file by file; the list says it stopped. */
const MAX_FILES = 2_000;
const UNTRACKED_LINE_COUNT_MAX_FILES = 200;
const UNTRACKED_LINE_COUNT_MAX_BYTES = 512 * 1024;
const GIT_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

const CHANGE_CODES: ReadonlySet<string> = new Set([".", "M", "T", "A", "D", "R", "C", "U", "?"]);

const toChangeCode = (value: string | undefined): GitChangeCode =>
  value !== undefined && CHANGE_CODES.has(value) ? (value as GitChangeCode) : ".";

export interface PorcelainEntry {
  readonly path: string;
  readonly originalPath?: string;
  readonly index: GitChangeCode;
  readonly worktree: GitChangeCode;
}

export interface PorcelainStatus {
  readonly refName: string | null;
  readonly entries: ReadonlyArray<PorcelainEntry>;
}

/** Parses `git status --porcelain=2 --branch -z`. */
export function parsePorcelainV2(stdout: string): PorcelainStatus {
  const records = stdout.split("\0");
  const entries: PorcelainEntry[] = [];
  let refName: string | null = null;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length === 0) continue;
    if (record.startsWith("# branch.head ")) {
      const value = record.slice("# branch.head ".length).trim();
      refName = value.startsWith("(") ? null : value;
      continue;
    }
    const kind = record[0];
    if (kind === "?") {
      entries.push({ path: record.slice(2), index: "?", worktree: "?" });
      continue;
    }
    if (kind !== "1" && kind !== "2" && kind !== "u") continue;
    // Field counts before the path: ordinary 8, rename/copy 9, unmerged 10.
    const fieldsBeforePath = kind === "1" ? 8 : kind === "2" ? 9 : 10;
    const fields = record.split(" ");
    const xy = fields[1] ?? "..";
    const path = fields.slice(fieldsBeforePath).join(" ");
    if (path.length === 0) continue;
    if (kind === "u") {
      entries.push({ path, index: "U", worktree: "U" });
      continue;
    }
    const entry: PorcelainEntry = {
      path,
      index: toChangeCode(xy[0]),
      worktree: toChangeCode(xy[1]),
    };
    if (kind === "2") {
      // The original path follows as its own NUL-terminated record.
      const originalPath = records[index + 1];
      index += 1;
      entries.push(originalPath ? { ...entry, originalPath } : entry);
    } else {
      entries.push(entry);
    }
  }
  return { refName, entries };
}

export interface NumstatEntry extends GitLineDelta {
  readonly path: string;
  readonly binary: boolean;
}

/** Parses `git diff --numstat -z`, keyed by the post-rename path. */
export function parseNumstatZ(stdout: string): ReadonlyMap<string, NumstatEntry> {
  const records = stdout.split("\0");
  const byPath = new Map<string, NumstatEntry>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length === 0) continue;
    // Only the first two tabs are separators: with `-z`, git keeps a tab
    // inside a filename as it is.
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab === -1 ? -1 : record.indexOf("\t", firstTab + 1);
    if (secondTab === -1) continue;
    const insertionsText = record.slice(0, firstTab);
    const deletionsText = record.slice(firstTab + 1, secondTab);
    const inlinePath = record.slice(secondTab + 1);
    const binary = insertionsText === "-" || deletionsText === "-";
    let path = inlinePath;
    if (path.length === 0) {
      // A rename: the old and new paths follow as two more records.
      path = records[index + 2] ?? "";
      index += 2;
    }
    if (path.length === 0) continue;
    byPath.set(path, {
      path,
      binary,
      insertions: binary ? 0 : Number.parseInt(insertionsText, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(deletionsText, 10) || 0,
    });
  }
  return byPath;
}

const ZERO_DELTA: GitLineDelta = { insertions: 0, deletions: 0 };

/** Joins the three reads into one row per file, in path order. */
export function combineWorkingTreeChanges(input: {
  readonly status: PorcelainStatus;
  readonly staged: ReadonlyMap<string, NumstatEntry>;
  readonly unstaged: ReadonlyMap<string, NumstatEntry>;
  readonly untrackedLineCounts: ReadonlyMap<string, number | "binary">;
}): ReadonlyArray<GitWorkingTreeChange> {
  return input.status.entries
    .map((entry): GitWorkingTreeChange => {
      const staged = input.staged.get(entry.path);
      const unstaged = input.unstaged.get(entry.path);
      const untrackedLines = input.untrackedLineCounts.get(entry.path);
      return {
        path: entry.path,
        ...(entry.originalPath ? { originalPath: entry.originalPath } : {}),
        index: entry.index,
        worktree: entry.worktree,
        staged: staged
          ? { insertions: staged.insertions, deletions: staged.deletions }
          : ZERO_DELTA,
        unstaged:
          entry.index === "?"
            ? { insertions: typeof untrackedLines === "number" ? untrackedLines : 0, deletions: 0 }
            : unstaged
              ? { insertions: unstaged.insertions, deletions: unstaged.deletions }
              : ZERO_DELTA,
        binary: staged?.binary === true || unstaged?.binary === true || untrackedLines === "binary",
      };
    })
    .toSorted((left, right) => left.path.localeCompare(right.path));
}

function countLines(bytes: Uint8Array): number | "binary" {
  let lines = 0;
  for (const byte of bytes) {
    if (byte === 0) return "binary";
    if (byte === 10) lines += 1;
  }
  return bytes.length > 0 && bytes[bytes.length - 1] !== 10 ? lines + 1 : lines;
}

const NON_REPOSITORY: GitWorkingTreeChangesResult = {
  isRepo: false,
  repositoryRoot: null,
  refName: null,
  files: [],
  truncated: false,
};

export interface WorkingTreeChangesDependencies {
  readonly git: GitVcsDriver.GitVcsDriver["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}

export const readWorkingTreeChanges = Effect.fn("GitWorkingTreeChanges.read")(function* (
  { git, fileSystem, path }: WorkingTreeChangesDependencies,
  cwd: string,
) {
  const run = (operation: string, args: ReadonlyArray<string>) =>
    git.execute({
      operation: `GitWorkingTreeChanges.${operation}`,
      cwd,
      // Without this, `git status` refreshes and rewrites the index, and the
      // working-tree watcher would read its own read as a change.
      args: ["--no-optional-locks", ...args],
      allowNonZeroExit: true,
      maxOutputBytes: GIT_OUTPUT_MAX_BYTES,
    });

  const [rootResult, statusResult, stagedResult, unstagedResult] = yield* Effect.all(
    [
      run("root", ["rev-parse", "--show-toplevel"]),
      run("status", ["status", "--porcelain=2", "--branch", "-z", "--untracked-files=all"]),
      run("staged", ["diff", "--cached", "--numstat", "-z", "-M"]),
      run("unstaged", ["diff", "--numstat", "-z"]),
    ],
    { concurrency: "unbounded" },
  );
  if (rootResult.exitCode !== 0 || statusResult.exitCode !== 0) return NON_REPOSITORY;

  // Only the newline git appends: a directory name may end in a space.
  const repositoryRoot = rootResult.stdout.replace(/\r?\n$/, "");
  const status = parsePorcelainV2(statusResult.stdout);
  const truncated = status.entries.length > MAX_FILES;
  const entries = truncated ? status.entries.slice(0, MAX_FILES) : status.entries;

  const untrackedPaths = entries
    .filter((entry) => entry.index === "?")
    .slice(0, UNTRACKED_LINE_COUNT_MAX_FILES)
    .map((entry) => entry.path);
  const untrackedLineCounts = new Map<string, number | "binary">(
    yield* Effect.forEach(
      untrackedPaths,
      (relativePath) =>
        Effect.gen(function* () {
          const absolutePath = path.join(repositoryRoot, relativePath);
          const info = yield* fileSystem.stat(absolutePath);
          if (info.type !== "File" || Number(info.size) > UNTRACKED_LINE_COUNT_MAX_BYTES) {
            return [relativePath, 0] as const;
          }
          return [relativePath, countLines(yield* fileSystem.readFile(absolutePath))] as const;
        }).pipe(Effect.orElseSucceed(() => [relativePath, 0] as const)),
      { concurrency: 8 },
    ),
  );

  return {
    isRepo: true,
    repositoryRoot: repositoryRoot.length > 0 ? repositoryRoot : null,
    refName: status.refName,
    files: combineWorkingTreeChanges({
      status: { refName: status.refName, entries },
      staged: stagedResult.exitCode === 0 ? parseNumstatZ(stagedResult.stdout) : new Map(),
      unstaged: unstagedResult.exitCode === 0 ? parseNumstatZ(unstagedResult.stdout) : new Map(),
      untrackedLineCounts,
    }),
    truncated,
  } satisfies GitWorkingTreeChangesResult;
});
