// @effect-diagnostics nodeBuiltinImport:off
/**
 * Mesura: the background pull-request sweep's local git reads (remotes, a
 * branch's upstream, remote-tracking refs, the default branch, config values)
 * answered from memory while the repository has not changed, so a steady-state
 * sweep spawns no git for a group whose state it already knows.
 *
 * Only reads made under `UseRepositoryStateMemo` are answered from memory; the
 * sweep sets it around its lookups. Every other GitManager caller (status, diff,
 * branch pickers, pull-request creation, push and pull) reads live.
 *
 * "Not changed" is a fingerprint built without spawning anything: `stat` of the
 * `.git` entry, the checkout's HEAD, `packed-refs`, every directory and loose
 * ref file under `refs/heads` and `refs/remotes`, and every config file git
 * reads — system, global, the repository's and the worktree's — with their
 * `include.path` and `includeIf` files followed recursively (every `includeIf`
 * target counts, whatever its condition). A config source whose location
 * cannot be worked out (an include that uses `%(prefix)`, a system config git
 * does not name) turns the memo off for that checkout, so those reads run as
 * before. A fingerprint that differs drops what was remembered.
 *
 * The fingerprint is computed at most once per event-loop turn per checkout,
 * so the reads of one sweep share it, and a change made by any process is seen
 * by the next turn's reads.
 *
 * @module git/repositoryStateMemo
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

/**
 * Set by the background pull-request sweep around its lookups. Reads made
 * without it (every interactive caller) always run git.
 */
export const UseRepositoryStateMemo = Context.Reference<boolean>(
  "mesura/git/repositoryStateMemo/UseRepositoryStateMemo",
  { defaultValue: () => false },
);

/** GitManager operations that only read refs and config. */
const MEMOIZED_EXECUTE_OPERATIONS = new Set([
  "GitManager.branchPullRequest.remotes",
  "GitManager.branchPullRequest.branchRef",
  "GitManager.branchPullRequest.remoteTrackingRefs",
  "GitManager.findRemoteTrackingRemote.remotes",
  "GitManager.findRemoteTrackingRemote.refs",
  "GitManager.isUnpublishedBranch",
]);

const MAX_CHECKOUTS = 2_048;
const MAX_INCLUDE_DEPTH = 10;

const statKey = (filePath: string): string => {
  try {
    const stat = NodeFS.statSync(filePath, { bigint: true });
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch {
    return "-";
  }
};

const readTextOrNull = (filePath: string): string | null => {
  try {
    return NodeFS.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
};

/** Every directory and loose ref file below `root`, with its stat key. */
function refTreeKeys(root: string, into: Array<string>): void {
  into.push(`${root}=${statKey(root)}`);
  let entries: Array<NodeFS.Dirent>;
  try {
    entries = NodeFS.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = NodePath.join(root, entry.name);
    if (entry.isDirectory()) refTreeKeys(entryPath, into);
    // A tool may rewrite a ref file in place, which leaves its directory untouched.
    else into.push(`${entryPath}=${statKey(entryPath)}`);
  }
}

let probedSystemConfigPath: string | null | undefined;

/** Where git reads its system config from, asked once; null when git does not say. */
function defaultSystemConfigPath(): string | null {
  if (probedSystemConfigPath !== undefined) return probedSystemConfigPath;
  const env = { ...process.env };
  delete env.GIT_CONFIG_SYSTEM;
  const result = NodeChildProcess.spawnSync(
    "git",
    ["config", "--system", "--show-origin", "--list"],
    { encoding: "utf8", env, timeout: 5_000 },
  );
  // Present: lines start with `file:<path>`. Absent: git names the file it could not read.
  const named =
    /^file:(.+?)\t/mu.exec(result.stdout ?? "")?.[1] ??
    /unable to read config file '([^']+)'/u.exec(result.stderr ?? "")?.[1];
  probedSystemConfigPath = named ?? null;
  return probedSystemConfigPath;
}

/** The top-level config files git reads, in no particular order; null when one is unknown. */
function configRoots(gitDir: string, commonDir: string): ReadonlyArray<string> | null {
  const roots: Array<string> = [
    NodePath.join(commonDir, "config"),
    NodePath.join(gitDir, "config.worktree"),
  ];
  if (!process.env.GIT_CONFIG_NOSYSTEM) {
    const system = process.env.GIT_CONFIG_SYSTEM ?? defaultSystemConfigPath();
    if (system === null) return null;
    roots.push(system);
  }
  const home = NodeOS.homedir();
  if (process.env.GIT_CONFIG_GLOBAL !== undefined) {
    roots.push(process.env.GIT_CONFIG_GLOBAL);
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || NodePath.join(home, ".config");
    roots.push(NodePath.join(home, ".gitconfig"), NodePath.join(xdg, "git", "config"));
  }
  return roots;
}

/** `path` values of `[include]` and `[includeIf "…"]` sections, as written. */
function includePaths(configText: string): ReadonlyArray<string> {
  const paths: Array<string> = [];
  let inInclude = false;
  for (const rawLine of configText.split(/\r?\n/u)) {
    let line = rawLine.trim();
    const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"(?:[^"\\]|\\.)*")?\s*\](.*)$/u.exec(line);
    if (header !== null) {
      const section = header[1]!.toLowerCase();
      inInclude = section === "include" || section === "includeif";
      line = header[2]!.trim();
    }
    if (!inInclude) continue;
    const entry = /^path\s*=\s*(.*)$/iu.exec(line);
    if (entry === null) continue;
    let value = entry[1]!.trim();
    if (value.startsWith('"')) {
      value = /^"((?:[^"\\]|\\.)*)"/u.exec(value)?.[1]?.replace(/\\(.)/gu, "$1") ?? value;
    } else {
      value = value.replace(/\s[#;].*$/u, "").trim();
    }
    paths.push(value);
  }
  return paths;
}

/** Stat keys of `configFile` and everything it includes; false when an include cannot be placed. */
function configSourceKeys(
  configFile: string,
  into: Array<string>,
  visited: Set<string>,
  depth: number,
): boolean {
  if (visited.has(configFile)) return true;
  if (depth > MAX_INCLUDE_DEPTH) return false;
  visited.add(configFile);
  into.push(`${configFile}=${statKey(configFile)}`);
  const text = readTextOrNull(configFile);
  if (text === null) return true;
  for (const includePath of includePaths(text)) {
    if (includePath.includes("%(")) return false;
    const resolved = includePath.startsWith("~/")
      ? NodePath.join(NodeOS.homedir(), includePath.slice(2))
      : NodePath.resolve(NodePath.dirname(configFile), includePath);
    if (!configSourceKeys(resolved, into, visited, depth + 1)) return false;
  }
  return true;
}

interface RepositoryLocation {
  readonly dotGit: string;
  readonly gitDir: string;
  readonly commonDir: string;
}

/** The git directories of the repository `cwd` belongs to, found without spawning git. */
function locateRepository(cwd: string): RepositoryLocation | null {
  let directory = NodePath.resolve(cwd);
  for (;;) {
    const dotGit = NodePath.join(directory, ".git");
    let gitDir: string | null = null;
    try {
      if (NodeFS.statSync(dotGit).isDirectory()) {
        gitDir = dotGit;
      } else {
        // A linked worktree or submodule: `.git` is a file naming the git directory.
        const pointer = /^gitdir:\s*(.+?)\s*$/mu.exec(readTextOrNull(dotGit) ?? "");
        if (pointer !== null) gitDir = NodePath.resolve(directory, pointer[1]!);
      }
    } catch {
      gitDir = null;
    }
    if (gitDir !== null) {
      const commonPointer = readTextOrNull(NodePath.join(gitDir, "commondir"))?.trim();
      const commonDir =
        commonPointer === undefined || commonPointer.length === 0
          ? gitDir
          : NodePath.resolve(gitDir, commonPointer);
      return { dotGit, gitDir, commonDir };
    }
    const parent = NodePath.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function configKeys(location: RepositoryLocation): Array<string> | null {
  const roots = configRoots(location.gitDir, location.commonDir);
  if (roots === null) return null;
  const keys = [`${location.dotGit}=${statKey(location.dotGit)}`, location.gitDir];
  const visited = new Set<string>();
  for (const root of roots) if (!configSourceKeys(root, keys, visited, 0)) return null;
  return keys;
}

/**
 * The fingerprint of every config file git reads for `cwd`'s repository; null
 * outside a repository or when a source cannot be placed. Remotes live here.
 */
export function repositoryConfigFingerprint(cwd: string): string | null {
  const location = locateRepository(cwd);
  if (location === null) return null;
  return configKeys(location)?.join("|") ?? null;
}

/** The fingerprint of `cwd`'s repository's config and refs; null when unknown. */
export function repositoryFingerprint(cwd: string): string | null {
  const location = locateRepository(cwd);
  if (location === null) return null;
  const keys = configKeys(location);
  if (keys === null) return null;
  keys.push(
    statKey(NodePath.join(location.gitDir, "HEAD")),
    statKey(NodePath.join(location.commonDir, "packed-refs")),
  );
  refTreeKeys(NodePath.join(location.commonDir, "refs", "heads"), keys);
  refTreeKeys(NodePath.join(location.commonDir, "refs", "remotes"), keys);
  return keys.join("|");
}

/**
 * Reports, per checkout, whether its config changed since the previous call.
 * The first call for a checkout reports no change.
 */
export function makeRepositoryConfigWatch(): (cwd: string) => boolean {
  const seen = new Map<string, string | null>();
  return (cwd) => {
    const fingerprint = repositoryConfigFingerprint(cwd);
    const changed = seen.has(cwd) && (fingerprint === null || seen.get(cwd) !== fingerprint);
    seen.delete(cwd);
    if (seen.size >= MAX_CHECKOUTS) {
      const oldest = seen.keys().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    seen.set(cwd, fingerprint);
    return changed;
  };
}

/**
 * Wraps a git driver so the lookup reads listed above, made under
 * `UseRepositoryStateMemo`, are remembered per checkout until its fingerprint
 * changes. Every other call goes straight through, and only successful reads
 * are remembered.
 */
export function memoizeRepositoryReads(
  git: GitVcsDriver.GitVcsDriver["Service"],
): GitVcsDriver.GitVcsDriver["Service"] {
  const checkouts = new Map<string, { fingerprint: string; reads: Map<string, unknown> }>();
  let turnFingerprints: Map<string, string | null> | null = null;

  const fingerprintThisTurn = (cwd: string): string | null => {
    if (turnFingerprints === null) {
      turnFingerprints = new Map();
      setImmediate(() => {
        turnFingerprints = null;
      });
    }
    if (!turnFingerprints.has(cwd)) turnFingerprints.set(cwd, repositoryFingerprint(cwd));
    return turnFingerprints.get(cwd) ?? null;
  };

  const remembered = <A, E>(cwd: string, readKey: string, read: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      if (!(yield* UseRepositoryStateMemo)) return yield* read;
      const fingerprint = fingerprintThisTurn(cwd);
      if (fingerprint === null) return yield* read;
      let checkout = checkouts.get(cwd);
      if (checkout === undefined || checkout.fingerprint !== fingerprint) {
        checkout = { fingerprint, reads: new Map() };
        checkouts.delete(cwd);
        if (checkouts.size >= MAX_CHECKOUTS) {
          const oldest = checkouts.keys().next().value;
          if (oldest !== undefined) checkouts.delete(oldest);
        }
        checkouts.set(cwd, checkout);
      }
      const reads = checkout.reads;
      if (reads.has(readKey)) return reads.get(readKey) as A;
      const value = yield* read;
      // A newer fingerprint may have replaced this checkout's table meanwhile.
      if (checkouts.get(cwd)?.reads === reads) reads.set(readKey, value);
      return value;
    });

  return {
    ...git,
    execute: (input) =>
      MEMOIZED_EXECUTE_OPERATIONS.has(input.operation) &&
      input.stdin === undefined &&
      input.env === undefined &&
      input.progress === undefined
        ? remembered(
            input.cwd,
            JSON.stringify(["execute", input.operation, input.args, input.allowNonZeroExit]),
            git.execute(input),
          )
        : git.execute(input),
    readConfigValue: (cwd, key) =>
      remembered(cwd, JSON.stringify(["config", key]), git.readConfigValue(cwd, key)),
    resolveDefaultBranchName: (cwd, remoteName) =>
      remembered(
        cwd,
        JSON.stringify(["defaultBranch", remoteName]),
        git.resolveDefaultBranchName(cwd, remoteName),
      ),
  };
}
