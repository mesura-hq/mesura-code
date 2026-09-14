# Synthesis — what the research found, and what has to be decided

This document sits on top of reports 01 through 11. It states the consolidated
picture, the decisions that are already made by evidence, and the decisions that
still need a human. It does not repeat the detail; each claim cites its report.

## 1. The finding that reframes the whole project

The task was stated as "port the Qt file manager to Electron". The research says
the real task is different in three ways.

**First, the destination is not an empty Electron app.** Mesura Code is a fork of
`pingdotgg/t3code`, a pnpm monorepo on Electron 41.5.0, React 19.2.6, Effect-TS
and Tailwind v4 (07 §5). It already ships the pieces a file manager needs:
a virtualised file tree with an unused git-decoration API, a diff and code viewer
with Shiki, a fuzzy-search engine, native-module packaging, a window service, an
IPC layer, and two Unix sockets to the Symmetria ecosystem (07, 08).

**Second, several "features to port" do not exist.** The PRD is largely
aspirational: visual mode, command mode, marks, `yy`/`dd`/`pp` and an editable
path bar were never built (01 §9). The file manager has **no git status
pipeline** — only an ignore filter, an unwired badge, and a stale word from `fff`
(11). So the port is smaller than the documents suggest, and the gap is design
space rather than porting work.

**Third, the reusable module the user asked about is already a dependency.**
`@ff-labs/fff-node@0.9.4` sits in `apps/server/package.json` — the same `fff`
engine the C++ plugin links, with prebuilt binaries, an asar-unpack patch, and a
packaging gate that boots the real Electron binary and proves the `.so` loads
(04, 07 §8). Extraction is not needed. Wrapping is.

## 2. What the file manager actually is, in numbers

| Dimension | Count | Report |
|---|---|---|
| Registry keybindings | 54 (28 CORE, 20 Miller-only, 6 tree-only) | 01 |
| Chord prefixes → invocations | 3 → 20 | 01 |
| View modes | 2 (Miller columns, tree) plus one embedded consumer surface | 01 |
| Modal types | 7 | 01 |
| Preview types | 18 | 02 |
| File operations | 12, all shelling out through `ShellRunner` | 03 |
| IPC commands | 4 (`open`, `openOverlay`, `createPicker`, `closePicker`) | 03 |
| Theme tokens | 63 declared, 71 emitted as CSS | 05 |
| `fff` C ABI functions used | 8 of ~80 | 04 |

No in-process filesystem mutation exists anywhere: every write is `cp`, `mv`,
`gio trash`, `touch`, `mkdir` or `bsdtar` in a `QProcess` (03).

## 3. Defects the research found in the existing code

These are real, they are in the current shipping file manager, and a port would
otherwise copy them.

| # | Defect | Where | Report |
|---|---|---|---|
| 1 | `closePicker` is unreachable — the CLI rejects it as `unknown method`, so a cancelled portal dialog waits out the full 300 s FIFO timeout | `cli.cpp:57-76` | 03 |
| 2 | The fuzzy finder's git badge always falls to `default` — `fff` emits English words, the `switch` expects porcelain characters; every clean file shows a grey `c` | `FuzzyFinderInfoPanel` | 11 |
| 3 | `.gitignore` hot reload does not work — the mtime is read, stored, and never compared, contradicting the file's own header comment | `Gitignore.qml` | 11 |
| 4 | Directory names lose a character in the finder — the delegate strips the trailing slash from `path` but not from `name`, so `src/components/` renders as `src` + `/components` | `FuzzyFinderResultDelegate.qml:47-48` | 04 |
| 5 | `Ctrl+D`/`Ctrl+U` jump the wrong distance in a compact tree — `halfPageCount` omits `compactScale`, which `rowHeight` includes, against a comment saying they must stay equal | `TreeModel.js:652,857` | 01 |
| 6 | `.xlsb` passes the MIME gate but QXlsx cannot read it | spreadsheet preview | 02 |
| 7 | The PDF branch is the only decoder that leaves a partial cache file on write failure, so a truncated PNG serves as a valid cache hit forever | `generateCachedPreview` | 02 |
| 8 | The D-Bus activation file pins `/usr/bin/python3.12`, which lacks `dbus-fast` | portal install | 03 |

Documentation that contradicts the code: the chord timeout (CLAUDE.md claims
500 ms; the file manager has no chord timer), the Escape priority order, hidden-file
persistence, the `fff` `display_name` trailing slash, and `tech-stack.md:63`
still recording Electron as rejected (01 §9, 04, 06).

## 4. What gets better and what gets worse

**Better, for free** (09):
- The `IN_MODIFY` directory-watch bug disappears. libuv watches include it, so
  `syncFileWatches`, `kMaxFileWatches` and the debounce-rescan get deleted rather
  than ported.
- The `wl-copy` clipboard bug disappears. Chromium owns the data source for the
  process lifetime.
- PDFs become real multi-page documents with selection and search; the whole
  PDF→cached-PNG path is deleted.
- Animated GIF, WebP and AVIF play. Markdown renders. Text previews scroll and
  select. SVG icons stay vector without the `QIcon` rasterisation dodge.
- The MIME implementation becomes unit-testable, which converts the silent
  `application/x-yaml` → `application/yaml` drift class into a failing test.

**Worse, honestly** (09, 10):
- **Memory, measured on this machine today: Qt daemon 113 MiB PSS with one
  window; an Electron shell ~345 MiB PSS with one window; 48–235 MiB PSS per
  extra window.** Expect roughly 3× resident, up to 4× with a warm pool and a
  picker.
- **Spreadsheets regress no matter which option is chosen.** `freexl` reads
  legacy `.xls` cleanly today; every JavaScript path is unmaintained,
  CDN-only, or licence-encumbered. This is the only HIGH risk on the map.
- Syntax coverage drops from ~400 KSyntaxHighlighting definitions to ~200 Shiki
  grammars, permanently.
- Hard links and sparse files are lost by a hand-rolled copy engine; `cp`
  preserves them today.
- Cold start, per-entry `stat` cost, and the npm supply chain are all new.

## 5. The architecture the evidence points to

### 5.1 Placement — four locations, not one

Goal one (a standalone resident daemon) and goal two (embedded in Mesura Code)
cannot be served from one place (07 §10).

| Location | Contents |
|---|---|
| `packages/file-manager-core/` | Framework-free model: keybinding registry, preview classification, MIME inheritance, sort and filter rules |
| `apps/desktop/src/fileManager/` | The privileged main-process half, registering its own IPC inline |
| `packages/file-manager-ui/` | The React surface, host-blind |
| `apps/file-manager/` | The standalone Electron host and resident daemon |

The evidence for keeping to fork-owned directories is quantitative:
`apps/web/src` took 587 upstream commits in three months and
`packages/contracts/src/ipc.ts` took 39, while the existing `symmetria/`
directories have never conflicted (07, 08).

### 5.2 The rule that overrides DRY inside the fork

Editing a line upstream maintains costs a merge conflict every week; adding a
file costs nothing. Disabling beats deleting. A tidier refactor that touches more
upstream lines is usually wrong, including extracting a shared constant (06).
This contradicts the global DRY instruction, and inside Mesura Code the fork rule
wins. Budget: **four upstream edit sites** for the embedded surface, each one line
or one `case`. A standalone window has **zero** upstream conflict surface, which
is why it is the cheaper first target (08).

Do not add a fourth Symmetria member to `packages/contracts/src/ipc.ts` — the
file carries a written warning and points at issue #16. Use the fork-cheap IPC
variant that `SttDelivery` and `ThreadPublisher` already use: register the
handler inside the feature's own layer, two lines instead of six files (07 §2).

### 5.3 The embedding contract already exists and should be preserved

Symmetria IDE does not consume "the file manager". It injects three duck-typed
objects and the tree knows nothing about git (06):

- `statusProvider` — `statusForPath(abs) → {char,color,tooltip,adds,dels} | null`, plus a `statusChanged` signal
- `ignoredPathSet`
- `pathFilter`

`null` is always safe. This is the correct seam for Mesura Code too: the host
injects its own git, and no git implementation is duplicated. Reproduce this
contract in TypeScript rather than inventing a new one.

### 5.4 The daemon and window strategy

- systemd user unit, not XDG autostart. Only systemd can express
  `UnsetEnvironment=HL_INITIAL_WORKSPACE_TOKEN`, which is load-bearing (10).
- Resident main process with `app.on("window-all-closed", () => {})`. This
  **inverts** the Qt host's deliberate quit-on-last-window choice, which is cheap
  in Qt and ruinous in Electron.
- Transport: a **Unix socket** on the same path with the same envelope and the
  same error strings, so the unchanged C++ `symmetria-fm-cli` and the unchanged
  `symmetria_portal.py` become the acceptance test. `second-instance` scores 1 of
  5: it costs a full cold start per message and has no reply channel (10).
- A warm pool of **one** hidden pre-painted window, plus a picker singleton.
  Retarget by IPC, never `loadURL` — a cross-origin navigation discards the warm
  renderer (Electron issue #49960).
- Paint a skeleton and `show()`; never wait for the directory scan.
- Target: **p50 under 60 ms, p95 under 120 ms**, measured with four timestamps
  from CLI `CLOCK_MONOTONIC` to the Wayland commit.

### 5.5 The backend technology map

One new native module: `@parcel/watcher`. **No new Rust** (09).

| Capability | Choice |
|---|---|
| Directory listing | `fs.opendir` + `statSync` in a `worker_thread`, lazy per-row probes |
| Watching | `@parcel/watcher` 2.6.0 |
| MIME + inheritance | ~200-line TS reader over `globs2`/`subclasses`/`aliases`, **including both implicit spec rules** |
| Icon theme | Port `IconThemeResolver` 1:1 to TS, serve via `protocol.handle()` |
| Syntax highlighting | **`highlight.js` + a generated Wine stylesheet, hard-truncated** — see report 13, which measured and overrides 09 |
| Images | **Chromium natively for 8 formats, `magick` shell-out for the long tail** — see report 14, which overrides 09. `sharp` is BLOCKED, see §6.7 |
| Archives | `yauzl` + `tar-stream` + `zlib` in-process, `bsdtar` shell-out for 7z/rar/cab/iso |
| PDF | Chromium's built-in viewer |
| Git | Shell out through Mesura Code's existing `apps/server/src/vcs/GitVcsDriverCore.ts` — no git library is or should be added |
| Fuzzy find | `@ff-labs/fff-node`, wrapped in a `packages/file-search` |

**The CSP trap, which applies to every WASM module we might ship** (a HEIC
decoder, a JXL decoder, anything): **Chromium blocks WebAssembly under a Content
Security Policy that omits `'wasm-unsafe-eval'` from `script-src`**. Electron's
own security guide recommends `script-src 'self'` and never mentions WASM, so
following it verbatim silently breaks the decoder (13 §3).

**The MIME inheritance trap, stated once so it is not lost:**
`text/x-shellscript` reaches `text/plain` only through the implicit `text/*` rule,
not through the `subclasses` table. A port that reads the table and stops
silently breaks every shell script. And `image/svg+xml` *is* text under that
rule — `PreviewContent.qml` is correct only because it tests `isImage` first.
That ordering is a contract (09).

## 6. Decisions — resolved by the user on 2026-08-24

**Resolved. Do not reopen these without the user.**

- **№3 — memory: ACCEPTED**, and superseded by an architecture change. The
  application moves to **one window with tabs**, not many windows. See §6b.
- **№4 — legacy `.xls`: DEFERRED.** Not part of the transition. The user does want
  a spreadsheet preview eventually — enough to see what tables a file holds — so
  design the preview router so a spreadsheet type can be added later without
  rework.
- **№5 — palette: use Mesura Code's own tokens.** Do not port the file manager's
  `FmTheme` ladder and do not follow the IDE's. Take Mesura Code's dark values as
  they are, stay minimal, and add claymorphism only where it earns its place.
  This retires the "which grey ladder" question entirely.
- **№6 — documentation: will be corrected.** The work is effectively a rewrite, so
  the stale documents get deleted and rewritten against what exists rather than
  patched.
- **№7 — image library: settled by a spike**, not by discussion. See §7.

### 6b. The architecture change that came with №3

The user chose **a single window with tabs** over many short-lived windows, on the
same reasoning that shaped Mesura Code against Symmetria IDE. Three consequences
for everything written above:

1. **The warm-window pool in §5.4 collapses to a simpler design.** One resident
   window, hidden rather than destroyed, shown on demand. No pool, no reset
   between uses, no `BrowserWindow` churn. This removes the largest source of
   complexity in report 10.
2. **The memory picture improves rather than degrades.** The 48–235 MiB marginal
   cost per extra window is not paid at all. Resident cost stays near the
   single-window figure instead of scaling with how many directories are open.
3. **The file manager already has the tab machinery** — `TabManager.qml` is a
   per-window instance today. The port promotes it from a per-window detail to
   the primary navigation model.

The user framed this as a discipline as much as an optimisation: fewer things
open at once, enforced by the tool.

## 6c. Still open

1. **Does the standalone file manager share one codebase with the Mesura Code
   surface, or are they two consumers of a shared core?** The four-way split in
   §5.1 assumes the second. Confirm before any directory is created.
2. **Who owns the `fff` index?** LMDB refuses a second open of one environment
   per process. Mesura Code's per-cwd index works today only because it passes no
   frecency path; enabling frecency turns that into a bug. A single-owner
   `utilityProcess` is the only shape that gives the IDE's "one index, one
   ranking" goal (04, 10).
3. **Is 3× resident memory acceptable for instant windows?** 113 MiB → ~345 MiB
   is the honest trade. The alternative is accepting a slower first window.
4. **Legacy `.xls`: keep it or drop it?** Every JavaScript path is a regression.
   Dropping it is defensible; a napi-rs `calamine` binding is the only way to
   keep parity, and it reopens the "no new Rust" decision.
5. **Which grey ladder does the Electron surface follow?** The file manager and
   the IDE map the same M3 names to different values (`surface` `#0f0f0f` versus
   `#131313`). They share the file, not the ladder. A third consumer must choose
   explicitly (05).
6. **Does `tech-stack.md:63` get corrected?** It still records Electron as
   rejected, and the migration plan places the file manager at position 9 of 10.
   Tonight's direction promotes it to first. Unless that is written down, a future
   agent will read the old document and "correct" the course (06).
7. **Which image-resize library, given that `sharp` is blocked?** `sharp` emits a
   warning on every Electron start on Linux and has an open, unfixed crash class
   caused by Electron leaking global `glib` symbols. `@napi-rs/image` links no
   glib and is the leading alternative, but decodes no HEIC on Linux and — an
   undocumented gap — no GIF at all. Report 14 §3 and §9. **A spike settles this,
   not a discussion.**

## 7. Recommended order of attack

**Phase 0 — four spikes before any feature work** (10, 14). Each answers a
question that can sink the design, and each is cheap.

1. **The window-spawn budget.** A four-timestamp harness against a
   skeleton-only renderer, 200 iterations. If p95 misses 120 ms, renegotiate the
   target before building anything.
2. **Picker keyboard focus.** Electron's `XDG_ACTIVATION_TOKEN` support targets
   freshly launched processes; a resident daemon is not one, and no public API
   hands a token to an existing window. A ~40-line script settles it. **This one
   opens a window, so the operator must run it deliberately.**
3. **The `sharp` GLib crash.** Load `sharp` in an Electron main process on this
   machine and decode a few hundred images on the libuv thread pool. If the
   `GLib-GObject` assertion or a SIGTRAP appears, `sharp` is out and the image
   pipeline goes to `@napi-rs/image` plus `magick`. Report 14 §3.
4. **Fractional-scale blur.** The display runs at scale 1.6; Electron 41.5.0 is
   Chromium 146, and fractional-scale support landed around Chromium 148. Costs
   one hour and no new code: `grim` the running Mesura Code window and the
   running `symmetria-fm` window and compare at 1:1.

**Phase 1 — the standalone file manager.** Zero upstream conflict surface. The
daemon, the socket protocol (the unchanged C++ CLI and the unchanged Python
portal are the acceptance test), the two view modes, the keybinding registry, and
the preview router.

**Phase 2 — the previews**, ordered by the map in §5.5 and by how often each type
is actually opened.

**Phase 3 — `packages/file-search`**, wrapping `@ff-labs/fff-node` with the
index-ownership decision from §6.2 settled.

**Phase 4 — git status**, built once, in the shape the IDE already proved, behind
the `statusProvider` seam.

**Phase 5 — the embedded surface in Mesura Code**, spending the four budgeted
upstream edit sites and no more.
