import { describe, expect, it } from "vite-plus/test";

import {
  type LintDiagnostic,
  type WorkspacePackage,
  packagesToTypecheck,
  parseChangedLineRanges,
  readWorkspaceGlobs,
  selectReportableDiagnostics,
  withoutTypecheckSuggestions,
} from "./mesura-checks.ts";

const workspacePackage = (
  name: string,
  directory: string,
  workspaceDependencies: ReadonlyArray<string> = [],
  options: { readonly hasTypecheck?: boolean } = {},
): WorkspacePackage => ({
  name,
  directory,
  typecheckScript: options.hasTypecheck === false ? undefined : "tsc --noEmit",
  workspaceDependencies: new Set(workspaceDependencies),
});

describe("parseChangedLineRanges", () => {
  it("keeps added and rewritten lines and skips pure deletions", () => {
    const diff = [
      "diff --git a/apps/web/a.ts b/apps/web/a.ts",
      "--- a/apps/web/a.ts",
      "+++ b/apps/web/a.ts",
      "@@ -3 +3 @@ rewritten single line",
      "@@ -10,2 +10,0 @@ pure deletion",
      "@@ -20,0 +21,3 @@ insertion",
      "diff --git a/old.ts b/old.ts",
      "--- a/old.ts",
      "+++ /dev/null",
      "@@ -1,4 +0,0 @@",
    ].join("\n");

    expect(parseChangedLineRanges(diff)).toEqual(
      new Map([
        [
          "apps/web/a.ts",
          [
            { start: 3, end: 3 },
            { start: 21, end: 23 },
          ],
        ],
      ]),
    );
  });
});

describe("selectReportableDiagnostics", () => {
  const diagnostic = (
    filename: string,
    line: number,
    severity: LintDiagnostic["severity"],
  ): LintDiagnostic => ({ filename, line, severity, code: "rule", message: "message" });

  it("reports every error, and warnings only on changed lines or in new files", () => {
    const changedLines = new Map([["a.ts", [{ start: 10, end: 12 }]]]);
    const reported = selectReportableDiagnostics(
      [
        diagnostic("a.ts", 2, "error"),
        diagnostic("a.ts", 2, "warning"),
        diagnostic("a.ts", 11, "warning"),
        diagnostic("new.ts", 1, "warning"),
      ],
      changedLines,
      new Set(["new.ts"]),
    );

    expect(
      reported.map(({ filename, line, severity }) => `${filename}:${line}:${severity}`),
    ).toEqual(["a.ts:2:error", "a.ts:11:warning", "new.ts:1:warning"]);
  });
});

describe("readWorkspaceGlobs", () => {
  it("reads only the packages list, comments and quotes included", () => {
    const yaml = [
      "packages:",
      "  - apps/*",
      "  # a comment between entries",
      '  - "scripts"',
      "  - vendor/symmetria-file-manager/packages/fm-main # trailing comment",
      "catalog:",
      "  - not-a-package",
    ].join("\n");

    expect(readWorkspaceGlobs(yaml)).toEqual([
      "apps/*",
      "scripts",
      "vendor/symmetria-file-manager/packages/fm-main",
    ]);
  });
});

describe("packagesToTypecheck", () => {
  const packages = [
    workspacePackage("@t3tools/contracts", "packages/contracts"),
    workspacePackage("@t3tools/shared", "packages/shared", ["@t3tools/contracts"]),
    workspacePackage("@t3tools/web", "apps/web", ["@t3tools/shared"]),
    workspacePackage("@mesura/keys", "packages/keys"),
    workspacePackage("@t3tools/no-typecheck", "packages/no-typecheck", ["@t3tools/contracts"], {
      hasTypecheck: false,
    }),
  ];

  it("adds every transitive dependent of a changed package", () => {
    const selected = packagesToTypecheck(packages, ["packages/contracts/src/thread.ts"]);

    expect(selected.map((selectedPackage) => selectedPackage.directory)).toEqual([
      "packages/contracts",
      "packages/shared",
      "apps/web",
    ]);
  });

  it("checks only the owner of a leaf change, and nothing for files outside every package", () => {
    expect(
      packagesToTypecheck(packages, ["apps/web/src/a.tsx", "AGENTS.md"]).map(
        (selectedPackage) => selectedPackage.directory,
      ),
    ).toEqual(["apps/web"]);
  });
});

describe("withoutTypecheckSuggestions", () => {
  it("drops suggestion diagnostics and keeps errors", () => {
    const output = [
      "a.ts(1,1): suggestion TS377098: prefer something",
      "a.ts(2,1): error TS2322: Type 'string' is not assignable to type 'number'.",
    ].join("\n");

    expect(withoutTypecheckSuggestions(output)).toBe(
      "a.ts(2,1): error TS2322: Type 'string' is not assignable to type 'number'.",
    );
  });
});
