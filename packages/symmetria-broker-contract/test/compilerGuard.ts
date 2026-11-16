// @effect-diagnostics nodeBuiltinImport:off - compiler guards run over temporary files on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { BORROWED_RUNTIME_VOCABULARIES } from "../src/upstreamLock.ts";

const packageRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = NodePath.join(packageRoot, "../..");
const typecheckerPath = NodePath.join(repositoryRoot, "node_modules/.bin/effect-tsgo");
const lockModulePath = NodePath.join(packageRoot, "src/upstreamLock.ts");
const COMPILER_PROCESS_TIMEOUT_MS = 900_000;
type VocabularyName = keyof typeof BORROWED_RUNTIME_VOCABULARIES;

// Lock only compiler subprocesses. Holding this lock around a test suite deadlocks
// when a nested suite starts another compiler guard.
export const runTypechecker = (
  command: string,
  args: ReadonlyArray<string>,
  cwd = repositoryRoot,
  timeoutMilliseconds = COMPILER_PROCESS_TIMEOUT_MS,
) =>
  NodeChildProcess.spawnSync(
    "flock",
    [
      "/tmp/mesura-typecheck.lock",
      "env",
      "GOMEMLIMIT=1536MiB",
      "timeout",
      "-k",
      "30",
      String(timeoutMilliseconds / 1000),
      command,
      "tsc",
      "--checkers",
      "1",
      "--pretty",
      "false",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 8 * 1024 * 1024,
    },
  );

/** Compile the unchanged lock source against matching or changed frozen vocabularies. */
export const compileVocabularyLock = (
  directory: string,
  replacement?: { readonly name: VocabularyName; readonly values: ReadonlyArray<string> },
) => {
  const shimSource = Object.entries(BORROWED_RUNTIME_VOCABULARIES)
    .map(([name, literals]) => {
      const members = replacement?.name === name ? replacement.values : literals;
      return `export type ${name} = ${members.map((value) => JSON.stringify(value)).join(" | ")};`;
    })
    // The lock derives the event vocabulary from the discriminant field.
    .concat("export type ProviderRuntimeEvent = { readonly type: ProviderRuntimeEventType };")
    .join("\n");
  const shimPath = NodePath.join(directory, "retiredUpstreamVocabulary.ts");
  NodeFS.writeFileSync(shimPath, `${shimSource}\n`);
  // Copy the source unchanged so its relative import resolves to the replacement vocabulary.
  const fixtureLockModulePath = NodePath.join(directory, "upstreamLock.ts");
  NodeFS.copyFileSync(lockModulePath, fixtureLockModulePath);
  NodeFS.writeFileSync(NodePath.join(directory, "package.json"), '{"type":"module"}\n');
  const configPath = NodePath.join(directory, "tsconfig.json");
  NodeFS.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        extends: NodePath.join(repositoryRoot, "tsconfig.base.json"),
        compilerOptions: { noEmit: true },
        files: [fixtureLockModulePath],
      },
      null,
      2,
    )}\n`,
  );
  return {
    ...runTypechecker(typecheckerPath, ["-p", configPath]),
    lockModulePath: fixtureLockModulePath,
  };
};

/**
 * A rejected vocabulary must produce exactly its lock's assignability diagnostic.
 * Infrastructure failures and unrelated diagnostics cannot prove that a lock fires.
 */
export const expectVocabularyLockRejection = (
  result: NodeChildProcess.SpawnSyncReturns<string> & { readonly lockModulePath?: string },
  vocabularyName: VocabularyName,
) => {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  function fail(reason: string): never {
    throw new Error(`${vocabularyName}: ${reason}\n${output}`);
  }
  if (result.error !== undefined) {
    fail(`compiler launch or execution failed: ${result.error.message}`);
  }
  if (result.signal !== null) {
    fail(`compiler ended with signal ${String(result.signal)}`);
  }
  // Accept compiler diagnostic exits, but never timeout or wrapper execution failures.
  if (result.status !== 1 && result.status !== 2) {
    fail(`compiler exited with ${String(result.status)}, expected diagnostic exit status 1 or 2`);
  }

  const source = NodeFS.readFileSync(lockModulePath, "utf8");
  // Derive the diagnostic location from the declaration so line additions and
  // formatting changes cannot invalidate a working vocabulary lock.
  const declaration = new RegExp(
    `export\\s+const\\s+(\\w+)\\s*:\\s*MutuallyAssignable<[^;]*\\b${vocabularyName}\\s*>\\s*=\\s*true;`,
  ).exec(source);
  if (declaration === null) fail("the changed vocabulary has no lock declaration");
  const identifierOffset = declaration.index + declaration[0].indexOf(declaration[1]!);
  const precedingSource = source.slice(0, identifierOffset);
  const expectedLine = precedingSource.split("\n").length;
  const expectedColumn = identifierOffset - precedingSource.lastIndexOf("\n");
  const diagnostic =
    /^(.+)\((\d+),(\d+)\): error TS2322: Type '(?:true|boolean)' is not assignable to type 'never'\.$/.exec(
      output,
    );
  if (
    diagnostic === null ||
    NodePath.resolve(repositoryRoot, diagnostic[1]!) !==
      (result.lockModulePath ?? lockModulePath) ||
    Number(diagnostic[2]) !== expectedLine ||
    Number(diagnostic[3]) !== expectedColumn
  ) {
    fail("expected only the assignability diagnostic at the changed vocabulary lock");
  }
};
