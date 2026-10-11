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

/**
 * The installed Node directory matching `engines.node`'s major, when the running
 * Node is a different major and nvm has the pinned one; otherwise `undefined`.
 */
function pinnedNodeBinDirectory(repositoryRoot: string): string | undefined {
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(repositoryRoot, "package.json"), "utf8"),
  ) as { engines?: { node?: string } };
  const pinnedMajor = /(\d+)/u.exec(manifest.engines?.node ?? "")?.[1];
  if (pinnedMajor === undefined || pinnedMajor === process.versions.node.split(".")[0]) {
    return undefined;
  }
  const nvmVersions = NodePath.join(
    process.env.NVM_DIR ?? NodePath.join(NodeOS.homedir(), ".nvm"),
    "versions",
    "node",
  );
  const pinnedInstall = NodeFS.existsSync(nvmVersions)
    ? NodeFS.readdirSync(nvmVersions)
        .filter((version) => version.startsWith(`v${pinnedMajor}.`))
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
        .at(-1)
    : undefined;
  if (pinnedInstall === undefined) {
    process.stderr.write(
      `note: running Node ${process.versions.node}, but package.json pins ${manifest.engines?.node}\n`,
    );
    return undefined;
  }
  return NodePath.join(nvmVersions, pinnedInstall, "bin");
}

/** `process.env` with the repository's `node_modules/.bin` and the pinned Node first on PATH. */
export function toolchainEnvironment(repositoryRoot: string): NodeJS.ProcessEnv {
  const binDirectory = NodePath.join(repositoryRoot, "node_modules", ".bin");
  if (!NodeFS.existsSync(NodePath.join(binDirectory, "vp"))) {
    throw new MissingToolchainError(
      "node_modules/.bin/vp is missing: install first (see AGENTS.md, Dev servers)",
    );
  }
  const nodeDirectory = pinnedNodeBinDirectory(repositoryRoot);
  return {
    ...process.env,
    NO_COLOR: "1",
    PATH: [binDirectory, ...(nodeDirectory === undefined ? [] : [nodeDirectory]), process.env.PATH]
      .filter((entry) => entry !== undefined && entry.length > 0)
      .join(NodePath.delimiter),
  };
}
