// @effect-diagnostics nodeBuiltinImport:off - drives the real compiler over files on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  compileVocabularyLock,
  expectVocabularyLockRejection,
  runTypechecker,
} from "../test/compilerGuard.ts";
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

type VocabularyName = keyof typeof BORROWED_RUNTIME_VOCABULARIES;

describe("upstream vocabulary locks", () => {
  it("upstream vocabulary compiler guard rejects a missing compiler instead of accepting a lock failure", () => {
    const directory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "symmetria-missing-compiler-"),
    );
    try {
      const result = runTypechecker(NodePath.join(directory, "missing-tsc"), ["--noEmit"]);
      expect(result.error).toMatchObject({ code: "ENOENT" });
      expect(() => expectVocabularyLockRejection(result, "RuntimeSessionState")).toThrow(
        "compiler launch or execution failed",
      );
    } finally {
      NodeFS.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("upstream vocabulary compiler guard rejects infrastructure errors and unrelated diagnostics even beside a real lock diagnostic", () => {
    const directory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "symmetria-lock-diagnostics-"),
    );
    try {
      const result = compileVocabularyLock(directory, {
        name: "RuntimeSessionState",
        values: [...BORROWED_RUNTIME_VOCABULARIES.RuntimeSessionState, "future_upstream_literal"],
      });
      expectVocabularyLockRejection(result, "RuntimeSessionState");
      const unrelatedDiagnostic = "unrelated.ts(1,1): error TS2307: Cannot find module 'missing'.";
      const invalidResults = [
        { ...result, error: new Error("failed compiler launch") },
        { ...result, error: Object.assign(new Error("compiler timed out"), { code: "ETIMEDOUT" }) },
        {
          ...result,
          error: Object.assign(new Error("output buffer exceeded"), { code: "ENOBUFS" }),
        },
        { ...result, signal: "SIGKILL" as const, status: null },
        { ...result, status: null },
        { ...result, status: 0 },
        { ...result, status: 127 },
        { ...result, stdout: "", stderr: "" },
        { ...result, stdout: result.stdout.replace("TS2322", "TS2307") },
        { ...result, stdout: result.stdout.replace("upstreamLock.ts", "unrelated.ts") },
        { ...result, stdout: `${result.stdout}\n${unrelatedDiagnostic}` },
      ];
      for (const invalidResult of invalidResults) {
        expect(() => expectVocabularyLockRejection(invalidResult, "RuntimeSessionState")).toThrow();
      }
      expect(() => expectVocabularyLockRejection(result, "RuntimeThreadState")).toThrow(
        "expected only the assignability diagnostic at the changed vocabulary lock",
      );
    } finally {
      NodeFS.rmSync(directory, { force: true, recursive: true });
    }
  }, 60_000);

  it("compiles clean while every borrowed vocabulary matches upstream", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "symmetria-lock-match-"));
    try {
      const result = compileVocabularyLock(directory);
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
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
        const added = compileVocabularyLock(directory, {
          name,
          values: [...literals, "future_upstream_literal"],
        });
        expectVocabularyLockRejection(added, name);

        const removed = compileVocabularyLock(directory, { name, values: literals.slice(1) });
        expectVocabularyLockRejection(removed, name);
      }
    } finally {
      NodeFS.rmSync(directory, { force: true, recursive: true });
    }
  }, 120_000);
});
