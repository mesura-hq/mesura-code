// @effect-diagnostics nodeBuiltinImport:off - drives repository tools as an external consumer.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { runTypechecker } from "../../packages/symmetria-broker-contract/test/compilerGuard.ts";

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
// Match phase one's package deadline. Outer Vitest limits do not reach child runners.
const PACKAGE_TEST_PROCESS_TIMEOUT_MS = 45_000;

const boundedTestArguments = (args: ReadonlyArray<string>) => {
  const normalizedArguments: Array<string> = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const option = argument.split("=", 1)[0]!;
    if (["--max-workers", "--maxWorkers", "--root", "-r", "--dir"].includes(option)) {
      if (!argument.includes("=")) index += 1;
      continue;
    }
    if (
      [
        "--file-parallelism",
        "--fileParallelism",
        "--no-file-parallelism",
        "--no-fileParallelism",
      ].includes(option)
    ) {
      if (args[index + 1] === "true" || args[index + 1] === "false") index += 1;
      continue;
    }
    normalizedArguments.push(argument);
  }
  return [
    ...normalizedArguments,
    "--max-workers=1",
    "--no-file-parallelism",
    "--root",
    ".",
    "--dir",
    ".",
  ];
};

export const run = (
  command: string,
  args: ReadonlyArray<string>,
  cwd = repositoryRoot,
  timeoutMilliseconds?: number,
) => {
  if (command === typecheckerPath) {
    return runTypechecker(command, args, cwd, timeoutMilliseconds);
  }
  const isTestRun = command === vitePlusPath && args[0] === "test" && args[1] === "run";
  return NodeChildProcess.spawnSync(command, isTestRun ? boundedTestArguments(args) : args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: RUN_OUTPUT_LIMIT_BYTES,
    timeout: timeoutMilliseconds ?? (isTestRun ? PACKAGE_TEST_PROCESS_TIMEOUT_MS : undefined),
    killSignal: "SIGKILL",
  });
};

export const commandOutput = (result: NodeChildProcess.SpawnSyncReturns<string>) =>
  `${result.stdout ?? ""}${result.stderr ?? ""}`;

export const expectSuccessfulCommand = (result: NodeChildProcess.SpawnSyncReturns<string>) => {
  if (result.error !== undefined) {
    throw new Error(
      `command could not complete: ${result.error.message}\n${commandOutput(result)}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`command exited with ${String(result.status)}\n${commandOutput(result)}`);
  }
};

export const runContractScript = (source: string) =>
  run(process.execPath, ["--input-type=module", "--eval", source], contractPackageRoot);

export const fixturePath = (name: string) => NodePath.join(contractFixtureRoot, name);
