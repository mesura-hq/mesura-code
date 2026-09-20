# 11 — the file manager's own git integration

Scope: the git code that lives **inside `symmetria-file-manager`**. The second,
independent git implementation lives in Symmetria-IDE and is recorded in
`docs/electron-transition/06-ide-embedding-and-git-status.md` Part B. Read both
before merging them; this document does not restate the IDE's command set.

All paths are relative to the repository root
`/home/jc/.t3/worktrees/symmetria-file-manager/t3code-a2a6aa9b`.

---

## 0. The one-sentence summary, and why the map looks empty

**The file manager runs no `git status`. It has no status pipeline.** What it has
is three weakly-related pieces that a reader expects to find joined and does not:

| Piece | File | What it actually is |
|---|---|---|
| Ignore filter | `qml/Symmetria/FileManager/UI/services/Gitignore.qml` | The ONLY git subprocess in the repository: `git check-ignore --stdin`, one per expanded tree directory. Feeds row **visibility**, never a badge. |
| Badge renderer + provider hook | `qml/Symmetria/FileManager/UI/components/GitStatusBadge.qml`, `statusProvider` on `FileTreeView.qml:108` and `FileList.qml:31` | A duck-typed extension point. **No provider is wired anywhere in this repository.** |
| fff git status | `plugin/src/Symmetria/FileManager/Models/fuzzyfinder.cpp:457` | An in-process libgit2 status string attached to every fuzzy-finder row, surfaced on exactly one surface. |

The design intent is stated at `GitStatusBadge.qml:5`:

> The FM is intentionally git-agnostic: this component does NOT decide what
> "M" or "?" means.

So in the **standalone** file manager the tree and the Miller columns render **no
badges at all**. `MillerColumns.qml:103` instantiates `FileList` without assigning
`statusProvider`, and nothing in `host/` assigns it either. The only git badge a
standalone user ever sees is in the fuzzy finder's File Info pane, and that one
does not render the colour palette it was written for (see §2.3).

---

## 1. The status pipeline, end to end

### 1.1 The only git command in the repository

`Gitignore.qml:62-67`:

```qml
const script = 'cd "$1" && stat -c %Y .gitignore 2>/dev/null; echo ""; git check-ignore --stdin 2>/dev/null; exit 0';
runner.workingDirectory = job.dirPath;
runner.command = ["sh", "-c", script, "--", job.dirPath];
runner.start();
runner.write(job.candidates.join("\n") + "\n");
runner.closeWriteChannel();
```

The exact argv handed to `QProcess` (`shellrunner.cpp:86-88`, program = element 0,
args = the rest):

```
sh -c 'cd "$1" && stat -c %Y .gitignore 2>/dev/null; echo ""; git check-ignore --stdin 2>/dev/null; exit 0' -- <dirPath>
```

- **Working directory**: `dirPath`, the directory being expanded. Set twice over —
  once by `QProcess::setWorkingDirectory` and once by the `cd "$1"` inside the
  script.
- **stdin**: the absolute paths of that directory's direct children, newline
  joined, then the write channel closes.
- **stdout**: `<mtime-of-.gitignore>`, an empty separator line, then one line per
  ignored path.

### 1.2 Trigger and cadence

- Triggered from `TreeModel.js:340-341`, inside the `expand()` finish path, after a
  directory's `FileSystemModel` scan settles.
- Gated on `root.respectGitignore` (default `true`, `FileTreeView.qml:67`, toggled
  by `.` — `KeyRegistry.js:435`) and on `candidates.length > 0`.
- Short-circuited entirely when the host supplies `ignoredPathSet`
  (`TreeModel.js:333-339`) — see §6.4.
- **Once per expanded directory, not once per repository.** A mount that expands
  40 directories spawns 40 shells.
- **Strictly sequential.** `Gitignore.qml:54-57` runs one job at a time per
  instance; the rest queue and drain in `_onRunnerExited`.
- **Cache-hit path spawns nothing** (`Gitignore.qml:45-49`), so a watcher-driven
  re-scan of an already-filtered directory never re-asks git.

### 1.3 A directory that is not in a git repository

`git check-ignore` exits 128 and writes `fatal: not a git repository` to stderr.
Both are swallowed: `2>/dev/null` discards the message and `exit 0` masks the
status. The stdout is then just the mtime line plus the separator, the parser
produces an empty `ignored` map, the map is cached under that `dirPath`, and no
row is filtered. Non-repository directories therefore cost one wasted `sh` +
`git` spawn per expanded directory and behave correctly.

### 1.4 The other two "pipelines"

**fff (in-process libgit2).** No subprocess. `FffEngine::acquire`
(`fuzzyfinder.cpp:124`) creates or re-points the process-wide engine, and fff's own
scan attaches a status to each indexed file. The FM sets `opts.watch = false`
(`fuzzyfinder.cpp:141`) and never calls `fff_refresh_git_status`, so **the git
status attached to finder rows is a snapshot taken at index time** and goes stale
for the lifetime of the process unless `searchPath` changes and forces
`fff_restart_index` (`fuzzyfinder.cpp:178`).

**The provider hook (push, external).** `FileTreeView.qml:408-414` and
`FileList.qml:233-237` listen for `statusChanged()` on the provider and bump
`_statusVersion`, which invalidates every visible row's badge binding in one pass.
The provider contract is `FileTreeView.qml:102-108`:

> Consumers supply `statusForPath(path) -> {char, color, textColor?, tooltip?, adds?, dels?}`
> or null, plus a `statusChanged()` signal. The provider answers for files AND
> directories (aggregate status …).

---

## 2. The parser

### 2.1 The ignore parser

`Gitignore.qml:70-110`. Deliberately layout-tolerant rather than positional:

1. Walk lines from the top; the last numeric line before the first empty line is
   the `.gitignore` mtime.
2. The first empty line is the separator; every non-empty line after it is an
   absolute ignored path.
3. Result: `{ mtime: <number>, ignored: { <absPath>: true, … } }`, stored in
   `_cache[dirPath]` by immutable reassignment (`Gitignore.qml:101-103`).
4. The callback receives only the `ignored` map. `TreeModel.js:240-242` files it
   under `root._ignored[dirPath]`, and `rebuildRows` (`TreeModel.js:723`) plus
   `autoExpandChildrenOf` (`TreeModel.js:482`) do the O(1) membership test per row.

**Gap: the payload is newline-delimited.** `git check-ignore` supports `-z` and the
code does not use it, so a filename containing a newline corrupts both the input
list and the output parse. Everything else in the FM (and every IDE command in doc
06 B.1) is NUL-safe; this one path is not.

### 2.2 The badge "parser"

There is no porcelain parser in this repository. The nearest thing is
`FuzzyFinderInfoPanel.qml:165-181`, which takes the **first character of the
trimmed status string** and switches on it:

| Char | State | Colour token | Tooltip |
|---|---|---|---|
| `M` | modified | `gitStatus.modifiedAmber` | Modified |
| `T` | type changed | `gitStatus.modifiedAmber` | Type changed |
| `A` | added | `gitStatus.addedGreen` | Added |
| `D` | deleted | `gitStatus.deletedRed` | Deleted |
| `R` | renamed | `gitStatus.renamedOrange` | Renamed |
| `C` | copied | `gitStatus.renamedOrange` | Copied |
| `?` | untracked | `gitStatus.untrackedBlue` | Untracked |
| `U` | conflicted | `gitStatus.conflictedMagenta` | Conflicted |
| `!` | ignored | `gitStatus.ignoredGray` | Ignored |
| anything else | unknown | `palette.outline` | the raw string |

Empty or whitespace-only input returns `null` and the badge hides
(`FuzzyFinderInfoPanel.qml:166-167`).

There is **no precedence rule**, because the FM never sees two states for one
path. Reduction of the porcelain `XY` pair to one char is the provider's job; the
IDE does it with worktree-over-index precedence (doc 06 B.2). There is **no
directory aggregate** either: the FM computes none and delegates it to the
provider by contract (`FileTreeView.qml:105-107`). fff hands directories an empty
status (`fff/crates/fff-c/src/ffi_types.rs:699`), so finder directory rows never
badge.

### 2.3 The live contract break — the switch never matches fff

`fuzzyfinder.hpp:55` documents the field as *"fff git status string ("M ", "??",
…)"*, and `FuzzyFinderInfoPanel.qml:157` repeats the assumption. **fff does not emit
porcelain codes.** `fff/crates/fff-c/src/ffi_types.rs:687` builds the string with
`format_git_status`, defined at `fff/crates/fff-core/src/git.rs:142-173`, which
returns English words:

```
clean | untracked | modified | deleted | renamed | staged_new | staged_modified | staged_deleted | ignored | unknown
```

Feed those through `_gitStatusObj` and every one lands in the `default` branch,
because JavaScript `switch` is case-sensitive and every word starts lowercase:

| fff emits | FM renders | Colour |
|---|---|---|
| `clean` | badge `c`, tooltip "clean" | `palette.outline` (grey) |
| `modified` | badge `m` | grey |
| `untracked` | badge `u` | grey |
| `deleted` | badge `d` | grey |
| `renamed` | badge `r` | grey |
| `staged_new` / `staged_modified` / `staged_deleted` | badge `s` | grey |
| `ignored` | badge `i` | grey |

Two consequences, both visible today: **the entire operation-colour table is
unreachable from the standalone FM**, and **every clean file shows a grey `c`
badge** instead of no badge — including every file outside a repository, since
`format_git_status_opt(None)` returns `"clean"` (`git.rs:143-144`). The commit that
introduced the palette (`45939c5 feat(git): operation-based git status badge
palette`) claims the FM and the IDE "render git status identically from one shared
palette"; that holds for the IDE's provider and not for the fff path.

**Port implication:** treat §2.2's table as the intended vocabulary and fff's word
list as a separate, incompatible one. Do not port the char-switch as-is.

---

## 3. The ten `git` colour tokens

`qml/Symmetria/FileManager/UI/services/FmTheme.qml:219-243`. Hardcoded on purpose:
badge semantics must not move when the wallpaper-derived palette moves
(`FmTheme.qml:199-203`). The grammar is **operation-based, not index-state based**
(`FmTheme.qml:205-212`) — the colour says *what kind of change*, never *whether it
is staged*.

| # | Token | Value | Paints |
|---|---|---|---|
| 1 | `addedGreen` | `#98c379` | `A` — new tracked content |
| 2 | `modifiedAmber` | `#e0a93a` | `M` and `T` — modified, type changed |
| 3 | `deletedRed` | `#e06c75` | `D` — deleted |
| 4 | `untrackedBlue` | `#61afef` | `?` — untracked |
| 5 | `renamedOrange` | `#d19a66` | `R` and `C` — renamed, copied |
| 6 | `conflictedMagenta` | `#c678dd` | `U` — unmerged |
| 7 | `ignoredGray` | `#5c6370` | `!` — ignored (rarely rendered) |
| 8 | `badgeText` | `#1a1818` | The character ON the saturated fill; must stay legible against tokens 1–7, not against the app background |
| 9 | `addsGreen` | `#7eb777` | The `+N` line-count accessory (text, muted) |
| 10 | `delsRed` | `#d76060` | The `-N` line-count accessory (text, muted) |

Tokens 9 and 10 are deliberately less saturated than 1–7 because they are drawn as
text on the surface, not as a fill (`FmTheme.qml:236-240`). The unmatched-char
fallback uses `palette.outline`, which is palette-derived and therefore **does**
move with the theme.

---

## 4. `GitStatusBadge.qml`

`qml/Symmetria/FileManager/UI/components/GitStatusBadge.qml`, 65 lines, root type
`Rectangle`.

**Public API** — one required property:

```qml
required property var status   // { char, color, textColor?, tooltip? }
```

Four private readonly derivations (`:30-37`) with total fallbacks, so a broken
provider degrades to a visual rather than aborting the row delegate:

- `_char` — `status.char.charAt(0)`, else `"?"`.
- `_bg` — `status.color`, else `FmTheme.palette.outline`.
- `_fg` — `status.textColor`, else `FmTheme.gitStatus.badgeText`.
- `_tooltip` — `status.tooltip`, else `""`.

**Rendering and sizing** (`:39-53`):

- `implicitWidth: 16`, `implicitHeight: 16`, `radius: 3` — a fixed 16 px square
  chip. **The size does not scale with `compactScale`**, unlike every other element
  in `FileTreeRow`; in the IDE's ~0.6-density sidebar the badge is proportionally
  larger than its row.
- Fill is `_bg` with `Behavior on color { CAnim {} }` (colour property → colour
  animation, per the project rule).
- One centred `StyledText`: `font.pointSize: FmTheme.font.size.sm`, mono family,
  `Font.Bold`.
- A `HoverHandler` plus a `ToolTip` with `delay: 400`, both disabled when the
  tooltip string is empty.

**Placement in a row:**

- Tree (`FileTreeRow.qml:139-162`) — inside the content `Row`, after the file name,
  vertically centred, wrapped in a `Loader` whose `active` is `_badge !== null`.
  A second `Loader` (`:169-199`) follows it and renders the `+N` / `-N` accessory
  only when `adds` or `dels` is greater than zero, reading the **same** cached
  `_badge` object rather than calling the provider twice.
- Miller list (`FileListItem.qml:228-247`) — between the symlink-target label and
  the size column, so the badge sits at the right edge of the name region for both
  files and directories (`FileListItem.qml:225-227`).
- Finder info pane (`FuzzyFinderInfoPanel.qml:106-111`) — the value slot of the
  "Git" metadata row, with an em dash rendered when the badge is invisible.

The provider call is wrapped in `try/catch` at both delegate sites; a throwing
provider yields no badge (`FileTreeRow.qml:151-156`).

---

## 5. `Gitignore.qml` — what it implements, and the honest gaps

### 5.1 What it parses

Nothing about ignore syntax. It **delegates every pattern decision to `git`
itself**, so the FM inherits git's exact semantics for free:

| Semantic | Supported | Because |
|---|---|---|
| Negation (`!pattern`) | yes | git evaluates it |
| Directory-only (`build/`) | yes, with a caveat — see §5.2 | git stats the path |
| `**` and all glob forms | yes | git |
| Nested `.gitignore` at any depth | yes | git walks the parent chain from the cwd |
| `.git/info/exclude` | yes | git; in a linked worktree this resolves through `$GIT_COMMON_DIR` |
| `core.excludesFile` (global excludes) | yes | git |
| Tracked-file exemption | yes | `check-ignore` consults the index unless `--no-index` is passed, and it is not — a force-added file that matches a pattern is NOT reported ignored |
| Per-repository resolution | yes, per directory — see §8 | cwd is the scanned directory |

### 5.2 Verified live, in this worktree

This checkout is a linked worktree (`.git` is the file
`gitdir: /home/jc/projects/symmetria-file-manager/.git/worktrees/t3code-a2a6aa9b`),
which makes it a usable test case. Read-only checks run for this document:

```
$ cd plugin && printf 'build\n' | git check-ignore -v --stdin      # dir absent here
(no output, exit 1)
$ cd plugin && printf 'build/\n' | git check-ignore -v --stdin
.gitignore:5:build/     build/
$ cd /home/jc/projects/symmetria-file-manager/plugin \
    && printf "$PWD/build\n" | git check-ignore -v --stdin          # dir present there
.gitignore:5:build/     /home/jc/projects/symmetria-file-manager/plugin/build
```

**The caveat that matters for a re-implementation:** a directory-only pattern
matches a slash-less path only when the path **exists on disk as a directory**,
because git stats it. The FM always feeds paths that exist (they came from a
completed directory scan), and `FileSystemEntry.path` carries no trailing slash
(`filesystemmodel.cpp:107`, built from the `QDir` listing). So the FM is correct
today — but a port that swaps `git` for a pattern-matching library must pass the
`isDirectory` bit explicitly or silently stop ignoring `node_modules`, `build/`,
`.venv/` and every other directory-only rule.

### 5.3 The gaps, bluntly

1. **The mtime is dead code.** The file header (`Gitignore.qml:4-6`) claims the
   cache is "keyed on the directory's `.gitignore` mtime (so edits to `.gitignore`
   invalidate the cache without restarting the daemon)". `filter()` never reads it:
   `Gitignore.qml:45-49` returns the cached map on any hit and compares nothing.
   The mtime is parsed, stored and never used. **Editing a `.gitignore` has no
   effect until `clear()` runs** — a `rootPath` change, `Shift+R`, or toggling `.`
   twice. Half the cost of the combined pipeline (the `stat` call) buys nothing.
2. **A new ignored file appears anyway.** The cached map holds the paths that were
   ignored at first expansion. A file created afterwards is not in it, so the
   watcher-driven rebuild renders it, ignored or not, until the cache is dropped.
3. **No `-z`.** Newline-bearing filenames corrupt both directions (§2.1).
4. **One `sh` + `git` per directory, serialised**, measured at ~30–40 ms each
   (commit `99167fb`). No batching by repository root, though every directory under
   one root shares one answer set.
5. **Direct children only.** The service is never asked about a path it was not
   handed; ignored subtrees are pruned by never expanding the ignored directory.
   Correct, but it means the FM never holds a repository-wide ignored set of its
   own.
6. **No timeout, no kill, no error surface.** `exit 0` masks every failure; a hung
   `git` blocks the queue for that `Gitignore` instance forever, and the only trace
   is a callback that never fires. `ShellRunner` exposes `terminate()`/`kill()`
   (`shellrunner.cpp:90-101`) and `Gitignore.qml` calls neither.
7. **The Miller columns have no ignore filtering at all.** `Gitignore` is
   instantiated once, in `FileTreeView.qml:342-345`. In the Miller view every
   ignored file is always visible.
8. **`.git` itself is only excluded from auto-expansion**, via
   `TreeModel.js:40 SKIP_NAMES`. It is still listed as a row when `showHidden` is
   on.

---

## 6. Caching, invalidation and refresh

### 6.1 What is cached

| Cache | Key | Value | Lives in |
|---|---|---|---|
| Ignore results | `dirPath` (absolute) | `{ mtime, ignored: {absPath: true} }` | `Gitignore.qml:24` |
| Per-directory ignored view | `dirPath` | the `ignored` map | `FileTreeView._ignored`, filled at `TreeModel.js:240-242` |
| Badge invalidation counter | — | monotonic `int` | `FileTreeView._statusVersion:232`, `FileList._statusVersion:37` |
| fff index + git status | base path | in the Rust engine, process-lifetime | `fuzzyfinder.cpp:105-202` |

### 6.2 Invalidation

- `Gitignore.clear()` is called from exactly two places:
  `TreeModel.resetTreeState` (`TreeModel.js:67` — reached on `rootPath` change and
  on `refreshAll`/`Shift+R`) and `FileTreeView.onRespectGitignoreChanged:311-314`.
- `root._ignored` entries are dropped per-path on `collapse`
  (`TreeModel.js:383-388`), together with every descendant key. The `Gitignore`
  cache is **not** dropped there, so re-expanding the same directory is free.
- Badges invalidate wholesale: `statusChanged()` → `_statusVersion + 1` → every
  visible delegate re-queries `statusForPath`. There is no per-path invalidation
  and no diffing.

### 6.3 Watchers and timers

- **`.git/` is not watched.** No `QFileSystemWatcher` in this repository points at
  `HEAD`, `index`, `MERGE_HEAD` or `refs/`. The IDE watches all of them (doc 06
  B.6); the FM has no equivalent, which is why its ignore cache and its fff status
  both go stale silently.
- Each expanded directory owns a `FileSystemModel` with `watchChanges: true`
  (`TreeModel.js:176-182`), so file-level changes rebuild rows. That rebuild reuses
  the cached ignore map (§5.3 gap 2).
- `FileWatcher` re-arms across atomic replace (`filewatcher.cpp:168` names `git
  checkout` as the motivating case) — relevant to `bookmarks.json` and
  `color-scheme.json`, not to git status.

### 6.4 Debounces and throttles, complete list

| Where | Value | Purpose |
|---|---|---|
| `FuzzyFinderPopup.qml:350-352` | 100 ms | Query debounce before `fuzzyModel.query` is set |
| `FuzzyFinderInfoPanel.qml:29-33` | 150 ms | Preview/`FileInfo` debounce on selection change |
| `PreviewPanel` (same convention) | 150 ms | Miller preview debounce |
| `Gitignore.qml` | **none** | Ignore queries are serialised, not debounced |
| Badge invalidation | **none** | Every `statusChanged()` bumps the counter immediately |
| `fff_wait_for_scan` | 30 000 ms timeout | Initial index and re-index (`fuzzyfinder.cpp:157,185`) |

### 6.5 Recorded measurements and guardrails

| Measure | Value | Source |
|---|---|---|
| `git check-ignore` cost per directory | ~30–40 ms, serialised | commit `99167fb`; `FileTreeView.qml:113` |
| Tree mount on a medium repo (bambin, ~480 dirs) before the short-circuit | ~4 s, target sub-100 ms | doc 06 B.14, quoting the IDE's `Main.qml:2652` |
| Directories instantiated per cascade | `MODEL_CEILING = 100` | `TreeModel.js:38` |
| Children above which a directory is not auto-expanded | `FANOUT_CAP = 200` | `TreeModel.js:37` |
| Total row backstop | `NODE_CEILING = 10000` | `TreeModel.js:39` |
| Lazy-expand overscroll headroom | `LAZY_BUFFER_ROWS = 8` | `TreeModel.js:41` |
| Mount-settled ground truth | `Logger.info("FileTreeView", "tree mount settled: N rows visible")` | `TreeModel.js:318-321` |

The one measured optimisation is the **`ignoredPathSet` short-circuit**
(`FileTreeView.qml:110-116`, consumed at `TreeModel.js:333-339`): a host that
already knows the whole repository's ignored set passes it in, and the per-directory
subprocess disappears. The tri-state is load-bearing — `null` means "not known yet,
fall back to `check-ignore`", an empty map means "nothing is ignored". In
JavaScript `{}` is truthy, so a port to TypeScript must encode the tri-state
explicitly (doc 06 B.14).

---

## 7. fff's git awareness

fff links `git2` with `vendored-libgit2` (`fff/Cargo.toml:24`), so libgit2 is
statically inside the plugin `.so`. `fff-core/src/git.rs` is the whole surface.

**What it knows.** `GitStatusCache::read_git_status` (`git.rs:76`) opens the
repository at the scan root and calls `Repository::statuses`, keyed by absolute
path. Two option sets:

- `default_status_options` (`git.rs:9`) — `include_untracked`,
  `recurse_untracked_dirs`, `include_unmodified`, `exclude_submodules`.
- `initial_scan_status_options` (`git.rs:24`) — the same minus `include_unmodified`,
  because a missing cache entry already means clean; the comment cites "seconds on
  huge dirty trees (e.g. chromium with 400k+ entries)".

**Its precedence ladder** (`git.rs:146-166`), first match wins:

```
WT_NEW → untracked
WT_MODIFIED → modified
WT_DELETED → deleted
WT_RENAMED → renamed
INDEX_NEW → staged_new
INDEX_MODIFIED → staged_modified
INDEX_DELETED → staged_deleted
IGNORED → ignored
CURRENT or empty → clean
otherwise → unknown
```

Worktree beats index, matching the IDE's LazyGit convention (doc 06 B.2). It is
**not** the same ladder: fff puts `untracked` above `modified`, and it exposes the
staged side as three distinct words instead of collapsing to a char.

**How it interacts with the QML side.** It does not. The two never compare notes,
and there are four standing disagreements:

1. **Vocabulary.** fff emits words; the FM's switch and the IDE's provider both
   speak porcelain chars (§2.3). The FM's colour table is dead on the fff path.
2. **Staleness.** `opts.watch = false` and `fff_refresh_git_status` is never called,
   so fff's status is frozen at index time. An IDE provider re-scans on a 200 ms
   debounce. Open the finder after editing a file and the info pane still says
   `clean` while the tree badge next to it says modified.
3. **Ignore model.** `showHidden` is inert for this backend (`CLAUDE.md`, Critical
   Pitfalls) and fff applies its own ignore rules during indexing, while the tree
   applies `git check-ignore`. A file the tree hides can still be findable, and the
   two answer to different rule sets.
4. **Repository scope.** fff resolves one repository for the whole base path; the
   tree resolves one per directory (§8).

`fff_refresh_git_status` exists in the C ABI (`fff.h:775`) and returns the number of
files updated. Calling it on a debounce would fix disagreement 2 without any new
subprocess — the cheapest available improvement to the current design.

---

## 8. Worktree, submodule, bare and nested repositories

| Case | `Gitignore.qml` (`check-ignore`, cwd = the directory) | fff / libgit2 | Provider (IDE) |
|---|---|---|---|
| **Linked worktree** (this checkout) | Correct. Git resolves the `gitdir:` file, and `info/exclude` comes from the common dir. Verified in §5.2. | Correct. `Repository::open` handles a worktree's `.git` file. | Correct; the IDE also runs `git worktree list --porcelain` (doc 06 B.1). |
| **Submodule** | Correct and arguably better: cwd inside the submodule resolves the **submodule's** repository, so its own `.gitignore` applies. | Blind. `exclude_submodules(true)` (`git.rs:14,28`) means every file inside a submodule reports `clean`. | The IDE runs one status at the superproject root, so submodule content is invisible there too. |
| **Bare repository** | Fails. `check-ignore` needs a work tree; the failure is swallowed and nothing is ignored. Academic — a bare repo has no files to browse. | Safe. `read_status_impl` returns an empty map when `repo.workdir()` is `None` (`git.rs:57-59`). | Not handled. |
| **Nested repository** | **Correct, and it is the strongest property of the per-directory design.** Each directory's query resolves the innermost repository, so an inner repository's rules apply to its own children. | Wrong. One repository per base path; files in the inner repository get the outer one's status or none. | Wrong, for the same reason. |

**Merge warning.** The `ignoredPathSet` short-circuit trades away the nested-repo
correctness: one repository-wide `git ls-files --others --ignored
--exclude-standard --directory` cannot see an inner repository's rules. The FM's
fallback path is more correct than its fast path. Any merged implementation should
either keep a per-repository-root grouping or accept the loss knowingly.

---

## 9. What is missing versus a full git file manager

Absent from this repository entirely. Each line is scope a port must decide to add
or to drop.

| Capability | Status in the FM |
|---|---|
| Working-tree status scan (`git status`) | **Absent.** No invocation anywhere. |
| Staging / unstaging (`add`, `restore --staged`) | **Absent.** No mutation of the index. Deliberate in the IDE too (doc 06 B.11). |
| Discard / checkout of a file | Absent. |
| Diff view | Absent. The preview router has no diff type. |
| Line counts (`+N` / `-N`) | **Rendering only.** `FileTreeRow.qml:169-199` draws `adds`/`dels` if a provider supplies them; nothing computes them. |
| Blame | Absent. |
| Branch name | Absent. No branch is displayed anywhere in the FM chrome. |
| Ahead / behind | Absent. |
| Stash | Absent. |
| Commit log / history | Absent. |
| Conflict resolution | Absent. The `U` badge char exists in the map; there is no action behind it. |
| Directory aggregate status | **Absent by delegation.** Contract requires the provider to answer for directories. |
| Remote operations (fetch, pull, push) | Absent. |
| `.git/` watching | Absent (§6.3). |
| Repository-root resolution (`rev-parse --show-toplevel`) | Absent. The FM never learns which repository it is in. |
| Ignore filtering in the Miller view | Absent; tree only. |

What **is** present, in full: the ignore filter for the tree, the badge component
and its palette, the provider extension point with its invalidation counter, and a
stale per-row status word from fff.

---

## 10. Porting to Electron

### 10.1 Does Mesura Code already depend on a git library?

**No library — but it already has a git subprocess layer, and it is a good one.**
Checked every non-vendored `package.json` under `/home/jc/projects/mesura-code`
(20 workspace manifests): no `isomorphic-git`, no `simple-git`, no `nodegit`, no
`dugite`, no `ignore`, no napi git module. The two Rust crates under `native/`
(`libghostty-vt`, `resource-monitor`) have no git dependency either.

What exists instead:

- `apps/server/src/vcs/GitVcsDriverCore.ts` — spawns the `git` binary through
  Effect's `ChildProcessSpawner` (`:738-741`), with per-call `timeoutMs`,
  `maxOutputBytes`, `allowNonZeroExit`, a typed `GitCommandError`, and a trace2
  monitor for progress.
- It already runs `["status", "--porcelain=2", "--branch"]` (`:1573`) and parses it
  (`parsePorcelainPath`, `:189`), plus `["ls-files", "--others",
  "--exclude-standard", "-z"]` (`:2120`), `worktree list --porcelain -z` (`:2497`)
  and `for-each-ref`.
- `apps/server/src/git/GitManager.ts` (84 KB) and `GitWorkflowService.ts` sit above
  it, and `ws.ts` already aggregates git RPC to the renderer.

### 10.2 The options, judged

| Option | Speed at repository scale | Ignore correctness | Packaging cost |
|---|---|---|---|
| **Shell out to `git`** (reuse `executeGit`) | Best available. One `status --porcelain=v2 -z` on a 50k-file repo is tens of ms warm; git's own untracked cache and fsmonitor apply for free. | Perfect by definition, including `info/exclude`, `core.excludesFile`, nested `.gitignore`, negation and the index exemption. | Zero. `git` is already a hard requirement of the product, and the executor exists. |
| `isomorphic-git` | Poor. `statusMatrix` walks the tree in JS and is seconds on a large repo; no untracked cache. | Partial. Its ignore support has historically missed `core.excludesFile` and `info/exclude`; negation and `**` are approximations. | Zero native code, but a real bundle-size and CPU cost. |
| `nodegit` | Good (libgit2). | Good (libgit2 shares git's rules; nested-repo scope still manual). | Worst. A native addon rebuilt per Electron ABI, per platform; historically the most fragile dependency in Electron apps. |
| `simple-git` | Same as shelling out — it *is* shelling out. | Perfect, same reason. | A dependency that duplicates `GitVcsDriverCore` and parses porcelain **v1** by default. Strictly worse than the code already in the repository. |
| Rust `git2` via **napi-rs** | Best raw latency, no fork/exec, and it is exactly what fff already does. | Good (libgit2), and it could share fff's cache if fff is ported. | High. Adds a Rust toolchain to CI plus a prebuild matrix (linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64) that Mesura Code does not maintain today. |

### 10.3 Recommendation

**Shell out to `git`, through the existing `GitVcsDriverCore.executeGit` seam. Add
no git dependency.**

The reason is not that the subprocess is fastest in the abstract — it is that every
alternative pays a real cost (packaging, or ignore correctness, or both) to solve a
problem the product does not have: the binary is already required, the executor is
already written, tested, timed out and traced, and its porcelain v2 parser already
exists. A napi-rs `git2` module is the only option worth revisiting later, and only
if profiling shows fork/exec dominating — which the FM's own numbers argue against,
since its 30–40 ms per directory came from spawning **per directory**, not from
spawning at all.

Commands to run, per repository root, cwd = that root:

```
git rev-parse --show-toplevel --git-dir
git status --porcelain=v2 -z --branch --untracked-files=all
git diff --numstat -z
git diff --cached --numstat -z
git ls-files --others --ignored --exclude-standard --directory -z
git check-ignore -z --stdin          # fallback only, for a directory outside the resolved root
```

Note `-z` on `check-ignore` — the fix for §2.1's gap. Keep the `check-ignore`
fallback rather than deleting it: it is the only mechanism that gets nested
repositories right (§8).

### 10.4 Streaming to a virtualised tree of thousands of rows

Four rules, each carried over from a measured decision in the Qt implementation:

1. **Compute in the server process, never in the renderer.** The scan, the parse
   and the directory aggregates run where `GitVcsDriverCore` already runs. Debounce
   every trigger at 200 ms with a 50 ms leading-edge throttle on the watcher
   thread (doc 06 B.13). Watch `<git_dir>/index`, `HEAD`, `MERGE_HEAD` and the
   working tree, and break the self-trigger loop by ignoring paths under `.git/`.
2. **Pre-compute directory aggregates once per scan, server-side.** A tree row asks
   for its status on every repaint; the answer must be an O(1) map lookup, never a
   walk. The Qt code states it plainly (doc 06 B.3): aggregating per call is
   O(rows × depth) per frame.
3. **Publish an immutable snapshot plus a version counter, not per-row events.**
   The whole FM badge design is one integer (`_statusVersion`) that invalidates
   every visible row at once, precisely because per-row signals at thousands of
   rows cost more than one re-read. In React: hold the `Map<absPath, GitStatus>` in
   an external store, expose it through `useSyncExternalStore` with a per-path
   selector, and let the virtualiser render only its window — a full-map swap then
   re-renders only mounted rows, which is tens of components, not thousands. Send
   the first payload chunked (about 1000 entries per message) so a cold scan on a
   large repository never blocks the websocket, and send later scans as a whole
   snapshot with a version stamp; at tens-to-hundreds of changed paths a diff costs
   more than it saves (doc 06 B.13, "full reset, cheaper than a diff").
4. **Keep the ignored set separate from the status map, and keep it tri-state.**
   `undefined` = not yet scanned (fall back to per-directory `check-ignore`),
   `Set` = authoritative, possibly empty. Do not let an empty set mean "unknown" —
   that is the bug the Python/QML boundary avoided only by accident of truthiness
   (§6.5).

---

## 11. Files a port must read

| File | Why |
|---|---|
| `qml/Symmetria/FileManager/UI/services/Gitignore.qml` | The only git subprocess; the cache and its dead mtime |
| `qml/Symmetria/FileManager/UI/modules/filemanager/handlers/TreeModel.js:325-343` | Where ignore filtering joins the expansion state machine, and the `ignoredPathSet` short-circuit |
| `qml/Symmetria/FileManager/UI/modules/filemanager/FileTreeView.qml:102-124` | The `statusProvider` / `ignoredPathSet` / `pathFilter` contracts |
| `qml/Symmetria/FileManager/UI/components/GitStatusBadge.qml` | The badge contract and its fallbacks |
| `qml/Symmetria/FileManager/UI/services/FmTheme.qml:199-243` | The ten tokens and the operation-based grammar |
| `qml/Symmetria/FileManager/UI/modules/filemanager/FuzzyFinderInfoPanel.qml:157-181` | The char→colour map, and the fff vocabulary break |
| `plugin/src/Symmetria/FileManager/Models/fuzzyfinder.cpp:105-202,432-471` | The fff engine singleton and where git status enters |
| `plugin/third_party/fff/crates/fff-core/src/git.rs` | fff's entire git surface, including its precedence ladder |
| `docs/electron-transition/06-ide-embedding-and-git-status.md` Part B | The IDE's independent implementation — the other half of the merge |
