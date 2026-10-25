// @effect-diagnostics nodeBuiltinImport:off - Read by a plain CLI and by repository guards.
/**
 * Logic behind `scripts/mesura-checks.ts`, the change gate that AGENTS.md's
 * `Deterministic Checks` section runs. Everything but `readWorkspacePackages` is
 * pure, so it is testable without git, a toolchain, or a workspace on disk.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Inclusive 1-based line range in the working-tree version of a file. */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Reads `git diff --unified=0` output and returns, per file, the line ranges the
 * diff added or rewrote. A pure deletion (`+N,0`) adds no range: nothing is left
 * on those lines to lint.
 */
export function parseChangedLineRanges(unifiedDiff: string): Map<string, LineRange[]> {
  const rangesByFile = new Map<string, LineRange[]>();
  let currentFile: string | undefined;
  for (const line of unifiedDiff.split("\n")) {
    if (line.startsWith("+++ ")) {
      // Git appends a tab after a filename that contains a space.
      const target = line.slice(4).replace(/\t$/u, "");
      currentFile = target === "/dev/null" ? undefined : target.replace(/^b\//u, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (hunk === null || currentFile === undefined) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0) continue;
    const ranges = rangesByFile.get(currentFile) ?? [];
    ranges.push({ start, end: start + count - 1 });
    rangesByFile.set(currentFile, ranges);
  }
  return rangesByFile;
}

export interface LintDiagnostic {
  readonly filename: string;
  readonly line: number;
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
}

/**
 * Keeps every error, and a warning only where the change wrote that line. The
 * repository carries over a hundred warnings in upstream code; reporting them for
 * every touched file made agents diff warning counts by hand to find their own.
 * Every line of a file in `newFiles` (untracked) counts as changed; a tracked file
 * with no range in `changedLines` has no changed line to report a warning on.
 */
export function selectReportableDiagnostics(
  diagnostics: ReadonlyArray<LintDiagnostic>,
  changedLines: ReadonlyMap<string, ReadonlyArray<LineRange>>,
  newFiles: ReadonlySet<string>,
): LintDiagnostic[] {
  return diagnostics.filter((diagnostic) => {
    if (diagnostic.severity === "error" || newFiles.has(diagnostic.filename)) return true;
    const ranges = changedLines.get(diagnostic.filename) ?? [];
    return ranges.some((range) => diagnostic.line >= range.start && diagnostic.line <= range.end);
  });
}

export interface WorkspacePackage {
  readonly name: string;
  /** Repository-relative directory, without a trailing slash. */
  readonly directory: string;
  readonly typecheckScript: string | undefined;
  /** Names of the workspace packages this one depends on (`workspace:` specifiers). */
  readonly workspaceDependencies: ReadonlySet<string>;
}

/**
 * Reads the `packages:` list from `pnpm-workspace.yaml`, globs unexpanded; an
 * exclusion keeps its leading `!`. Handles the block-list form this repository
 * uses, not every YAML shape: `readWorkspacePackages` refuses an empty result.
 */
export function readWorkspaceGlobs(workspaceYaml: string): string[] {
  const globs: string[] = [];
  let insidePackages = false;
  for (const line of workspaceYaml.split("\n")) {
    if (/^packages:\s*(?:#.*)?$/u.test(line)) {
      insidePackages = true;
      continue;
    }
    if (!insidePackages) continue;
    if (/^\S/u.test(line) && !line.startsWith("#")) break;
    const entry = /^\s+-\s+["']?(!?[^"'\s#]+)/u.exec(line);
    if (entry !== null) globs.push(entry[1]!);
  }
  return globs;
}

/** Every workspace package `pnpm-workspace.yaml` lists, vendored members included. */
export function readWorkspacePackages(repositoryRoot: string): WorkspacePackage[] {
  const globs = readWorkspaceGlobs(
    NodeFS.readFileSync(NodePath.join(repositoryRoot, "pnpm-workspace.yaml"), "utf8"),
  );
  const exclusions = new Set(
    globs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1)),
  );
  const directories = globs
    .filter((glob) => !glob.startsWith("!"))
    .flatMap((glob) => {
      if (!glob.endsWith("/*")) return [glob];
      const parent = glob.slice(0, -2);
      return NodeFS.readdirSync(NodePath.join(repositoryRoot, parent)).map(
        (entry) => `${parent}/${entry}`,
      );
    });
  const packages = directories
    .filter((directory) => !exclusions.has(directory))
    .flatMap((directory) => {
      const manifestPath = NodePath.join(repositoryRoot, directory, "package.json");
      if (!NodeFS.existsSync(manifestPath)) return [];
      const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as {
        name: string;
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      // Each section separately: spreading them together lets one section's
      // specifier overwrite another section's `workspace:` edge.
      const workspaceDependencies = new Set(
        [
          manifest.dependencies,
          manifest.devDependencies,
          manifest.peerDependencies,
          manifest.optionalDependencies,
        ].flatMap((section) =>
          Object.entries(section ?? {})
            .filter(([, specifier]) => specifier.startsWith("workspace:"))
            .map(([name]) => name),
        ),
      );
      return [
        {
          name: manifest.name,
          directory,
          // Vite+ tasks can own typecheck without a package script.
          typecheckScript:
            manifest.scripts?.typecheck ??
            (NodeFS.existsSync(NodePath.join(repositoryRoot, directory, "tsconfig.json"))
              ? manifest.devDependencies?.["@astrojs/check"] === undefined
                ? "tsc-rs --noEmit"
                : "astro check"
              : undefined),
          workspaceDependencies,
        },
      ];
    });
  if (packages.length === 0) {
    throw new Error("pnpm-workspace.yaml lists no workspace package this reader understands");
  }
  return packages;
}

/** The workspace package that owns a file: the one with the deepest matching directory. */
export function owningPackage(
  packages: ReadonlyArray<WorkspacePackage>,
  repositoryPath: string,
): WorkspacePackage | undefined {
  let owner: WorkspacePackage | undefined;
  for (const candidate of packages) {
    if (!repositoryPath.startsWith(`${candidate.directory}/`)) continue;
    if (owner === undefined || candidate.directory.length > owner.directory.length) {
      owner = candidate;
    }
  }
  return owner;
}

/**
 * Repository-root files every package's typecheck reads: compiler settings they
 * extend, and the manifests and lockfile that decide which types resolve.
 */
const ROOT_TYPECHECK_INPUTS =
  /^(?:tsconfig[^/]*\.json|package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml)$/u;

/**
 * The packages a change can break the types of: each package that owns a changed
 * file, plus every package that depends on one of those, transitively. A changed
 * type in `packages/contracts` fails in `apps/web`, not in `contracts` itself.
 *
 * `changedFiles` includes deleted paths: removing a module breaks its importers.
 * `importingFiles` are files that import a changed file by relative path across a
 * package boundary, which no manifest records (`apps/*\/vite.config.ts` import
 * `scripts/lib/public-config.ts`). A change to a root typecheck input selects
 * every package.
 */
export function packagesToTypecheck(
  packages: ReadonlyArray<WorkspacePackage>,
  changedFiles: ReadonlyArray<string>,
  importingFiles: ReadonlyArray<string> = [],
): WorkspacePackage[] {
  if (changedFiles.some((file) => ROOT_TYPECHECK_INPUTS.test(file))) {
    return packages.filter((candidate) => candidate.typecheckScript !== undefined);
  }
  const selected = new Set<string>();
  const pending: string[] = [];
  for (const file of [...changedFiles, ...importingFiles]) {
    const owner = owningPackage(packages, file);
    if (owner !== undefined && !selected.has(owner.name)) {
      selected.add(owner.name);
      pending.push(owner.name);
    }
  }
  while (pending.length > 0) {
    const changedName = pending.pop()!;
    for (const candidate of packages) {
      if (selected.has(candidate.name) || !candidate.workspaceDependencies.has(changedName)) {
        continue;
      }
      selected.add(candidate.name);
      pending.push(candidate.name);
    }
  }
  return packages.filter(
    (candidate) => selected.has(candidate.name) && candidate.typecheckScript !== undefined,
  );
}

/**
 * Drops TypeScript 7's `suggestion TS…` diagnostics, which do not fail the check
 * and can fill several kilobytes of output around the one real error.
 */
export function withoutTypecheckSuggestions(output: string): string {
  return output
    .split("\n")
    .filter((line) => !/\bsuggestion TS\d+:/u.test(line))
    .join("\n");
}
