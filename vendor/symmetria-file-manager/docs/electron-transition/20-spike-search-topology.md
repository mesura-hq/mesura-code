# Spike 20 — search process topology, measured

**Question.** Report 18 §1 settled that `fff` indices can share one frecency store
across processes but not inside one process. It then *proposed* a topology: one
index per Electron `utilityProcess`, all sharing one store on disk. This spike
measures whether that proposal works, what it costs, and how it recovers.

**Answer in one line.** The topology works at every size tested, propagates its
learning immediately, loses no writes under contention, survives a `SIGKILL`, and
costs about 25 MB and 180 ms per worker — **but the shared store teaches far less
than report 18 assumed, because the C ABI has no frecency-write function at all.**

---

## Method and environment

Every number below was produced on this machine, in this session. Nothing appeared
on the user's screen: the harness creates **no `BrowserWindow`**, and no service was
restarted.

- Host: AMD Ryzen AI 7 350, 16 threads, 30 GB RAM, Linux 7.2.0-rc1-1-mainline,
  `/home` on btrfs over NVMe. Page cache warm.
- Electron **41.5.0** (Node 24.15.0), launched with `env -u ELECTRON_RUN_AS_NODE`.
- `@ff-labs/fff-node` **0.9.4**, native library
  `@ff-labs/fff-bin-linux-x64-gnu@0.9.4/libfff_c.so`.
- Rust source read for semantics: the vendored submodule at
  `plugin/third_party/fff`, commit `8092cfa3`, release **0.9.3**.
- Scratch stores under `/tmp/fm-spikes/topology/db-*`. `~/.local/share/symmetria/fff/`
  was never opened.

**Harness** (reusable, in `/tmp/fm-spikes/topology/`):

| File | Role |
|---|---|
| `main.mjs` | Electron main process. Forks workers, runs one named test, prints the numbers. |
| `worker.mjs` | The `utilityProcess` worker. Owns exactly one `FileFinder`. Request/response over `parentPort`. |
| `diag.mjs` | Isolates *when* a `trackQuery` write becomes visible. |
| `diag-ai.mjs`, `diag-ai-read.mjs` | Prove the one frecency-write path the C ABI can reach. |

Run any test with:

```bash
env -u ELECTRON_RUN_AS_NODE \
  /home/jc/projects/mesura-code/node_modules/.pnpm/electron@41.5.0/node_modules/electron/dist/electron \
  /tmp/fm-spikes/topology/main.mjs <topology|propagate2|contention|cost|membudget|freshcost|crash|oneworker>
```

---

## 1 — Does the topology work? **Yes, at N = 2, 4 and 8.**

Each worker created one `FileFinder` over a **different** project root, and every
worker passed the **same** `frecencyDbPath` and `historyDbPath`. Proof is
`healthCheck()`, not the absence of an error: the check reports
`frecency.initialized` and `queryTracker.initialized` separately, and a failed LMDB
open shows up there as `initialized: false` with an `error` string.

| N | Workers booted | `FileFinder.create` OK | `frecency.initialized` | `queryTracker.initialized` |
|---|---|---|---|---|
| 2 | 2/2 in 191 ms | 2/2 | 2/2 | 2/2 |
| 4 | 4/4 in 191 ms | 4/4 | 4/4 | 4/4 |
| 8 | 8/8 in 257 ms | 8/8 | 8/8 | 8/8 |

`create()` cost 14–19 ms in every case, with no upward trend as N grew. Every
worker reported `frecency.dbHealthcheck.diskSize = 8192` — the same environment,
opened eight times from eight processes, with no `environment already open in this
program`.

**This is the fix for Mesura Code's latent bug.** N indices in N processes is a
working configuration; N indices in one process is not.

---

## 2 — Does the learning propagate? **Yes — but not the learning that was assumed.**

### 2.1 The finding that changes D2

`trackQuery()` **does not write the frecency database.** It writes the *query
tracker* only. Three independent confirmations:

1. **Behaviour.** `diag.mjs` wrote `trackQuery("cmakelists", <abs path>)` five
   times, then searched. `accessFrecencyScore` stayed `0` — in the same finder,
   after a `reindex()`, after `destroy()` + recreate in the same process, and in a
   fresh process. The frecency database stayed at its empty size of 8192 bytes.
   The history database, by contrast, returned the query string from
   `getHistoricalQuery(0)` in all four positions.
2. **Source.** `crates/fff-c/src/lib.rs` `fff_track_query` calls
   `tracker.track_query_completion(...)` on the query tracker and touches nothing
   else. The frecency writer is `Frecency::track_access`, in
   `crates/fff-core/src/dbs/frecency.rs`.
3. **Symbol table.** `nm -D` on the shipped `libfff_c.so` lists 78 exported
   `fff_*` functions. `fff_track_access` is **not** among them. `track_access` is
   reachable only from the Neovim binding (`crates/fff-nvim/src/lib.rs`) and from
   the background watcher.

So the sentence in `CLAUDE.md` — "`recordOpen(index, query)` → `fff_track_query`
with the **absolute** path teaches frecency on file open" — and the matching
comment at `plugin/src/Symmetria/FileManager/Models/fuzzyfinder.cpp:497`
("`fff_track_query` keys frecency on the absolute opened path") are **both wrong**.
They describe the query tracker. Correct them.

### 2.2 What the shared store *does* propagate — measured

The query tracker keeps one record per `(project_path, query)` pair, holding the
selected file and an `open_count` (`crates/fff-core/src/dbs/query_tracker.rs`,
`create_query_key` hashes `project_path` + `"::"` + `query`). A search whose query
string matches that record adds `comboMatchBoost = open_count × comboBoostMultiplier`
to the score (`crates/fff-core/src/score.rs`, around line 684).

Test `propagate2`: workers A and B held **separate indices over the same root**,
sharing one store. Worker D held a **different root** over the same store.

| Observation | Result |
|---|---|
| B before A wrote | `comboMatchBoost = 0`, total score 154, `getHistoricalQuery(0) = null` |
| B after A wrote ×3, **A still alive** | `comboMatchBoost = 300`, total score **454**, `getHistoricalQuery(0) = "cmakelists"` |
| First sample that saw it | the **first** read, at +0 ms after the three writes returned |
| B at +25, +125, +625, +2625 ms | identical — the value is stable, not eventual |
| B after **A was killed** | new query written by A before its death is readable: `getHistoricalQuery(0) = "after-death-54358"` |
| **C**, a worker forked *after* A died | `comboMatchBoost = 300`, `getHistoricalQuery(0) = "after-death-54358"` |
| **D**, different root, same store | `comboMatchBoost = 0`, `getHistoricalQuery(0) = null` |

Two conclusions, and the second one is a constraint nobody recorded:

- **Propagation is immediate and durable.** The next read transaction after the
  write sees the new value. The bound I proved is one IPC round trip, about 2 ms;
  I did not measure below that, and LMDB's single-writer plus MVCC semantics mean
  there is no window to measure.
- **The query tracker is scoped to the index root.** D shares the store yet sees
  nothing, because its `project_path` differs and therefore its key differs. So
  the file manager and Mesura Code share query-completion learning **only for
  directories they open under the identical absolute root path**. Sharing one file
  on disk is not sharing one ranking.

### 2.3 The one frecency-write path that does exist

`crates/fff-core/src/background_watcher.rs` line 627 calls `frecency.track_access`
for created and modified files, but only when `mode.is_ai()`, and only when the
watcher runs. `diag-ai.mjs` proves it end to end:

| Step | `accessFrecencyScore` | frecency db on disk |
|---|---|---|
| Fresh index, `aiMode: true`, `disableWatch: false` | 0 | 8192 bytes |
| After 5 writes to the file, +3 s | **1** | **12288 bytes** |
| After `reindex()` | 1 | 12288 bytes |

`diag-ai-read.mjs` then opened the **same store from a second process with a
different root** — the parent directory of the tree the writer indexed — and read
`{"rel":"aitree/file3.txt","a":1,"t":1}`. So the frecency table **is** keyed by
absolute path and **does** cross index boundaries and processes. It is the right
mechanism for "one ranking". Nothing in the current C ABI can write to it on a
file *open*; only the AI-mode watcher writes it, and only on a file *modification*.

`modificationFrecencyScore` needs no database. `Frecency::get_modification_score`
returns 0 unless the file's git status is modified — confirmed in the crash test,
where a git-modified `CLAUDE.md` scored `{"total":2,"access":0,"mod":2}`.

---

## 3 — Write contention. **Zero errors, zero lost writes.**

Test `contention`: 8 `utilityProcess` workers, 8 different roots, **one** shared
store, all calling `trackQuery()` in a tight loop at the same time for 10 s.

Each worker wrote 20 `(query, path)` pairs, the query being the file's basename and
unique inside that root. That makes each pair exactly one LMDB record whose
`open_count` equals the number of successful writes, so loss is countable rather
than estimated: read back `comboMatchBoost / comboBoostMultiplier` with
`minComboCount: 1`.

| Worker | Writes | Errors | `trackQuery` median | p99 | Read back |
|---|---:|---:|---:|---:|---|
| c0 | 37 076 | 0 | 272.1 µs | 980 µs | 37 076 |
| c1 | 37 634 | 0 | 267.8 µs | 952 µs | 37 634 |
| c2 | 36 881 | 0 | 267.1 µs | 998 µs | 36 881 |
| c3 | 36 898 | 0 | 272.5 µs | 954 µs | 36 898 |
| c4 | 37 703 | 0 | 264.1 µs | 865 µs | 37 703 |
| c5 | 36 609 | 0 | 268.8 µs | 952 µs | 36 609 |
| c6 | 37 034 | 0 | 266.4 µs | 854 µs | 37 034 |
| c7 | 37 049 | 0 | 271.7 µs | 937 µs | 37 049 |
| **total** | **296 884** | **0** | — | — | **296 884 (100.00 %)** |

- Aggregate rate: **29 656 writes/s** over 10.011 s wall time.
- No worker's LMDB environment failed, locked out, or reported an error.
- The store held 0.26 MB after the run (history 249 856 bytes, frecency 8192 bytes
  — untouched, as §2.1 predicts).
- **Fresh process afterwards:** a new worker opened the store,
  `frecency.initialized=true`, `queryTracker.initialized=true`, and read 20/20 of
  c0's records, for example `CLAUDE.md` with `openCount = 1854`.

**A measurement trap worth recording.** The first run of this test reported
"76.77 % readable". That was the harness, not the store. `fff` honours
`.gitignore`, so 37 of the 160 chosen files (`__pycache__/*.pyc`, android
keystores, generated `bench/results-*.json`) were written to the tracker but were
never in any index, so no search could return them — they came back with
`totalMatched: 0`. The final run filters candidates through a `verifyPairs` step
that keeps only files the index actually contains, and the loss then measures
exactly zero. Do not report a lost-write rate without proving the readback path
can see the record.

---

## 4 — Cost.

### 4.1 Startup, from `utilityProcess.fork` to a usable index

Test `cost`, four workers forked in sequence:

| Root | fork→boot | of which `import` | `FileFinder.create` | fork→ready | scan + index |
|---|---:|---:|---:|---:|---:|
| symmetria-file-manager | 179 ms | 20 ms | 17 ms | **196 ms** | 54 ms |
| symmetria-ide | 171 ms | 17 ms | 14 ms | 185 ms | 53 ms |
| hypr-sessions | 157 ms | 13 ms | 12 ms | 169 ms | 53 ms |
| orchestrator.nvim | 165 ms | 14 ms | 13 ms | 179 ms | 53 ms |

- `fork→boot` is process spawn plus the `@ff-labs/fff-node` import, measured with
  `Date.now()` in the parent before `fork()` and in the worker at module top.
- **Process spawn dominates**: about 150 ms of the 180 ms is Electron creating the
  utility process, before any `fff` code runs. `create()` itself is 12–17 ms.
- A worker is therefore **ready to answer in under 200 ms**, and ready to *search*
  in about 250 ms on a project tree.

### 4.2 Per-root index cost, fresh worker each time (test `freshcost`)

| Root | Indexed files | fork→indexed | scan | PSS | RSS |
|---|---:|---:|---:|---:|---:|
| `/usr/share/applications` | 95 | 71 ms | 52 ms | 47.8 MB | 103.8 MB |
| `symmetria-file-manager` | 467 | 66 ms | 52 ms | 48.9 MB | 105.2 MB |
| `symmetria-ide` | 331 | 66 ms | 51 ms | 48.8 MB | 105.4 MB |
| `/usr/include` | 44 282 | 121 ms | 103 ms | 53.5 MB | 111.8 MB |
| `mesura-code` | 16 159 | 169 ms | 154 ms | 52.1 MB | 108.5 MB |
| `~/Downloads` | 237 079 | 1 132 ms | 1 114 ms | 93.4 MB | 152.0 MB |

The index is cheap up to tens of thousands of files. A quarter-million files costs
1.1 s and about 45 MB above the floor.

### 4.3 Memory budget — the marginal worker, not the first one

PSS divides shared pages by the number of sharers, so a lone worker looks dearer
than one of eight. Test `membudget` adds one indexed worker at a time and sums PSS
across all live workers:

| N | Workers total PSS | Marginal cost of the Nth | Total RSS | Main-process PSS |
|---:|---:|---:|---:|---:|
| 1 | 36.7 MB | +36.7 MB | 104.9 MB | 52.5 MB |
| 2 | 66.2 MB | +29.5 MB | 210.8 MB | 51.3 MB |
| 4 | 119.9 MB | +26.0 MB | 419.3 MB | 50.0 MB |
| 6 | 169.9 MB | +24.8 MB | 627.7 MB | 49.3 MB |
| 8 | **218.9 MB** | +24.6 MB | 837.1 MB | 48.7 MB |

- **The marginal worker costs about 25 MB** on a small project root. The 105 MB
  RSS figure is mostly shared Electron and library pages and must not be
  multiplied by N.
- An idle worker that imported the module but created **no** `FileFinder` was
  30.0 MB PSS / 98.5 MB RSS. So the Electron utility-process floor is the bulk of
  the cost, and the index on a project tree adds only a few megabytes.

### 4.4 Message round trip versus calling `fff` directly

Same worker, same root, same queries, `pageSize: 20`:

| Path | Median | p95 |
|---|---:|---:|
| Empty `ping` over `parentPort` (n = 200) | **0.070 ms** | 0.184 ms |
| `fileSearch` via worker, full round trip (n = 200) | **2.02 ms** | 3.31 ms |
| the `fff` call inside the worker | 1.81 ms | — |
| `fileSearch` in the Electron main process, in-process (n = 200) | **1.79 ms** | 2.64 ms |

**IPC overhead is 0.23 ms median — 1.13× the direct call.** Structured-clone of a
20-item result plus two hops costs a fifth of a millisecond. The overhead is
irrelevant next to the 1.1 s scan a main-process index would block on.

---

## 5 — Crash isolation. **Holds, in both failure shapes.**

Test `crash`, two separate kills against one shared store.

**Kill during a scan.** The victim indexed `/usr` and was `SIGKILL`ed while
`getScanProgress()` reported `{"scannedFilesCount":134549,"isScanning":true}` — the
kill genuinely landed mid-scan.

**Kill during writes.** A second worker was `SIGKILL`ed one second into a tight
`trackQuery` loop, so it died holding LMDB write transactions. This is the case
that risks a stale reader-table entry or a held lock.

Observed recovery sequence, in order:

1. The parent Electron process survived both kills. It observed `exit code 9`
   within 501 ms and rejected the dead worker's pending requests.
2. The surviving worker kept `frecency.initialized = true`, read back its own
   earlier record (`{"total":2,"access":0,"mod":2}`), and **wrote again**, after
   both kills.
3. A **fresh** worker opened the same store **73 ms** after the mid-write kill and
   read the dead writer's records intact — `README.md` with `openCount = 22013`.
   No stale-lock stall, no recovery step, no manual unlock.
4. A **respawned** worker over `/usr`, the exact root the first victim died on,
   initialised in 13 ms (fork→ready 180 ms), reported
   `frecency.initialized = true` and `queryTracker.initialized = true`, completed
   its scan in 1213 ms, and wrote to the shared store.
5. The store's own files were normal afterwards: `frecency/{data.mdb,lock.mdb}`
   16 384 bytes, `history/{data.mdb,lock.mdb}` 77 824 bytes.

**The recovery procedure is therefore: notice the `exit` event, reject the pending
requests, fork a replacement, re-`create` over the same root.** Nothing has to be
repaired on disk.

---

## 6 — The alternative: one worker, swapped root.

Test `oneworker`. One `utilityProcess`, one `FileFinder`, root changed in place.

### `reindex(newPath)`

| New root | `reindex()` call | scan + index | Total | First search | Worker PSS after |
|---|---:|---:|---:|---:|---:|
| `symmetria-ide` (331 files) | 1 ms | 50 ms | **51 ms** | 2.37 ms | 48.8 MB |
| `~/Downloads` (237 079) | 0 ms | 1 110 ms | 1 110 ms | 32.01 ms | 95.8 MB |
| `/usr/include` (44 282) | 0 ms | 102 ms | **102 ms** | 10.48 ms | 102.7 MB |
| `symmetria-file-manager` (467) | 1 ms | 51 ms | **52 ms** | 1.65 ms | 103.0 MB |
| `/usr/share/applications` (95) | 0 ms | 51 ms | **51 ms** | 0.99 ms | 103.0 MB |

### `destroy()` + `create()`

| New root | destroy | create | scan + index | Total | Worker PSS after |
|---|---:|---:|---:|---:|---:|
| `symmetria-ide` | 0 ms | 1 ms | 51 ms | 53 ms | 103.2 MB |
| `~/Downloads` | 0 ms | 1 ms | 1 061 ms | 1 062 ms | 141.9 MB |
| `/usr/include` | 0 ms | 1 ms | 102 ms | 103 ms | 148.5 MB |

Three findings:

1. **A root swap is fast on a project tree — about 51 ms**, which is the same
   50 ms floor a fresh index pays. The call itself returns in 0–1 ms; the cost is
   the scan, and the scan scales with the file count, not with the swap.
2. **`reindex()` beats `destroy()` + `create()` on memory.** Both take the same
   time, but after the same three roots the recreating worker sat at 148.5 MB PSS
   against the reindexing worker's 102.7 MB.
3. **A swapping worker does not give memory back.** PSS rose 34 → 48.8 → 95.8 →
   102.7 MB and then stayed at 103.0 MB across two more swaps to *small* roots.
   The resident size is the **high-water mark of the largest tree ever indexed**,
   not the current one. That is allocator retention, which I infer from the plateau
   rather than prove; the practical consequence is the same either way. A
   long-lived worker that browses one big directory keeps that memory for the
   session. A per-index worker that is discarded returns it to the operating
   system at once.

---

## Recommendation

### Topology

**Adopt one index per `utilityProcess`, all sharing one store on disk.** Proved:
it works at N = 8, loses no writes, propagates immediately, and survives a kill. It
is also the only configuration in which Mesura Code can enable frecency at all,
which makes it a bug fix and not only an optimisation.

Put the worker behind the shared search package that report 17 assigns to this
repository. The package owns the worker pool, the store path, and the
request/response protocol. Both products then get the same topology for free.

### Worker count

- **Mesura Code: one worker per open workspace, capped at 8.** Its
  `WorkspaceSearchIndex` already expires an index after 15 minutes idle; make that
  timeout kill the worker. At 8 workers the measured cost is 219 MB PSS, which is
  the ceiling worth paying.
- **The file manager: one worker, root swapped with `reindex()`.** Decision D3
  gives it one window, and a 51 ms swap on a project tree is under the threshold at
  which a user notices. The N-worker design buys nothing here, and its per-worker
  180 ms spawn is worse than a 51 ms swap.
  - **Recycle the worker when the swap is expensive.** The swapping worker keeps
    the high-water memory of the largest directory it ever indexed (§6.3). Kill and
    respawn instead of `reindex()` when the previous root exceeded roughly 100 000
    files; 180 ms of spawn is cheaper than carrying 60 MB for the rest of the
    session.
  - Use `reindex()`, not `destroy()` + `create()`. Same latency, less retained
    memory.
- **Never run the index in the Electron main process.** The IPC overhead is
  0.23 ms; the scan it would block on is up to 1.1 s.

### Memory budget

| Item | Budget |
|---|---|
| Electron utility-process floor, module imported, no index | 30 MB PSS |
| Marginal worker on a project root | **25 MB PSS** |
| Worker on a 44 000-file tree | ~30 MB PSS marginal |
| Worker on a 237 000-file tree | ~60 MB PSS marginal |
| Mesura Code at the 8-worker cap | **219 MB PSS**, 837 MB RSS mostly shared |
| File manager, one worker, project roots | **~50 MB PSS** |

### Recovery procedure

1. Listen for `exit` on every `utilityProcess`.
2. Reject the dead worker's pending requests with a typed error. The caller retries
   against the replacement.
3. Fork a replacement and `create()` over the same root. Measured at 180 ms
   fork→ready, with no store repair.
4. Do **not** add unlock, recovery, or lock-file deletion logic. A `SIGKILL` during
   an LMDB write transaction left the store readable by a fresh process 73 ms
   later.
5. Rate-limit the respawn. A worker that dies twice within, say, 30 s should be
   left dead and the failure surfaced, so a repeatable crash does not become a fork
   loop.

### What this spike did **not** settle, and what it broke

- **D2's premise needs revision.** "Every file open teaches the ranking for both"
  is **not achievable through the current C ABI**, because it exposes no frecency
  write. What one store shares today is the query tracker, and that is scoped to
  the index root, so it does not cross between a file manager browsing `~/projects`
  and Mesura Code holding `~/projects/foo`. Three options, none of them measured
  here:
  1. **Patch `fff-c`** to export `fff_track_access`. The function exists in
     `fff-core` and the Neovim binding calls it. This is a small upstream addition,
     and it is the only option that delivers what D2 promised. Mesura Code already
     carries a patch against this package, so the mechanism exists.
  2. **Run indices with `aiMode: true` and the watcher enabled**, and accept that
     the ranking then learns from *edits*, not from *opens*. Proved to work and to
     propagate across roots and processes (§2.3). It is the wrong signal for a file
     manager, where opening and previewing dominate.
  3. **Keep our own access table** beside `fff` and apply the boost ourselves.
     Full control, and it duplicates a decayed-frecency implementation that already
     exists in the engine.
  Recommend option 1, with option 3 as the fallback if upstream is slow.
- **Two documentation defects to fix in this repository**: the frecency claim in
  `CLAUDE.md` under *Fuzzy finder is backed by the Rust `fff` engine*, and the
  comment at `fuzzyfinder.cpp:497`. Both name frecency where the code writes the
  query tracker.
- **Proved versus inferred.** Proved by measurement: §1 topology, §2 propagation
  and its root scoping, §3 contention and readback, §4 cost, §5 crash recovery, §6
  swap latency. Inferred: the memory plateau in §6.3 is read as allocator retention
  from the shape of the curve, not from an allocator trace; the 8-worker cap is a
  judgement on the measured 25 MB marginal cost, not a measured limit; and the
  recommendation to recycle a worker above roughly 100 000 files interpolates
  between the 44 282-file and 237 079-file rows rather than bisecting for the
  threshold.
