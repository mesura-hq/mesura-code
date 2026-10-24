// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { runGitSync } from "./GitManager.testkit.ts";
import { repositoryFingerprint } from "./repositoryStateMemo.ts";

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: Array<string>) => runGitSync(cwd, args);

function makeRepository(): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fingerprint-"));
  roots.push(root);
  const repo = NodePath.join(root, "repo");
  NodeFS.mkdirSync(NodePath.join(repo, "src"), { recursive: true });
  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  NodeFS.writeFileSync(NodePath.join(repo, "src", "file.txt"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "first");
  return repo;
}

describe("repository fingerprint", () => {
  it("repository fingerprint: is null outside a repository", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fingerprint-none-"));
    roots.push(root);
    expect(repositoryFingerprint(root)).toBeNull();
  });

  it("repository fingerprint: a repository without remotes is stable until a remote is added", () => {
    const repo = makeRepository();
    const before = repositoryFingerprint(repo);
    expect(before).not.toBeNull();
    expect(repositoryFingerprint(NodePath.join(repo, "src"))).toBe(before);
    expect(repositoryFingerprint(repo)).toBe(before);
    git(repo, "remote", "add", "origin", "https://github.com/acme/widgets.git");
    expect(repositoryFingerprint(repo)).not.toBe(before);
  });

  it("repository fingerprint: working-tree edits leave it unchanged", () => {
    const repo = makeRepository();
    const before = repositoryFingerprint(repo);
    NodeFS.writeFileSync(NodePath.join(repo, "src", "file.txt"), "two\n");
    expect(repositoryFingerprint(repo)).toBe(before);
  });

  it("repository fingerprint: a linked worktree sees ref, upstream and HEAD changes", () => {
    const repo = makeRepository();
    const worktree = NodePath.join(NodePath.dirname(repo), "linked");
    git(repo, "worktree", "add", "--quiet", "-b", "feature/linked", worktree);

    let previous = repositoryFingerprint(worktree);
    expect(previous).not.toBeNull();
    expect(previous).not.toBe(repositoryFingerprint(repo));
    const expectChanged = () => {
      const next = repositoryFingerprint(worktree);
      expect(next).not.toBe(previous);
      previous = next;
    };

    // A branch created from the main checkout lands in the shared refs.
    git(repo, "branch", "feature/other");
    expectChanged();
    // Upstream config lives in the shared config.
    git(worktree, "config", "branch.feature/linked.merge", "refs/heads/feature/linked");
    expectChanged();
    // A commit in the worktree moves its branch ref.
    NodeFS.writeFileSync(NodePath.join(worktree, "src", "file.txt"), "worktree\n");
    git(worktree, "commit", "--quiet", "-am", "in worktree");
    expectChanged();
    // Switching branches rewrites the worktree's own HEAD.
    git(worktree, "switch", "--quiet", "feature/other");
    expectChanged();
  });

  it("repository fingerprint: packing refs is seen", () => {
    const repo = makeRepository();
    git(repo, "branch", "feature/packed");
    const before = repositoryFingerprint(repo);
    git(repo, "pack-refs", "--all");
    expect(repositoryFingerprint(repo)).not.toBe(before);
  });
});
