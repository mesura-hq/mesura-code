# CLAUDE.md

> **Principle: No duplicate sources of truth.** This document contains ONLY information that cannot be discovered by reading the codebase. For implementation details, read the actual source files.

## Project Overview

Symmetria File Manager is a keyboard-first graphical file manager built as a standalone Qt6 application. It runs as a headless systemd user service (`symmetria-fm.service`) that listens on `$XDG_RUNTIME_DIR/symmetria-fm.sock` and spawns Qt windows on demand via IPC. Pure native Qt/QML/C++ inspired by Yazi's UX philosophy — no Yazi or QuickShell runtime dependency.

The same QML panel is also embeddable in any Qt6 host: Symmetria-IDE imports `Symmetria.FileManager.UI` and renders it as a Telescope-style toggle-overlay above NeoVim.

**Do NOT kill the symmetria-fm service** without the user's consent — they may have open file manager or picker windows with unsaved state.

## Build & Run

### C++ Plugin (`Symmetria.FileManager.Models`)

The file manager's core data models live in `plugin/` as a standalone CMake project that builds a Qt6 QML plugin. This plugin is separate from Symmetria Shell's plugin build.

```bash
./build-plugin.sh              # Build + install (no restart)
./build-plugin.sh --restart    # Build + install + restart symmetria-fm
```

Or manually:
```bash
cd plugin
cmake -B build
cmake --build build --parallel $(nproc)
sudo cmake --install build
systemctl --user restart symmetria-fm
```

**Install path:** `/usr/lib/qt6/qml/Symmetria/FileManager/Models/` — Qt's QML engine discovers modules here automatically.

**CMake variables:**
- `CMAKE_INSTALL_PREFIX` defaults to `/usr` (via `CMAKE_INSTALL_PREFIX_INITIALIZED_TO_DEFAULT` guard) — combined with `INSTALL_QMLDIR=lib/qt6/qml`, the final path is `/usr/lib/qt6/qml/`
- Pass `-DCMAKE_INSTALL_PREFIX=/custom/path` to override if needed

**Build dependencies (Arch):** `qt6-base qt6-declarative syntax-highlighting libarchive qxlsx-qt6 freexl qt6-imageformats libheif qt6-webengine rust`

`qt6-webengine` backs the **HTML render preview** (Ctrl+R). It is a build/link dep
of the standalone host (which must initialize WebEngine before `QGuiApplication` —
see `host/standalone/main.cpp` for the ordering rationale) **and** a runtime dep of
the UI panel itself, since `HtmlPreview.qml` does `import QtWebEngine`. The
non-obvious cross-host caveat: importing the module is harmless, but instantiating
a `WebEngineView` needs `QtWebEngineQuick::initialize()` to have run in the host's
`main()`. So an **embedding host (e.g. the IDE) must initialize WebEngine itself**
to use Ctrl+R — the panel only instantiates the view lazily on toggle, so a host
that never calls it still loads fine and just can't render.

`libheif` backs HEIC/HEIF preview: Arch's `qt6-imageformats` is built **without** libheif, so Qt has no native HEIF image plugin and `QImageReader::canRead()` returns false for `.heic`/`.heif`. Like `.icns` (which has its own `IcnsDecoder`), these are decoded by a custom `HeifDecoder` (`heifdecoder.cpp`, libheif → cache PNG) rather than handed to a QML `Image`, routed through `PreviewImageHelper`'s `needsCachedDecode` / `generateCachedPreview`.

The fuzzy finder links the Rust **`fff`** engine (MIT), vendored as a git submodule at `plugin/third_party/fff` (pinned commit) and built via **Corrosion** (fetched by CMake at configure time). A Rust toolchain (`rust`/`cargo`) is therefore required. `build-plugin.sh` runs `git submodule update --init` automatically; a fresh clone otherwise needs `git submodule update --init --recursive`. fff's native deps (libgit2 via `git2`, LMDB) are vendored by their `-sys` crates — no extra system packages. To bump fff: `git -C plugin/third_party/fff checkout <rev>` then commit the submodule pointer. After checkout, re-run `cmake -B build` from `plugin/` so Corrosion rebuilds against the new source tree.

### Running Tests

The plugin includes a QTest-based test suite. Tests are built by default (`BUILD_TESTING=ON`):

```bash
cd plugin
cmake -B build
cmake --build build --parallel $(nproc)
QT_QPA_PLATFORM=offscreen ctest --test-dir build --output-on-failure
```

Four test executables cover the async model classes: `FileSystemModelTest` (sorting, filtering, file watcher diffs), `ArchivePreviewModelTest` (entry caps, truncation, corruption handling), `SyntaxHighlightHelperTest` (highlighting output, binary detection, truncation), `FileInfoTest` (path → entry bridge). `QT_QPA_PLATFORM=offscreen` is required because `QTextDocument` and `QImageReader` need `QGuiApplication`.

To skip tests when doing a production build: `cmake -B build -DBUILD_TESTING=OFF`

### CI

GitHub Actions runs on every push/PR to `main` (`.github/workflows/ci.yml`). The workflow builds the C++ plugin and runs the QTest suite on Ubuntu 24.04. Qt 6.9 is installed via `jurplel/install-qt-action`; KF6SyntaxHighlighting and QXlsx are built from source and cached. The Rust toolchain is installed via `dtolnay/rust-toolchain@stable`; the submodule is checked out with `submodules: recursive`; the Cargo registry is cached by `actions/cache`.

### Electron Changes — Rebuild and Restart Before Reporting

An edit to anything bundled into `app/dist-electron/` — `app/src/**` and
`packages/fm-*/src/**` — is NOT live until the bundle is rebuilt and the daemon
restarts onto it. `symmetria-fm-electron.service` is resident and holds the old
code in memory, so the operator then tests the previous bundle and sees a fix
that did not work. A change confined to tests, docs or tooling needs no restart.

**This is the LAST command of the change — after the tests, after the gates.**
`pnpm -r test` rebuilds `app/dist-electron/` itself and leaves a DEVELOPMENT
bundle there, so anything that runs the suite must be followed by this again:

```bash
readlink -f ~/.local/bin/symmetria-fm-electron   # must resolve inside THIS tree
pnpm --filter @symmetria/fm-app build \
  && systemctl --user restart symmetria-fm-electron.service \
  && systemctl --user is-active symmetria-fm-electron.service
```

- **The `readlink` is not ceremony.** That launcher and the unit are symlinks
  into ONE tree, and this project is worked on in `t3` worktrees. From any other
  worktree the build succeeds and changes nothing the operator can see — the
  same silent-stale failure this rule exists to prevent. If it resolves
  elsewhere, say so instead of restarting.
- **A failed build must NOT be followed by a restart** — the old bundle is still
  serving the operator. Report the build output instead.
- If the service is not `active` afterwards, report
  `systemctl --user status symmetria-fm-electron.service`. Never `pkill`.

Then state in the final summary that the daemon was rebuilt and restarted, so
the operator knows the running window holds the new code.

Restarting this unit needs NO consent: the operator asked for the reload so they
can check the change, and accepts that it closes any open Electron FM window.
The permission covers `symmetria-fm-electron.service` ONLY. `symmetria-fm.service`
is the Qt daemon, serves the system's portal dialogs, and still needs consent —
see the warning in Project Overview.

Why the unit does not rebuild, and why a test run poisons the bundle:
`docs/electron-transition/22-desktop-integration.md` → *Rebuilding before a
restart*.

### QML Changes

No compilation needed — just restart the service:
```bash
systemctl --user restart symmetria-fm
```
Qt's QML disk cache at `~/.cache/Symmetria/symmetria-fm/qmlcache/` **persists across
restarts** — the unit has no `ExecStartPre` clearing it (an earlier version of this
document claimed it did; that was never true of the standalone host's unit). Qt
invalidates a `.qmlc` entry itself when the source `.qml` is newer, so an edit is
picked up without any manual purge. Delete the directory only to test a genuinely
cold compile. Keeping it is what holds the first window's panel load at ~0.2 s
(measured offscreen: ~0.25 s cached vs ~0.30 s with `QML_DISABLE_DISK_CACHE=1`,
against a ~0.05 s bare-process baseline).

### QML Linting

```bash
/usr/lib/qt6/bin/qmllint qml/Symmetria/FileManager/UI/modules/filemanager/*.qml \
                         qml/Symmetria/FileManager/UI/services/*.qml \
                         qml/Symmetria/FileManager/UI/components/*.qml \
                         qml/Symmetria/FileManager/UI/config/*.qml
```

Uses `.qmllint.ini` at the project root. The Qt6 qmllint is at `/usr/lib/qt6/bin/qmllint` (not `/usr/bin/qmllint`, which is the Qt5 version). Configuration notes:
- `MissingProperty` is demoted to `info` — most hits are false positives from `var`-typed singletons (`FmTheme.palette` is a plain JS object) whose keys aren't visible to static analysis
- `UnqualifiedAccess` and `UnusedImports` are the primary actionable warning categories
- `AdditionalQmlImportPaths=/usr/lib/qt6/qml` resolves `Symmetria.FileManager.Models` and `Symmetria.FileManager.UI` imports

### Opening the File Manager

```bash
# Standalone (talks to the symmetria-fm.service daemon)
symmetria-fm-cli open ~/Downloads

# Or directly without the daemon (for one-off invocations)
/usr/bin/symmetria-fm

# Inside Symmetria-IDE: <leader>e toggles the embedded overlay
```

## Quality Gate (enforced by /seal and code-review)

Project quality standards live in **`.claude/project-standards.md`**. Any change
touching QML MUST pass the deterministic checker on its changed files:

```bash
tools/quality/check-qml.sh <changed .qml files>                 # scoped mode for a commit
tools/quality/check-qml.sh --with-callers <changed component>   # + lint every call site
tools/quality/check-qml.sh                                       # full tree
```

**When you change any QML component file's public API** (add, remove, or rename a
`property` or `signal` declaration that other QML files assign or bind), run
`check-qml.sh --with-callers <changed-component.qml>`. A property a caller assigns
but the component no longer declares is a type error qmllint only sees at the
**call site**, not in the component — at runtime it's the fatal
`Cannot assign to non-existent property` that aborts the whole QML load (it
cascades upward, so the service log blames the top-level file, not the real one).
`--with-callers` greps every file that names the changed component and lints
those too; the gate promotes that specific `Could not find property` diagnostic
to a failure (the noisy `Member "x" not found` var-singleton false positives stay
demoted). Caller scoping is automatic: a caller file's own `Warning`/`Error`
lines are reported as a non-blocking `ℹ` note (a pre-existing baseline warning in
a call site is not a regression this change introduced), while `Could not find
property` stays tree-wide so the actual API break still fails the gate. So only
the changed file's `Warning`/`Error` plus any caller's `Could not find property`
are blocking — no need to eyeball which caller warnings are pre-existing. This
catches the break statically, before any `systemctl restart`.

It wraps `qmllint` (via `.qmllint.ini`) and adds god-file + dead-component
detection (the "Knip + ESLint for QML"; no extra deps). The gate is **delta-based**:
changed files must be clean (no `Warning`/`Error`, not a god file, no new dead
component) and the full-tree baseline must not regress — see the baseline snapshot
in `.claude/project-standards.md`. The **`/seal` and `code-review` workflows MUST
run this on a change's QML and treat findings as blocking**, the same as a reviewer
finding. C++ plugin changes use the ctest gate (see Build & Run → Running Tests).

The two sections below are the machine-readable form of that gate, plus the
TypeScript toolchain added for the Electron rewrite. **They are the contract
`/seal`, `/code-review`, `/tech-debt` and CI actually read** — the prose above
describes the QML gate, these sections are what runs it.

## Deterministic Checks

Run these change-scoped checks during `/seal`, `/code-review`, and ad-hoc review. Substitute `<base>` with the commit the review target diffs against: the parent of one reviewed commit, or `<oldest>^` for a commit range.

```bash
{ git diff --name-only --diff-filter=ACMR <base>; git ls-files --others --exclude-standard; } | sort -u | xargs -r pnpm exec biome check --reporter=summary --no-errors-on-unmatched  # lint + format + a11y
git diff -z --name-only --diff-filter=ACMR <base> -- '*.js' '*.jsx' '*.mjs' '*.cjs' '*.ts' '*.tsx' '*.mts' '*.cts' | xargs -0 -r pnpm exec oxlint --config anti-slop.config.mjs --disable-nested-config --format agent --  # command-id: typescript.anti-slop.changed.v1; type-evidence policy; errors gate, pilot warnings advise
pnpm exec tsc -p packages/fm-core --noEmit --pretty false  # types — shared core: no environment at all
pnpm exec tsc -p packages/fm-main --noEmit --pretty false  # types — privileged half: Node, no DOM
pnpm exec tsc -p packages/fm-ui --noEmit --pretty false  # types — panel SOURCE: DOM, no Node
pnpm exec tsc -p packages/fm-search --noEmit --pretty false  # types — finder engine: Node, no DOM
pnpm exec tsc -p packages/fm-search/tsconfig.ui.json --noEmit --pretty false  # types — finder overlay: DOM, no Node
pnpm exec tsc -p packages/fm-search/tsconfig.test.json --noEmit --pretty false  # types — finder TESTS: both, they read the source tree
pnpm exec tsc -p packages/fm-ui/tsconfig.test.json --noEmit --pretty false  # types — panel TESTS: Node, they read the source tree
pnpm exec tsc -p app/tsconfig.main.json --noEmit --pretty false  # types — host main process: Node, no DOM
pnpm exec tsc -p app/tsconfig.renderer.json --noEmit --pretty false  # types — host renderer entry: DOM, no Node
pnpm exec fallow audit --changed-since <base> --format compact  # dead code, complexity, duplication; new findings gate
git diff -z --name-only --diff-filter=ACMR <base> -- '*.qml' | xargs -0 -r tools/quality/check-qml.sh  # QML gate, scoped to changed files; exits 0 when none changed
```

**Biome is given an explicit file list, and `--changed --since=<base>` is wrong here.** That flag reads COMMITTED state. `/code-review` and any ad-hoc review look at a working tree, where it reports `Checked 0 files` and exits 0 with eleven files modified — a silent pass, which is the worst shape a check can fail in. The list form above covers both cases, because `git diff --name-only <base>` against a working tree includes uncommitted edits.

**The `git ls-files --others` half is not optional.** `git diff` alone cannot see an untracked file, so a phase's brand-new source and test files are invisible to the formatter and the linter until the moment they are committed. That happened: two whole new test files went unchecked for a phase before anyone noticed.

Biome, `tsc` and the QML gate exit non-zero on findings. Anti-slop exits non-zero for its eight error rules; its seven pilot warnings print and exit zero. Fallow uses the gating `audit` command. The QML line exits 0 when the change touches no `.qml` file, which is the normal case for the Electron tree.

**One `tsc` line per context, not one for the tree.** There are NINE and they must not share a `lib`. `packages/fm-core` is imported by everything and gets no environment at all; `packages/fm-main` — the privileged half — gets Node and no DOM; `packages/fm-ui` — the panel — gets DOM and no Node; the host's two halves get the same treatment as the packages they load. A shared `lib` would let a `window` reference type-check inside a main process and a `node:fs` import type-check inside a sandboxed renderer.

**`packages/fm-search` is THREE of the nine, because it spans the boundary.** It is the only package that ships code for both sides — an engine that runs in a utility process and an overlay that runs in the sandboxed renderer — so it carries the fm-main and fm-ui treatments in one package: `tsconfig.json` covers `src/main` with Node and no DOM, `tsconfig.ui.json` covers `src/ui` with DOM and no Node. One config for the package would defeat the split the package exists to hold, since a host must be able to mount the overlay alone. Its `tsconfig.test.json` is the third and gets BOTH, for the same reason `packages/fm-ui` needs one: the boundary test reads every source file under `src/ui` to prove that half never imports Node, so it needs a filesystem, and the standalone test mounts the overlay, so it needs a DOM. Neither permission may reach either source.

**`packages/fm-ui` has TWO configs and both are in the fence.** Its `tsconfig.json` covers `src` alone with `types: []`, which is the real contract: the panel is sandboxed and must not reach Node. Its tests DO need Node, because the invariant test reads every source file to prove that contract holds — so they live in `tsconfig.test.json`. One shared config would hand the source whatever the tests need, which is the whole thing this package exists to prevent. The rule earns its keep in practice, not only in principle: `packages/fm-core/src/windowUrl.ts` reaches for `URLSearchParams` and cannot have it, because that package compiles against no environment at all — which is what forced a hand-rolled parse, and the hand-rolled one turned out to be more correct anyway (`URLSearchParams` decodes `+` as a space, so a directory named `c++` would come back wrong).

**`--with-callers` is yours to add, and the fence will not do it for you.** When a change alters a QML component's public API, the Quality Gate above requires `tools/quality/check-qml.sh --with-callers <component.qml>`. The scoped line in this fence never runs that form, so a reviewer who runs the fence and stops has skipped the one check that catches an API break at its call site.

**Advisory pilot — anti-slop: REVIEWED 2026-09-07.** Catalog revision `bc94865c5c4a2663b344cc7a9b6d755526fd5fca614618ff92761f4e2658e396` (profile `typescript.md`, no layers matched). Tool source revision `6d538555cb151d4121ed51a27db81890eacf8ae9`. **Next review due 2027-03-07**; on or after that date, report `pilot review overdue` and keep the rules still listed as advisory until a reviewed decision changes this contract. Command records: `typescript.anti-slop.changed.v1` = `5ac5cd1291b040b6294b8429d5ee68c8e05b1df27002d46c7b70fc732ef814a6`; `typescript.anti-slop.full.v1` = `758ba14767a3b44c4d51dd419b710c17bf41120e0c4705a94fede96ab5b9f884`. The review measured all seven rules against the whole tree and settled five of them; each decision and its evidence sits beside the rule in `anti-slop.config.mjs`, which is the place to read before changing one. **Promoted to blocking errors**, taking the error set from eight rules to ten: `anti-slop/no-module-mocking` and `anti-slop/require-safety-comment-for-type-assertion`. **Retired to `off`**: `anti-slop/no-runtime-typeof`, `anti-slop/no-unknown-parameters` and `anti-slop/no-unsafe-dictionary-type` — they assume a schema library parses at the I/O boundary, this project parses by hand in `packages/fm-core/src/contract.ts`, and so they fired 151 times on the decoders that implement the discipline they exist to advocate without one defect among them. Reinstate them only if this project adopts a schema library. **The two rule IDs that remain advisory are `anti-slop/no-conditional-empty-object-spread` and `anti-slop/no-shape-in-symbol-names`**, both on an inconclusive sample — one observation and zero. `require-safety-comment-for-type-assertion` is scoped `off` for test files by an `overrides` block; source is clean and gates. Promote a warning only with observed project evidence; keep it advisory when the sample is inconclusive.

**Inherited CSS findings — reviewed 2026-09-12; next review 2027-03-12.**
For `rules.css-selector-complexity`, `rules.css-duplicate-block`,
`rules.css-token-drift`, and `rules.css-dead-surface`, retain a finding as
advisory only when comparison with the review base proves that the same finding
already exists under the same rule configuration. Match its contributing
selectors, declarations, and references, not line numbers. An unchanged reported
CSS block alone is insufficient: findings caused by changed usage, a new
duplicate, or other changed contributing code remain blocking. Record the
evidence in the review report. New findings remain blocking even when Fallow
emits a warning. On or after the next review date, report `pilot review overdue`
and keep this classification until it is reviewed again.

This project prose is the runtime classification authority. A blocking finding prevents completion until it is fixed or suppressed narrowly with a reason. A listed advisory finding remains review evidence but does not prevent completion. A command that cannot execute is a tooling failure: report it and continue the review. Suppressions live in `biome.jsonc`, `anti-slop.config.mjs`, `.fallowrc.jsonc`, `knip.json` and `.qmllint.ini`, each beside a reason.

**Tests never enter this section, tracked or not** — the catalog excludes them by contract. Vitest and `ctest` are repository-gate concerns only. Run them as their own invocation beside this fence; the command and the trap it hides are in *Full-Project Checks* below.

## Full-Project Checks

Run every command during `/tech-debt`, a full codebase audit, and CI. Run all lines even when one reports findings.

```bash
pnpm exec biome check . --reporter=summary  # lint + format + a11y — complete project
pnpm exec oxlint --config anti-slop.config.mjs --disable-nested-config --format stylish -- .  # command-id: typescript.anti-slop.full.v1; type-evidence policy; errors gate, pilot warnings feed tech debt
pnpm exec tsc -p packages/fm-core --noEmit --pretty false  # types — shared core: no environment at all
pnpm exec tsc -p packages/fm-main --noEmit --pretty false  # types — privileged half: Node, no DOM
pnpm exec tsc -p packages/fm-ui --noEmit --pretty false  # types — panel SOURCE: DOM, no Node
pnpm exec tsc -p packages/fm-search --noEmit --pretty false  # types — finder engine: Node, no DOM
pnpm exec tsc -p packages/fm-search/tsconfig.ui.json --noEmit --pretty false  # types — finder overlay: DOM, no Node
pnpm exec tsc -p packages/fm-search/tsconfig.test.json --noEmit --pretty false  # types — finder TESTS: both, they read the source tree
pnpm exec tsc -p packages/fm-ui/tsconfig.test.json --noEmit --pretty false  # types — panel TESTS: Node, they read the source tree
pnpm exec tsc -p app/tsconfig.main.json --noEmit --pretty false  # types — host main process: Node, no DOM
pnpm exec tsc -p app/tsconfig.renderer.json --noEmit --pretty false  # types — host renderer entry: DOM, no Node
pnpm -r test  # the whole suite, per package. NEVER `vitest` from the root — see below. Leaves a DEVELOPMENT bundle in app/dist-electron/: rebuild before any daemon restart (Build & Run → Electron Changes)
pnpm exec knip --reporter json  # files, exports, dependencies, and the workspace package graph
pnpm exec fallow dead-code --fail-on-issues  # whole-project dead code; any issue gates
pnpm exec fallow health --score --hotspots --fail-on-issues  # complexity, cycles, and health hotspots
pnpm exec fallow dupes --fail-on-issues  # whole-project duplication
```

**Advisory pilot — anti-slop: REVIEWED 2026-09-07.** Catalog revision `bc94865c5c4a2663b344cc7a9b6d755526fd5fca614618ff92761f4e2658e396` (profile `typescript.md`, no layers matched). Tool source revision `6d538555cb151d4121ed51a27db81890eacf8ae9`. **Next review due 2027-03-07**; on or after that date, report `pilot review overdue` and keep the rules still listed as advisory until a reviewed decision changes this contract. Command records: `typescript.anti-slop.changed.v1` = `5ac5cd1291b040b6294b8429d5ee68c8e05b1df27002d46c7b70fc732ef814a6`; `typescript.anti-slop.full.v1` = `758ba14767a3b44c4d51dd419b710c17bf41120e0c4705a94fede96ab5b9f884`. The review measured all seven rules against the whole tree and settled five of them; each decision and its evidence sits beside the rule in `anti-slop.config.mjs`, which is the place to read before changing one. **Promoted to blocking errors**, taking the error set from eight rules to ten: `anti-slop/no-module-mocking` and `anti-slop/require-safety-comment-for-type-assertion`. **Retired to `off`**: `anti-slop/no-runtime-typeof`, `anti-slop/no-unknown-parameters` and `anti-slop/no-unsafe-dictionary-type` — they assume a schema library parses at the I/O boundary, this project parses by hand in `packages/fm-core/src/contract.ts`, and so they fired 151 times on the decoders that implement the discipline they exist to advocate without one defect among them. Reinstate them only if this project adopts a schema library. **The two rule IDs that remain advisory are `anti-slop/no-conditional-empty-object-spread` and `anti-slop/no-shape-in-symbol-names`**, both on an inconclusive sample — one observation and zero. `require-safety-comment-for-type-assertion` is scoped `off` for test files by an `overrides` block; source is clean and gates. Promote a warning only with observed project evidence; keep it advisory when the sample is inconclusive.

This gate starts clean. Every blocking finding must be fixed or suppressed narrowly with a reason before setup is complete. Listed advisory findings remain visible for `/tech-debt` and do not prevent adoption. A command that cannot execute is a tooling failure and does not hide results from the remaining commands.

**Run the suite as `pnpm -r test`, and NEVER as `vitest` from the repository root.** There is no vitest config at the root. The app's lives at `app/vitest.config.ts`, and it carries two things that are silently lost when the root form is used:

- **`globalSetup`, which BUILDS the bundles the smoke test launches.** Without it the smoke test launches whatever `app/dist-electron/` happens to hold, so it asserts against a stale build and passes for code that is no longer there. It did exactly that for three phases before anyone noticed, and what caught it was a deliberate change to the bridge surface that should have failed and did not.
- **`fileParallelism: false`.** The smoke test spawns a real Electron under a virtual display and must never race a second copy of itself, and the renderer suites starve each other's `waitFor` timers when they run in parallel — which produced flakes in two different files that were mistaken for product bugs.

`pnpm -r test` runs each package under its own config, which is the only form that honours both.

**Two commands are deliberately absent, and neither is an oversight.**

- **The QML full-tree sweep.** `tools/quality/check-qml.sh` with no arguments exits 1 on the pre-existing baseline recorded in `.claude/project-standards.md`, so it can never satisfy a gate that starts clean. Encoding a permanent exemption for it here would be exactly the hidden baseline this contract forbids. Changed-file cleanliness is enforced by the scoped line in the change gate; the full-tree sweep is `/tech-debt` input, described in the Quality Gate section above. Do not add it to this fence.
- **`ctest`.** It cannot run until `plugin/build` exists — see Build & Run → Running Tests. Add its line once a build directory is produced; a line that fails for every reviewer is worse than an absent one.

## Architecture

### Plugin: `Symmetria.FileManager.Models` (C++ → QML)

Model classes in C++ namespace `symmetria::filemanager::models`:

| Class | Purpose |
|-------|---------|
| `FileSystemModel` + `FileSystemEntry` | Async directory listing with sorting, filtering, file watching |
| `FileInfo` | Async path → single `FileSystemEntry`. The QML bridge for path-only consumers (the fuzzy finder; the future IDE) that need to drive `PreviewContent` but have no `FileSystemModel`. Reuses `buildCachedEntryData()` so its derivation is identical to the scan's |
| `ArchivePreviewModel` | Lists archive contents (zip, tar, 7z, rar) via libarchive |
| `SpreadsheetPreviewModel` | Reads .xlsx (QXlsx) and .xls (freexl) for preview |
| `SyntaxHighlightHelper` | Syntax-highlighted HTML for text file previews via KF6 |
| `PreviewImageHelper` | Image preview generation with background compositing + caching |
| `FuzzyFinder` | Fuzzy file search backed by the Rust `fff` engine via its C ABI |
| `AppIconProvider` | Resolves a `.desktop` id to a themed app-icon file path for the "Open With" menu via `IconThemeResolver::resolveApp`; cached per id |

**Icon resolution returns file paths, not `QIcon`s, by design.** `IconThemeResolver::resolve` (MIME/folder icons) and `IconThemeResolver::resolveApp` (application icons, the `apps/` context path) hand-roll XDG theme lookup to return the real SVG/PNG path on disk — because QML `Image { source: "file://..." }` renders an SVG source crisply, whereas `QIcon::fromTheme(...).pixmap()` would rasterize and lose the vector. This is why a new `.desktop` app entry resolves automatically without QML changes.

### The file finder: `packages/fm-search`

The finder ships as its own workspace package because a host must be able to
mount it **without** the file-manager panel — Mesura Code takes the finder, not
the file manager. Everything a consumer looks up lives in
`packages/fm-search/README.md`; what an agent has to know **before touching this
tree** is only this:

- **Two halves, two environments, and they must not cross.** `./main` is the
  engine and runs in a Node process; `./ui` is the overlay and runs in a
  sandboxed renderer. `test/boundary.test.ts` reads every source file under each
  and fails on a `node:` import in `src/ui` or an `@symmetria/fm-ui` import in
  either. The panel depends on this package, so an import back would also be a
  cycle.
- **One index per process, keyed by directory.** The engine's store refuses a
  second open inside one program. This is the one place the port deliberately
  departs from Qt, whose single process-wide engine swaps its base path and
  races across windows. Do not "simplify" `main/pool` into a shared engine.
- **The overlay reaches the engine through the bridge global, not through the
  panel.** Its `onChoose` / `onClose` / `renderPreview` props are the activation
  seam; a host supplies all three, and the panel's own preview arrives through
  `renderPreview` rather than an import.

### Symmetria Shell Dependency (One-Sided)

Symmetria Shell imports `Symmetria.FileManager.Models` in 5 QML files (wallpaper grid, file dialog, etc.) — it depends on this plugin being installed. Symmetria File Manager does NOT depend on the shell at runtime — it reads its palette directly from `color-scheme.json` on disk, not via IPC.

If the plugin is not installed, Symmetria Shell's wallpaper picker and file dialog will fail to load. After any plugin API changes, verify the shell still works.

### Preview Routing (shared)

- **`PreviewContent.qml`** is the single file-preview router shared by the
  normal pane (`PreviewPanel.qml`) and the fuzzy finder's info pane
  (`FuzzyFinderInfoPanel.qml`). A new preview type added here appears in both
  consumers automatically — do NOT re-implement type routing in a consumer.
- The two consumers differ only in how they obtain the `entry`: `PreviewPanel`
  has a real `FileSystemEntry` from its `FileSystemModel`; the finder has only a
  path, so `FuzzyFinderInfoPanel` mints one via the `FileInfo` element. Both
  debounce (150 ms) before driving the preview so fast j/k doesn't thrash it.
- **Text classification is `FileSystemEntry.isText` (C++), the single source of
  truth** — MIME inheritance from `text/plain` plus a NUL-byte content sniff as a
  fallback for unregistered/extensionless configs (when the MIME DB returns
  `application/octet-stream` or an invalid type). The router uses it as the catch-all after
  the specific binary types, so any non-binary file previews its contents (with
  syntax highlighting only when a definition exists). Do NOT reintroduce a
  QML-side mime-string list — the old one silently rotted (it predated the
  `application/x-yaml` → `application/yaml` rename, which is why YAML stopped
  previewing).
- **HTML render toggle (`Ctrl+R`)** — an `.html`/`.xhtml` file previews as
  highlighted **source** by default (it is `isText`); `Ctrl+R` on the Miller cursor
  flips it to a real **WebEngine** render via `HtmlPreview.qml`. Two non-obvious
  design constraints: (1) the toggle is **per-file** (reset when the previewed
  entry changes) so Chromium spins up only on deliberate intent, never per j/k —
  do not make it sticky across files; (2) the render is deliberately **sandboxed**
  (JS off by default, no remote loads, ephemeral profile) precisely so it is safe
  to auto-render on a keystroke — the exact settings and *why* each one matters
  live in `HtmlPreview.qml`'s header comment. Only the Miller pane offers it; the
  finder info pane has no key handler, so it always shows source there. The
  `Ctrl+R` binding and its gating/precedence live in `KeyRegistry.js` (see that
  file's header, per the Keyboard Event Handling convention — not restated here).

### State Architecture

- **`WindowState.qml`** (per-window) — navigation, search, chords, modals
- **`FileManagerService.qml`** (singleton) — clipboard, picker mode, format utilities
- **`HostController` (C++, in `host/standalone/server.cpp`)** — owns the QLocalServer, validates incoming IPC commands, emits Qt signals that the host's `main.qml` listens to in order to spawn windows. Replaces the old QuickShell `WindowFactory.qml` which folded windowing + IPC into one QML singleton.

### Service & Portal

- `symmetria-fm.service` — headless systemd user service, `ExecStart=/usr/bin/symmetria-fm`, `Restart=always`. The binary owns a `QLocalServer` at `$XDG_RUNTIME_DIR/symmetria-fm.sock`.
- `portal/symmetria_portal.py` — XDG Desktop Portal backend for system file dialogs.
- Communication: Portal → `symmetria-fm-cli createPicker '<json>'` → QLocalSocket → daemon → QML picker window → FIFO → Portal → D-Bus response.

**The daemon is periodically absent, and every client MUST tolerate that.** It
exits when its last window closes (deliberate — `main.cpp` documents why) and
removes its socket file, so between that exit and the `Restart=always` respawn
there is a window in which a connect fails INSTANTLY with `ServerNotFoundError`
— a connect *timeout* never helps, because no connect is in flight to wait on.
`symmetria-fm-cli` therefore retries for 5 s and asks systemd to start the unit
if the socket stays absent (`connectWithRetry` in `cli.cpp`), and `RestartSec` is
200 ms rather than seconds. Both were needed: at `RestartSec=2` a `Super+E` press
right after closing the last window did nothing at all, silently, because a
compositor `exec` bind discards the CLI's stderr. `StartLimitIntervalSec=0` is
part of the same fix — with an exit-per-close daemon, a burst of open/close
cycles is a burst of *starts*, and hitting systemd's default limit parks the
unit in `failed` permanently.

**Two copies of the unit file exist and only one is live.** The repo's
`symmetria-fm.service` is the source; `~/.dotfiles/.config/systemd/user/symmetria-fm.service`
is what stow symlinks into `~/.config/systemd/user`, so that is the one systemd
reads. Editing only the repo copy changes nothing at runtime.

**The app ID is a three-way contract** — `host/standalone/main.cpp`'s
`setDesktopFileName()` value == the installed `.desktop` basename == that file's
`StartupWMClass`. Only the first two are load-bearing, and they fail differently:
basename drift breaks Qt's `org.freedesktop.portal.Registry` registration
(`Could not register app ID: App info not found for '<id>'` — the id is empty
only when `setDesktopFileName` is absent entirely). `StartupWMClass` is merely a
launcher/XWayland hint and drives **nothing** here — do not edit it to fix a
window rule. What a compositor rule actually matches is the Wayland `app_id`,
which Qt takes from `setDesktopFileName()` and only otherwise falls back to the
executable's basename; both are `symmetria-fm` today, so renaming that literal
(say, to a reverse-DNS id) would silently change the `app_id` too. Why any of
it is load-bearing: see the comment above the call in `main.cpp`. The `.desktop`
and its icon ship with the **host** build — the only installer that places them,
and it targets `/usr`, because a `~/.local/share` copy takes XDG precedence and
goes stale —
`cmake --build host/standalone/build && sudo cmake --install host/standalone/build`.
Verify with `journalctl --user -u symmetria-fm --invocation=0 | grep "app ID"`: a
healthy start logs nothing. The `--invocation=0` scoping is load-bearing —
without it the query also matches the hundreds of pre-fix failures still in the
journal and looks like a regression. If it does log, check for a shadowing copy
first
(`ls ~/.local/share/applications/symmetria-fm.desktop`) — `~/.local/share` takes
XDG precedence over `/usr/share`. No Hyprland windowrule matches this class
today; see Critical Pitfalls → *Wayland focus on Hyprland* before adding one.

## Coding Conventions

### QML Property Ordering

Declare properties in this order within every QML component:

1. `id`
2. `required property` (mandatory parameters)
3. Regular `property` (mutable state)
4. `readonly property` (computed bindings)
5. Private `property` (prefix with `_`)
6. Signals
7. Implicit size / layout (`implicitHeight`, `anchors.*`)
8. `Behavior` animations
9. Event handlers (`onXxxChanged`)
10. Functions
11. Child components

### QML Pragmas

- Use `pragma ComponentBehavior: Bound` in all new QML files — enforces explicit scoping and prevents accidental access to parent properties
- Use `pragma Singleton` only for true singletons (`Singleton {}` root type)

### Naming Conventions

| Context | Convention | Example |
|---------|-----------|---------|
| QML files | PascalCase | `FileListItem.qml`, `DeleteConfirmPopup.qml` |
| QML root id | Always `root` | `id: root` |
| QML private properties | Underscore prefix | `property var _history: []` |
| QML signals | camelCase, past-tense or imperative | `closeRequested()`, `flashJump()` |
| QML functions | camelCase, private = underscore prefix | `navigate()`, `_resetState()` |
| C++ files | snake_case | `filesystemmodel.hpp` |
| C++ namespace | `symmetria::filemanager::models` | — |
| C++ member vars | `m_` prefix | `m_loading`, `m_entries` |
| C++ bool properties | `FileSystemEntry` predicates: `is` prefix (`isText`, `isDir`, `isImage`); `FileSystemModel` state: bare adjective (`loading`, `truncated`) |  |

### Imports

**Always declare explicit imports in every QML file.** Never rely on scope inheritance from parent Loaders — it is fragile and causes intermittent `ReferenceError` (see `QUIRKS.md` §2).

```qml
// All panel-tier QML accesses singletons + types via the unified module URI.
// The single qmldir at qml/Symmetria/FileManager/UI/qmldir declares
// FileManager (entry), FmTheme/Logger/FileManagerService/etc. (singletons),
// and per-instance / component types — all under one module URI.
import Symmetria.FileManager.UI
import Symmetria.FileManager.Models  // for ShellRunner, FileWatcher, FileSystemModel
import QtQuick
import QtQuick.Layouts
```

External hosts that embed the panel use `import Symmetria.FileManager.UI as FmUi` to avoid colliding with their own `Theme` singleton (e.g. Symmetria-IDE's `qml/design/Theme.qml`).

### Animation Rules

| Property type | Animation component | Example |
|--------------|-------------------|---------|
| Numeric (`width`, `height`, `opacity`, `scale`) | `Anim` (NumberAnimation) | `Behavior on opacity { Anim {} }` |
| Color (`color`, `border.color`) | `CAnim` (ColorAnimation) | `Behavior on border.color { CAnim {} }` |

- **Never use `Anim` on color properties** — produces `#000000` permanently (see `QUIRKS.md` §7)
- `StyledRect` and `StyledText` already have internal `Behavior on color { CAnim {} }` — do NOT add another
- Both `Anim` and `CAnim` use `FmTheme.animDuration` (400ms) and `FmTheme.animCurveStandard` easing

### State Management

**Immutable updates for binding reactivity:**
```qml
// WRONG — mutation does NOT trigger property bindings:
selectedPaths[path] = true;

// CORRECT — reassign triggers bindings:
const copy = Object.assign({}, selectedPaths);
copy[path] = true;
selectedPaths = copy;
```

**State ownership:**
- Per-window/tab state → `WindowState.qml` (navigation, search, chords, selection, modals)
- Shared global state → `FileManagerService.qml` (clipboard, picker mode)
- Tab collection → `TabManager.qml` (per-window instance)
- Do not create new singletons for small pieces of state — group related state together

**Singleton initialization:**
- QML singletons are lazy — they don't exist until first referenced. The standalone host's `main.qml` references the singletons it uses (Logger, FmTheme, FileManagerService) at startup so they instantiate before the first IPC arrives.
- `pragma Singleton` files use `QtObject` as their root (not `Item`); since QtObject has no default property, child elements (Timer, ShellRunner, FileWatcher) are declared as named properties (`property Timer _foo: Timer { id: foo }`).

### Loader Patterns

- **Never use `anchors.margins` inside Loader `sourceComponent`** — silently ignored (see `QUIRKS.md` §1)
- Use explicit `x`/`y`/`width`/`height` positioning instead
- Always declare imports explicitly in loaded components
- Set dependent properties BEFORE the property that triggers Loader activation (e.g., set `mimeType` before `path` if the Loader's `active:` binding depends on `path`)

### Modal/Popup Pattern

All modals use `Loader` with `active` bound to the `activeModal` enum on `WindowState`. A single `activeModal` property gates visibility, preventing multiple modals from opening simultaneously:

```qml
Loader {
    anchors.fill: parent
    active: windowState && windowState.activeModal === windowState.modalDelete
    sourceComponent: DeleteConfirmPopup { ... }
}
```

### Keyboard Event Handling

- **Normal-mode keybindings are data in `handlers/KeyRegistry.js`** — one
  declarative array is the single source of truth, read by BOTH the dispatcher
  and the `?` help popup (`HelpPopup.qml`). Add a `CORE` binding → it works in
  both views and appears in the cheat-sheet; view-specific ops go in `MILLER_ONLY`
  / `TREE_ONLY`. That file's own header documents the binding shape, the `ctx`
  adapter, and why it is *not* a `pragma library` — read it there, don't restate
  it here. `KeyRegistryTest` (Qt Quick Test) fails if a row lacks help metadata,
  uses a `group` HelpPopup can't render, or collides with another unconditional
  row on the same key+mods.
- **The dispatch cascade owns precedence and stays imperative** — each view's
  `Keys.onPressed` runs modal → bookmark sub-mode → chord RESOLUTION → flash, and
  only its final step delegates to `KeyRegistry.dispatch` (the tree path adds a
  `Ctrl+E` view-toggle before flash; see `TreeKeyHandler.js`). Those are modes,
  not bindings. **Load-bearing rule:** chord resolution must run in the cascade
  *before* `dispatch`'s internal picker-suppression pre-pass — don't move it into
  the registry. A binding whose `when()` is false does NOT consume its key (it
  falls through — preserving n/N and the tree's Escape-propagates-to-close).
- **`?` is itself an ordinary `CORE` row** (`help.open` → `openHelp()`); the
  status-bar `?` button calls the same `openHelp()`, so there is no special-case
  to hunt for outside the registry array.
- **Chords**: prefix keys (g/c/,) are registry rows that set `activeChordPrefix`;
  RESOLUTION and the sub-menu table stay in `ChordHandler.js` + `WindowState`'s
  `chordBindings` (rendered by BOTH the `WhichKeyPopup` HUD and `HelpPopup`).
  NOT Symmetria's KeyChords module. **There is NO chord timer.** This document
  used to claim a 500 ms timeout, in two places; `ChordHandler.js` has no timer
  and never had one. A prefix persists until the next key resolves it, an
  Escape cancels it, the view loses focus, or the tab changes. Do not add a
  timer to make the code match a sentence that was wrong.
- **The windowState-less embedded tree path** (IDE sidebar) bypasses the registry
  entirely — `TreeKeyHandler` keeps a legacy navigation-only switch + `gg` timer
  for that consumer; only when `root.windowState` exists does it dispatch.
- **Escape priority** (stack-based, last-entered-first-exited). The real order
  has EIGHT steps, and search is not one of them — whether the search field sees
  Escape is decided by which input holds FOCUS, not by the cascade. An earlier
  version of this list omitted the modal and bookmark steps and placed search
  inside the cascade; it was wrong on both counts:
  1. a text input has focus → the input handles it, and the cascade never runs;
  2. a modal is open → the modal handles it;
  3. the bookmark sub-mode is active → cancels the sub-mode;
  4. a chord is pending → cancels the chord;
  5. flash is active → the flash handler cancels it;
  6. a picker is open → clears the selection if multi-select, else cancels the picker;
  7. something is selected → clears the selection (`sel.clear`);
  8. Miller swallows what is left (`miller.escapeSwallow`); the tree intentionally
     has no such binding, so Escape propagates to the host's close-window handling.
- Picker mode suppresses certain keys (Y/X/P/Space/T/[/]) via the `dispatch`
  pre-pass; gated OFF for `pickerFileOps` embedding hosts.

### C++ Plugin Patterns

- **Async I/O**: Use `QtConcurrent::run()` for all heavy operations (directory scans, file reads, image decoding)
- **Generation counters**: Discard stale async results when user navigates faster than I/O completes
- **Mutable lazy init**: Expensive properties (`mimeType`, `icon`) computed on first access with `mutable` backing fields
- **QML registration**: Use `QML_ELEMENT` macro; use `QML_UNCREATABLE("reason")` for types not instantiated directly from QML
- **Header guards**: `#pragma once` (no `#ifndef` guards)
- **No `using` directives in headers** — use full namespace paths

### Logging

Use the `Logger` singleton, not `console.log`:

```qml
Logger.debug("TabManager", "init with path: " + initialPath);
Logger.warn("FileManager", "Picker already active");
Logger.error("FileManager", "FIFO write failed");
```

Logs write to `~/.local/share/symmetria/logs/filemanager.log` with timestamps, levels, and component names.

### Path Utilities

Use `Paths.basename(path)` and `Paths.parentDir(path)` instead of inline `substring`/`replace` expressions. These are defined in `services/Paths.qml` and handle edge cases (root path, empty result) consistently.

### Theme & Typography

- All colors from `FmTheme.palette.*` — property names match `color-scheme.json` keys directly (e.g., `FmTheme.palette.surface`, `FmTheme.palette.onSurface`, `FmTheme.palette.primary`)
- **Theme source**: The near-black palette in `FmTheme.qml` is the real default. An OPTIONAL `~/.config/symmetria/ui/color-scheme.json` overrides the keys it declares (no IPC, no runtime dependency). ⚠ That path is **toolkit-owned, NOT Symmetria Shell's** — the file manager used to read the shell's `~/.config/quickshell/symmetria/config/color-scheme.json` and followed the desktop's palette, but the shell took its own metallic direction that the FM and the Symmetria IDE deliberately do not follow, so the shell's file was dropped from the chain entirely. Editing the shell's colours no longer affects this app. The **IDE reads the same file** (`src/symmetria_ide/ui_scheme.py` → the `uiScheme` context property), so one edit re-skins both; keep the two key mappings in sync when adding a key. Transparency, layout tokens (rounding, spacing, padding, fonts), and other appearance values stay file-manager-specific and hardcoded. ⚠ Pill lightness is **not** palette-driven: `_mattePill` takes only hue and saturation from the palette and computes lightness from a hardcoded formula, so darkening the scheme darkens no pill — the formula is the only lever.
- **Transparency model**: Solid-body model (macOS-Tahoe / GNOME-Files style). The Miller columns are **solid rounded surfaces** built in `MillerColumns.qml` (one `StyledRect` per column: `radius rounding.lg`, solid `palette.surface`, hairline `overlay.subtle` border, content inset by `padding.md`, columns separated by `padding.sm` gaps — no more 1px separators). ⚠ That fill is `palette.surface` — the BASE colour, not a container rung — since the flat-aesthetic move: at `surfaceContainerLow` the panes read as a grey box sitting ON the chrome instead of as part of it, most visibly inside the Symmetria IDE, whose chrome paints the same base. The same surface is repeated four times (three columns + the single-pane view in `FileManager.qml`); change all four together. ⚠ **Verified in the IDE-hosted file manager only.** In the STANDALONE window the surrounding area is `windowBackdrop` (black at 0.6 over the wallpaper), not a solid base fill, so the "panes match the host background" rationale does not apply there — the panes stay opaque either way, so the floating-card separation is unchanged and the shift is only 3 lightness units, but nobody has looked at it over a bright wallpaper. Transparency survives only in the **chrome**: the empty areas of the top/bottom bars around the clay pills and the gaps between cards, where `FmTheme.windowBackdrop` shows through. The backdrop is pure black at 0.6 alpha (`Qt.rgba(0, 0, 0, 0.6)`) — **deliberately identical to Ghostty's `background = #000000` + `background-opacity = 0.6`** (`~/.config/ghostty/config`) so the FM's transparent regions match the terminal's wallpaper-darkness side by side. (The earlier *Ghostty single-layer* model also used 0.6 but made the *whole body* transparent; this solid-body model keeps the columns opaque and applies the 0.6 only to the chrome/gaps. It was briefly 0.9 during the redesign, which read far darker than Ghostty — keep it at 0.6.) Pitfalls: (1) `_transparencyLayers` stays **0.0** — the panels' internal backgrounds (`FmTheme.layer(surfaceContainerLow)`) remain transparent and *reveal* the `MillerColumns` surface behind them; the solid fill is owned by the column surfaces, NOT by raising the layer alpha (which would compound with the backdrop in the chrome gaps). (2) The middle column's surface is added **around** `FileList` in `MillerColumns.qml` — `FileList` is inset over it (the surface wraps from outside so `FileList` does not own its own background). (3) There is **NO per-row zebra striping**, in either the Miller list or the file tree. `FileListItem.qml` and `FileTreeRow.qml` each used to paint a plain un-animated `Rectangle` behind even rows; both were removed with the flat-aesthetic move (user decision) after a first attempt at merely lowering the alpha. Over the near-black base the alternation read as banding rather than as a reading aid, and the lists are quieter without it — row separation is carried by indent guides and row spacing, and the ONLY remaining row fill is the current-item highlight. The `overlay.zebra` token introduced for it was retired with it. Change the two files together or neither; restoring the striping is a revert of one commit. Same j/k-stutter rule as the selection highlight (adding a `Behavior` or `gradient` to a per-delegate `Rectangle` causes stutter during fast j/k navigation) — keep it a plain `Rectangle`, no gradient/Behavior.
- **Indicator colors** via `FmTheme.indicator.cut`, `.yank`, `.selection` — hardcoded deliberately because palette tokens change with wallpaper-derived color schemes
- **Overlay colors** via `FmTheme.overlay.subtle` (0.06 white) and `.emphasis` (0.10 white) — separators, borders, and small-swatch backgrounds like keycaps. There is deliberately no alternating-row token; see the zebra note in the transparency-model bullet above before adding one
- Sans: `FmTheme.font.family.sans` (Rubik), Mono: `FmTheme.font.family.mono` (CaskaydiaCove NF), Icons: `FmTheme.font.family.material`
- Spacing/padding/rounding accessed via `FmTheme.spacing.*`, `FmTheme.padding.*`, `FmTheme.rounding.*`
- **Syntax-preview theme is separate from `FmTheme`.** Code/Markdown previews are highlighted by `SyntaxHighlightHelper` (C++/KF6), which uses a custom KSyntaxHighlighting theme named **"Wine"** — NOT the wallpaper-derived `FmTheme.palette`. The theme is a `.theme` JSON at `plugin/src/Symmetria/FileManager/Models/themes/wine.theme`, embedded into the plugin `.so` as a Qt resource (`:/symmetria-fm-syntax/themes/wine.theme`) and discovered via `Repository::addCustomSearchPath` — KF6 appends `/themes` to the path automatically; it falls back to KF6's built-in `DarkTheme` if the embedded theme fails to load. **It deliberately mirrors the user's NeoVim Lush colorscheme** at `~/.config/nvim/lua/jc/plugins/theme/wine_theme/lua/lush_theme/wine_theme.lua` so editor and previews share one palette — derive all color values from `wine_theme.lua`; do NOT modify one file without updating the other to match.

### SortBy Enum

Use `FileSystemModel.Alphabetical`, `.Modified`, `.Size`, `.Extension`, `.Natural` (Q_ENUM values) instead of magic integers in QML. WindowState stores `sortBy` as an `int` to avoid depending on the C++ plugin module.

## Critical Pitfalls

**QFileSystemWatcher atomic-replace** — The watcher silently drops a watch when the watched path is unlinked then renamed-into-place (the typical pattern for `:w` in nvim, git checkout, atomic JSON saves). `FileWatcher` mitigates this by watching both the file AND its parent directory and re-arming via `removePath; addPath` on every change signal, with a 100ms QTimer retry fallback. The `atomicReplaceTenTimes` test asserts this holds across 10 consecutive replacements. If hot-reload of bookmarks.json or color-scheme.json starts breaking, this is where to look.

**QFileSystemWatcher directory watch is deaf to in-place content writes** — Qt's directory inotify mask tracks creation/deletion/rename/attribute changes but **omits `IN_MODIFY`/`IN_CLOSE_WRITE`**, so a file that grows on disk *after* it was first listed emits **no `directoryChanged` at all**. This bites downloads streamed straight to their final name (`curl -O`, `wget`, `yt-dlp`, "Save image as") — not temp-file-then-rename downloads (Firefox/Chrome), whose final name appears already full-size via `IN_MOVED_TO`. Compounded by `FileSystemEntry` holding an immutable `QFileInfo` stat'd once at construction, and `FileSystemModel`'s diff historically comparing only the *set of paths*, the symptom was a file stuck at **0 bytes with no preview** until re-navigation rebuilt the entries. Fix (in `FileSystemModel`, see those functions for mechanics): `syncFileWatches()` adds a per-file watch so `fileChanged` fires on growth, debounced into a rescan by `onFileChanged()`; the background diff also rebuilds same-path size/mtime changes as remove+add (keeping entries immutable snapshots). Bounded deliberately — per-file watches are **non-recursive only** and capped at `kMaxFileWatches` to protect the inotify budget. Regression test: `growingFileRefreshesSize`.

**Wayland focus on Hyprland** — Without `WlrKeyboardFocus.Exclusive` (which only existed under QuickShell's wlr-layer-shell), the picker window relies on `Qt.Dialog | Qt.WindowStaysOnTopHint + requestActivate()` to claim focus. If Hyprland's bindings still swallow keys destined for the picker, ship a `windowrule = float, match:class ^(symmetria-fm)$` rule. **None is shipped today** — the class it would match is the app ID contract described under Service & Portal, so the two must be changed together. (Note the syntax: this Hyprland config uses the current `windowrule = <action>, match:<selector>` form, not the older `windowrulev2 = <action>,<selector>`.)

**Portal startup stalls outside this repo** — `xdg-desktop-portal` activates the GTK Settings backend *synchronously* at startup (GTK is the only backend implementing that interface). If GTK isn't already running, the call burns a 75 s D-Bus timeout and systemd can kill the unit — and then *no* file dialog works system-wide, ours included, so the symptom looks like our bug. Check `systemctl --user status xdg-desktop-portal` for `start operation timed out` **before** suspecting anything in `portal/`. The fix is a systemd drop-in that lives in **dotfiles, not this repo** — `~/.dotfiles/.config/systemd/user/xdg-desktop-portal.service.d/gtk-ordering.conf` (measurements and full rationale in its header). If it is missing, re-stow from `~/.dotfiles` and run `systemctl --user daemon-reload`; confirm with `systemctl --user cat xdg-desktop-portal`. Related: `~/.config/xdg-desktop-portal/portals.conf` pins `Settings=gtk` and is tracked by **neither** repo — machine-local state a reinstall loses silently.

**QML Loader quirks** — `anchors.margins` silently fails inside Loader `sourceComponent` blocks. Always use explicit x/y/width/height positioning and explicit imports inside Loaders. See `QUIRKS.md` for details.

**QtObject has no default property** — `pragma Singleton` files and the host's `main.qml` use `QtObject` as their root; child elements (Timer, ShellRunner, FileWatcher, Component, Connections) must be declared as named properties (`property Timer _foo: Timer { id: foo }`). The `id: foo` form remains accessible from the rest of the scope.

**Two `Theme` singletons in one engine** — When the panel is embedded in Symmetria-IDE, both modules (`Symmetria.FileManager.UI` and the IDE's `design`) define `Theme`. The FM's singleton is renamed to `FmTheme` to remove the collision; external hosts that import via `import Symmetria.FileManager.UI as FmUi` get the alias-prefixed namespace.

**QML `on` prefix restriction** — QML reserves identifiers starting with `on` + uppercase letter for signal handlers. The palette uses `property var` (plain JS object) instead of `QtObject` because M3 token names like `onSurface`, `onPrimary`, `onSecondaryContainer` would clash with signal handler syntax inside `QtObject`. This means palette updates must use immutable reassignment (`root.palette = {...}`) to trigger bindings — do NOT mutate individual keys.

**Vim chord detection** — Multi-key detection in `qml/Symmetria/FileManager/UI/modules/filemanager/handlers/ChordHandler.js`. **There is no timeout.** This entry used to state a 500 ms timer; the file contains none. See Keyboard Event Handling → Chords for what actually ends a pending prefix.

**Claymorphism shadows render outside the pill bounds** — `PillSurface`/`PillCard` cast `RectangularShadow`s that paint into the area *around* the pill, beyond the component's own rect. So (1) any ancestor with `clip: true` slices the soft shadow edges into a flat, chopped look, and (2) the host must leave margin around the pill for the shadow to occupy. If a shadow looks cut off, search the parent chain for a `clip` — do NOT shrink the blur. Full rationale in the `GOTCHA` block at the top of `components/PillSurface.qml`.

**Fuzzy finder is backed by the Rust `fff` engine** (`fuzzyfinder.cpp`, QML element still `FuzzyFinder`). Non-obvious constraints a future change must respect:
- **`extern "C"` around `#include "fff.h"`** — fff-c's cbindgen header has no `__cplusplus`/`extern "C"` guard, so without the wrapper the C++ compiler mangles every `fff_*` symbol and the link fails with undefined references. (Upstream fix would be `cpp_compat = true` in their cbindgen.toml.)
- **One process-wide engine, not one per instance** (`FffEngine` singleton in `fuzzyfinder.cpp`). LMDB/heed refuses to open the same frecency-DB environment twice in a process ("environment already open"), so a per-`FuzzyFinder` engine would fail the moment a second finder/window opens. The singleton is permanent and never destroyed; its internal engine handle is swapped via `fff_restart_index` when `searchPath` changes. Trade-off: two finders open at once across windows share the one engine, so the last-acquired path wins — rare, transient, never crashes.
- **`fff_search_mixed`, not `fff_search`** — the latter is files-only; mixed returns directories too (so directory navigation in the finder survives). Directory items carry a **trailing `/`** in their `relativePath` and `fullPath` (e.g., `src/components/`). The `name` role (`display_name`) is the bare last segment without a trailing slash.
- **`matchIndices` are recomputed in the C++ wrapper** (greedy subsequence) because fff's file-search result exposes no per-character match positions; the popup's highlighter depends on them.
- **`showHidden` is inert** for this backend — `FffCreateOptions` has no hidden toggle; fff governs hidden/ignored files via its own ignore model. The property is kept only for QML binding compatibility.
- **Frecency LMDB** lives at `~/.local/share/symmetria/fff/` (`frecency`/`history` dirs). `SYMMETRIA_FM_FRECENCY_DIR` overrides the location (tests isolate it into a temp dir; also a user relocation hook). The directory is created automatically by fff (via `fs::create_dir_all`) if it does not exist — no manual `mkdir` required. fff creates and opens the `frecency` environment, but **no code path in this application ever inserts a record into it** — see the next bullet.
- **`recordOpen()` does NOT teach frecency, and this document used to say it did.** `recordOpen(index, query)` → `fff_track_query` writes the **query tracker**, not the frecency database. ⚠ And in this application even the tracker's payoff is currently zero: `startSearch()` passes `combo_boost_multiplier = 0` to `fff_search_mixed`, so the boost described below is always `0`. What the write buys in principle: the tracker keeps one record per `(project path, query)` pair holding the selected file and an `open_count`, and a later search whose query matches that record adds `open_count × combo_boost_multiplier` to the score — measured taking a result from 154 to 454, visible to a second process on the first read. That gain is **per-project and per-query**, so an embedding host shares it only when the host indexes the identical absolute root. Evidence, three ways (`docs/electron-transition/20-spike-search-topology.md` §2.1):
  1. The frecency DB stays at its empty 8192 bytes across repeated writes, a reindex, a finder recreated in-process, and a fresh process.
  2. The C wrapper's track-query function calls the query tracker's completion method and touches nothing else.
  3. `fff_track_access` — the exported C symbol that would write frecency — is **not among the 78 `fff_*` symbols the shipped `libfff_c.so` exports**, so no C-ABI caller can reach it. (`Frecency::track_access` is the Rust function behind it, reachable only from the Neovim binding and the background watcher.)
