# Spike results — measured, 2026-08-24

Every number below was produced on this machine tonight, not cited. Scripts live
in `/tmp/fm-spikes/` and are reproducible. Nothing appeared on the user's screen:
the windowed run used `xvfb-run` on a virtual display, and the native-Wayland run
created no `BrowserWindow` at all.

Environment: Electron **41.5.0** (Chromium 146.0.7680.216, Node 24.15.0),
`sharp` **0.35.3** with libvips **8.18.3**, `@ff-labs/fff-node` **0.9.4**,
system libheif 1.23.1, ImageMagick 7.

---

## Spike 1 — `fff` frecency store sharing · **DECISION D2 SETTLED**

**Question:** can several `fff` indices share one frecency store, so that opening
a file anywhere teaches one ranking?

**Answer: yes across processes, no within a process.**

| Test | Result |
|---|---|
| Two indices, **same store, one process** | **FAILS** |
| Same root opened twice, same store, one process | **FAILS** |
| Per-root stores, one process | WORKS |
| No frecency at all (Mesura Code today) | WORKS |
| `destroy()` then reopen, same process | **WORKS** — sequential ownership is fine |
| **Two separate processes, same store, concurrently** | **WORKS** |

The failure is exact and unambiguous:

```
Failed to init frecency db: Failed to open frecency database env:
environment already open in this program; close it to be able to
open it again with different options
```

Note the wording — *"in this program"*. LMDB guards the **process**, not the file.
The cross-process test confirmed it: a child process opened the same store, wrote
to it with `trackQuery`, and exited while the parent still held it. The parent's
`healthCheck()` then reported the frecency database initialised and healthy.

### What this means for the design

**The user's wish is achievable.** The standalone file manager and Mesura Code are
separate processes, so they can share one store at
`~/.local/share/symmetria/fff/` and both feed the same ranking. That was the whole
point of D2, and it works.

**The real constraint is narrower than recorded:** Mesura Code holds N indices in
**one** process — `WorkspaceSearchIndex.ts` keys a `LayerMap` by working directory
with a 15-minute idle timeout. The moment frecency is enabled, the second project
fails to open. That is a live latent bug, not a hypothetical.

**The clean fix follows from the measurement:** move each workspace index into its
**own process** — a `utilityProcess` per index. Cross-process sharing works, so N
indices in N processes all share one store with no conflict. This also buys crash
isolation, which report 09 wanted anyway.

**Fallback if that is too invasive:** give the store to exactly one index per
process and let the others run without frecency. Because frecency is keyed by
absolute path, a search rooted inside a project scores only paths under that
project, so the loss is confined to searches whose scope crosses projects.

### Bonus — the real API surface

`FileFinder` exposes more than the C++ plugin uses. Confirmed by reflection:

```
destroy, directorySearch, ensureAlive, fileSearch, getBasePath,
getHistoricalQuery, getScanProgress, glob, grep, healthCheck,
isDestroyed, isScanning, mixedSearch, multiGrep, refreshGitStatus,
reindex, scanFiles, trackQuery, waitForIndexReady, waitForScan,
waitForScanBlocking
```

Three of these matter and the Qt plugin uses none of them: **`grep`**,
**`multiGrep`** and **`glob`**. The content search the user asked for is already
in the engine we already link.

`InitOptions` also confirms `frecencyDbPath` and `historyDbPath` are optional
separate paths, and that **`useUnsafeNoLock` is now a deprecated no-op** — the
package documents that the no-lock LMDB flags "showed no measurable win under
realistic contention". Do not reach for it.

---

## Spike 2 — `sharp` under Electron on Linux · **the crash did NOT reproduce**

**Question:** does the open GLib symbol-leak bug (report 14 §3) actually break
`sharp` in this Electron version, on this machine?

**Answer: no, across 8000 decodes in three configurations.**

| Run | Platform | Window | Threadpool | Decodes | Failures | Rate |
|---|---|---|---|---|---|---|
| A | X11 (Xvfb) | none | 4 (default) | 2400 | **0** | 141.8/s |
| B | **native Wayland** | none | 16 | 3200 | **0** | 179.3/s |
| C | X11 (Xvfb) | **real `BrowserWindow`** | 16 | 2400 | **0** | 178.8/s |

Run C is the honest reproduction, and it confirms the precondition was present.
Reading `/proc/self/maps` showed the GLib stack **already loaded before any window
was created**:

```
libglib-2.0.so.0.8800.3, libgobject-2.0.so.0.8800.3,
libgio-2.0.so.0.8800.3, libgtk-3.so.0.2420.32
```

So the symbols the bug report blames were in the process the whole time, a real
GTK window was created and driven, decodes ran on 16 libuv threads concurrently
with renderer work, and nothing asserted, trapped or segfaulted.

**The documented warning does fire**, exactly as report 14 said:

```
[SharpElectronLinux] Warning: Binaries provided by Electron for use on Linux
may be incompatible with sharp
```

### How to read this result, honestly

This **weakens** report 14's blocker but does not erase it. The upstream issue is
open, the failure is described as *intermittent*, and 8000 decodes in one sitting
is not proof of absence. What it does establish:

- The bug is **not deterministic** on Electron 41.5.0 with `sharp` 0.35.3 on this
  hardware and this GLib version.
- `sharp` is **not disqualified**. It moves from "blocked" to "usable with a
  known risk and a fallback ready".
- Throughput is ample: ~180 thumbnails/second at 256 px.

**Recommendation revised:** keep `sharp` as the resize and thumbnail engine, but
(a) run image work in a **`utilityProcess`**, so that if the bug ever does fire it
kills a worker rather than the application, and (b) keep `@napi-rs/image` as a
documented drop-in escape hatch. The `utilityProcess` isolation is worth having
regardless of this bug, which makes it a cheap insurance premium rather than a
concession.

---

## Spike 3 — HEIC · **report 14 confirmed, and the shell-out is faster than estimated**

`sharp` cannot decode HEIC. Two different files, two different errors, both fatal:

| File | Error |
|---|---|
| A freshly encoded, minimal 800×600 HEIC | `bad seek to 2666` |
| A real 12 MP iPhone photo (`IMG_5046.HEIC`, 3.0 MB, 4032×3024) | `Security limit exceeded: Number of references in iref box (48) exceeds the security limits of 16 references` |

The first is exactly the failure mode report 14 recorded. The second is a
different libheif guard tripping first — which incidentally shows libheif *is*
linked and *is* parsing, it simply has no HEVC decoder behind it.

**The recommended shell-out is faster than report 14 estimated.** Measured on the
12 MP photo, steady state after the first run:

| Command | Time |
|---|---|
| `magick <heic> -resize 512x512 out.png` | **0.37–0.39 s** |
| `heif-convert -q 80 <heic> out.jpg` | **0.23–0.28 s** |
| `magick <jpeg> -resize 512x512 out.png` (baseline) | 0.08–0.10 s |

Report 14 quoted 0.61–0.72 s for the `magick` path. The real figure is roughly
half that, and `heif-convert` is faster still. **The shell-out design gets
stronger**, not weaker: it beats the WASM decoders by a wide margin, and it covers
RAW, TIFF, JXL and JP2 in the same subprocess.

---

## Spike 6 — `fff` grep versus ripgrep · **content search is a solved problem**

**Question:** the user wants content search, which the Qt file manager never had.
Build it on `fff`'s indexed `grep`, or shell out to `ripgrep`?

**Answer: `fff`, decisively.** It is faster in almost every case, the index is
cheap to build, and its results carry information ripgrep cannot produce.

### Large repository — `mesura-code`, 4.1 GB, 16,159 indexed files

| Query | ripgrep | `fff` cold | `fff` warm | Speed-up |
|---|---|---|---|---|
| `FileFinder` | 11.2 ms | 12.2 ms | **4.3 ms** | 0.9× → 2.6× |
| `useEffect` | 12.0 ms | 9.1 ms | **8.8 ms** | 1.3× |
| `BrowserWindow` | 10.7 ms | 6.7 ms | **6.4 ms** | 1.6× |
| `frecency` | 11.5 ms | 6.4 ms | **3.4 ms** | 1.8× → 3.4× |
| *(no match)* | 11.2 ms | 4.4 ms | **2.8 ms** | 2.5× → 4.0× |

**Up-front cost: 152 ms total** — `create()` 6.7 ms, `waitForScan()` 50.2 ms,
`waitForIndexReady()` 101.6 ms. That is the whole price of the content index on a
four-gigabyte tree, paid once.

On the small `symmetria-file-manager` tree (467 files) the scan is 49.7 ms and the
index is ready in 0.7 ms. **Misses are where the index wins hardest** — a query
with no results answers in 0.3 ms against ripgrep's 10 ms, because the index knows
immediately instead of walking the tree.

### What a `fff` grep hit carries that ripgrep cannot

```json
{
  "relativePath": "...", "fileName": "...", "lineNumber": 569, "col": 46,
  "byteOffset": 20311, "lineContent": "...", "matchRanges": [[46, 56]],
  "gitStatus": "clean", "isBinary": false, "isDefinition": true,
  "totalFrecencyScore": 0, "accessFrecencyScore": 0, "modificationFrecencyScore": 0
}
```

Three fields change what the interface can do:

- **`matchRanges`** — character offsets, so highlighting is exact and needs no
  re-matching in JavaScript.
- **`gitStatus`** per hit, for free, from the same engine.
- **`isDefinition`** — the engine distinguishes a definition from a reference.
  That turns "search" into "go to definition" without a language server.

`glob("**/*.ts")` answered in **2.2 ms** on the same 16,159-file index, which
makes filtered browsing essentially free.

### ⚠ Recommendation REVERSED by report 17 — use `ripgrep`

This spike originally concluded "build content search on `fff.grep`". **That
conclusion was wrong for a file manager**, and report 17 measured the case this
spike did not.

The error was the choice of test subject. Both repositories measured here are
**project trees that get searched repeatedly** — exactly the workload an index is
built for. A file manager opens **arbitrary directories once**, so the index cost
is paid every time and amortised never.

Report 17 measured that case:

| Tree | `fff` content index | `ripgrep` |
|---|---|---|
| `mesura-code`, 16,160 files | 212 ms build, 21 ms grep, **124 MB RSS** | 24 ms, **10 MB** |
| `/usr/include`, 44,282 files / 585 MB | **916 ms build, 280 MB RSS** | **53 ms, 10 MB** |

Content indexing cost **8.3× the path-only scan time and 28× the memory**. My
152 ms figure above was the index on a *project*; on a real system directory it is
nearly a second and a quarter-gigabyte of resident memory, per directory opened.

Three further arguments this spike missed:

1. **`ripgrep` cannot go stale.** The file manager passes `watch: false`, so its
   index is stale the moment anything moves — and a file manager is precisely the
   tool that moves things.
2. **`ripgrep` already has** globs, type filters, context lines, and `--json` with
   the same byte-offset match shape `fff` returns.
3. The index only pays back when **one** directory is searched **many** times.
   That is Mesura Code's workload, not this one.

**What survives from this spike:** the query-latency numbers are real, and
`fff.glob` at 2.2 ms remains excellent for *path* filtering. The `isDefinition`
and per-hit `gitStatus` fields remain genuinely unique to `fff` — worth revisiting
if the file manager ever gains a persistent project mode. **`fff` keeps the path
search; `ripgrep` gets the content search.**

**Method note worth keeping:** measuring the right *workload* mattered more than
measuring carefully. Both sets of numbers are correct; only one answers the
question.

---

## Spike 7 — directory listing in Node · **no native module needed**

**Question:** report 09 estimated Node's directory-listing throughput but did not
measure it. A file manager does this constantly, so the estimate had to be
replaced.

**Answer: plain `node:fs/promises` is fast enough. Nothing native is required.**

| Directory | Entries | `readdir` names | `withFileTypes` | **+ `lstat` all, parallel** | + `lstat` serial |
|---|---:|---:|---:|---:|---:|
| `/usr/lib` | 5938 | 3.0 ms | 4.8 ms | **53.5 ms** | 94.4 ms |
| `node_modules/.pnpm` | 1785 | 1.9 ms | 4.2 ms | **17.9 ms** | 33.4 ms |
| `~/Downloads` | 947 | 0.6 ms | 1.1 ms | **7.3 ms** | 14.4 ms |
| KDE syntax definitions | 459 | 0.2 ms | 0.3 ms | **3.6 ms** | 6.9 ms |

Three conclusions.

**1. The listing itself is free.** `readdir` with `withFileTypes` costs under 5 ms
even on a six-thousand-entry directory, and it already carries the
file-versus-directory distinction. That covers the first paint of a pane.

**2. `stat` dominates, and parallelism halves it.** Size, modification time and
permissions need a `lstat` per entry, and that is where the time goes — 53.5 ms
for `/usr/lib`. Running them concurrently is consistently about **1.8× faster**
than a serial loop. Never write the serial loop.

**3. The design follows.** Paint rows from `withFileTypes` immediately, then fill
size and modification time as the `lstat` results arrive. A directory of 6000
entries reaches first paint in about 5 ms and is fully decorated in about 60 ms —
and the user only ever sees a screenful, so the visible rows can be stat'd first.

This retires the "fast directory listing" line from report 09's native-module
budget. The only new native module remains `@parcel/watcher`.

**Caveat:** measured on a warm page cache, on this NVMe machine. A cold cache or a
network mount will be far slower, which is an argument for the progressive fill
above rather than against Node.

---

## Spike 4 — window spawn budget · **deprioritised by decision D3**

Not run. Decision D3 replaced many short-lived windows with **one window and
tabs**, which removes the warm-pool design this spike was meant to validate. The
remaining question is much easier — how fast a hidden resident window shows — and
it needs the real application to mean anything.

**Deferred to first implementation**, with the four-timestamp harness from report
10 kept as the measurement method.

---

## Spike 5 — fractional-scale blur · **needs the user**

Not run. It requires capturing two already-running windows on the user's session
and comparing them at 1:1. The user is asleep and the windows are not in a known
state.

**Hand-off, one command, no code:**

```bash
grim -o <output> /tmp/blur-check.png     # with a Mesura Code window focused
```

Then compare a text region against the same region in the Qt file manager. If
Electron's text is visibly softer, Chromium is scaling by an integer factor and
letting the compositor downscale.

---

## Corrections this session made to earlier reports

| Report | Claim | Correction |
|---|---|---|
| 14 §3 | `sharp` is **blocked** by an Electron GLib crash | Did not reproduce in 8000 decodes across three configurations. Downgraded from blocker to known risk, mitigated by `utilityProcess`. |
| 14 §5 | `magick` HEIC thumbnail costs 0.61–0.72 s | Measured 0.37–0.39 s; `heif-convert` 0.23–0.28 s. |
| 04 | LMDB "blocks a second open per process, not across processes" | **Confirmed exactly**, with the verbatim error and a working cross-process test. |
| 04 | The `fff` C ABI surface used is 8 of ~80 functions | The Node binding exposes `grep`, `multiGrep` and `glob`, which the Qt plugin never used. Content search is already available. |

## A trap worth recording

`ELECTRON_RUN_AS_NODE=1` is set in this environment. With it set, the Electron
binary runs as plain Node: `require("electron")` fails with `MODULE_NOT_FOUND` and
Chromium flags are rejected as `bad option`. Any script that drives Electron
directly must clear it. Mesura Code sets it deliberately when it spawns its own
server as a child process, so this will keep coming up.
