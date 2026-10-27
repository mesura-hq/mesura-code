// @effect-diagnostics nodeBuiltinImport:off - reads product source from an external contract guard, not from the application runtime.
import * as NodeFS from "node:fs";
import { assert, it } from "vite-plus/test";

import { commandOutput, run } from "./contractHarness.ts";

// A linked worktree keeps its own `<worktree>/.t3` through devHome.ts.
// The setup marker and icon-scanner exceptions below must prove their local
// use before this scan accepts them. No product default may reach the shared
// home of the installed T3 Code that runs beside Mesura Code.
const SITES_ALLOWED_TO_KEEP_THE_T3_LITERAL = ["packages/shared/src/devHome.ts"];

it("leaves no product code defaulting to T3 Code's shared home", () => {
  const found = run("git", [
    "grep",
    "--files-with-matches",
    "--fixed-strings",
    '".t3"',
    "--",
    ":(exclude)*.test.ts",
    ":(exclude)docs/",
    ":(exclude)packaging/",
    ":(exclude)tests/",
    ":(exclude)AGENTS.md",
  ]);

  // git grep exits 1 when nothing matches, which is a result and not a failure.
  assert.isAtMost(found.status ?? 2, 1, commandOutput(found));

  // The icon scanner mentions the worktree state directory only to exclude it.
  // A literal used outside that exclusion set must still fail this home guard.
  const candidateScannerPath = "apps/server/src/project/ProjectIconCandidates.ts";
  const candidateScannerSource = NodeFS.readFileSync(
    new URL(`../../${candidateScannerPath}`, import.meta.url),
    "utf8",
  );
  const excludedDirectories = candidateScannerSource.match(
    /const EXCLUDED_DIRECTORIES = new Set\(\[([\s\S]*?)\]\);/,
  )?.[1];
  const onlyExcludesWorktreeState =
    candidateScannerSource.match(/"\.t3"/g)?.length === 1 && excludedDirectories?.includes('".t3"');

  // Setup markers belong beside this script's worktree, never under HOME.
  // Do not allow the file wholesale: a second `.t3` use must fail the scan.
  const setupPath = "scripts/setup-worktree.ts";
  const setupSource = NodeFS.readFileSync(new URL(`../../${setupPath}`, import.meta.url), "utf8");
  const onlyUsesWorktreeMarkers =
    setupSource.match(/"\.t3"/g)?.length === 1 &&
    setupSource.includes("const worktree = NodePath.dirname(import.meta.dirname);") &&
    setupSource.includes('const markerDir = NodePath.join(worktree, ".t3");');

  const files = (found.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((file) => file !== candidateScannerPath || !onlyExcludesWorktreeState)
    .filter((file) => file !== setupPath || !onlyUsesWorktreeMarkers)
    .sort();

  assert.deepEqual(files, SITES_ALLOWED_TO_KEEP_THE_T3_LITERAL);
});

// `--help` text naming `~/.t3` in these files would tell an operator this fork reads the installed
// T3 Code's database. The scan is for `~/.t3`, not `.t3`: `<worktree>/.t3` in migrate-dev-db's doc
// comment is correct, because a linked worktree keeps its own local directory.
const FILES_WHOSE_DEFAULT_HOME_MOVED = [
  "apps/desktop/src/app/DesktopStatePaths.ts",
  "apps/server/scripts/migrate-dev-db.ts",
  "apps/server/scripts/t3-sqlite-state.ts",
  "apps/server/src/os-jank.ts",
  "scripts/dev-runner.ts",
];

it("leaves no prose naming T3 Code's home where the default already moved", () => {
  const found = run("git", [
    "grep",
    "--files-with-matches",
    "--fixed-strings",
    "~/.t3",
    "--",
    ...FILES_WHOSE_DEFAULT_HOME_MOVED,
  ]);

  assert.isAtMost(found.status ?? 2, 1, commandOutput(found));
  assert.equal((found.stdout ?? "").trim(), "");
});

// ⚠ A sweep for `T3 Code` cannot see encoded forms: the client-runtime OAuth fixture carries
// `client_label=T3+Code+Mobile` FORM-ENCODED, and a rename once broke it unseen for five days.
// List encodings, not spellings. `T3-Code` is deliberately ABSENT: it is the packaging artifact
// name, which the plan deferred with the rest of the packaging identity.
const ENCODED_PRODUCT_NAMES = [
  "T3+Code", // application/x-www-form-urlencoded — the one that actually broke
  "T3%20Code", // percent-encoded space, in a URL path or query
  "T3%2BCode", // a percent-encoded plus, i.e. double encoding
  "T3\\u0020Code", // a JSON/JS unicode escape
];

it.each(ENCODED_PRODUCT_NAMES)(
  "leaves no product code naming T3 Code through the encoding %s",
  (encoded) => {
    const found = run("git", [
      "grep",
      "--files-with-matches",
      "--fixed-strings",
      encoded,
      "--",
      // Upstream's own product surfaces keep their own name, exactly as the
      // plain-text scans exclude them.
      ":(exclude)apps/marketing",
      ":(exclude)infra/relay",
      ":(exclude)docs/",
      ":(exclude)tests/",
    ]);

    assert.isAtMost(found.status ?? 2, 1, commandOutput(found));
    assert.equal((found.stdout ?? "").trim(), "", commandOutput(found));
  },
);
