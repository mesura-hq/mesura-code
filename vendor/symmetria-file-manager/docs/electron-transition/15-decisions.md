# Decision log — Electron transition

Every decision the user made, with the reasoning they gave. This file is the
authority. Where it contradicts an earlier report, **this file wins**, because the
reports recommended and the user decided.

Date of all entries below: **2026-08-24**.

---

## D1 — The file manager keeps its own repository

**Decided: separate repository. Mesura Code consumes it.**

This reverses the recommendation in report 07 §10, which argued for a single
monorepo. The user's reasoning, which is sound and answers the argument:

- **The file manager is a daily-driver tool used outside Mesura Code.** Mesura
  Code is a large application; the file manager must not require it to run.
- **They are different things.** One consumes the other for convenience — to avoid
  maintaining two file systems — not because they are one product.
- **The same shape is coming for the editor.** When an editor is brought in, it
  will be another independently useful tool consumed by Mesura Code. Establishing
  the pattern now is deliberate.
- **The standalone has features Mesura Code does not need**, and the reverse. A
  shared repository would blur that boundary.

**The cost, stated plainly and accepted by the user:** versioning and publishing
between repositories, and the risk of the two drifting. The user accepts this as
the price of keeping the boundary honest.

**What this changes from report 07:** the four-way split still holds as a *layer*
model, but the layers no longer all live in one workspace:

| Layer | Where it lives now |
|---|---|
| Core — keybinding registry, preview classification, MIME inheritance, sort and filter | The file-manager repository, published as a package |
| Privileged half — filesystem, watching, git, file operations | The file-manager repository, published as a package |
| UI — the React surface | The file-manager repository, published as a package |
| Standalone host — the Electron app, the resident process, the socket | The file-manager repository, not published |
| The embedding | Mesura Code, consuming the three published packages under `symmetria/` |

**Open sub-question for implementation:** how the packages are published and
consumed. Options are a real registry, a git dependency, or a pnpm workspace link
during development. This is a mechanics question, not a direction question.

---

## D2 — The `fff` index is shared

**Decided: the file manager and Mesura Code share one frecency store. Every file
open teaches the ranking for both.**

The user's position — "todo uso de un archivo constituye a subir el ranking" — is
achievable, and the constraint is smaller than first recorded:

- **LMDB blocks a second open of one environment _within a process_, not across
  processes.** It is designed for multi-process access with a lock file. Two
  separate applications sharing one store is the easy case.
- The hard case is narrower: Mesura Code holds **N indices in one process**, one
  per open working directory (`WorkspaceSearchIndex.ts`, keyed by a `LayerMap`
  with a 15-minute idle timeout), and all of them would want the same store.
- Today this does not break **only because no frecency path is passed** —
  `FileFinder.create` is called with `basePath` and scanning flags, and nothing
  else. Enabling frecency turns the current design into a bug.

### ⚠ REVISED 2026-08-25 — the premise was wrong

Report 20 spiked this and found that **the shared-ranking goal is not reachable
through today's C ABI**. The decision above stated the intent correctly; the
mechanism it assumed does not exist.

**`trackQuery()` does not write the frecency database.** It writes the *query
tracker*. Verified three independent ways:

1. **Behaviour** — `accessFrecencyScore` stayed at 0 in the same finder, after
   `reindex()`, after recreating the finder, and in a fresh process. The frecency
   file never grew past 8192 bytes.
2. **Source** — `fff_track_query` calls `track_query_completion`.
3. **Symbols** — `nm -D` on the shipped `libfff_c.so` exports **no
   `fff_track_access`**. The function exists in `fff-core` and is simply not
   exposed.

**What does propagate is narrower than "the ranking".** A query-to-file record
does cross processes, and it works well: worker B saw worker A's write on the
first read (`comboMatchBoost` 0 → 300, score 154 → 454), the value survived A's
death, and a worker forked afterwards still read it.

**But it is keyed by `blake3(project_path + "::" + query)`.** A worker on a
different root sees nothing. **Sharing the file is not sharing the ranking.** This
kills the cross-project learning the decision was made for.

The one frecency write path reachable from the C ABI needs `aiMode: true` plus the
watcher, and it fires on file *modification*, not on open. It does cross roots and
processes — proved, score 0 → 1 read by a second process on a different root — but
"the file changed" is not "the user opened it".

### What to do about it

**Recommended: patch `fff-c` to export `fff_track_access`.** The function already
exists upstream in `fff-core`. Mesura Code **already patches this package** for the
asar path fix, so the mechanism and the precedent are both in place.

**Fallback, if upstream will not take it:** keep our own access table beside the
`fff` store — an absolute path to open-count-and-timestamp map that we write on
open and blend into the score ourselves. Roughly the shape the Qt version thought
it already had.

**Until either lands, the honest position is:** the file manager and Mesura Code
share a *store*, not a *ranking*. Do not describe it as shared learning.

### Two documentation defects this uncovered

Each named frecency where the code writes the query tracker. **All are now
fixed**, along with a third copy in this dossier at
`04-fuzzy-finder-module.md` and the API-contract comment in
`21-search-surface-spec.md`:

- The frecency claim in `CLAUDE.md`.
- The comment at `plugin/src/Symmetria/FileManager/Models/fuzzyfinder.cpp:497`.

---

## D3 — One window with tabs

**Decided: a single window, not many short-lived windows. Tabs carry the
navigation.**

The user framed this as a philosophy, not only an optimisation: fewer things open
at once, and a tool that enforces that discipline. It mirrors the change Mesura
Code made relative to Symmetria IDE.

Consequences:

1. **The warm-window pool from report 10 collapses.** One resident window, hidden
   rather than destroyed, shown on demand. No pool, no state reset between uses,
   no `BrowserWindow` churn. This removes the largest source of complexity in that
   design.
2. **The memory objection dissolves.** The 48–235 MiB marginal cost per additional
   window is never paid. Resident cost stays near the single-window figure instead
   of scaling with how many directories are open.
3. **The tab machinery already exists** — `TabManager.qml` is a per-window
   instance today. The port promotes it from a per-window detail to the primary
   navigation model.

---

## D4 — Memory: accepted

**Decided: the roughly 3× resident-memory increase is accepted**, on the strength
of D3. The single-window model is expected to make the Electron build *more*
memory-disciplined in daily use than a Qt build that encourages many windows.

---

## D5 — Auto-expansion of the file tree is removed

**Decided: no auto-expansion at all. Not eager, not lazy.**

The user's reasoning: it is not a realistic way to see a folder structure, it is
slow to open on large repositories, and it feels lazy as a design.

This **supersedes** the optimisation history in
`symmetria-ide/docs/file-tree-mount-optimization.md`. That work took a large
repository from 3994 ms to 449 ms by replacing eager recursive expansion with
viewport-driven lazy expansion. **Removing expansion entirely is strictly faster
than both**, so the optimisation becomes history rather than a thing to port.

**Keep the lesson, discard the mechanism.** The measured finding was that the
dominant cost is *the number of expansion units*, not the cost of each. A React
port that virtualises rows but expands eagerly re-pays the full 4 seconds in a new
disguise. With expansion removed the risk disappears, but the reasoning applies to
any future feature that mounts many directories at once.

**Still wanted, by a different means:** a way to see the folder structure. The
user wants this, and rejects auto-expansion as the way to get it. Candidate
directions, none chosen:

- An explicit, on-demand "expand all under here" action with a visible progress
  and a bound.
- A `tree`-style flat overview rendered as a preview, not as a mounted tree.
- Breadcrumbs plus the Miller columns, which already show three levels at once.
- Fuzzy-finding by path, which answers "where is X" without expanding anything.

---

## D6 — Legacy `.xls`: deferred

**Decided: not part of the transition.** The user does want a spreadsheet preview
eventually — enough to see what tables a file contains — so the preview router
must stay open to adding a spreadsheet type later without rework.

---

## D7 — Theme: use Mesura Code's tokens

**Decided: take Mesura Code's own dark palette as it is.** Do not port the file
manager's `FmTheme` ladder, and do not follow Symmetria IDE's. Stay minimal, and
add claymorphism only where it earns its place.

This retires the "which grey ladder" question. The theme research in report 05
stays useful as a record of what the Qt version did, not as a target.

---

## D8 — Icons: use Mesura Code's set

**Decided: adopt Mesura Code's icons for the file manager.** The user prefers them
to the current set.

**Resolved in detail by report 16.** Three facts make this cheaper than expected:

1. **Both icon sources are public npm packages, unrelated to the fork.** A separate
   repository installs them directly: `@pierre/trees@1.0.0-beta.4` (Apache-2.0,
   58 file-type symbols, art from the MIT `@pierre/vscode-icons`) and
   `lucide-react@0.564.0` (ISC, 1917 icons) for chrome. Both tree-shake, so the
   file-type resolver imports without the tree renderer.
2. **The file-type mapping is already a pure, framework-free function** —
   `createFileTreeIconResolver`. It takes custom overrides, falls through 104
   filename tokens then 120 extension tokens, matches longest dot-suffix first (so
   `env.local` and `spec.ts` work), and **never fails** — an unknown extension gets
   `default`. Icons paint `currentColor`, so they inherit the theme.
3. **Do NOT copy Mesura Code's wrapper files.** `pierre-icons.ts`,
   `PierreEntryIcon.tsx`, `Icons.tsx` and `JetBrainsIcons.tsx` are all
   upstream-owned by `pingdotgg/t3code` and unmodified by the fork. Copying them
   creates silent drift rather than a visible merge conflict. Depend on the public
   package and write roughly 80 lines locally.

**Coverage gaps.** Pierre's set has no symbol for folder, video, audio, PDF,
symlink, executable or remote mount. Five of those come free from lucide; only the
PDF mark needs a decision. Git status is rendered as letters in both products, so
there is nothing to build there.

**This is not a new concept for the file manager** — `FileIcon.qml:22` already
reads `Config.fileManager.iconMode` with values `"material"` and `"system"`. The
curated path exists today as the fallback. D8 promotes it to the only mode.

### `IconThemeResolver` — reduced, not dropped

**Drop** `resolveForFile`, the `QMimeDatabase` name chain, the mimes and places
routing, and the `folder` case. That is the larger half of its 398 lines, and it
leaves the hot path of every directory scan.

**Keep** `resolveApp` plus its INI parser, `Inherits` walk, scalable-first sort,
explicit `hicolor` pass, pixmaps fallback and `.desktop` parse.

**"Open With" is the only remaining XDG need**, confirmed by checking every other
candidate: there is no mount sidebar, bookmarks are a hardcoded table, `user-trash`
has no caller, the application's own icon is a desktop-entry contract, and
thumbnails are decoded content. Mesura Code proves the point negatively — its 34
application icons are hand-drawn, which a file manager cannot do on behalf of
whatever the user has installed.

Serve the resolved path through `protocol.handle("app-icon", …)`. **Do not use
`app.getFileIcon`**, which rasterises and resolves the wrong thing.

---

## D9 — Documentation: rewrite, do not patch

**Decided.** The work is effectively a rewrite, so the stale documents get deleted
and written again against what exists. This settles the `tech-stack.md:63`
contradiction — that file records Electron as rejected — by removing it rather
than amending it.

---

## D10 — Search, grep and the command palette

**Direction set, specifics open.** The user wants three things and asked for the
comparison to be added to the decision set:

1. **Content search (grep).** The file manager has none today and the user wants
   it. `fff` provides content indexing; Mesura Code already exposes a content
   search through `WorkspaceSearchIndex` with a `variant: "content"` that enables
   `fff`'s content indexing, a 250 ms time budget and a 100-matches-per-file cap.
2. **Which file searcher wins** — the file manager's `fff` integration with the
   interface built around it, or Mesura Code's. Both sit on the *same engine*, so
   this is a question about the interface and the surrounding features, not about
   the matcher.
3. **A command palette.** The user likes Mesura Code's and wants the pattern in
   the file manager eventually.

**Resolved by report 17.** Three separate answers:

### File search — keep the file manager's interface, adopt six corrections

The file manager wins on the thing that matters most: **the File Info panel
renders a live `PreviewContent` of the highlighted result, and Mesura Code has no
equivalent in any search surface.** It also wins on git status in the finder,
directories in results, real frecency writes, `Ctrl+J`/`Ctrl+K`, coalesced
highlight runs, and a two-stage debounce.

Mesura Code wins the plumbing, and these six get adopted:

1. An index **keyed by working directory with an idle timeout**, instead of one
   process-wide engine whose base path is swapped — the current design is
   "last acquire wins" across windows.
2. A reported `matchedQuery`, so highlighting never runs against half-typed input.
3. A `truncated` flag — the finder currently shows "200 results" whether there are
   200 or 20,000.
4. An "indexing" state distinct from "searching".
5. One shared dialog chrome across modes.
6. Blocking Enter while a newer query is in flight.

Two gaps neither product has, and both are wanted: **directory drill-down inside
the popup**, and **scroll keys for the preview**.

**Confirms the spike:** Mesura Code passes no `frecencyDbPath` at all, so its
ranking never learns. Ours does.

### Content search — `ripgrep`, not `fff`

**This reverses the conclusion of spike 6.** See `18-spike-results.md` for the
correction and the reasoning. The short version: a content index costs 8.3× the
scan time and 28× the memory, and only pays back when one directory is searched
many times. A file manager opens arbitrary directories once. `ripgrep` also cannot
go stale, and a file manager is the tool that changes files.

**`fff` keeps path search and `glob`; `ripgrep` gets content search.**

Copy Mesura Code's *interface* regardless: the 250 ms budget, the
100-matches-per-file cap, grouping under sticky per-file headers, 100-row windowed
mounting, and treating query whitespace as significant. Keep the result type at
`{ path, lineNumber, lineContent, matchRanges }` so the backend stays swappable.

### Command palette — a third consumer of `KeyRegistry.js`

Do not build a parallel command list. The registry already carries `id`, `label`,
`icon`, `group`, `keycap`, `run()`, ordered groups, context-sensitive hiding, and
a test that fails incomplete rows. Mesura Code's palette is a 170-line imperative
block with none of that.

Three additions needed:

1. `searchTerms` — curated synonyms. This is what makes Mesura Code's palette feel
   smart, and it is the only real gap.
2. A separate `enabled(ctx)` for display gating. **Leave `when()` alone** — its
   fall-through semantics are load-bearing for the dispatch cascade.
3. A `ctx` that can be built outside a view's key handler.

Copy from Mesura Code: the one-overlay/three-modes reducer, the `>` actions-only
prefix, the rank formula, live shortcut labels, and `keepOpen`.

### The shared package — engine access yes, search UI no

`packages/file-search` can own index creation and lifetime, readiness, the search
calls, entry mapping, match-index computation, byte-to-string offset conversion,
and — the piece D2 needs and neither repository implements — **one owner of the
frecency-store path**. Roughly 400 lines, one dependency.

It cannot own the UI. The two products disagree on what a result *is*, and Mesura
Code's picker is welded to its own state, router, component library and tokens.

**Provenance finding that settles where it lives:** every search surface in Mesura
Code is **byte-identical to `upstream/main`** — the picker, the content-search
dialog, `WorkspaceSearchIndex.ts`, even the fff asar patch. Only `CommandPalette.tsx`
and the two keybinding files carry fork deltas.

So **the shared package must be published from the file-manager repository.**
Putting it in Mesura Code would bind the daily-driver tool to upstream's cadence —
exactly the coupling D1 exists to prevent.

---

## D11 — The image pipeline

**Settled by report 19, and it overturns the mitigation this project had already
adopted.**

**`sharp` 0.35.3 wins the library comparison**, measured on a 13-image set:

| Metric | `sharp` | `@napi-rs/image` 1.14.0 |
|---|---:|---:|
| Serial median per image | **22.6 ms** | 31.9 ms |
| Throughput at concurrency 4 | **130.6/s** | 92.0/s |
| Large PNG (4928×3279) → 256 px | **393.9 ms** | 613.1 ms |
| Peak RSS over 3000 operations | **345 MB, flat** | **4227 MB, still climbing** |
| Cold `require()` | 47.5 ms | **5.1 ms** |

This **reverses report 14 §4**, which recorded `@napi-rs/image` as faster on a
large PNG. It is not.

`@napi-rs/image`'s memory growth is reclaimable but invisible to V8 — `external`
reported 9–42 MB while RSS was at 3 GB. Pinning it needs `global.gc()` every 20
operations, which is a maintenance burden, not a configuration.

### 🚨 `sharp` segfaults inside a `utilityProcess`

**The isolation mitigation this project adopted does not run.** `sharp` crashes on
its **first decode** inside an Electron `utilityProcess`, deterministically, across
four separate harnesses. `/proc/<pid>/status` shows `CoreDumping: 1`, and the
parent's `exit` event fires with code 139 roughly **57 seconds later**.

`UV_THREADPOOL_SIZE` at 1 and 16, `VIPS_CONCURRENCY=1` and `sharp.concurrency(1)`
all fail identically. The same crash appears in an `ELECTRON_RUN_AS_NODE` fork.
There is **no** crash in the main process, and **no** crash in `worker_threads`.

This is the same failure family as the GLib bug in report 14 — which did not
reproduce in the main process across 8000 decodes (report 18 §2) but reproduces
instantly one process boundary away.

### The decision

**`sharp` 0.35.3 in a `worker_threads` Worker.** Not a `utilityProcess`, not the
main process.

| Setting | Value |
|---|---|
| `UV_THREADPOOL_SIZE` | **16** (hardware threads; 32 gains nothing) |
| Decodes in flight | **8** — 173/s at p50 42 ms, against 195/s at p50 77 ms for 16 |
| `sharp.concurrency()` | leave at 1 |

Isolation overhead in `worker_threads` is **+0.48 ms per image (+1.9 %)** with a
73.5 ms startup, and a 1500-decode soak passed clean.

**Two rules that follow from the measurements:**

1. **Every request needs its own timeout.** A `sharp` crash does not produce a
   timely `exit` — 57 seconds is not a failure signal a user will wait for.
2. **Send compressed bytes across the boundary, never raw pixels.** Transfer lists
   are **not zero-copy** in Electron: transfer and clone cost identically at every
   size, about 400 MB/s, and a 256 MB payload takes 607 ms either way. The
   parent-to-child transfer list rejects `ArrayBuffer` outright. The empty round
   trip is only 0.053 ms, so the entire cost is payload copying.

**Fallbacks, in order:** `@napi-rs/image` in a `utilityProcess` (82.4/s across four
workers, but no GIF, no HEIC, and mandatory garbage-collection pacing), then a
`magick` subprocess.

**Accepted limitation:** true crash isolation is not purchasable today. It needs
upstream to statically link libvips, which carries the licensing problem report 14
recorded.

### Format gaps confirmed and discovered

Both report 14 claims held: `@napi-rs/image` fails HEIC and **cannot decode GIF at
all**, animated or still. Two gaps are new:

- `@napi-rs/image` cannot decode SVG through its normal constructor; it needs
  `Transformer.fromSvg`.
- **`sharp` cannot decode BMP or ICO.** Neither library decodes JXL or ICNS.

`sharp` wins WebP, AVIF, TIFF, SVG and GIF including animation. `@napi-rs/image`
wins BMP and ICO. Since Chromium decodes BMP and ICO natively (report 14 §1),
`sharp`'s gap costs nothing in practice.

---

## D12 — Start-up decisions, 2026-08-25

Taken to unblock the first commit.

### Repository layout

**The Electron code lives in THIS repository, in new directories beside the Qt
tree.** The Qt tree stays intact until the rewrite reaches parity, then it is
removed in one commit.

Reasoning: history is preserved, no new remote or CI to provision, and — the
operative reason — the working Qt version stays available to compare behaviour
against while the rewrite is built.

### Language and runtime style

**Plain TypeScript. Not Effect-TS.**

The decisive argument is that **interoperability is asymmetric**. A package that
returns promises is consumed from Effect in one line (`Effect.tryPromise`). A
package that returns `Effect` **imposes Effect on every consumer**. D1 exists so
the file manager stays an independent tool; exposing Effect at the package
boundary would re-couple it to Mesura Code — and to `effect@4.0.0-beta.103`, a
beta, at that.

The strongest argument Effect had here — guaranteed resource release, which Mesura
Code uses via `Effect.acquireRelease` — is **now covered by the language**:
`using` and `await using` with `Symbol.dispose` / `Symbol.asyncDispose`.

**Borrow the discipline without the library:**

- Typed errors as discriminated unions in the return type, not thrown exceptions.
- `await using` for everything with a `destroy()` — the `fff` finder, watchers,
  worker handles.
- A pure core: the keybinding registry, the preview classifier and the sort and
  filter rules take data and return data.

**When to revisit:** if the file manager ever grows twenty interdependent services
with tangled lifetimes, the way Mesura Code has. It does not have them today.

### Renderer security posture

**The renderer is sandboxed, with no `fs` access**, mirroring Mesura Code
(`sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`). Not
negotiable: if the standalone does not respect the same boundary, the UI package
cannot be shared and we end up with two implementations.

### Scope of v1

**Navigation and previews, plus file operations.** Both, together.

The user's reasoning: without copy, move, rename, trash and open, they would still
open the Qt version for any real change, so the rewrite would not displace it.

**In v1:** Miller columns, tabs, the full keyboard registry, the preview router
with the types opened often (text, code, images, PDF), and the twelve file
operations.

**Not in v1:** the fuzzy finder, content search, the command palette, the file
tree with git status. Those follow once the tool is in daily use.

---

## What remains genuinely open

Updated 2026-08-25 after the first round of spikes and research.

| # | Question | Status |
|---|---|---|
| 1 | Which image library the pipeline uses | **SETTLED — see D11.** `sharp` in a `worker_threads` Worker. The `utilityProcess` mitigation was measured and it segfaults. |
| 2 | `fff` frecency store ownership | **SETTLED, and the premise was revised — see D2.** Store sharing works; *ranking* sharing does not, because `trackQuery` writes the query tracker, not frecency. Needs an upstream patch or our own access table. File manager runs **one worker with a swapped root**. |
| 3 | How the packages are published to Mesura Code | Mechanics. Decide at implementation. Report 17 fixed the *direction*: publish **from** the file-manager repository. |
| 4 | Which search and palette interface wins | **SETTLED — report 17, specified in report 21.** Seven low-risk sub-points are marked OPEN in that spec, each with a recommendation, awaiting the user. |
| 5 | How to show folder structure without auto-expansion | **DEFERRED by the user, 2026-08-25.** Not blocking. Revisit after the standalone works. |
