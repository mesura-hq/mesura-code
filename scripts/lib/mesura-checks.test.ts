// @effect-diagnostics nodeBuiltinImport:off - Tests write a throwaway workspace to disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  type LintDiagnostic,
  type WorkspacePackage,
  packagesToTypecheck,
  parseChangedLineRanges,
  readWorkspaceGlobs,
  readWorkspacePackages,
  selectReportableDiagnostics,
  withoutTypecheckSuggestions,
} from "./mesura-checks.ts";
import { satisfiesNodeRange } from "./mesura-toolchain.ts";

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

  it("strips the tab Git appends after a filename that contains a space", () => {
    const diff = ["--- a/docs/my file.ts\t", "+++ b/docs/my file.ts\t", "@@ -1 +1 @@"].join("\n");

    expect([...parseChangedLineRanges(diff).keys()]).toEqual(["docs/my file.ts"]);
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

  it("accepts a comment after the key and keeps exclusions", () => {
    expect(readWorkspaceGlobs("packages: # the workspace\n  - apps/*\n  - '!apps/old'\n")).toEqual([
      "apps/*",
      "!apps/old",
    ]);
  });
});

describe("readWorkspacePackages", () => {
  const writeWorkspace = (files: Record<string, string>) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mesura-checks-"));
    for (const [file, text] of Object.entries(files)) {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(root, file), text);
    }
    return root;
  };

  it("unions workspace edges from every dependency section and honours exclusions", () => {
    const root = writeWorkspace({
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n  - '!packages/old'\n",
      "packages/a/package.json": JSON.stringify({ name: "a" }),
      "packages/old/package.json": JSON.stringify({ name: "old" }),
      "packages/b/package.json": JSON.stringify({
        name: "b",
        dependencies: { a: "workspace:*" },
        devDependencies: { a: "^1.0.0" },
        optionalDependencies: { c: "workspace:^" },
      }),
    });
    try {
      const packages = readWorkspacePackages(root);
      expect(packages.map((entry) => entry.name).sort()).toEqual(["a", "b"]);
      expect(
        [...packages.find((entry) => entry.name === "b")!.workspaceDependencies].sort(),
      ).toEqual(["a", "c"]);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds typecheck tasks that moved out of package scripts", () => {
    const root = writeWorkspace({
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/tasks/package.json": JSON.stringify({ name: "tasks" }),
      "packages/tasks/tsconfig.json": "{}",
      "packages/plain/package.json": JSON.stringify({ name: "plain" }),
      "packages/astro/package.json": JSON.stringify({
        name: "astro",
        devDependencies: { "@astrojs/check": "^0.9.0" },
      }),
      "packages/astro/tsconfig.json": "{}",
    });
    try {
      const scripts = Object.fromEntries(
        readWorkspacePackages(root).map((entry) => [entry.name, entry.typecheckScript]),
      );
      expect(scripts).toEqual({
        tasks: "tsc --noEmit",
        plain: undefined,
        astro: "astro check",
      });
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a workspace it reads as empty instead of selecting nothing", () => {
    const root = writeWorkspace({ "pnpm-workspace.yaml": "packages: [apps/*]\n" });
    try {
      expect(() => readWorkspacePackages(root)).toThrow(/no workspace package/u);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
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

  it("selects every package when a root typecheck input changes", () => {
    expect(packagesToTypecheck(packages, ["tsconfig.base.json"])).toHaveLength(4);
    expect(packagesToTypecheck(packages, ["pnpm-lock.yaml"])).toHaveLength(4);
  });

  it("selects the owner of a deleted file and of a file that imports a changed one by path", () => {
    const selected = packagesToTypecheck(
      packages,
      ["packages/keys/src/removed.ts"],
      ["apps/web/vite.config.ts"],
    );

    expect(selected.map((selectedPackage) => selectedPackage.directory)).toEqual([
      "apps/web",
      "packages/keys",
    ]);
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

describe("satisfiesNodeRange", () => {
  it("reads the caret, exact and major forms, and rejects the rest", () => {
    expect(satisfiesNodeRange("v24.21.0", "^24.13.1")).toBe(true);
    expect(satisfiesNodeRange("24.13.1", "^24.13.1")).toBe(true);
    expect(satisfiesNodeRange("v24.12.9", "^24.13.1")).toBe(false);
    expect(satisfiesNodeRange("v26.7.0", "^24.13.1")).toBe(false);
    expect(satisfiesNodeRange("v24.0.0", "24.x")).toBe(true);
    expect(satisfiesNodeRange("v24.13.0", "24.13.1")).toBe(false);
    expect(satisfiesNodeRange("v24.13.0", ">=22")).toBe(false);
  });
});
