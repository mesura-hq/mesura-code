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
 * Proves every lock fires in both directions against the broker's frozen vocabulary.
 * The compiler checks an unchanged copy of upstreamLock.ts with only its imported types
 * replaced, so the tests exercise the production declarations without runtime imports.
 */

type VocabularyName = keyof typeof BORROWED_RUNTIME_VOCABULARIES;
const vocabularies = Object.entries(BORROWED_RUNTIME_VOCABULARIES) as Array<
  [VocabularyName, ReadonlyArray<string>]
>;

describe("frozen broker vocabulary locks", () => {
  it("rejects a missing compiler instead of accepting a lock failure", () => {
    const directory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "symmetria-missing-compiler-"),
    );
    try {
      const result = runTypechecker(NodePath.join(directory, "missing-tsc"), ["--noEmit"]);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(127);
      expect(result.stderr).toContain("missing-tsc");
      expect(() => expectVocabularyLockRejection(result, "RuntimeSessionState")).toThrow(
        "expected diagnostic exit status 1 or 2",
      );
    } finally {
      NodeFS.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects infrastructure errors and unrelated diagnostics even beside a real lock diagnostic", () => {
    const directory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "symmetria-lock-diagnostics-"),
    );
    try {
      const result = compileVocabularyLock(directory, {
        name: "RuntimeSessionState",
        values: [...BORROWED_RUNTIME_VOCABULARIES.RuntimeSessionState, "future_broker_literal"],
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
        { ...result, status: 124 },
        { ...result, status: 126 },
        { ...result, status: 127 },
        { ...result, status: 137 },
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
  });

  it("compiles clean while every tuple matches its frozen broker vocabulary", () => {
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
  });

  it.each(vocabularies)("fails when %s adds or removes a frozen literal", (name, literals) => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "symmetria-lock-drift-"));
    try {
      const added = compileVocabularyLock(directory, {
        name,
        values: [...literals, "future_broker_literal"],
      });
      expectVocabularyLockRejection(added, name);

      const removed = compileVocabularyLock(directory, { name, values: literals.slice(1) });
      expectVocabularyLockRejection(removed, name);
    } finally {
      NodeFS.rmSync(directory, { force: true, recursive: true });
    }
  });
});
