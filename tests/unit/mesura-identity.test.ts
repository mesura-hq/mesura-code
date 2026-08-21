import { assert, it } from "vite-plus/test";

import { commandOutput, run } from "./contractHarness.ts";

// Two sites keep T3 Code's `.t3` literal on purpose, and neither can collide
// with the installed T3 Code this fork runs beside:
//
//   packages/shared/src/devHome.ts  a linked worktree's own `<worktree>/.t3`,
//                                   which is local to that worktree.
//   packages/ssh/src/tunnel.ts      `$HOME/.t3` inside shell scripts that run on
//                                   REMOTE hosts, not on this machine. It builds
//                                   the path from shell text rather than the
//                                   `".t3"` literal, so this scan never sees it.
//
// Every other product path must resolve to Mesura Code's own home. This is a
// negative over the whole repository: a review by hand cannot promise it,
// because the cost of missing one site is that the fork writes into the live
// database of the T3 Code in daily use.
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

  const files = (found.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();

  assert.deepEqual(files, SITES_ALLOWED_TO_KEEP_THE_T3_LITERAL);
});

// The five files whose default home moved. Their prose has to move with it:
// `--help` output naming `~/.t3` is worse than no help at all here, because it
// tells an operator this fork reads the installed T3 Code's database. Verification
// found exactly that in migrate-dev-db's flag description and command
// description, where the code beside them already resolved to `~/.mesura-code`.
//
// This scans for `~/.t3` and not for `.t3` alone, on purpose: `<worktree>/.t3`
// still appears in migrate-dev-db's doc comment and is still correct, because a
// linked worktree keeps its own local directory.
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

// ⚠ The rename sweep searched for `T3 Code`, with a space, and that alphabet is
// not the only one the name appears in. `packages/client-runtime` builds an
// OAuth token-exchange body, so its expected fixture carries the name
// FORM-ENCODED — `client_label=T3+Code+Mobile`, where the space is a `+`. The
// sweep renamed the label that FEEDS that request and could not see the
// expectation it had to match, because no search for `T3 Code` reaches
// `T3+Code`. It sat broken from 992a7122b until the first upstream sync ran the
// package, five days later.
//
// Two things hid it for that long, and both are fixed elsewhere: CI had never
// run on this fork (#8), and the verification sweep covered ten of sixteen
// packages. This guard is the third defence, and the only one that is specific
// to the failure rather than to the process around it.
//
// Encodings, not spellings. `T3-Code` is deliberately ABSENT from this list:
// it is the packaging artifact name (`T3-Code-0.0.4-x64.dmg`), which the
// approved plan defers along with the rest of the packaging identity. Adding it
// here would fail on work that was scoped out on purpose.
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
