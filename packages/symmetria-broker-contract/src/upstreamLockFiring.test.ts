// @effect-diagnostics nodeBuiltinImport:off - drives the real compiler over files on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { BORROWED_RUNTIME_VOCABULARIES } from "./upstreamLock.ts";

/**
 * Proves every lock fires in both assignability directions, by typechecking
 * `upstreamLock.ts` on its own against a stand-in for the upstream types.
 *
 * The `@ts-expect-error` proofs in `upstreamLock.test.ts` cover the removal
 * direction only, and they compare against whatever upstream currently says.
 * This walks the other direction too — an upstream that gained a literal — which
 * is the case a weekly synchronization actually produces. It compiles the module
 * in isolation rather than perturbing the real `@t3tools/contracts`, which is
 * why `upstreamLock.ts` deliberately carries no runtime import: with only types
 * to resolve, a temporary directory with no `node_modules` above it is enough.
 *
 * The vocabularies come from `BORROWED_RUNTIME_VOCABULARIES` rather than from a
 * second hardcoded table. A hardcoded copy would go stale the moment somebody
 * mirrors a legitimate upstream addition, and would then fail with nothing to
 * say about the lock it exists to exercise.
 */

const packageRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = NodePath.join(packageRoot, "../..");
const tsgoPath = NodePath.join(repositoryRoot, "node_modules/.bin/tsgo");
const lockModulePath = NodePath.join(packageRoot, "src/upstreamLock.ts");

type VocabularyName = keyof typeof BORROWED_RUNTIME_VOCABULARIES;

/**
 * Typechecks `upstreamLock.ts` against a stand-in `@t3tools/contracts` whose
 * vocabularies are the borrowed ones, optionally with one replaced. Returns the
 * compiler's exit status.
 */
const compileAgainstUpstream = (
  directory: string,
  replacement?: { readonly name: VocabularyName; readonly literals: ReadonlyArray<string> },
) => {
  const shimSource = Object.entries(BORROWED_RUNTIME_VOCABULARIES)
    .map(([name, literals]) => {
      const members = replacement?.name === name ? replacement.literals : literals;
      return `export type ${name} = ${members.map((value) => JSON.stringify(value)).join(" | ")};`;
    })
    .join("\n");
  const shimPath = NodePath.join(directory, "contracts-shim.ts");
  NodeFS.writeFileSync(shimPath, `${shimSource}\n`);

  const configPath = NodePath.join(directory, "tsconfig.json");
  NodeFS.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        extends: NodePath.join(repositoryRoot, "tsconfig.base.json"),
        compilerOptions: { noEmit: true, paths: { "@t3tools/contracts": [shimPath] } },
        files: [lockModulePath],
      },
      null,
      2,
    )}\n`,
  );

  return NodeChildProcess.spawnSync(tsgoPath, ["-p", configPath], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
};

describe("upstream vocabulary locks", () => {
  it("compiles clean while every borrowed vocabulary matches upstream", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "symmetria-lock-match-"));
    try {
      const result = compileAgainstUpstream(directory);
      expect(`${result.stdout ?? ""}${result.stderr ?? ""}`).toBe("");
      expect(result.status).toBe(0);
    } finally {
      NodeFS.rmSync(directory, { force: true, recursive: true });
    }
  }, 60_000);

  it("fails when upstream adds or removes a literal in any borrowed vocabulary", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "symmetria-lock-drift-"));
    try {
      for (const [name, literals] of Object.entries(BORROWED_RUNTIME_VOCABULARIES) as Array<
        [VocabularyName, ReadonlyArray<string>]
      >) {
        const added = compileAgainstUpstream(directory, {
          name,
          literals: [...literals, "future_upstream_literal"],
        });
        expect(added.status, `${name} accepted an upstream addition`).not.toBe(0);

        const removed = compileAgainstUpstream(directory, { name, literals: literals.slice(1) });
        expect(removed.status, `${name} accepted an upstream removal`).not.toBe(0);
      }
    } finally {
      NodeFS.rmSync(directory, { force: true, recursive: true });
    }
  }, 120_000);
});
