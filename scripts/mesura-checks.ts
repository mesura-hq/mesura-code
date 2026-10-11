// @effect-diagnostics nodeBuiltinImport:off globalDate:off - A plain CLI over git and the repository toolchain; no Effect runtime.
/**
 * The change gate behind AGENTS.md's `Deterministic Checks` section, one check per
 * invocation so consumers can run each line in a fresh shell:
 *
 *   node scripts/mesura-checks.ts <fmt|lint|typecheck|knip> [<base> | --all]
 *
 * `<base>` is the commit the change is compared against; it defaults to the merge
 * base with `origin/dev`. The change set is that diff plus untracked files, so the
 * same line works on a commit range and on a dirty tree. `--all` checks the whole
 * repository instead, as CI's `Check` job does.
 *
 * Exit codes: 0 clean, 1 findings, 2 tooling failure (missing install, bad ref).
 *
 * Three things the plain package scripts get wrong on a shared host, and the reason
 * this file exists rather than a list of `vp` commands:
 * - `vp` and the pinned Node are often not on an agent shell's PATH. This resolves
 *   both from `node_modules/.bin` and nvm before running anything.
 * - TypeScript 7's multithreaded `tsc` on several packages at once exhausted the
 *   host's memory. Each package is checked alone, one checker, under a host-wide
 *   lock, with a hard kill after the timeout (TS 7 can ignore SIGTERM).
 * - Lint warnings: only the ones on lines this change wrote are reported.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  type LintDiagnostic,
  type WorkspacePackage,
  packagesToTypecheck,
  parseChangedLineRanges,
  readWorkspacePackages,
  selectReportableDiagnostics,
  withoutTypecheckSuggestions,
} from "./lib/mesura-checks.ts";
import { MissingToolchainError, toolchainEnvironment } from "./lib/mesura-toolchain.ts";

const EXIT_CLEAN = 0;
const EXIT_FINDINGS = 1;
const EXIT_TOOLING_FAILURE = 2;

/** Paths this repository never checks: vendored references and the file manager subtree. */
const EXCLUDED_PREFIXES = [".repos/", "vendor/"];
const LINTABLE_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/u;
const TYPECHECK_LOCK = "/tmp/mesura-typecheck.lock";
const TYPECHECK_TIMEOUT_SECONDS = 900;

/** `vp` prints this after every built-in `fmt` and `lint` run; it is noise here. */
const VITE_PLUS_BUILTIN_NOTE = /as a Vite\+ built-in command/u;

const repositoryRoot = NodePath.resolve(import.meta.dirname, "..");

class ToolingFailure extends Error {}

function git(args: ReadonlyArray<string>): string {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new ToolingFailure(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

interface RunResult {
  /** `null` when a signal ended the process. */
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
}

function run(
  command: string,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
): RunResult {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: repositoryRoot,
    env: environment,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    throw new ToolingFailure(`${command} could not start: ${result.error.message}`);
  }
  const output = `${result.stdout}${result.stderr}`
    .split("\n")
    .filter((line) => !VITE_PLUS_BUILTIN_NOTE.test(line))
    .join("\n");
  return { status: result.status, signal: result.signal, output };
}

/** A tool's own exit: 0 clean, 1 its findings; anything else means it did not finish. */
function classifyToolExit(command: string, result: RunResult): number {
  if (result.status === 0) return EXIT_CLEAN;
  if (result.status === 1) return EXIT_FINDINGS;
  process.stderr.write(
    `tooling failure: ${command} ended with ${result.signal ?? `exit ${result.status}`}\n`,
  );
  return EXIT_TOOLING_FAILURE;
}

/** The worse of two exit codes: a tooling failure outranks findings, findings outrank clean. */
function worseExit(left: number, right: number): number {
  const rank = (code: number) =>
    code === EXIT_TOOLING_FAILURE ? 2 : code === EXIT_FINDINGS ? 1 : 0;
  return rank(left) >= rank(right) ? left : right;
}

function hasCommand(command: string): boolean {
  return NodeChildProcess.spawnSync("sh", ["-c", `command -v ${command}`]).status === 0;
}

function defaultBase(): string {
  for (const reference of ["origin/dev", "origin/main"]) {
    const result = NodeChildProcess.spawnSync("git", ["merge-base", "HEAD", reference], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    if (result.status === 0) return result.stdout.trim();
  }
  return "HEAD";
}

function isChecked(repositoryPath: string): boolean {
  return !EXCLUDED_PREFIXES.some((prefix) => repositoryPath.startsWith(prefix));
}

interface ChangeSet {
  readonly base: string;
  /** Changed or new files that still exist, repository-relative: fmt and lint read these. */
  readonly files: string[];
  /** Every changed path, deleted ones and both sides of a rename included: typecheck reads these. */
  readonly changedPaths: string[];
  /** Untracked files: every line of them is new. */
  readonly newFiles: Set<string>;
}

/**
 * NUL-separated, so a path with spaces, quotes or non-ASCII survives unquoted.
 * `-z` goes right after the subcommand: after `--` Git reads it as a pathspec,
 * matches nothing, and the whole gate passes on an empty change set.
 */
function gitPaths([subcommand, ...args]: ReadonlyArray<string>): string[] {
  return git([subcommand!, "-z", ...args])
    .split("\0")
    .filter((file) => file.length > 0);
}

function readChangeSet(base: string): ChangeSet {
  git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
  // --no-renames reports a rename as a deletion plus an addition, so the old
  // path's package is selected too.
  const changed = gitPaths(["diff", "--name-only", "--no-renames", base, "--"]);
  const untracked = gitPaths(["ls-files", "--others", "--exclude-standard"]);
  const changedPaths = [...new Set([...changed, ...untracked])].filter(isChecked).sort();
  const files = changedPaths.filter((file) =>
    NodeFS.existsSync(NodePath.join(repositoryRoot, file)),
  );
  return { base, files, changedPaths, newFiles: new Set(untracked) };
}

const IMPORTABLE_SOURCE = /\.(?:[cm]?[jt]sx?)$/u;

/**
 * Files anywhere in the repository whose text names a changed source file by its
 * repository path without the extension, which is how a relative import across a
 * package boundary reads (`../../scripts/lib/public-config.ts`). A comment that
 * names the path also matches; the cost is one extra package typechecked.
 */
function filesNamingChangedSources(changedPaths: ReadonlyArray<string>): string[] {
  const needles = changedPaths
    .filter((file) => IMPORTABLE_SOURCE.test(file))
    .map((file) => file.replace(IMPORTABLE_SOURCE, ""));
  if (needles.length === 0) return [];
  const result = NodeChildProcess.spawnSync(
    "git",
    [
      "grep",
      "-l",
      "-z",
      "-F",
      ...needles.flatMap((needle) => ["-e", needle]),
      "--",
      "*.ts",
      "*.tsx",
      "*.mts",
      "*.cts",
      "*.js",
      "*.mjs",
    ],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  // git grep exits 1 when nothing matches.
  if (result.status !== 0 && result.status !== 1) {
    throw new ToolingFailure(`git grep failed: ${result.stderr.trim()}`);
  }
  return result.stdout.split("\0").filter((file) => file.length > 0 && isChecked(file));
}

function checkFormat(changeSet: ChangeSet | "all", environment: NodeJS.ProcessEnv): number {
  const files = changeSet === "all" ? [] : changeSet.files;
  if (changeSet !== "all" && files.length === 0) {
    process.stdout.write("fmt: no changed files\n");
    return EXIT_CLEAN;
  }
  const result = run(
    "vp",
    ["fmt", "--check", "--no-error-on-unmatched-pattern", ...files],
    environment,
  );
  process.stdout.write(result.output);
  return classifyToolExit("vp fmt", result);
}

function checkLint(changeSet: ChangeSet | "all", environment: NodeJS.ProcessEnv): number {
  if (changeSet === "all") {
    // Errors only, as CI's `vp check` fails: the repository carries upstream warnings.
    const result = run("vp", ["lint", "--report-unused-disable-directives"], environment);
    process.stdout.write(result.output);
    return classifyToolExit("vp lint", result);
  }
  const files = changeSet.files.filter((file) => LINTABLE_EXTENSIONS.test(file));
  if (files.length === 0) {
    process.stdout.write("lint: no changed source files\n");
    return EXIT_CLEAN;
  }
  const result = run("vp", ["lint", "--format", "json", ...files], environment);
  const jsonText = result.output.slice(
    result.output.indexOf("{"),
    result.output.lastIndexOf("}") + 1,
  );
  let parsed: {
    diagnostics: Array<{
      filename: string;
      severity: "error" | "warning";
      code?: string;
      message: string;
      labels?: Array<{ span?: { line?: number } }>;
    }>;
  };
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new ToolingFailure(`vp lint did not return JSON:\n${result.output.slice(0, 2000)}`);
  }
  const diagnostics: LintDiagnostic[] = parsed.diagnostics.map((diagnostic) => ({
    filename: diagnostic.filename,
    line: diagnostic.labels?.[0]?.span?.line ?? 0,
    severity: diagnostic.severity,
    code: diagnostic.code ?? "syntax",
    message: diagnostic.message,
  }));
  const changedLines = parseChangedLineRanges(
    git([
      "-c",
      "core.quotePath=false",
      "diff",
      "--unified=0",
      "--no-color",
      "--no-ext-diff",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      changeSet.base,
      "--",
      ...files,
    ]),
  );
  const reportable = selectReportableDiagnostics(diagnostics, changedLines, changeSet.newFiles);
  for (const diagnostic of reportable) {
    process.stdout.write(
      `${diagnostic.filename}:${diagnostic.line} ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}\n`,
    );
  }
  const hidden = diagnostics.length - reportable.length;
  process.stdout.write(
    `lint: ${reportable.length} finding(s) on changed lines${hidden > 0 ? `, ${hidden} older warning(s) in the same files not shown` : ""}\n`,
  );
  return reportable.length === 0 ? EXIT_CLEAN : EXIT_FINDINGS;
}

function checkTypes(changeSet: ChangeSet | "all", environment: NodeJS.ProcessEnv): number {
  let packages: WorkspacePackage[];
  try {
    packages = readWorkspacePackages(repositoryRoot).filter((candidate) =>
      isChecked(`${candidate.directory}/`),
    );
  } catch (error) {
    throw new ToolingFailure(`cannot read the workspace: ${(error as Error).message}`);
  }
  const selected =
    changeSet === "all"
      ? packages.filter((candidate) => candidate.typecheckScript !== undefined)
      : packagesToTypecheck(
          packages,
          changeSet.changedPaths,
          filesNamingChangedSources(changeSet.changedPaths),
        );
  if (selected.length === 0) {
    process.stdout.write("typecheck: no workspace package owns a changed file\n");
    return EXIT_CLEAN;
  }
  const lock = hasCommand("flock") ? ["flock", TYPECHECK_LOCK] : [];
  const timeout = hasCommand("timeout")
    ? ["timeout", "-k", "30", String(TYPECHECK_TIMEOUT_SECONDS)]
    : [];
  // A host without them still gets a typecheck, but loudly: on a shared host the
  // lock and the hard kill are what keep parallel agents from exhausting memory.
  if (lock.length === 0)
    process.stderr.write("warning: no `flock`: typechecks are not serialized across agents\n");
  if (timeout.length === 0)
    process.stderr.write("warning: no `timeout`: a hung typecheck is never killed\n");
  const tscVersion = run("tsc", ["--version"], environment).output;
  const isTypeScript7 = /Version 7\./u.test(tscVersion);
  let worst = EXIT_CLEAN;
  for (const workspacePackage of selected) {
    const usesPlainTsc = workspacePackage.typecheckScript === "tsc --noEmit";
    const command = usesPlainTsc
      ? [
          ...(isTypeScript7 ? ["env", "GOMEMLIMIT=1536MiB"] : []),
          "tsc",
          ...(isTypeScript7 ? ["--checkers", "1"] : []),
          "-p",
          `${workspacePackage.directory}/tsconfig.json`,
          "--noEmit",
        ]
      : ["vp", "run", "--filter", workspacePackage.name, "typecheck"];
    const [executable, ...args] = [...lock, ...timeout, ...command];
    const startedAt = Date.now();
    const result = run(executable!, args, environment);
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    const output = withoutTypecheckSuggestions(result.output).trim();
    // 124 and 137 are `timeout`'s own exits: the check did not finish, so its
    // silence is not a pass and its kill is not a type error.
    const timedOut = result.status === 124 || result.status === 137 || result.signal !== null;
    const outcome =
      result.status === 0 ? EXIT_CLEAN : timedOut ? EXIT_TOOLING_FAILURE : EXIT_FINDINGS;
    const verdict =
      outcome === EXIT_CLEAN ? "ok" : timedOut ? "timed out (tooling failure)" : "errors";
    process.stdout.write(`typecheck ${workspacePackage.directory}: ${verdict} (${seconds}s)\n`);
    if (outcome === EXIT_FINDINGS && output.length > 0) process.stdout.write(`${output}\n`);
    worst = worseExit(worst, outcome);
  }
  return worst;
}

function checkUnusedCode(environment: NodeJS.ProcessEnv): number {
  // knip's file and dependency checks are repository-wide by nature; CI runs this first.
  const result = run("vp", ["run", "knip:check"], environment);
  process.stdout.write(result.output);
  return classifyToolExit("knip", result);
}

function main(argv: ReadonlyArray<string>): number {
  const [check, target] = argv;
  const usage = "usage: node scripts/mesura-checks.ts <fmt|lint|typecheck|knip> [<base> | --all]\n";
  if (check === undefined || check === "--help" || check === "-h") {
    process.stdout.write(usage);
    return check === undefined ? EXIT_TOOLING_FAILURE : EXIT_CLEAN;
  }
  const environment = toolchainEnvironment(repositoryRoot);
  if (check === "knip") return checkUnusedCode(environment);
  const changeSet = target === "--all" ? "all" : readChangeSet(target ?? defaultBase());
  switch (check) {
    case "fmt":
      return checkFormat(changeSet, environment);
    case "lint":
      return checkLint(changeSet, environment);
    case "typecheck":
      return checkTypes(changeSet, environment);
    default:
      process.stderr.write(usage);
      return EXIT_TOOLING_FAILURE;
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof ToolingFailure || error instanceof MissingToolchainError)) throw error;
  process.stderr.write(`tooling failure: ${error.message}\n`);
  process.exitCode = EXIT_TOOLING_FAILURE;
}
