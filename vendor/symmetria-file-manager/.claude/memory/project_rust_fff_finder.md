---
name: project_rust_fff_finder
description: "Fuzzy finder now backed by the Rust `fff` engine (fff-c) — the deliberate Rust beachhead, shared with the future IDE"
metadata: 
  node_type: memory
  type: project
  originSessionId: 667b44d3-121a-4ccd-bb63-7c0e94559cfd
---

The fuzzy finder's backend was replaced (2026-06-08) from an in-house C++ Smith-Waterman scorer to the MIT-licensed Rust **`fff`** engine (github.com/dmtrKovalenko/fff), consumed via its `fff-c` C ABI, vendored as a submodule at `plugin/third_party/fff` (pinned 8092cfa3 / v0.9.3), built with Corrosion.

**Why (measured, not assumed):** benchmarked on this box — fff's per-keystroke scoring is 11–20× faster than the old C++ (e.g. /usr/include 41k files: 70ms→3.6ms), up to ~80× on rare queries, AND returns git status + frecency + score breakdown in the same call. Rust ≈ C++ for raw compute; the win is inherited library optimization (SIMD frizbee + warm index + gix), not the language. Cold index is ~par.

**This is the deliberate "Rust beachhead," not a migration.** The decision rule: adopt Rust only where a service is (1) data-in/data-out (no Qt objects crossing FFI), (2) concurrency-heavy, (3) backed by a mature crate. The finder scores 3/3; the preview/highlight/image services (which emit QImage/QTextDocument) score 0/3 and stay C++. Do NOT generalize this into a broad Rust rewrite. See [[project_framework_evaluation]] (the "stay on QML" decision still holds — this is additive, at one well-chosen surface).

**Shared with the IDE:** the engine lives in the `Symmetria.FileManager.Models` plugin, which Symmetria-IDE already imports, so the IDE inherits frecency + (future) grep through the boundary that already works. No separate repo extraction yet (YAGNI until a third consumer).

**First cut delivered:** engine swap + fff.nvim-style File Info side-panel (size/type/git/frecency/score breakdown + text preview) in FuzzyFinderPopup.qml. Grep (`fff_live_grep`) is available in the C ABI but not yet wired — natural next step, especially for the IDE.

Implementation gotchas are documented in the project CLAUDE.md "Critical Pitfalls" (extern "C" header wrap, process-wide singleton engine for the LMDB single-env constraint, fff_search_mixed for dirs, recomputed matchIndices, inert showHidden, frecency DB at ~/.local/share/symmetria/fff). Benchmark harnesses (C++ lift of the old scorer + fff C harness) were left at /tmp/fff-bench during evaluation.
