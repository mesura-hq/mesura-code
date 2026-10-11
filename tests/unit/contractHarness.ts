// @effect-diagnostics nodeBuiltinImport:off - drives repository tools as an external consumer.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const repositoryRoot = NodeURL.fileURLToPath(new URL("../..", import.meta.url));
export const contractPackageRoot = NodePath.join(
  repositoryRoot,
  "packages/symmetria-broker-contract",
);
export const contractSourceRoot = NodePath.join(contractPackageRoot, "src");
export const contractFixtureRoot = NodePath.join(contractPackageRoot, "test/fixtures");
export const vitePlusPath = NodePath.join(repositoryRoot, "node_modules/.bin/vp");
/**
 * The repository's typechecker.
 *
 * v0.0.42 dropped `@typescript/native-preview`, which is what provided `tsgo`;
 * every package went back to `tsc`. These guards spawn the binary directly, so
 * they need the path rather than the package script.
 */
export const typecheckerPath = NodePath.join(repositoryRoot, "node_modules/.bin/tsc");

/**
 * Room for a `git grep --only-matching` over the whole tracked tree, which
 * prints tens of megabytes. spawnSync's 1 MiB default truncates it silently
 * into a non-zero status.
 */
const RUN_OUTPUT_LIMIT_BYTES = 256 * 1024 * 1024;

export const run = (command: string, args: ReadonlyArray<string>, cwd = repositoryRoot) =>
  NodeChildProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: RUN_OUTPUT_LIMIT_BYTES,
  });

export const commandOutput = (result: NodeChildProcess.SpawnSyncReturns<string>) =>
  `${result.stdout ?? ""}${result.stderr ?? ""}`;

export const expectSuccessfulCommand = (result: NodeChildProcess.SpawnSyncReturns<string>) => {
  if (result.status !== 0) {
    throw new Error(`command exited with ${String(result.status)}\n${commandOutput(result)}`);
  }
};

export const runContractScript = (source: string) =>
  run(process.execPath, ["--input-type=module", "--eval", source], contractPackageRoot);

export const fixturePath = (name: string) => NodePath.join(contractFixtureRoot, name);
