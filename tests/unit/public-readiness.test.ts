// @effect-diagnostics nodeBuiltinImport:off - hashes repository text as an external consumer.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "vite-plus/test";

import { commandOutput, expectSuccessfulCommand, repositoryRoot, run } from "./contractHarness.ts";

// Entry point: the tracked tree as `git grep` sees it, and `AGENTS.md` as every
// agent harness loads it. These guards hold the repository ready to be made
// public; they do not decide that it is public.

// ── Client project names ────────────────────────────────────────────────────
//
// The developer works for clients, and their project names leak into fixtures
// by way of real directory names. A guard that listed those names in plain text
// would publish them itself, so it keeps SHA-256 digests of the lowercase name
// and hashes every substring of the tracked tree's letter runs instead.
//
// Deliberately NOT in this list, although they are names the developer works
// with: a name that is also a common word (a Spanish noun), a name that is a
// hex fragment (it matches inside lockfile checksums), and a name that is also
// an upstream package identifier. Each of those would fail on text that names
// no client.
const CLIENT_PROJECT_NAME_DIGESTS = new Set([
  "267e4fc577a7bb3849986387c6ff6b279524f3c4a64f2a0687d3ac8c2503ea19",
  "fa08d34011acaa81bac69abd1f40d213a4fa3da88caafc8f3c2f4dfe5dcb7ee8",
  "4e5a53caff6c39b60c7d4c288dfc7fdcf2a5de11e518422f1b14edd4455df83a",
  "139c0c044510d899e032162e2f79691305c1d84592d0c9cf3f48d720f2ef100b",
  "3dad9474066fa06814f7f5badae74da96a956c03617cb646453665f9031f8967",
  "3637cdef7b689bc830434b494be257cca3a24ddd369b4e73a8ae391454f53c7a",
]);

// The letter counts of the listed names. Adding a name of a new length means
// adding its length here, or the scan never forms a candidate that long.
const CLIENT_PROJECT_NAME_LENGTHS = [6, 7, 8, 9, 13];

// The client project that the first pre-publication review found by name.
// Criterion: it appears in no tracked file at all, not only in tests.
const FIRST_FOUND_CLIENT_PROJECT_DIGEST =
  "267e4fc577a7bb3849986387c6ff6b279524f3c4a64f2a0687d3ac8c2503ea19";

interface ProtectedNames {
  readonly digests: ReadonlySet<string>;
  readonly lengths: ReadonlyArray<number>;
}

const CLIENT_PROJECT_NAMES: ProtectedNames = {
  digests: CLIENT_PROJECT_NAME_DIGESTS,
  lengths: CLIENT_PROJECT_NAME_LENGTHS,
};

// `.repos/` is upstream's vendored reference code, never edited here.
const OUTSIDE_VENDORED_REFERENCES = ":(exclude).repos";

// Test and fixture paths. Here a client name is replaced; anywhere else it is
// listed for the developer's decision.
const TEST_AND_FIXTURE_PATHS = [
  ":(glob)**/*.test.*",
  ":(glob)**/*.spec.*",
  ":(glob)**/test/**",
  ":(glob)**/tests/**",
  ":(glob)**/__tests__/**",
  ":(glob)**/fixtures/**",
  ":(glob)**/testFixtures/**",
  ":(glob)**/testkit/**",
];

// One-shot `hash` (Node 21.7+) is about 2.5x faster than `createHash` for the
// million short strings the scan hashes.
const sha256 = (text: string) => NodeCrypto.hash("sha256", text, "hex");

/** Every distinct lowercase letter run, at least `shortest` letters long, in the tracked tree. */
const letterRunsIn = (root: string, shortest: number) => {
  const found = run(
    "git",
    [
      "grep",
      "-h", // git grep has no --no-filename long form
      "--only-matching",
      "-I",
      "--extended-regexp",
      `[A-Za-z]{${shortest},}`,
      "--",
      OUTSIDE_VENDORED_REFERENCES,
    ],
    root,
  );
  assert.isAtMost(found.status ?? 2, 1, commandOutput(found));
  const runs = new Set<string>();
  for (const line of (found.stdout ?? "").split("\n")) {
    if (line.length >= shortest) runs.add(line.toLowerCase());
  }
  return runs;
};

/**
 * The protected names inside the given letter runs, at any offset, so a name
 * embedded in a longer identifier (`prefixNAMEsuffix`) is found too.
 */
const protectedNamesIn = (letterRuns: Iterable<string>, names: ProtectedNames) => {
  const candidates = new Set<string>();
  for (const letterRun of letterRuns) {
    for (const length of names.lengths) {
      for (let start = 0; start + length <= letterRun.length; start++) {
        candidates.add(letterRun.slice(start, start + length));
      }
    }
  }
  const found = new Map<string, string>();
  for (const candidate of candidates) {
    const digest = sha256(candidate);
    if (names.digests.has(digest)) found.set(candidate, digest);
  }
  return found;
};

/**
 * The tracked files, within the given paths, that carry one of the found names.
 * The recovered name appears only in this local failure message, never in the tree.
 */
const filesNaming = (
  root: string,
  foundNames: ReadonlyMap<string, string>,
  pathspecs: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const hits: Array<string> = [];
  for (const name of foundNames.keys()) {
    const files = run(
      "git",
      [
        "grep",
        "--files-with-matches",
        "--ignore-case",
        "--fixed-strings",
        name,
        "--",
        OUTSIDE_VENDORED_REFERENCES,
        ...pathspecs,
      ],
      root,
    );
    assert.isAtMost(files.status ?? 2, 1, commandOutput(files));
    for (const file of (files.stdout ?? "").split("\n").filter(Boolean)) {
      hits.push(`${file} (${name})`);
    }
  }
  return hits.sort();
};

const clientNamesIn = (root: string, names: ProtectedNames) =>
  protectedNamesIn(letterRunsIn(root, Math.min(...names.lengths)), names);

// One scan of the tree serves every spec below. It costs a few seconds, so it
// runs once and the specs read the cached result.
let clientNamesInThisTree: ReadonlyMap<string, string> | undefined;
const clientNamesInRepository = () =>
  (clientNamesInThisTree ??= clientNamesIn(repositoryRoot, CLIENT_PROJECT_NAMES));

const onlyDigest = (foundNames: ReadonlyMap<string, string>, digest: string) =>
  new Map([...foundNames].filter(([, found]) => found === digest));

// Spawning git grep over the tree and hashing its substrings takes several
// seconds on a loaded machine.
const TREE_SCAN_TIMEOUT_MS = 60_000;

describe("client project names before publishing", () => {
  it(
    "names the first-found client project in no tracked file",
    () => {
      const found = onlyDigest(clientNamesInRepository(), FIRST_FOUND_CLIENT_PROJECT_DIGEST);
      assert.deepEqual(filesNaming(repositoryRoot, found, []), []);
    },
    TREE_SCAN_TIMEOUT_MS,
  );

  it(
    "names no client project in a tracked test or fixture",
    () => {
      const found = clientNamesInRepository();
      assert.deepEqual(filesNaming(repositoryRoot, found, TEST_AND_FIXTURE_PATHS), []);
    },
    TREE_SCAN_TIMEOUT_MS,
  );

  // Guard on the guard: the test-path pathspecs locate the files a name is in.
  // If they matched nothing, the spec above would pass on any tree. One tracked
  // file per pathspec shape: `tests/**`, `*.test.*`, and `test/**` without a
  // `.test` suffix.
  it("reaches this repository's own test files with the test-path pathspecs", () => {
    const listed = run("git", ["ls-files", "--", ...TEST_AND_FIXTURE_PATHS]);
    expectSuccessfulCommand(listed);
    const files = (listed.stdout ?? "").split("\n");
    for (const expected of [
      "tests/unit/contractHarness.ts",
      "apps/web/src/components/projects/projectScopePicker.logic.test.ts",
      "vendor/symmetria-file-manager/packages/fm-ui/test/renderer/support.ts",
    ]) {
      assert.include(files, expected);
    }
  });

  // The scan, end to end, on a throwaway repository with a made-up name, so the
  // proof carries no real client name into the tracked tree.
  it(
    "catches a protected name embedded in a longer identifier, in any case",
    () => {
      const madeUpName = "zqxwvut";
      const names: ProtectedNames = { digests: new Set([sha256(madeUpName)]), lengths: [7] };
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "public-readiness-"));
      try {
        expectSuccessfulCommand(run("git", ["init", "--quiet"], root));
        NodeFS.writeFileSync(
          NodePath.join(root, "embedded.test.ts"),
          'const fixture = "/srv/PrefixZqxwvutSuffix";\n',
        );
        NodeFS.writeFileSync(NodePath.join(root, "absent.test.ts"), 'const near = "zqxwvu";\n');
        expectSuccessfulCommand(run("git", ["add", "."], root));

        const found = clientNamesIn(root, names);
        assert.deepEqual([...found.keys()], [madeUpName]);
        assert.deepEqual(filesNaming(root, found, TEST_AND_FIXTURE_PATHS), [
          `embedded.test.ts (${madeUpName})`,
        ]);
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
    TREE_SCAN_TIMEOUT_MS,
  );
});

// ── AGENTS.md identity text ─────────────────────────────────────────────────
//
// These read the opening and the "What this fork is, and is not" section, which
// carry the fork's identity. They check only what is mechanical: a forbidden
// claim, and where upstream's facts sit. Whether the prose still says what the
// fork is belongs to review, because any phrase a guard pinned here is one a
// legitimate rewording would break (AGENTS.md, "A guard may not pin …").

const agentsInstructions = NodeFS.readFileSync(NodePath.join(repositoryRoot, "AGENTS.md"), "utf8");

/** The text before the first second-level heading. */
const openingOf = (markdown: string) => markdown.split(/^## /m)[0] ?? "";

/** One second-level section, up to the next second-level heading. */
const sectionOf = (markdown: string, heading: string) => {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  assert.isAtLeast(start, 0, `AGENTS.md has no "## ${heading}" section`);
  const rest = markdown.slice(start + 1);
  const next = rest.slice(3).search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next + 3);
};

const identityText = () =>
  `${openingOf(agentsInstructions)}\n${sectionOf(agentsInstructions, "What this fork is, and is not")}`;

/** The paragraph that opens with the given bold name. */
const paragraphAbout = (markdown: string, boldName: string) => {
  const paragraph = markdown
    .split(/\n\s*\n/)
    .find((candidate) => candidate.startsWith(`**${boldName}**`));
  assert.isDefined(
    paragraph,
    `AGENTS.md identity text has no paragraph opening with **${boldName}**`,
  );
  return paragraph ?? "";
};

const USER_COUNT = /\b\d[\d,]*\s+users\b/;

describe("AGENTS.md identity before publishing", () => {
  it("does not claim in its identity text that the repository is private", () => {
    const privacyClaims = identityText()
      .split("\n")
      .filter((line) => /\bprivate\b/i.test(line));
    assert.deepEqual(privacyClaims, []);
  });

  // Upstream's user count is upstream's to change, so this asserts where the
  // count sits and never what it is (AGENTS.md, "A guard may not pin a number
  // that is upstream's to change").
  it("keeps the user count attributed to T3 Code and off Mesura Code", () => {
    assert.match(paragraphAbout(identityText(), "T3 Code"), USER_COUNT);
    assert.notMatch(paragraphAbout(identityText(), "Mesura Code"), USER_COUNT);
  });
});
