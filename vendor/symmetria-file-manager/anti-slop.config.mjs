import { defineConfig } from "oxlint";

export default defineConfig({
  categories: {
    correctness: "off",
  },
  ignorePatterns: [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/out/**",
    "**/.next/**",
    "**/.astro/**",
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".roo/**",
    ".windsurf/**",
    "tools/oxlint/anti-slop/**",
    // The Qt tree. Its `.js` files are QML-flavoured JavaScript — `.pragma
    // library`, QML type annotations — which oxlint cannot parse, so it reports
    // `Unexpected token` on three of them. They also already have an incumbent
    // gate: `tools/quality/check-qml.sh`, delta-based against the baseline in
    // `.claude/project-standards.md`. Two tools in one slot is worse than
    // either alone. Remove this line when the Qt tree is deleted at parity.
    "qml/**",
    "plugin/third_party/**",
  ],
  jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
  rules: {
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-widen-then-assert": "error",

    // PROMOTED out of the pilot, 2026-09-07. It protects a decision this
    // project already made in writing. Every seam this codebase needs for a
    // test is an injected one — `spawn` and `now` in `main/pool.ts`,
    // `WorkerChannel` in `main/client.ts`, the bridge global in the overlay —
    // and `pool.ts`'s header says why: injecting the spawn "is what lets the
    // lifetime rules be tested without a process". A `vi.mock` undoes that
    // silently, one test at a time. Measured at the review: ZERO hits across
    // the tree and 1713 tests, and a probe file confirmed the rule still
    // fires, so promoting it can only ever block a NEW one.
    "anti-slop/no-module-mocking": "error",

    // RETIRED, 2026-09-07 — all three for one measured reason, stated once
    // here rather than three times.
    //
    // These rules assume a codebase that parses at its boundary with a schema
    // library, where a hand-written `typeof`, an `unknown` parameter and a
    // `Record<string, unknown>` are each a sign that the parse is missing.
    // This codebase parses at its boundary by HAND — `packages/fm-core/src/
    // contract.ts` is that parser, and `fm-core` compiles against no
    // environment at all, which is what forced the hand-rolled decoders in the
    // first place. So the rules fire hardest on the code that implements the
    // discipline they exist to advocate.
    //
    // The counts are the evidence: at the review the three produced 151
    // warnings between them and NOT ONE was a defect. `no-unknown-parameters`
    // put 31 of its 83 on `fm-core/src/bridge.ts`, the preload interface whose
    // `unknown` is the honest type for a value that crossed a process
    // boundary, and 12 more on the decoders whose entire job is to accept it.
    // `no-runtime-typeof` put 21 of its 50 inside `contract.ts` itself; its
    // `allowInTypeGuards` escape hatch cannot reach them, because that option
    // exempts only a function returning `x is T` and every decoder here
    // returns `Result<T>`. Its remaining hits are environment probes
    // (`typeof Worker`, `typeof window`, `typeof ResizeObserver`) where a bare
    // identifier comparison would throw and there is no domain value to parse
    // at all. `no-unsafe-dictionary-type` flags the `Record<string, unknown>`
    // that a decoder holds AFTER proving the value is an object and BEFORE
    // proving its fields — the one shape it can correctly have there.
    //
    // Retired rather than left advisory because a rule that fires 50 times
    // cannot flag the 51st: the noise is what makes a true positive invisible.
    // Reinstate any of them if this project adopts a schema library, which is
    // the precondition they were written for.
    "anti-slop/no-runtime-typeof": "off",
    "anti-slop/no-unknown-parameters": "off",
    "anti-slop/no-unsafe-dictionary-type": "off",

    // STILL ADVISORY after the review, and deliberately: zero observations and
    // one observation are both inconclusive samples, which is the case the
    // contract says to leave advisory. `no-shape-in-symbol-names` has never
    // fired (the same probe proved it live), so the codebase is COMPATIBLE
    // with it — which is not the same as evidence it is useful, and is not
    // enough to promote on. `no-conditional-empty-object-spread` has fired
    // exactly once, at `packages/fm-main/src/fs/scan.ts:107`, where the
    // conditional spread is a commented one-liner that keeps the result
    // `readonly`; the alternative it asks for is longer and mutable. One site
    // decides nothing either way.
    "anti-slop/no-conditional-empty-object-spread": "warn",
    "anti-slop/no-shape-in-symbol-names": "warn",

    // PROMOTED, 2026-09-07, and it earned it by finding a bug. Writing the
    // invariant at each of its 17 source sites showed that one of them had
    // none to write: `sendCommand` in `app/src/main/socket.ts` asserted a
    // shape onto `JSON.parse`, which accepts `null`, `123` and `"ok"` without
    // throwing — so a truncated daemon reply resolved a value the caller then
    // read `.ok` off. That site is now checked instead of asserted. The other
    // 16 had real invariants and now state them. Source is at zero; tests are
    // scoped off in `overrides` below.
    "anti-slop/require-safety-comment-for-type-assertion": "error",
  },

  overrides: [
    {
      // A test constructs the value it then asserts about, usually two lines
      // up, so a `SAFETY:` note on each assertion restates the line above it.
      // Measured at the review: 72 of this rule's 89 hits were in tests, and
      // they buried the 17 in source — several of which sit at real trust
      // boundaries (`fm-search/src/main/worker.ts`, `contract.ts`) and are
      // worth writing. Scoped off here rather than retired, so those 17 are
      // what the next review looks at.
      files: ["**/test/**", "**/*.test.ts", "**/*.test.tsx"],
      rules: {
        "anti-slop/require-safety-comment-for-type-assertion": "off",
      },
    },
  ],
});
