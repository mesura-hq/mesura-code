// @effect-diagnostics nodeBuiltinImport:off - Resolves executables for plain CLI scripts.
/**
 * The environment the agent-facing scripts (`mesura-checks.ts`, `mesura-browser.ts`)
 * give their children. Agent shells on the developer's hosts often have neither
 * `vp` nor the pinned Node on PATH, and a check run under the wrong Node fails in
 * ways that look like code findings (Electron's postinstall, `localStorage` in tests).
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export class MissingToolchainError extends Error {}

/** `[major, minor, patch]` of a version string such as `v24.13.1` or `24.13.1`. */
function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(version.trim());
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Whether `version` satisfies an `engines.node` range of the forms this repository
 * uses: `^X.Y.Z` (same major, at least X.Y.Z), an exact `X.Y.Z`, or a major (`X`,
 * `X.x`). Any other form is never satisfied, so it fails loudly instead of guessing.
 */
export function satisfiesNodeRange(version: string, range: string): boolean {
  const actual = parseVersion(version);
  const majorOnly = /^\s*(\d+)(?:\.x)?\s*$/u.exec(range);
  if (actual === undefined) return false;
  if (majorOnly !== null) return actual[0] === Number(majorOnly[1]);
  const minimum = parseVersion(range.replace(/^\s*\^/u, ""));
  if (minimum === undefined) return false;
  if (actual[0] !== minimum[0]) return false;
  if (/^\s*\d/u.test(range)) return actual.join(".") === minimum.join(".");
  if (!/^\s*\^/u.test(range)) return false;
  for (let index = 1; index < 3; index += 1) {
    if (actual[index]! !== minimum[index]!) return actual[index]! > minimum[index]!;
  }
  return true;
}

/**
 * The bin directory of a Node that satisfies `engines.node`: the running one when
 * it does, else the newest satisfying nvm install. Children get it first on PATH,
 * so a script launched by an absolute Node 24 path does not hand its children the
 * Node 26 that PATH would otherwise find.
 */
function pinnedNodeBinDirectory(repositoryRoot: string): string {
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(repositoryRoot, "package.json"), "utf8"),
  ) as { engines?: { node?: string } };
  const range = manifest.engines?.node;
  if (range === undefined || satisfiesNodeRange(process.versions.node, range)) {
    return NodePath.dirname(process.execPath);
  }
  const nvmVersions = NodePath.join(
    process.env.NVM_DIR ?? NodePath.join(NodeOS.homedir(), ".nvm"),
    "versions",
    "node",
  );
  const satisfying = NodeFS.existsSync(nvmVersions)
    ? NodeFS.readdirSync(nvmVersions)
        .filter((version) => satisfiesNodeRange(version, range))
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
        .at(-1)
    : undefined;
  if (satisfying === undefined) {
    throw new MissingToolchainError(
      `package.json needs Node ${range}, this is ${process.versions.node}, and nvm has no match: install one (nvm install, or the Vite+ node shim)`,
    );
  }
  return NodePath.join(nvmVersions, satisfying, "bin");
}

/** `process.env` with the repository's `node_modules/.bin` and the pinned Node first on PATH. */
export function toolchainEnvironment(repositoryRoot: string): NodeJS.ProcessEnv {
  const binDirectory = NodePath.join(repositoryRoot, "node_modules", ".bin");
  if (!NodeFS.existsSync(NodePath.join(binDirectory, "vp"))) {
    throw new MissingToolchainError(
      "node_modules/.bin/vp is missing: install first (see AGENTS.md, Dev servers)",
    );
  }
  return {
    ...process.env,
    NO_COLOR: "1",
    PATH: [binDirectory, pinnedNodeBinDirectory(repositoryRoot), process.env.PATH]
      .filter((entry) => entry !== undefined && entry.length > 0)
      .join(NodePath.delimiter),
  };
}
