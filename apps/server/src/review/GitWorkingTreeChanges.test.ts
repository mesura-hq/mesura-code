// @effect-diagnostics nodeBuiltinImport:off - the fixture drives real git synchronously.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

import {
  combineWorkingTreeChanges,
  parseNumstatZ,
  parsePorcelainV2,
} from "./GitWorkingTreeChanges.ts";
import * as ReviewService from "./ReviewService.ts";

// The parsers are checked against what git itself prints, not against a
// hand-written sample of the format, so a misread field shows up here.
let repo: string;
const git = (...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
const write = (relativePath: string, contents: string) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(repo, relativePath)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(repo, relativePath), contents);
};

beforeAll(() => {
  repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "git-working-tree-changes-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  write("src/kept.ts", "one\ntwo\nthree\n");
  write("src/old name.ts", "a\nb\nc\nd\ne\nf\n");
  write("gone.txt", "bye\n");
  write("both.ts", "1\n2\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");

  write("src/kept.ts", "one\nTWO\nthree\nfour\n"); // unstaged: +2 -1
  git("mv", "src/old name.ts", "src/new name.ts"); // staged rename, path with a space
  git("rm", "-q", "gone.txt"); // staged delete
  write("both.ts", "1\n2\n3\n");
  git("add", "both.ts"); // staged +1
  write("both.ts", "1\n2\n3\n4\n5\n"); // then unstaged +2
  write("docs/new.md", "x\ny\n"); // untracked
});

afterAll(() => {
  NodeFS.rmSync(repo, { recursive: true, force: true });
});

describe("GitWorkingTreeChanges parsers", () => {
  it("reads both status letters, renames and untracked files from porcelain v2", () => {
    const status = parsePorcelainV2(
      git("status", "--porcelain=2", "--branch", "-z", "--untracked-files=all"),
    );
    expect(status.refName).toBe("main");
    const byPath = new Map(status.entries.map((entry) => [entry.path, entry]));
    expect(byPath.get("src/kept.ts")).toMatchObject({ index: ".", worktree: "M" });
    expect(byPath.get("src/new name.ts")).toMatchObject({
      index: "R",
      worktree: ".",
      originalPath: "src/old name.ts",
    });
    expect(byPath.get("gone.txt")).toMatchObject({ index: "D", worktree: "." });
    expect(byPath.get("both.ts")).toMatchObject({ index: "M", worktree: "M" });
    expect(byPath.get("docs/new.md")).toMatchObject({ index: "?", worktree: "?" });
    expect(status.entries).toHaveLength(5);
  });

  it("splits staged and unstaged line counts per file", () => {
    const changes = combineWorkingTreeChanges({
      status: parsePorcelainV2(
        git("status", "--porcelain=2", "--branch", "-z", "--untracked-files=all"),
      ),
      staged: parseNumstatZ(git("diff", "--cached", "--numstat", "-z", "-M")),
      unstaged: parseNumstatZ(git("diff", "--numstat", "-z")),
      untrackedLineCounts: new Map([["docs/new.md", 2]]),
    });
    const byPath = new Map(changes.map((change) => [change.path, change]));
    expect(byPath.get("both.ts")).toMatchObject({
      staged: { insertions: 1, deletions: 0 },
      unstaged: { insertions: 2, deletions: 0 },
    });
    expect(byPath.get("src/kept.ts")).toMatchObject({
      staged: { insertions: 0, deletions: 0 },
      unstaged: { insertions: 2, deletions: 1 },
    });
    // A pure rename moves no lines; it is keyed by its new path.
    expect(byPath.get("src/new name.ts")).toMatchObject({
      staged: { insertions: 0, deletions: 0 },
    });
    expect(byPath.get("gone.txt")).toMatchObject({ staged: { insertions: 0, deletions: 1 } });
    expect(byPath.get("docs/new.md")).toMatchObject({
      unstaged: { insertions: 2, deletions: 0 },
      binary: false,
    });
    expect(changes.map((change) => change.path)).toEqual(
      [...byPath.keys()].toSorted((left, right) => left.localeCompare(right)),
    );
  });

  it("marks binary numstat entries instead of counting lines", () => {
    const parsed = parseNumstatZ("-\t-\timage.png\0");
    expect(parsed.get("image.png")).toMatchObject({ binary: true, insertions: 0, deletions: 0 });
  });
});

/** The real review stack over real git, rooted at `workspaceRoot`. */
function makeReviewLayer(workspaceRoot: string) {
  return ReviewService.layer.pipe(
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsDriverRegistry.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provide(ServerConfig.layerTest(workspaceRoot, { prefix: "t3-tree-read-base-" })),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("ReviewService.getWorkingTreeChanges one-shot read", () => {
  effectIt.live("guard: the one-shot read returns the fixture's per-file changes", () =>
    Effect.gen(function* () {
      const review = yield* ReviewService.ReviewService;
      const result = yield* review.getWorkingTreeChanges({ cwd: repo });
      assert.strictEqual(result.isRepo, true);
      assert.strictEqual(result.repositoryRoot, NodeFS.realpathSync(repo));
      assert.strictEqual(result.refName, "main");
      assert.strictEqual(result.truncated, false);
      assert.deepStrictEqual(
        result.files.map((file) => [file.path, file.index, file.worktree]),
        [
          ["both.ts", "M", "M"],
          ["docs/new.md", "?", "?"],
          ["gone.txt", "D", "."],
          ["src/kept.ts", ".", "M"],
          ["src/new name.ts", "R", "."],
        ],
      );
    }).pipe(Effect.provide(makeReviewLayer(repo))),
  );

  effectIt.live("guard: the one-shot read refuses a cwd outside the workspace root", () => {
    const workspaceRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-tree-read-ws-"));
    return Effect.gen(function* () {
      const review = yield* ReviewService.ReviewService;
      const error = yield* review.getWorkingTreeChanges({ cwd: repo }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      if (error._tag !== "VcsRepositoryDetectionError") return;
      assert.strictEqual(error.operation, "ReviewService.getWorkingTreeChanges");
      assert.strictEqual(error.cwd, repo);
      assert.strictEqual(
        error.detail,
        "Working tree changes cwd must stay within the configured workspace root.",
      );
    }).pipe(
      Effect.provide(makeReviewLayer(workspaceRoot)),
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(workspaceRoot, { recursive: true, force: true })),
      ),
    );
  });
});

describe("GitWorkingTreeChanges filenames with tabs", () => {
  it("keeps staged and unstaged counts on a filename that contains a tab", () => {
    const tabRepo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "git-tab-filenames-"));
    const gitIn = (...args: string[]) =>
      NodeChildProcess.execFileSync("git", args, {
        cwd: tabRepo,
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
      });
    try {
      gitIn("init", "-q", "-b", "main");
      gitIn("config", "user.email", "test@example.com");
      gitIn("config", "user.name", "Test");
      NodeFS.mkdirSync(NodePath.join(tabRepo, "src"));
      NodeFS.writeFileSync(NodePath.join(tabRepo, "src/a\tb.txt"), "1\n");
      NodeFS.writeFileSync(NodePath.join(tabRepo, "src/a"), "plain\n");
      gitIn("add", ".");
      gitIn("commit", "-q", "-m", "base");
      NodeFS.writeFileSync(NodePath.join(tabRepo, "src/a\tb.txt"), "1\n2\n");
      gitIn("add", "src/a\tb.txt"); // staged +1
      NodeFS.writeFileSync(NodePath.join(tabRepo, "src/a\tb.txt"), "one\n2\n3\n4\n"); // unstaged +3 -1

      const changes = combineWorkingTreeChanges({
        status: parsePorcelainV2(
          gitIn("status", "--porcelain=2", "--branch", "-z", "--untracked-files=all"),
        ),
        staged: parseNumstatZ(gitIn("diff", "--cached", "--numstat", "-z", "-M")),
        unstaged: parseNumstatZ(gitIn("diff", "--numstat", "-z")),
        untrackedLineCounts: new Map(),
      });
      expect(changes).toEqual([
        {
          path: "src/a\tb.txt",
          index: "M",
          worktree: "M",
          staged: { insertions: 1, deletions: 0 },
          unstaged: { insertions: 3, deletions: 1 },
          binary: false,
        },
      ]);
    } finally {
      NodeFS.rmSync(tabRepo, { recursive: true, force: true });
    }
  });
});
