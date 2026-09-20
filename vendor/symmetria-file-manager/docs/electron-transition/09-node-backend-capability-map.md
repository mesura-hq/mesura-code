# Node/TypeScript Capability Map for the Electron File-Manager Backend

Research date: 2026-08-24. Target host: `mesura-code` `apps/desktop`, Electron 41.5.0, Node 24.13.1,
pnpm 11.10.0.

This document maps every behaviour of the C++ QML plugin
`plugin/src/Symmetria/FileManager/Models/` onto a Node/web replacement. It is a research
output. It changes no source file.

Read section 1 first. It records what the C++ actually does, because several capabilities
below look easy until you match the concrete limit or the concrete fallback rule.

---

## 1. What the C++ backend actually does

### 1.1 `FileSystemModel` + `FileSystemEntry` (`filesystemmodel.cpp`, 955 lines)

The scan runs on a `QtConcurrent::run` worker. Per entry it calls `buildCachedEntryData`,
which performs, in the worker thread:

1. `QFileInfo(path)` — one `stat`.
2. `buildPermissions` — a 10-character `ls -l` string (`d/l/-` then `rwxrwxrwx`) from the
   cached `QFileDevice::Permissions`.
3. `QFileInfo::owner()` — a `getpwuid` call. The code comments that this is a blocking
   syscall and must not run on the UI thread.
4. `detectRemoteMount` for directories only — a `statfs` on the entry, compared against the
   parent's `f_type`. Flags only the mount root, not every child. Magic numbers:
   `FUSE 0x65735546`, `NFS 0x6969`, `SMB 0x517B`, `CIFS 0xFF534D42`.
5. `QMimeDatabase::mimeTypeForFile(path)` with the default match mode — glob first, then
   content sniff, so it can open the file.
6. `QImageReader(path).canRead()` — opens the file and reads its header, unless the suffix is
   one of `.rpgmvp`, `.png_`, `.icns`, `.heic`, `.heif`, which are forced `isImage = true`
   because Qt cannot decode them.
7. `IconThemeResolver::resolveForFile` — cached per icon name, but a cache miss probes the
   filesystem.

So a 10,000-entry directory costs about 10,000 `stat` calls plus up to 20,000 extra `open`
calls (one for the MIME sniff, one for `QImageReader`). That is the real baseline to beat,
not `readdir`.

**The `isText` rule** (`isTextLike`) is the single source of truth for text classification:

```
isText = mime.inherits("text/plain")
      OR ( (mime is invalid OR mime.name() == "application/octet-stream")
           AND first 4096 bytes are non-empty AND contain no NUL byte )
```

An empty or unreadable file is deliberately NOT text.

**Sorting**: directories always sort before files, in both directions. Modes are
`Alphabetical` (`localeAwareCompare` on `relativePath`), `Modified`, `Size`, `Extension`
(`completeSuffix`, tie-broken by name), and `Natural` (a `thread_local QCollator` with
`setNumericMode(true)` and `CaseInsensitive`). `Modified`, `Size` and `Extension` all
tie-break on `relativePath`.

**Filters**: `NoFilter`, `Files`, `Dirs`, `Images`. The `Images` filter builds its glob list
from `QImageReader::supportedImageFormats()` plus `*.rpgmvp`, `*.png_`, `*.icns`.

**The diff**: the worker compares the new path set against the old one, and separately
compares per-path `(size, mtime)` pairs. A path whose size or mtime changed is put in BOTH
`removed` and `added`, so `applyChanges` rebuilds it as an immutable snapshot. Per-path
stats are collected in non-recursive mode only.

**Watching**: `kMaxFileWatches = 2048`. Above that cap the model drops all per-file watches,
warns once, and keeps directory-only watching. `onFileChanged` starts a 250 ms single-shot
debounce that triggers a full rescan.

`FileSystemEntry` exposes: `path`, `relativePath`, `name`, `baseName`, `parentDir`, `suffix`
(`completeSuffix`, so `tar.gz` not `gz`), `size`, `isDir`, `isImage`, `isVideo`
(`mimeType.startsWith("video/")`), `isText`, `modifiedDate`, `permissions`, `isSymlink`,
`symlinkTarget`, `isExecutable`, `owner`, `isRemoteMount`, `mimeType`, `iconPath`.

### 1.2 `SyntaxHighlightHelper` (`syntaxhighlighthelper.cpp`)

Hard limits: `MaxBytes = 65536` (64 KiB read cap), `MaxLines = 500`, `BinaryScanBytes = 8192`.
A NUL byte inside the first 8 KiB sets `isError` and aborts. Decoding is UTF-8 with
replacement characters.

Language detection: `definitionForFileName(basename)` first, then
`definitionForMimeType(mimeTypeForFile(path, MatchExtension))`.

Output is a string of HTML: `<pre style="margin:0;padding:0;color:#dddddd">` wrapping
`<span style="color:…;font-weight:bold;font-style:italic;text-decoration:underline">` runs.
Only colour, weight, style and underline survive. No background colour, no font.

Theme: the custom `Wine` theme, embedded as a Qt resource at
`:/symmetria-fm-syntax/themes/wine.theme`, discovered through
`Repository::addCustomSearchPath`. Falls back to KF6 `DarkTheme`.

### 1.3 `ArchivePreviewModel` (`archivepreviewmodel.cpp`)

libarchive with `archive_read_support_filter_all`, `archive_read_support_format_all`, and
also `archive_read_support_format_raw` for single-stream `.gz`/`.bz2`/`.xz`.

It reads headers only, never entry data. It builds a tree from the flat paths, then flattens
depth-first with directories before files at each level. `MaxEntries = 5000`; `totalEntries`
stays uncapped so `truncated` is meaningful. `archive_entry_size` is used only when
`archive_entry_size_is_set` is true. Errors are reported even when entries were read, so a
partial listing plus an error string is a valid state.

### 1.4 `SpreadsheetPreviewModel` (`spreadsheetpreviewmodel.cpp`)

QXlsx for `.xlsx`/`.xlsm`/`.xltx`/`.xltm`, freexl for `.xls`. `MaxRows = 200`,
`MaxCols = 50`. Everything is stringified. Column headers are spreadsheet letters
(`A`…`Z`, `AA`…). Sheet names are listed and one sheet is active at a time.

### 1.5 `PreviewImageHelper` (`previewimagehelper.cpp`)

Cache key: `SHA1(path + ":" + mtimeSeconds).toHex() + ".png"` under
`QStandardPaths::CacheLocation + "/preview"`. Cache hit is a bare `QFileInfo::exists`, which
is why every decoder deletes its partial file on a failed write.

`needsCachedDecode` is a suffix test: `.pdf`, `.rpgmvp`, `.png_`, `.icns`, `.heic`, `.heif`.
Everything else is passed straight through as `file://` + path.

- PDF: `QImageReader` with `setBackgroundColor(Qt::white)`, first page, saved as PNG.
- RPGMV: skip 32 bytes, prepend the fixed 16-byte PNG header (magic + IHDR length + `IHDR`).
  No XOR key needed.
- ICNS: `IcnsDecoder`.
- HEIF: `HeifDecoder`.

`resolvePathForOpen` redirects to the cache for RPGMV only. PDF and ICNS open by source path
so the user's real handler launches.

### 1.6 `HeifDecoder` (`heifdecoder.cpp`)

`heif_init`/`heif_deinit` guard, primary image handle, decode to
`heif_chroma_interleaved_RGBA`, wrap as `QImage::Format_RGBA8888`, deep copy, downscale so
the larger dimension is at most `kMaxPreviewDim = 2048`, save PNG, remove the partial file on
failure.

### 1.7 `IcnsDecoder` (`icnsdecoder.cpp`)

Validates the `icns` magic and the big-endian total size, then walks 8-byte chunk headers.
It picks the highest-priority PNG chunk in this fixed order:

`ic10` (1024) > `ic14` (512@2x) > `ic09` (512) > `ic13` (256@2x) > `ic08` (256) >
`ic12` (64@2x) > `ic07` (128) > `ic11` (32@2x)

It validates the full 8-byte PNG signature and writes the chunk out verbatim. No re-encode.

### 1.8 `IconThemeResolver` (`iconthemeresolver.cpp`, 398 lines)

Search paths, in order: `$XDG_DATA_HOME/icons`, each `$XDG_DATA_DIRS/icons`,
`/usr/share/pixmaps`.

`index.theme` is parsed by a hand-written INI reader, because "QSettings fails on long values
and group names with spaces". It collects only directories whose `Context` is `MimeTypes`,
`Places` or `Applications`, and sorts them scalable-first then by descending `Size`.

Two lookup categories:

- `MimePlaces` — **SVG only**. Names starting with `folder`, plus `user-home`, `user-desktop`,
  `user-trash`, search `Places` first, everything else searches `MimeTypes` first. The other
  list is tried as a fallback because some themes misfile folder icons.
- `Apps` — tries `.svg`, `.png`, `.xpm` in each `Applications` directory, then explicitly
  searches `hicolor` even when the active theme does not declare it in `Inherits`, then falls
  back to flat `/usr/share/pixmaps`.

`Inherits` is walked recursively with a `visited` set. Both caches (`s_cache`, `s_appCache`)
store misses as well as hits.

`resolveForFile` order: `mime.iconName()`, then `mime.genericIconName()`, then the
`iconName()` of each entry in `mime.parentMimeTypes()`.

The design note is load-bearing: it returns a **path**, not a `QIcon`, so QML renders the SVG
as a vector instead of a rasterised pixmap.

### 1.9 `FileWatcher` (`filewatcher.cpp`)

A single-file text watcher, separate from `FileSystemModel`. `MaxBytes = 8 MiB`,
`RetryDelayMs = 100`. It watches the file **and** its parent directory, and re-arms with
`removePaths` then `addPaths` on every event. On a vanish it keeps the stale text and only
flips `loaded` to false, so a consumer never reads a blank frame during the unlink/rename gap.

### 1.10 Others

- `FuzzyFinder` — the Rust `fff` engine through its C ABI. `MaxResults = 200`.
- `AudioWaveformModel` — `QAudioDecoder`, `TargetBinCount = 300` peak bins.
- `AppIconProvider` — `.desktop` id to app icon path via `IconThemeResolver::resolveApp`.
- `ShellRunner` — `QProcess` wrapper.

---

## 2. What Mesura Code already ships

Verified by reading `pnpm-workspace.yaml`, the workspace `package.json` files, and
`pnpm-lock.yaml`. Do not re-add any of these.

| Package | Version in lock | How it enters the tree |
|---|---|---|
| `sharp` | `0.35.0` (patched), `0.34.5` | **Direct** dependency of `scripts`. `allowBuilds: sharp: true` |
| `shiki` + `@shikijs/core` + `@shikijs/engine-javascript` + `@shikijs/langs` + `@shikijs/themes` | `4.2.0` | **Direct** dependency of `apps/mobile`. Also transitive through `@pierre/diffs` for `apps/web` |
| `chokidar` | `4.0.3` and `5.0.0` | Transitive only |
| `jszip` | `3.10.1` | **Direct** dependency of `apps/web` |
| `tar` | `7.5.16` | Transitive |
| `yauzl` | `2.10.0` | Transitive |
| `fdir` | `6.5.0` | Transitive |
| `mime-types` | `2.1.35`, `3.0.2` | Transitive |
| `image-size` | `1.2.1` | Transitive |
| `pngjs` | `7.0.0` | **Direct** dependency of `scripts` |
| `@ff-labs/fff-node` | `0.9.4` (patched) | **Direct** dependency of `apps/server` |
| `electron-builder` | `26.15.6` | `apps/desktop` devDependency |
| `node-pty` | `^1.1.0` | `apps/server`. `allowBuilds: node-pty: true` |

Not present: `@parcel/watcher`, `file-type`, `highlight.js`, `monaco-editor`, `codemirror`,
`tree-sitter`, `exceljs`, `xlsx`, `pdfjs-dist`, any `@napi-rs/*`.

**`@ff-labs/fff-node` is the same `fff` engine the Qt plugin links.** It reaches Node through
`ffi-rs` plus per-platform prebuilt binaries (`@ff-labs/fff-bin-<platform>-<arch>`). The
fuzzy-finder capability is therefore already solved with no new work. `apps/server` uses it
in `src/workspace/WorkspaceSearchIndex.ts`.

**`native/resource-monitor` is the precedent for native code in this repo.** It is a plain
Rust binary (`src/main.rs`, `sysinfo`, no napi), built by
`pnpm build:resource-monitor` (`cargo build --locked --release`), spawned as a subprocess and
driven with newline-delimited JSON over stdin/stdout with an explicit
`PROTOCOL_VERSION: u32 = 2`. `apps/server/src/resourceTelemetry/ResourceMonitorBinary.ts`
resolves the binary by platform, architecture and glibc-versus-musl, and returns typed errors
for unsupported/not-found/not-executable. Section 14 argues from this precedent.

---

## 3. Capability 1 — Fast directory listing

**Today**: `QDirIterator` on a `QtConcurrent` worker, one `QFileInfo` per entry, plus MIME and
`QImageReader::canRead()` per entry.

### Options

| Option | Native? | In Mesura Code? |
|---|---|---|
| **Chosen**: `fs.opendir` / `fs.readdirSync(dir, {withFileTypes:true})` + `fs.statSync` per entry, inside a `worker_thread` | No | Yes, built in |
| Runner-up: `fdir` 6.5.0 | No | Yes (transitive) |
| Runner-up: Rust `jwalk` or `ignore::WalkBuilder` behind napi-rs | Yes | No |

### How the syscalls actually behave

On Linux, `readdir` with `withFileTypes: true` reads directory blocks with `getdents64` and
reads the `d_type` byte straight out of the dirent. No `stat` is issued for the type. The
fallback matters: when the filesystem returns `DT_UNKNOWN` — old XFS without `ftype`, some
NFS mounts, some FUSE filesystems — libuv issues an `lstat` per entry to fill in the type.
So `withFileTypes` is free on ext4 and btrfs and is not free everywhere.

`fs.watch`/`readdir` recursion: `uv_fs_event_start` on Linux never reads its `flags`
parameter, so libuv has no recursive inotify watch. Node's `recursive: true` on Linux is a
**userland** walk in `lib/internal/fs/`, not a kernel feature.

Sources:
https://github.com/libuv/libuv/blob/v1.x/src/unix/linux.c
https://nodejs.org/docs/latest-v24.x/api/fs.html
https://github.com/libuv/libuv/issues/1778

### Real expectations for a 10,000-entry directory

Be careful about what each published number measures.

- `fdir` reports **10,000 files crawled in 13 ms** and 1 million files in under a second. That
  benchmark measures *path collection only* — no `stat`, no MIME, no image probe. Hardware and
  cache state are not stated in the README, and the run is warm-cache. Treat 13 ms as the floor
  for the `getdents64` half of the work, not as a listing time.
  https://github.com/thecodrr/fdir/blob/master/BENCHMARKS.md
  https://dev.to/thecodrr/how-i-wrote-the-fastest-directory-crawler-ever-3p9c
- `fdir`'s comparison table gives `node:fs.readdir` 13.1 ops/sec against `fdir`'s 76.1 ops/sec
  on a 1-million-file tree. That gap is recursion strategy and allocation, not raw syscall cost.
  A single flat directory closes most of it.
- The stat half dominates and I found **no published Node benchmark that measures 10,000
  `stat` calls**, so the following is an engineering estimate, flagged as such. A warm-cache
  `statSync` costs roughly 3–10 µs, mostly the JS-to-C++ boundary. 10,000 of them is therefore
  roughly **30–100 ms** on one thread. `fs.promises.stat` is materially worse for this shape of
  work: every call round-trips through the libuv threadpool, whose default size is 4
  (`UV_THREADPOOL_SIZE`), and allocates a promise. For a bulk scan, synchronous calls inside a
  dedicated worker thread beat async calls on the main thread.
  https://docs.libuv.org/en/v1.x/threadpool.html

**Budget to aim for: 10,000 entries listed with full stat data in under 150 ms, warm cache, one
worker thread.** That is comfortably inside a frame budget for a paginated list and it is in the
same class as the current Qt scan, which pays the same `stat` cost plus two extra `open` calls
per entry.

### The design change that matters more than the library

Do not port `buildCachedEntryData` literally. Split it:

- **Eager, whole directory**: `d_type`, name, and one `lstat` for size, mtime, mode, uid,
  nlink, symlink flag. This is everything the list view renders.
- **Lazy, per visible row or per selection**: `mimeType`, `isText`, `isImage`, `iconPath`,
  `owner`. MIME needs no file open if the glob matches, and the image probe and the `getpwuid`
  can wait until the row is on screen.

`owner` is a `getpwuid` per entry today. In Node, read `uid` from the `Stats` object and
resolve names through a `Map<number, string>` built once from `/etc/passwd` or from
`os.userInfo()`. A directory owned by one user then costs one lookup, not 10,000.

`isRemoteMount` has no Node equivalent for `statfs`. Replace it by parsing `/proc/self/mountinfo`
once, watching that file for changes, and testing whether an entry's path is a mount point with
an `fstype` in `{fuse, fuse.*, nfs, nfs4, cifs, smb3}`. This is strictly better than the current
per-directory `statfs`: it is one read instead of N syscalls, and it names the filesystem type
rather than matching four magic numbers.

**Native module: not needed.** A Rust `jwalk` scanner would win on a recursive tree of hundreds
of thousands of entries. The file manager lists one directory at a time and caps recursion, so
the win does not apply. Revisit only if recursive mode over a large tree becomes a hot path.

**Risk: LOW.**

---

## 4. Capability 2 — File watching

The two Qt failure modes are documented in `CLAUDE.md` under *Critical Pitfalls*. Evaluate every
candidate against both, separately.

### Failure mode A — atomic replace (unlink then rename-into-place)

`nvim :w`, `git checkout`, and atomic JSON saves write a temp file and rename it over the
target. `QFileSystemWatcher` watches an inode; the rename gives the path a new inode, and the
watch silently dies. `FileWatcher` mitigates it by watching the parent directory as well and
re-arming with `removePath; addPath` on every signal, plus a 100 ms `QTimer` retry.

### Failure mode B — directory watches deaf to in-place content writes

This one is exact and provable. Qt's `qfilesystemwatcher_inotify.cpp` uses two different masks:

```
directory: IN_ATTRIB | IN_MOVE | IN_CREATE | IN_DELETE | IN_DELETE_SELF
file:      IN_ATTRIB | IN_MODIFY | IN_MOVE | IN_MOVE_SELF | IN_DELETE_SELF
```

`IN_MODIFY` is present for files and **absent for directories**. A file that grows after it was
first listed emits nothing on the directory watch. That is the 0-byte-download bug.

https://github.com/qt/qtbase/blob/dev/src/corelib/io/qfilesystemwatcher_inotify.cpp

### What each Node/Rust option actually requests

| Option | Directory mask | Fixes A? | Fixes B? | Watch count |
|---|---|---|---|---|
| `fs.watch` (libuv) | `IN_ATTRIB \| IN_CREATE \| IN_MODIFY \| IN_DELETE \| IN_DELETE_SELF \| IN_MOVE_SELF \| IN_MOVED_FROM \| IN_MOVED_TO` | Partly | **Yes, structurally** | 1 per watched path |
| `chokidar` v4/v5 | same as `fs.watch` (it wraps it) | Yes, with `atomic: true` | Yes | 1 per directory, recursion in JS |
| `@parcel/watcher` 2.6.0 | `IN_ATTRIB \| IN_CREATE \| IN_DELETE \| IN_DELETE_SELF \| IN_MODIFY \| IN_MOVE_SELF \| IN_MOVED_FROM \| IN_MOVED_TO \| IN_DONT_FOLLOW \| IN_ONLYDIR \| IN_EXCL_UNLINK` | Yes | Yes | 1 per subdirectory, recursive in C++ |
| Rust `notify` (`RecommendedWatcher`) | `MODIFY` plus `CREATE`/`MOVED_TO` always added when recursive | Yes, cookie-matched `MOVED_FROM`/`MOVED_TO` into `RenameMode::Both` | Yes | 1 per subdirectory via `walkdir` |

Sources:
https://github.com/libuv/libuv/blob/v1.x/src/unix/linux.c
https://github.com/parcel-bundler/watcher/blob/master/src/linux/InotifyBackend.cc
https://github.com/notify-rs/notify/blob/main/notify/src/inotify.rs
https://github.com/paulmillr/chokidar/blob/main/README.md

### Plainly: which are real fixes and which are papering over

- **Failure mode B is fixed for free by every Node option.** libuv requests `IN_MODIFY` on a
  directory watch. Qt does not. This is not a workaround, it is a different mask. Delete
  `syncFileWatches`, `kMaxFileWatches`, the `m_fileWatchCapWarned` latch and the 250 ms
  `onFileChanged` debounce-rescan entirely. Do not port them. A single directory watch reports
  a growing download.
- **Failure mode A is fixed by watching the directory, not the file.** The unlink/rename pair
  arrives as `IN_MOVED_FROM`/`IN_MOVED_TO` or `IN_DELETE`/`IN_CREATE` on the parent, which is a
  watch that never dies. This is a structural fix, not a re-arm hack. What remains is
  *presentation*: coalescing the delete/create pair into one "changed" event.
  - `chokidar`'s `atomic` option (default true) does exactly that coalescing with a 100 ms
    window. That part **is** a paper-over, but a correct one, and it is optional.
  - `notify-debouncer-full` does the same with explicit rename-cookie matching, which is
    stronger: it pairs `MOVED_FROM` and `MOVED_TO` by inotify cookie instead of by a timer.
  - `@parcel/watcher` sets `IN_EXCL_UNLINK`, which stops events from unlinked-but-open files —
    exactly the noise an atomic replace generates.
- **`chokidar` still polls in one place**: `awaitWriteFinish` uses `fs.stat` polling to detect a
  settled write, and `usePolling: true` switches the whole backend to `fs.watchFile`. Neither is
  needed here, because `IN_MODIFY` already reports growth. Leave both off.

### The inotify budget

- The kernel default for `fs.inotify.max_user_watches` is **8192**, unchanged since 2005. Many
  distributions raise it via `sysctl.d`, but Arch historically ships the kernel default.
  `fs.inotify.max_user_instances` defaults to 128, which caps the number of separate
  `inotify_init` handles per user, not the number of watches.
  https://bugs.archlinux.org/task/47830
  https://man.archlinux.org/man/inotify.7
- A file manager showing one directory needs **one** watch. The Miller-column view needs three.
  A tree view needs one per expanded directory. This is a two-digit number, not a budget problem.
- The budget only bites in recursive mode. Both `@parcel/watcher` and Rust `notify` add a watch
  per subdirectory, so watching a `node_modules` tree can exhaust 8192 instantly. Keep the
  existing policy: recursive watching is opt-in, and cap it. The Qt code already has this
  instinct in `kMaxFileWatches`; move the cap from *files* to *directories*.

### Recommendation

**`@parcel/watcher` 2.6.0.** It is actively maintained (published August 2026), it is used by
VS Code, Nx, Nuxt and Tailwind, its inotify mask is a superset of libuv's, it does recursion in
C++ instead of JS, and its `writeSnapshot`/`getEventsSince` API lets a window that was closed
catch up on what changed while it was gone — something the Qt version cannot do at all.

It is a native module, but a Node-API one distributed as per-platform prebuilt packages
(`@parcel/watcher-linux-x64-glibc` and friends), so it needs no compiler at install time and no
rebuild against Electron's ABI. It does need `asarUnpack` in `electron-builder`.
https://www.npmjs.com/package/@parcel/watcher

**Runner-up: `chokidar` v4**, already in the lockfile transitively. Pure JS on top of `fs.watch`,
zero native surface, correct on both failure modes. Choose it if you want to ship with no new
native dependency at all and accept JS-side recursion.

**Risk: MEDIUM** — not because the libraries are weak, but because the event-to-model reducer is
where the bugs will live. Write the regression tests from `FileSystemModelTest` first:
`atomicReplaceTenTimes` and `growingFileRefreshesSize` both port directly and both are the
tests that will catch a wrong reducer.

---

## 5. Capability 3 — MIME type detection with inheritance

**Today**: `QMimeDatabase`, which reads `/usr/share/mime` and implements the shared-mime-info
spec including `QMimeType::inherits`.

This is the capability that looks hardest and is actually the most tractable, because the XDG
database ships the answer as plain text.

### What is on disk right now (verified on this machine)

```
/usr/share/mime/globs2          51 K   text   weight:mimetype:glob[:cs]
/usr/share/mime/subclasses      24 K   text   "child parent" per line, 610 lines
/usr/share/mime/aliases         13 K   text   "alias canonical" per line
/usr/share/mime/generic-icons   23 K   text   "mimetype:iconname"
/usr/share/mime/icons          108 B   text   "mimetype:iconname"
/usr/share/mime/magic           47 K   binary
/usr/share/mime/mime.cache     204 K   binary (mmap-able index of all of the above)
```

Everything the file manager's `isText` and `iconPath` rules need is in the five text files,
about 115 KB total. Parsing them is a few hundred lines of TypeScript and one startup read.

### The inheritance trap — verified, and it will bite a naive port

The spec defines two **implicit** subclass rules on top of the explicit `subclasses` edges:

1. every `text/*` type is a subclass of `text/plain`;
2. every type except `inode/*` is a subclass of `application/octet-stream`.

https://specifications.freedesktop.org/shared-mime-info/latest/ar01s02.html

Rule 1 is not decoration. Computing the transitive closure of `subclasses` alone on this
machine gives:

```
application/json        -> reaches text/plain  (via json5 -> typescript -> javascript -> text/plain)
application/yaml        -> reaches text/plain  (explicit edge)
application/toml        -> reaches text/plain  (explicit edge)
application/xml         -> reaches text/plain  (explicit edge)
image/svg+xml           -> reaches text/plain  (via application/xml)
text/x-shellscript      -> DOES NOT reach text/plain; its only listed parent is application/x-executable
```

`subclasses` contains **zero** rows ending in `application/octet-stream`, and only a subset of
`text/*` rows point at `text/plain`. A TypeScript implementation that reads `subclasses` and
stops there silently breaks shell scripts, and probably other `text/*` types too. Add both
implicit rules explicitly.

Two more consequences worth recording:

- `image/svg+xml` **is** text under this rule. The current `PreviewContent.qml` router only gets
  the right answer because it checks `isImage` before falling through to `isText`. That ordering
  is a contract, not an accident. Keep it.
- Alias resolution must run before the subclass walk. `application/acrobat` is an alias of
  `application/pdf` and has no `subclasses` row of its own.

### Options

| Option | Reads real XDG DB? | Inheritance? | Verdict |
|---|---|---|---|
| **Chosen**: a ~200-line TypeScript reader over `globs2` + `subclasses` + `aliases` + `generic-icons` + `icons`, plus the two implicit rules | Yes | **Yes** | Recommended |
| Rust `xdg-mime` 0.4.0 behind the sidecar | Yes | Docs list `get_mime_types_from_file_name`, `get_mime_type_for_data`, `guess_mime_type`. I could **not confirm** from docs.rs that a subclass query is public | Fallback |
| `mime-xdg` (npm) | No — ships a pre-generated dataset baked at publish time | Partial. It exposes a "mimeHead" parent, a single primary parent, not a transitive closure | **Cannot reproduce the rule** |
| `mime-types` / `mime-db` | No — IANA/Apache/nginx tables | **No** concept of subclassing at all | Cannot |
| `file-type` | No — magic bytes only | **No**. It also explicitly does not detect `text/plain` | Cannot |
| `mmmagic` (libmagic binding) | No — libmagic, a different database | **No**. Also unmaintained; last release predates Node 22 and it is a `node-gyp` build | Cannot |
| `magic-bytes.js` | No | **No** | Cannot |

Sources:
https://specifications.freedesktop.org/shared-mime-info/latest/ar01s02.html
https://github.com/wareset/mime-xdg
https://docs.rs/xdg-mime/latest/xdg_mime/
https://github.com/ebassi/xdg-mime-rs

### Plainly

`file-type`, `mime-types`, `mime-db`, `mmmagic` and `magic-bytes.js` **cannot** reproduce the
inheritance rule. None of them models a type graph. `mime-xdg` gets closer but exposes one
parent, not a closure, and its data is frozen at publish time so it will drift from the system
database the way the old QML mime-string list drifted.

The only two options that can answer "does `text/x-shellscript` inherit from `text/plain`" are
reading the XDG database yourself in TypeScript, or the Rust `xdg-mime` crate.

### Content sniffing

The Qt code only sniffs when the database returns `application/octet-stream` or an invalid type,
and its sniff is a NUL-byte scan of the first 4 KiB. That means the binary `magic` file is
**not needed**. Port the NUL-byte sniff verbatim, including the "empty file is not text" rule.
Skipping `magic` removes the one genuinely hard part of the parsing job.

### Cache invalidation

`/usr/share/mime/version` changes when `update-mime-database` runs. Watch the directory and
reload. This is exactly what `FileWatcher` already does for `bookmarks.json`.

**Native module: not needed.**
**Risk: MEDIUM** — the technology risk is low, the correctness risk is real. Write a table-driven
test that asserts `isText` for `.sh`, `.json`, `.yaml`, `.toml`, `.md`, an extensionless config,
a `.desktop` file, and asserts NOT-text for a PNG and a 0-byte file. That test is the whole
capability.

---

## 6. Capability 4 — Icon theme resolution

**Today**: `IconThemeResolver`, 398 hand-written lines. Returns a path.

### The renderer changes the shape of the problem

In Qt, returning a path instead of a `QIcon` was a workaround to stop the SVG being rasterised.
In Electron the renderer *is* a browser: `<img src="file:///usr/share/icons/…/text-x-python.svg">`
renders the vector natively, at any DPI, with no decode step in the main process. The design
that the C++ arrived at by necessity is the natural design here.

Two consequences:

- The backend's whole job is `iconName -> absolute path`. No pixmap, no data URI, no IPC of
  image bytes.
- Loading a `file://` URL from a renderer needs either `webSecurity` relaxed (do not) or a
  custom protocol handler registered with `protocol.handle()` that maps, say,
  `symmetria-icon://text-x-python` to the resolved file and refuses anything outside the icon
  search paths. Do the second. It also gives you a natural cache point.

### Options

| Option | Native? | In Mesura Code? |
|---|---|---|
| **Chosen**: port `IconThemeResolver` to TypeScript, roughly 1:1 | No | No |
| Runner-up: `freedesktop-icons` (npm) | No | No |
| Runner-up: `get-icon-path`, `node-desktop-icons` | No | No |
| Rust `freedesktop-icons` / `linicon` behind the sidecar | Yes | No |

npm has at least three icon-theme resolvers: `freedesktop-icons` (bastimeyer), `get-icon-path`
(maxerbox) and `node-desktop-icons` (sdumetz). I could **not confirm** current maintenance for
any of them — the npm registry pages returned HTTP 403 to the fetch tool, and the GitHub
repositories show no recent release in the search snippets. Treat all three as unverified.
https://github.com/bastimeyer/freedesktop-icons
https://github.com/maxerbox/get-icon-path
https://github.com/sdumetz/node-desktop-icons

**Port the C++ rather than adopt a library.** The existing 398 lines encode several decisions a
generic library will not make, and each one is a bug you would otherwise rediscover:

- MIME and Places lookups are **SVG-only**, deliberately.
- `folder*`, `user-home`, `user-desktop`, `user-trash` search `Places` first; everything else
  searches `MimeTypes` first; each falls back to the other list.
- `hicolor` is searched explicitly for app icons even when the active theme omits it from
  `Inherits`.
- A sloppy `Icon=foo.png` has the extension stripped before theme lookup, so it does not become
  `foo.png.svg`, but the literal form is still tried last under `/usr/share/pixmaps`.
- The INI parser is hand-written on purpose, because `QSettings` mishandled long values and
  group names with spaces. A Node `ini` package has the same class of problem; write the parser.
- The cache stores misses. A theme with no icon for a rare MIME type must not re-probe the
  filesystem on every scroll.

### What to add that the C++ does not have

The spec's `Type=Threshold` and `MinSize`/`MaxSize` keys are ignored today, because the resolver
sorts scalable-first and takes the first hit. That is fine for a vector renderer. Record it as a
deliberate simplification rather than silently reproducing it.
https://specifications.freedesktop.org/icon-theme-spec/icon-theme-spec-latest.html

### `.desktop` parsing and default applications

`AppIconProvider` only needs the `Icon=` key. A full "Open With" menu needs more:

- `.desktop` files live in `$XDG_DATA_HOME/applications` then each `$XDG_DATA_DIRS/applications`,
  first match wins by basename.
- MIME-to-application mapping lives in `mimeapps.list` (`[Default Applications]` and
  `[Added Associations]`) plus the generated `mimeinfo.cache`.
- I found no maintained npm package that implements this lookup. Write it. It is a
  desktop-entry INI parse plus two lookup tables, and the same hand-written INI parser serves it.

**Native module: not needed.**
**Risk: LOW.**

---

## 7. Capability 5 — Syntax highlighting

**Today**: KSyntaxHighlighting (KF6) with the custom `Wine` theme, capped at 64 KiB and 500
lines, emitting inline-styled HTML.

### Options

| Option | Languages | Theme format | Bundle | In Mesura Code? |
|---|---|---|---|---|
| **Chosen**: `shiki` 4.2.0 | TextMate grammars from `tm-grammars`, roughly 200 | VS Code / TextMate JSON | `shiki/bundle/full` 6.4 MB min / 1.2 MB gzip; fine-grained imports far less | **Yes**, direct dep of `apps/mobile`, transitive for `apps/web` |
| Runner-up: `highlight.js` | roughly 190 | CSS classes | ~1 MB for all languages, much less per-language | No |
| `codemirror` 6 + Lezer | roughly 30 first-party grammars | CSS-variable theme extension | modest, but per-language grammar packages | No |
| `monaco-editor` | roughly 90 Monarch grammars | VS Code theme JSON | very large, and it wants to own the DOM | No |
| `tree-sitter` (`web-tree-sitter` WASM or napi) | 200+ grammars, but each needs a `highlights.scm` query | none — you build one | one WASM per language | No |

### Judgement

**Language coverage.** KSyntaxHighlighting ships roughly 400 XML language definitions. Nothing
in the JavaScript world matches that. Shiki's grammar set is the largest realistic option at
roughly half. The honest position is that the Electron version will highlight fewer languages
than the Qt version, and that the gap is in long-tail formats — KDE ships definitions for things
like ABC notation and Sieve filters that no TextMate grammar set carries. Mitigation: Shiki
accepts any TextMate grammar at runtime through `createHighlighterCore`, so a missing language
is one JSON file, not a fork.

**Theme portability.** This is where Shiki wins decisively. `Wine` is a colour-per-token-class
theme with no structural features. Shiki consumes VS Code themes, which are the same shape.
`highlight.js` would need the theme rewritten as CSS rules against its own class names, and it
has no equivalent of several KSyntaxHighlighting classes. `tree-sitter` would need the theme
rewritten against capture names *and* a `highlights.scm` written per language.

**Speed on a large file.** Shiki is genuinely slow on large inputs — this is its known weakness,
and the Oniguruma WASM regex engine is the reason. The saving grace is that this capability
never sees a large file: the C++ caps input at **64 KiB and 500 lines**. Port that cap and the
performance question disappears. Highlighting 64 KiB is a few milliseconds in either engine.
Do not remove the cap in the name of a "better" preview.

**Engine choice.** `@shikijs/engine-javascript` (`createJavaScriptRegexEngine`) compiles the
TextMate Oniguruma patterns to native JavaScript `RegExp` and drops the WASM entirely. It is
faster to start and smaller to ship, at the cost of a small number of grammars whose patterns it
cannot translate. `apps/mobile` already depends on it, and `apps/web` already sets
`preferredHighlighter: "shiki-js"` in `src/lib/syntaxHighlighting.ts`. Follow that precedent.

Sources:
https://shiki.style/guide/bundles
https://shiki.style/guide/regex-engines
https://github.com/shikijs/shiki

### Converting `wine.theme` into a Shiki theme

`plugin/src/Symmetria/FileManager/Models/themes/wine.theme` has **31 text styles** and one
`editor-colors` block. Every style carries `text-color` plus optional `bold`, `italic`,
`underline`. Full extraction:

| KSyntaxHighlighting style | Colour | Attrs | TextMate scopes to emit |
|---|---|---|---|
| Normal | `#dddddd` | — | theme `colors.editor.foreground` |
| Keyword | `#c28b12` | bold | `keyword`, `keyword.other`, `storage`, `storage.type` |
| Function | `#fdd888` | bold italic | `entity.name.function`, `support.function`, `meta.function-call` |
| Variable | `#dddddd` | — | `variable`, `variable.other` |
| ControlFlow | `#c28b12` | bold italic | `keyword.control` |
| Operator | `#dddddd` | — | `keyword.operator`, `punctuation.separator`, `punctuation.terminator` |
| BuiltIn | `#c75828` | — | `support.class`, `support.type`, `support.constant` |
| Extension | `#fdd888` | italic | `support.other`, `entity.name.namespace` |
| Preprocessor | `#c28b12` | — | `meta.preprocessor`, `keyword.control.directive` |
| Attribute | `#e7cb8f` | — | `entity.other.attribute-name` |
| Char | `#e1d797` | — | `constant.character` |
| SpecialChar | `#e19773` | — | `constant.character.escape` |
| String | `#62ba46` | — | `string`, `string.quoted` |
| VerbatimString | `#62ba46` | — | `string.quoted.triple`, `string.unquoted` |
| SpecialString | `#e19773` | — | `string.regexp`, `string.interpolated` |
| Import | `#c28b12` | — | `keyword.control.import`, `keyword.control.from` |
| DataType | `#c75828` | — | `entity.name.type`, `storage.type.primitive` |
| DecVal | `#e1d797` | — | `constant.numeric.integer` |
| BaseN | `#e1d797` | — | `constant.numeric.hex`, `constant.numeric.octal`, `constant.numeric.binary` |
| Float | `#e1d797` | — | `constant.numeric.float` |
| Constant | `#e1d797` | — | `constant.language`, `constant.other` |
| Comment | `#9e9e9e` | italic | `comment`, `comment.line`, `comment.block` |
| Documentation | `#9e9e9e` | italic | `comment.block.documentation` |
| Annotation | `#e7cb8f` | — | `storage.type.annotation`, `meta.decorator`, `punctuation.decorator` |
| CommentVar | `#9e9e9e` | italic | `comment.block.documentation variable` |
| RegionMarker | `#6d94e9` | — | `meta.block-level`, `comment.block.region` |
| Information | `#6d94e9` | — | `markup.info` |
| Warning | `#b0a878` | — | `markup.warning`, `invalid.deprecated` |
| Alert | `#d2602d` | bold | `markup.error`, `comment.line.alert` |
| Error | `#d2602d` | underline | `invalid`, `invalid.illegal` |
| Others | `#e1d797` | — | leave unmapped; it is the KSyntaxHighlighting catch-all |

Recipe:

1. Write `tools/wine-theme-to-shiki.ts` that reads `wine.theme`, applies the table above, and
   emits a VS Code theme JSON: `{ name, type: "dark", colors: {...}, tokenColors: [ { scope, settings: { foreground, fontStyle } } ] }`.
2. `fontStyle` is a space-separated string: `"bold"`, `"italic"`, `"underline"`,
   `"bold italic"`.
3. Map `editor-colors` into `colors`: `BackgroundColor` to `editor.background`, `TextSelection`
   to `editor.selectionBackground`, `CurrentLine` to `editor.lineHighlightBackground`,
   `LineNumbers` to `editorLineNumber.foreground`, `CurrentLineNumber` to
   `editorLineNumber.activeForeground`, `IndentationLine` to `editorIndentGuide.background`,
   `SearchHighlight` to `editor.findMatchBackground`.
4. **Keep the generator, not just its output.** `wine.theme` must stay in sync with
   `~/.config/nvim/lua/jc/plugins/theme/wine_theme/lua/lush_theme/wine_theme.lua`. A generator
   preserves that single source of truth; a hand-written Shiki theme creates a third copy that
   will drift.
5. `Underline` has no direct KSyntaxHighlighting-to-TextMate analogue for `Error` in some
   grammars. Accept that `Error` will underline less often than KF6 does.

Language detection also changes: KSyntaxHighlighting matched by filename glob, then by MIME
type. Shiki takes a language id. Build the map from the XDG MIME work in section 5 — the same
`globs2` table that resolves `*.py` to `text/x-python` can resolve it to Shiki's `python`, with a
small hand-maintained MIME-to-Shiki-id table for the cases where the ids differ.

**Native module: not needed.**
**Risk: MEDIUM** — the theme conversion is mechanical, the language-coverage gap is real and
permanent.

---

## 8. Capability 6 — Image decoding and thumbnails

### What Chromium gives you for free on Linux

Be precise here, because getting it wrong costs a whole native dependency.

| Format | Chromium on desktop Linux | Note |
|---|---|---|
| JPEG, PNG, GIF (incl. animated), BMP, ICO | Yes | Since forever |
| WebP, including animated | Yes | |
| APNG | Yes | Since Chrome 59 |
| SVG | Yes, as a vector, in `<img>` | The reason section 6 is easy |
| **AVIF** | **Yes**, since Chrome 85 (August 2020) | Both still and animated |
| **HEIC / HEIF** | **No.** Not on Linux, not on Windows, not on macOS, not in `<img>`, not with any flag | Chromium has never shipped a HEIF decoder for images. On macOS it does not call the OS decoder either |
| JPEG XL | **No.** Behind a flag in Chrome 91–109, removed in Chrome 110 (2023), not restored | |
| TIFF | **No** in `<img>` | |
| RAW (CR2/NEF/ARW/DNG) | **No** | |
| ICNS | **No** | |

Sources:
https://www.testmuai.com/learning-hub/heif-browser-support/
https://www.avif.fast/blog/avif-browser-support-guide
https://issues.chromium.org/issues/40686133

So Chromium covers the entire `WORKSPACE_IMAGE_PREVIEW_EXTENSIONS` list already declared in
`packages/shared/src/filePreview.ts` (`.avif .gif .ico .jpeg .jpg .png .svg .webp`) with zero
backend work. The renderer points an `<img>` at a custom-protocol URL and Chromium does the rest,
including animation, which the Qt version handles only through `AnimatedImage`.

### The gaps, and what fills each

| Gap | Fill | Native? |
|---|---|---|
| TIFF | `sharp` — prebuilt libvips includes TIFF | Yes (already shipped) |
| HEIC / HEIF | `libheif-js` (WASM) in a worker, decode to PNG or raw RGBA | No |
| ICNS | Port `IcnsDecoder` to TypeScript, ~80 lines, no decode needed | No |
| RAW | Extract the embedded JPEG preview with `exiftool` or a small TS EXIF reader | No |
| RPGMV `.rpgmvp` / `.png_` | Port `decryptRpgmvp`, ~20 lines | No |
| PDF first page | See section 10 — Electron renders PDFs itself | No |
| Downscaling for thumbnails | `sharp` | Yes (already shipped) |

**`sharp` 0.35.3 is the right thumbnail engine and it is already a direct dependency of
`scripts`.** Its prebuilt binaries cover "JPEG, PNG, Ultra HDR, WebP, AVIF, TIFF, GIF and SVG
(input)". They deliberately **exclude libheif**, because HEIC uses HEVC and the prebuilds cannot
carry patent-encumbered code. Getting HEIC through `sharp` would require a globally installed
libvips built with libheif, libde265 and x265 — which is precisely the "Arch's qt6-imageformats
has no libheif plugin" problem the Qt code already works around, moved to a new place. Do not
chase it. Use `libheif-js` in a worker and keep `sharp` on its prebuilt path.

`sharp` in Electron needs `asarUnpack` for `**/node_modules/sharp/**/*` and
`**/node_modules/@img/**/*`. `electron-builder` 26.15.6 is already in `apps/desktop`.
https://sharp.pixelplumbing.com/install/

**Runner-up: `@napi-rs/image`.** A napi-rs image toolkit covering the common raster formats with
per-platform prebuilds. It is smaller than `sharp` and has no libvips. It is the right choice
only if `sharp` were not already in the tree. It is, so this is a runner-up and nothing more.
**Runner-up: `wasm-vips`.** Same libvips, in WASM, no native binary. Slower and larger; take it
only if a future target forbids native modules entirely.

I could **not independently confirm** the current maintenance status of `libheif-js`,
`heic-decode`, or `@jsquash/*` within this research pass. Verify before committing to one.

### Thumbnail cache design

The C++ cache is: `SHA1(path + ":" + mtimeSeconds)` hex + `.png`, under
`QStandardPaths::CacheLocation + "/preview"`, hit-tested by bare existence.

Two design faults to fix in the port:

1. Bare existence testing forces every writer to delete partial files on failure. Write to a
   temp name in the same directory and `rename` into place. The rename is atomic; a partial file
   can never be observed.
2. Baking the mtime into the key means every edit orphans the old entry and nothing ever prunes.
   Add an LRU sweep on a size budget at startup.

**Recommended layout**

```
$XDG_CACHE_HOME/symmetria-fm/thumbnails/<algo>/<aa>/<hash>.png
key   = sha256(fileURI + "\0" + mtimeMs + "\0" + size + "\0" + targetPx)
```

Include `size` alongside `mtime`. The Qt key uses mtime at **second** granularity, so a file
rewritten twice inside one second serves a stale thumbnail. This is the same coarse-mtime
limitation the scan diff already documents. Adding `size` removes most of it for free.

Invalidation: the key is content-derived, so there is nothing to invalidate. Eviction is an LRU
sweep over `atime` against a byte budget, run once at startup in the worker.

### Is the XDG thumbnail spec worth honouring?

The freedesktop Thumbnail Managing Standard puts thumbnails in
`$XDG_CACHE_HOME/thumbnails/{normal,large,x-large,xx-large}` at 128/256/512/1024 px, names each
file after the **MD5 of the file's canonical `file://` URI**, and requires the PNG to carry
`Thumb::URI` and `Thumb::MTime` `tEXt` chunks, with failures recorded under
`$XDG_CACHE_HOME/thumbnails/fail/<appname-version>/`.
https://specifications.freedesktop.org/thumbnail/latest/

I could not extract the section text through the fetch tool — the page returned only its table
of contents — so treat the key names above as recalled rather than freshly quoted, and confirm
against the spec before implementing.

**Recommendation: read the shared cache, write your own.**

- **Reading** it is close to free and is a real user-visible win: a directory Nautilus or Dolphin
  has already visited shows thumbnails instantly, with no decode. Check
  `thumbnails/large/<md5>.png`, validate `Thumb::MTime` against the file's mtime, use it if it
  matches.
- **Writing** it costs correctness. You must match the spec's sizes exactly, embed the `tEXt`
  chunks, honour the `fail/` convention, and respect the "do not thumbnail files on removable or
  remote filesystems" rule. Get any of it wrong and you corrupt another application's cache. The
  benefit — other file managers see your thumbnails — is not worth that.
- Writing your own cache also lets you key on size as well as mtime, which the spec's format
  cannot express.

**Native module: `sharp`, already shipped. No new one.**
**Risk: MEDIUM** — the format matrix is wide and HEIC needs a separate WASM path.

---

## 9. Capability 7 — Archives

**Today**: libarchive, header-only reads, one code path for zip, tar and its filters, 7z, rar,
and raw single-stream compressors.

### Options

| Option | Formats | Listing without extract | Licence | Maintained |
|---|---|---|---|---|
| **Chosen (JS path)**: `yauzl` + `tar`/`tar-stream` + `fflate` | zip, tar, tar.gz, tar.br | Yes — `yauzl` reads the central directory only | MIT / ISC | Yes. Both already in the lockfile |
| **Chosen (wide path)**: shell out to `bsdtar -tvf` | Everything libarchive supports | Yes | BSD | Yes. It is libarchive, the same engine as today |
| Runner-up: `archive-wasm` | 7z, tar, pax, cpio, zip, lha, ar, cab, mtree, rar, ISO | Metadata comes with iteration | **GPL-3.0** | Uncertain — 58 commits, no dated release found |
| Runner-up: `libarchive-wasm` (ofk) | zip, 7z, rar v4, rar v5, tar | Yes | Check before use | Last release "less than a year ago" per npm |
| Runner-up: `libarchive.js` | Broad; runs the WASM in a Web Worker by design | Yes | MIT | Older, largely superseded |
| `adm-zip` | zip | Yes | MIT | Avoid — repeated zip-slip and traversal CVEs |
| `jszip` 3.10.1 | zip | Loads the whole archive into memory | MIT | Already a dep of `apps/web`. Fine for small archives, wrong for a 2 GB zip |

Sources:
https://github.com/HeavenVolkoff/archive-wasm
https://github.com/ofk/libarchive-wasm
https://github.com/nika-begiashvili/libarchivejs

### The RAR licensing catch

RARLAB's UnRAR source may be used in any software to read RAR archives free of charge, but it
**may not be used to re-create the RAR compression algorithm**. That use restriction is what
makes the licence GPL-incompatible and non-free in Debian's and Fedora's classification.

Consequences for this project:

- Shipping UnRAR-derived code inside an Electron app under a permissive licence is a licence
  conflict. Do not bundle it.
- libarchive's own RAR reader is BSD-licensed and independent of UnRAR for RAR4. For **RAR5**,
  libarchive can be built either with its own reader or against UnRAR; which one you get depends
  on the build. Windows 11 ships libarchive for RAR extraction, which is evidence the BSD path
  is viable.
- `archive-wasm` is **GPL-3.0**, which is a separate and larger problem for a proprietary or
  permissively-licensed Electron app than the RAR question is.
- The clean answer on Arch: **do not bundle a RAR reader. Shell out.** `bsdtar` comes with
  `libarchive`, which is already a hard dependency of the current build. `unrar` is in Arch's
  `extra` repository and users who want RAR can install it; detect it at runtime and degrade
  gracefully when it is absent.

Sources:
https://fedoraproject.org/wiki/Licensing:Unrar
https://en.wikipedia.org/wiki/Unrar

### Recommendation

A two-tier design that mirrors what libarchive gave you in one call:

1. **Tier 1, in-process JS**: `yauzl` for zip (central-directory listing is exactly what
   `ArchivePreviewModel` needs — headers, no data), `tar-stream` for tar, Node's built-in `zlib`
   for gzip and brotli, and `fflate` for deflate. Node 22+ also ships `zlib.zstdDecompress` for
   `.tar.zst`. This covers the overwhelming majority of archives a developer opens.
2. **Tier 2, `bsdtar -tvf`**: everything else — 7z, rar, cab, cpio, iso, lha, xz, bz2, lzip.
   Parse the tabular output. `bsdtar` is libarchive, so the format coverage is identical to what
   the Qt version has today, by construction.

This keeps the common path fast and dependency-free, keeps the licence surface clean, and makes
the format matrix a runtime property of the machine rather than a compile-time property of the
bundle.

Port these behaviours verbatim: `MaxEntries = 5000` with an uncapped `totalEntries` so
`truncated` stays meaningful, directories before files at each tree level, size treated as
unknown rather than zero when the archive does not set it, and partial-listing-plus-error as a
valid state.

**Native module: not needed** if you accept a `bsdtar` runtime dependency.
**Risk: MEDIUM** — mostly the licence question and the tier-2 output parsing.

---

## 10. Capability 8 — Spreadsheets

**Today**: QXlsx for `.xlsx`, freexl for `.xls`. Capped at 200 rows by 50 columns, all
stringified.

This is the weakest capability in the JavaScript ecosystem and the report should say so plainly.

### Options

| Option | xlsx | xls (BIFF8) | Licence | Maintained |
|---|---|---|---|---|
| `xlsx` on npm (SheetJS CE) | Yes | Yes | Apache-2.0 | **No.** Last npm publish `0.18.5`, four years old. Two unpatched high-severity advisories on npm: CVE-2023-30533 (prototype pollution on read, fixed in 0.19.3, never published to npm) and CVE-2024-22363 (ReDoS) |
| SheetJS from `https://cdn.sheetjs.com` | Yes | Yes | Apache-2.0 | Yes, but distributed only from their own CDN, not npm |
| `@e965/xlsx` | Yes | Yes | Apache-2.0 | Automated republish of SheetJS to npm. Latest `0.20.3`, last published about two years ago |
| `exceljs` | Yes | **No** | MIT | **No.** `4.4.0`, last published three years ago; the maintainers' own issue #2969 is unanswered. Forks `@protobi/exceljs` and `@excel.js/exceljs` are more recent |
| `read-excel-file` | Yes | No | MIT | Yes, but read-only and schema-oriented |
| `node-xlsx` | Yes | via SheetJS | MIT | Wraps SheetJS, inherits its problem |
| Rust `calamine` | Yes | **Yes**, plus xlsb, xla, xlam, ods | MIT | Yes, actively maintained. **No npm binding found** — only `python-calamine` exists |
| Shell out to `libreoffice --headless --convert-to csv` or `ssconvert` | Yes | Yes | — | Yes, but slow to start and a heavy runtime dependency |

Sources:
https://cdn.sheetjs.com/advisories/CVE-2023-30533
https://git.sheetjs.com/sheetjs/sheetjs/issues/2961
https://www.npmjs.com/package/@e965/xlsx
https://github.com/exceljs/exceljs/issues/2969
https://crates.io/crates/calamine

### The SheetJS licence and distribution situation, stated exactly

SheetJS Community Edition is **Apache-2.0**. The licence never changed. What changed is
distribution: the maintainers stopped publishing to npm after `0.18.5` and now ship only from
`https://cdn.sheetjs.com`. The `xlsx` package still on npm is therefore a frozen, four-year-old,
known-vulnerable snapshot that the maintainers will not update — and the CVE fix for
CVE-2023-30533 landed in `0.19.3`, a version that exists only on their CDN.

The current install instruction from SheetJS is:

```
pnpm add https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
```

That is a tarball URL, not a registry package. In a pnpm workspace with a lockfile and a
`minimumReleaseAge` policy — both of which `mesura-code` uses — a CDN tarball dependency is a
supply-chain and reproducibility decision that needs an explicit sign-off, not a silent `add`.

### Recommendation

There is no clean answer. In preference order:

1. **Pin the SheetJS CDN tarball** for `.xlsx` and `.xls`. It is the only maintained option that
   reads both, and the licence is genuinely Apache-2.0. Accept the non-registry install, pin the
   exact URL and integrity hash, and document why in `CLAUDE.md`.
2. **`@e965/xlsx`** if a registry package is mandatory. It is the same code, republished. It is
   two years stale, so it carries the `0.20.3` code, which does contain the CVE-2023-30533 fix.
3. **Write a napi-rs binding for `calamine`** if spreadsheets matter enough. This is the only
   *good* option technically: pure Rust, maintained, reads xlsx **and** xls **and** xlsb **and**
   ods, MIT. It is also the only place in this whole document where a new native module earns
   its keep on merit rather than convenience. Section 14 argues against it anyway, on budget
   grounds.
4. **Drop `.xls`.** The legacy BIFF8 format is genuinely rare in 2026. Reading `.xlsx` with a
   maintained library and showing a metadata card for `.xls` is a defensible product decision
   and removes the whole problem.

Whatever you pick, keep the 200-row by 50-column cap and the stringify-everything behaviour. A
preview pane never needs cell types.

**Native module: not needed for options 1, 2 and 4. Needed for option 3.**
**Risk: HIGH** — this is the one capability where every JavaScript option is compromised.

---

## 11. Capability 9 — PDF and documents

**Today**: `QImageReader` renders the first page of a PDF onto white and caches it as a PNG. One
page, one image, no text.

Electron changes this completely, and in the user's favour.

- Chromium's **built-in PDF viewer** is compiled into Electron. A `<webview>`, a `BrowserView`,
  or an `<iframe>` pointed at a PDF URL gets the full viewer: every page, scrolling, zoom, text
  selection, in-document search, printing, and the outline sidebar.
- The historical caveat is that the viewer is hard to *disable* — `webPreferences.plugins: false`
  has repeatedly failed to suppress it. That is an annoyance for apps that do not want it and an
  advantage here.
- **`pdfjs-dist`** is the alternative when you need control: render a page to a canvas at an
  exact size, extract the text layer for a search index, or produce a thumbnail bitmap. It is
  Apache-2.0 and actively maintained by Mozilla. It is not currently in the lockfile.

Sources:
https://github.com/electron/electron/issues/24334
https://github.com/electron/electron/issues/9412

### What this gives us that Qt did not

- **Multi-page**. The Qt preview is one page. Chromium's is the document.
- **Selectable text and in-document search**, which Qt's rasterised first page cannot offer.
- **No cache entry at all** for the common case. Drop `.pdf` from `needsCachedDecode`; there is
  no PNG to generate, key, or evict.
- **No white-background compositing hack**. `reader.setBackgroundColor(Qt::white)` exists because
  a transparent PDF rendered onto a dark pane is unreadable. The Chromium viewer paints its own
  page background.

Use `pdfjs-dist` only for the grid-thumbnail case, where you want a small first-page bitmap
rather than an embedded viewer.

Other document formats — `.docx`, `.odt`, `.pptx` — have no good in-process story. Shell out to
`libreoffice --headless --convert-to pdf` into the cache directory, then show the result in the
built-in viewer. This is strictly more than the Qt version does today, which shows nothing.

**Native module: not needed.**
**Risk: LOW.**

---

## 12. Capability 10 — Trash, open, and file operations

### What Electron gives you

| API | What it does | Caveat |
|---|---|---|
| `shell.trashItem(path)` | Async, resolves on success. On Linux it runs `gio trash` | Fails on tmpfs and on filesystems with no `.Trash` directory (electron#28045). `ELECTRON_TRASH=gio` forces the modern implementation |
| `shell.openPath(path)` | Opens with the desktop's default handler. Resolves to `""` on success or an error string | Replaces `xdg-open` shelling. Does not tell you *which* handler ran |
| `shell.openExternal(url)` | Opens a URL in the default browser | `apps/desktop/src/electron/ElectronShell.ts` already wraps this with a URL allowlist that rejects `file://`. Reuse that guard |
| `shell.showItemInFolder(path)` | Reveals in the system file manager | Not useful when you *are* the file manager |
| `clipboard` | Text, HTML, image, and custom formats | **This solves the documented `wl-copy` clipboard bug.** Chromium owns the Wayland data-source for the process lifetime, so a copy does not die when one window closes |

https://www.electronjs.org/docs/latest/api/shell

`shell.trashItem` replaces the current `gio trash` `ShellRunner` invocation with a supported API.
`shell.openPath` replaces `xdg-open`. Both remove a subprocess.

The clipboard win deserves emphasis. `.claude/memory/project_clipboard_bug_root_cause.md` records
that `cc` copies but paste fails, because `wl-copy`'s serving fork dies when the FM window closes
and systemd kills the cgroup. Electron's clipboard is owned by the Chromium process, so the bug
cannot occur. That is a real defect fixed by the platform change, not by any code.

### What you must build yourself

`fs.promises.cp(src, dest, { recursive: true })` is stable since Node 22. It is also a black box:
no progress, no conflict policy, no cancellation. It cannot back a file manager's copy dialog.

Build a copy engine with these properties:

- **Two passes.** Walk first to compute total bytes and entry count, then copy. Without the walk
  there is no denominator and no honest progress bar.
- **Stream per file**, `createReadStream().pipe(createWriteStream())`, so progress is byte-level
  and an `AbortSignal` can stop mid-file. `fs.copyFile` is faster per file — it can use
  `copy_file_range` — but it is atomic and uninterruptible, so it gives you neither progress nor
  cancel. Use `copyFile` for files under a threshold (say 4 MiB) and streams above it.
- **Throttle progress IPC.** Emit at most 10 updates per second, not per chunk. A per-chunk
  `webContents.send` will saturate the IPC channel and stall the renderer.
- **Conflict resolution as a protocol, not a callback.** The worker pauses on a conflict and
  emits `{ type: "conflict", src, dest, srcStat, destStat }`. The renderer replies with
  `overwrite` / `skip` / `rename` / `overwriteAll` / `skipAll` / `cancel`. The `*All` variants
  must be held in worker state, or the dialog will reappear on every file.
- **Cancel must clean up.** A cancelled copy leaves a partial destination file. Delete it. A
  cancelled *move* is worse: never delete the source until the destination is fully written and
  `fsync`ed.
- **Move is not copy plus delete.** Try `fs.rename` first. Within a filesystem it is instant and
  atomic. Only fall back to copy-then-delete on `EXDEV`.
- **Preserve metadata** the way `cp -a` does: mode, mtime, atime, and symlinks as symlinks.
  `fs.promises.cp` has `preserveTimestamps` and `verbatimSymlinks`; a hand-rolled engine must do
  it explicitly with `utimes` and `symlink`.
- **Hard links and sparse files** will not be preserved. Say so in the UI or accept the
  difference. The current Qt implementation shells out to `cp`, which does preserve them, so this
  is a real regression to record.

**Native module: not needed.**
**Risk: MEDIUM** — every item above is a known file-manager bug class, and none of them is hard,
but there are a lot of them.

---

## 13. Capability 11 — Blocking the event loop

Electron gives four execution contexts. The rule is one sentence: **anything that can take longer
than one frame must not run in the main process, and anything that holds long-lived OS state
should not run in a `worker_thread`.**

### The four contexts

| Context | Use it for | Never use it for |
|---|---|---|
| **Main process** | Window lifecycle, `shell.*`, menus, IPC routing, policy. Nothing else | Any filesystem walk, decode, parse, or highlight. A blocked main process freezes every window |
| **`utilityProcess`** | A long-lived child with its own event loop, Node API access, and a `MessagePort` to the renderer. Crashes independently. Can be restarted | Anything trivially short — the process costs memory |
| **`worker_thread`** | CPU-bound work inside a process. Cheap to spawn, shares memory through `SharedArrayBuffer` | Holding OS resources whose lifetime must outlive the task, like inotify watches |
| **Native async task** (`sharp`, `@parcel/watcher`, napi `AsyncTask`) | Work that already releases the JS thread. `sharp` runs on the libuv threadpool by design | Assuming it is free — the default `UV_THREADPOOL_SIZE` is 4, so many concurrent `sharp` calls queue |

### Recommended placement

| Capability | Where | Why |
|---|---|---|
| Directory scan | **`utilityProcess`**, one `worker_thread` per in-flight scan | The scan is bursty and CPU-bound; workers give parallel scans across Miller columns without blocking each other |
| File watching | **`utilityProcess`**, on its main thread | inotify watches are long-lived OS state. Their lifetime must match the *window*, not a task. A worker that exits drops every watch it held |
| MIME database | **`utilityProcess`**, main thread, loaded once at start | ~115 KB of text parsed once into `Map`s. Shared by every scan worker through the parent |
| Icon resolution | **`utilityProcess`**, main thread, memoised | Cheap per call after warm-up, and the cache must be shared |
| Syntax highlighting | **`utilityProcess`** worker, or the renderer | Input is capped at 64 KiB, so either works. The renderer is simpler; the worker keeps one Shiki instance instead of one per window |
| Image decode of Chromium-native formats | **Renderer**, `<img>` | Chromium decodes off the main thread already. Sending bytes over IPC would be strictly worse |
| HEIC / ICNS / RPGMV decode | **`utilityProcess`** worker | WASM and byte-slicing; must not touch the main process |
| Thumbnail generation with `sharp` | **`utilityProcess`**, native async | `sharp` releases the thread itself. Add an explicit concurrency limit; do not rely on the libuv pool size |
| Archive listing | **`utilityProcess`** worker for JS tiers; `child_process` for `bsdtar` | Both are I/O-bound with a CPU tail |
| Spreadsheet parse | **`utilityProcess`** worker | SheetJS is synchronous and can spend seconds on a large workbook |
| PDF | **Renderer** | It is Chromium's own viewer |
| Copy / move / delete | **`utilityProcess`**, one worker per operation | Needs cancellation, progress, and independent lifetime from any window |
| Fuzzy find (`@ff-labs/fff-node`) | **`utilityProcess`** | It already holds a process-wide LMDB frecency environment. The Qt notes record that LMDB refuses to open the same environment twice in one process — so exactly one process may host it |

**One `utilityProcess` for the whole file-manager backend, not one per capability.** It holds the
MIME maps, the icon cache, the watch registry, and the fff engine, all of which are per-process
singletons that would be duplicated or broken by splitting. Spawn `worker_thread`s inside it for
bursty CPU work.

The `LMDB refuses to open the same environment twice` constraint from the Qt `FuzzyFinder` notes
transfers directly and is the strongest single argument for the one-process design.

---

## 14. Summary table

| # | Capability | Chosen technology | Native module? | In Mesura Code? | Risk |
|---|---|---|---|---|---|
| 1 | Directory listing | `fs.opendir` + `statSync` in a `worker_thread`; lazy MIME/icon/image per row | No | Yes (built in) | **LOW** |
| 2 | File watching | `@parcel/watcher` 2.6.0 (runner-up `chokidar` v4) | Yes — Node-API prebuilt, no compiler | No (chokidar transitively) | **MEDIUM** |
| 3 | MIME + inheritance | Hand-written TS reader over `globs2`/`subclasses`/`aliases` + both implicit rules | No | No | **MEDIUM** |
| 4 | Icon theme | Port `IconThemeResolver` to TS; serve through `protocol.handle()` | No | No | **LOW** |
| 5 | Syntax highlighting | `shiki` 4.2.0 with `@shikijs/engine-javascript` + generated Wine theme | No | **Yes, direct** | **MEDIUM** |
| 6 | Images + thumbnails | Chromium native for 8 formats; `sharp` for TIFF and downscale; `libheif-js` for HEIC; TS ports for ICNS and RPGMV | `sharp` only | **Yes, direct** | **MEDIUM** |
| 7 | Archives | `yauzl` + `tar-stream` + `zlib` in-process; `bsdtar` shell-out for the rest | No | Partly (`yauzl`, `tar`) | **MEDIUM** |
| 8 | Spreadsheets | SheetJS CDN tarball, or `@e965/xlsx`, or drop `.xls` | No (unless `calamine`) | No | **HIGH** |
| 9 | PDF / documents | Chromium built-in viewer; `pdfjs-dist` for thumbnails only | No | No | **LOW** |
| 10 | Trash / open / file ops | `shell.trashItem`, `shell.openPath`, custom streaming copy engine | No | Partly (`ElectronShell.ts`) | **MEDIUM** |
| 11 | Fuzzy find | `@ff-labs/fff-node` 0.9.4 | Yes — already shipped and patched | **Yes, direct** | **LOW** |
| 12 | Audio waveform | Web Audio `decodeAudioData` in the renderer, 300 peak bins | No | No | **LOW** |

---

## 15. Native modules budget

### What this design actually implies

| Module | Status | Kind |
|---|---|---|
| `sharp` | **Already shipped**, direct dep of `scripts`, patched, `allowBuilds: true` | Node-API prebuilt |
| `@ff-labs/fff-node` | **Already shipped**, direct dep of `apps/server`, patched | `ffi-rs` + prebuilt shared library |
| `@parcel/watcher` | **New**, one addition | Node-API prebuilt |
| A Rust `calamine` binding | **Optional**, only if spreadsheets must be first-class | Would need writing |

So the honest count is **one new native dependency** (`@parcel/watcher`), and it needs no
compiler at install time. Everything else that looked like it needed native code — MIME
inheritance, icon resolution, ICNS, RPGMV, directory scanning — turned out not to.

### Can they be collapsed into ONE Rust core?

The tempting design is a single Rust module doing scan + watch + mime + fuzzy find. **Argue
against it**, for four reasons grounded in what this repo already does.

**1. Two of the four are already solved by shipped packages.** `@ff-labs/fff-node` is the same
`fff` engine as the C++ plugin, already patched into `apps/server`, already used by
`WorkspaceSearchIndex.ts`. Folding fuzzy find into a new module means re-implementing something
that works and losing the `apps/server` sharing. Directory scanning needs no native code at all.
A consolidated core would therefore fold in one genuine need (mime), one thing already done
better elsewhere (fff), one thing off-the-shelf and battle-tested (watch), and one thing that
does not need it (scan).

**2. The `native/resource-monitor` precedent points at a sidecar, not a napi addon, and the
sidecar's transport is wrong for scan results.** `resource-monitor` is a plain Rust binary
speaking newline-delimited JSON over stdio, versioned with `PROTOCOL_VERSION: u32 = 2`, resolved
by `ResourceMonitorBinary.ts` across platform, architecture and glibc-versus-musl. That machinery
is real and reusable, and it is the right shape for *low-frequency, streaming* data — which is
exactly what resource telemetry is. It is the wrong shape for a scan of 10,000 entries, which
would become a multi-megabyte JSON line serialised in Rust and parsed in JS on every directory
change. Consolidation forces you to choose one transport for four workloads with different
shapes.

**3. Node-API prebuilds have already removed the pain consolidation was meant to solve.** The
classic argument for one native module is "each one is another thing to compile, rebuild against
Electron's ABI, and asar-unpack". Node-API prebuilds break that argument: `sharp` and
`@parcel/watcher` both ship per-platform binaries compiled against a stable ABI, so neither needs
`electron-rebuild` and neither breaks on an Electron upgrade. The remaining cost is one
`asarUnpack` glob each, which `electron-builder` 26.15.6 already handles.

**4. The one genuine native need has a good non-native answer.** MIME inheritance was the
strongest candidate for a Rust core. Section 5 shows the XDG database ships `globs2`,
`subclasses` and `aliases` as plain text totalling 115 KB, and that the content-sniff fallback
the file manager needs is a NUL-byte scan, not the binary `magic` parser. That removes the last
must-have.

### Recommendation

**Add exactly one native dependency: `@parcel/watcher`. Write no new Rust for this project.**

Two conditions would change that answer, and both should be decided deliberately rather than
drifted into:

- **Spreadsheets become first-class.** Then write a napi-rs binding to `calamine`. It is the one
  place where the Rust option is not merely faster but *better licensed and better maintained*
  than every JavaScript alternative. Do it as a napi-rs addon, not a stdio sidecar — the workload
  is request/response with a bounded result, which is exactly napi's shape.
- **Recursive scanning over very large trees becomes a hot path.** Then a `jwalk`-based scanner
  earns its place. Measure first, the way the `fff` decision was measured — the memory file
  records an 11–20× per-keystroke win backed by real numbers, and that is the bar.

If a Rust core is written anyway, follow the `resource-monitor` shape exactly: a plain binary,
`cargo build --locked --release` behind a root `package.json` script, NDJSON over stdio with an
explicit protocol version, and a typed resolver modelled on `ResourceMonitorBinary.ts` including
its platform / architecture / libc detection and its three tagged error classes. Do not invent a
second convention.

---

## 16. Honest assessment: worse, and better

### What the Electron version will do WORSE

1. **Language coverage in previews.** KSyntaxHighlighting ships roughly 400 language definitions.
   Shiki carries roughly 200 TextMate grammars. Long-tail formats will lose highlighting. This is
   permanent; adding a grammar is possible but is manual work per language.
2. **Memory.** The Qt plugin runs inside one process with a shared Qt runtime. Electron adds a
   Chromium browser process, a GPU process, a renderer per window, and a `utilityProcess`. Expect
   a baseline several hundred megabytes higher, before any file is listed.
3. **Cold start.** The current daemon answers an IPC command and spawns a Qt window. Electron must
   start Chromium. `symmetria-fm.service` keeping the daemon warm mitigates this, but the first
   window after a cold start will be slower.
4. **Per-entry metadata cost.** `QFileInfo` returns size, mtime, permissions, owner and symlink
   state from one cached `stat` with no boundary crossing. Node crosses the JS/C++ boundary per
   call and allocates a `Stats` object per entry. Section 3's lazy split hides this, but the
   underlying cost is higher.
5. **`statfs`-based remote mount detection is gone.** Node has no `statfs` binding. The
   `/proc/self/mountinfo` replacement is better in most ways but is Linux-only and needs its own
   watch, where `statfs` was a single portable syscall.
6. **HEIC decode gets slower.** libheif compiled into the plugin is replaced by libheif in WASM.
   Expect roughly 2–4× slower decode for a 12 MP phone photo. The 2048 px downscale cap keeps it
   tolerable.
7. **Spreadsheets regress.** freexl reads `.xls` cleanly today. Every JavaScript path is
   compromised — stale, CDN-only, or unmaintained. Something gets worse here no matter which
   option is chosen.
8. **Hard links and sparse files.** The current implementation shells out to `cp`, which
   preserves both. A hand-rolled stream copy engine will not.
9. **Native window integration.** Qt talks to the compositor directly. Electron adds a layer, and
   the `WlrKeyboardFocus.Exclusive` problem documented in *Critical Pitfalls* does not get easier.
10. **One more supply chain.** The Qt build depends on distribution packages that Arch audits.
    The Electron build depends on the npm registry.

### What the Electron version will do BETTER

1. **The in-place-write watcher bug disappears.** libuv requests `IN_MODIFY` on directory
   watches; Qt does not. `syncFileWatches`, `kMaxFileWatches`, the warn-once latch and the 250 ms
   debounce-rescan all get deleted, not ported. A growing download reports its size with no
   special case.
2. **The clipboard bug disappears.** Chromium owns the Wayland data-source for the process
   lifetime, so a copied path survives the window that copied it. This is the documented `wl-copy`
   fork-death bug, fixed by the platform.
3. **PDFs become real documents.** Chromium's built-in viewer gives every page, text selection,
   in-document search, zoom and print, against a rasterised first page today. The whole
   PDF-to-cached-PNG path is deleted.
4. **Animated images work by default.** Animated GIF, animated WebP and animated AVIF all play in
   an `<img>` with no code.
5. **AVIF works with no dependency.** Chromium has decoded AVIF since version 85. Qt needs a
   plugin.
6. **SVG icons render as vectors with zero effort.** The hand-rolled path-returning design exists
   in C++ specifically to dodge `QIcon`'s rasterisation. In a browser it is simply how `<img>`
   works.
7. **The watcher can catch up after being closed.** `@parcel/watcher`'s snapshot API answers
   "what changed while this window was shut" — something `QFileSystemWatcher` cannot express at
   all.
8. **Crash isolation.** A `utilityProcess` that dies takes the backend with it, not the windows.
   A libheif or libarchive fault today takes the whole daemon down with every open window.
9. **The MIME implementation becomes inspectable.** `QMimeDatabase` is a black box that silently
   changed behaviour when freedesktop renamed `application/x-yaml` to `application/yaml` — the
   incident that broke YAML previews. A 200-line TypeScript reader over the same files can be
   unit-tested against a table of expected answers, so that class of silent drift becomes a
   failing test.
10. **Fuzzy find is already done.** `@ff-labs/fff-node` is the same engine, already patched into
    `apps/server`, already used for workspace search. Zero porting work, and one engine shared
    between the file manager and the IDE.
11. **Better testing.** Qt Quick Tests need `QT_QPA_PLATFORM=offscreen` and a display abstraction.
    The Node backend is plain functions over a filesystem and runs under `vitest` in CI with no
    display at all. `mesura-code` already runs `vp test run` across the workspace.
12. **The whole preview surface becomes web.** Markdown, HTML, SVG, JSON trees, diffs and video
    are all things a browser does natively and Qt does with a plugin per format.

---

## 17. Sources

https://github.com/libuv/libuv/blob/v1.x/src/unix/linux.c
https://github.com/libuv/libuv/issues/1778
https://docs.libuv.org/en/v1.x/threadpool.html
https://nodejs.org/docs/latest-v24.x/api/fs.html
https://github.com/thecodrr/fdir/blob/master/BENCHMARKS.md
https://dev.to/thecodrr/how-i-wrote-the-fastest-directory-crawler-ever-3p9c
https://github.com/qt/qtbase/blob/dev/src/corelib/io/qfilesystemwatcher_inotify.cpp
https://github.com/parcel-bundler/watcher/blob/master/src/linux/InotifyBackend.cc
https://www.npmjs.com/package/@parcel/watcher
https://github.com/paulmillr/chokidar/blob/main/README.md
https://github.com/notify-rs/notify/blob/main/notify/src/inotify.rs
https://man.archlinux.org/man/inotify.7
https://bugs.archlinux.org/task/47830
https://specifications.freedesktop.org/shared-mime-info/latest/ar01s02.html
https://github.com/wareset/mime-xdg
https://docs.rs/xdg-mime/latest/xdg_mime/
https://github.com/ebassi/xdg-mime-rs
https://specifications.freedesktop.org/icon-theme-spec/icon-theme-spec-latest.html
https://github.com/bastimeyer/freedesktop-icons
https://github.com/maxerbox/get-icon-path
https://github.com/sdumetz/node-desktop-icons
https://shiki.style/guide/bundles
https://shiki.style/guide/regex-engines
https://github.com/shikijs/shiki
https://napi.rs/docs/concepts/async-task
https://sharp.pixelplumbing.com/install/
https://www.testmuai.com/learning-hub/heif-browser-support/
https://www.avif.fast/blog/avif-browser-support-guide
https://issues.chromium.org/issues/40686133
https://specifications.freedesktop.org/thumbnail/latest/
https://github.com/HeavenVolkoff/archive-wasm
https://github.com/ofk/libarchive-wasm
https://github.com/nika-begiashvili/libarchivejs
https://fedoraproject.org/wiki/Licensing:Unrar
https://en.wikipedia.org/wiki/Unrar
https://cdn.sheetjs.com/advisories/CVE-2023-30533
https://git.sheetjs.com/sheetjs/sheetjs/issues/2961
https://www.npmjs.com/package/@e965/xlsx
https://github.com/exceljs/exceljs/issues/2969
https://crates.io/crates/calamine
https://www.electronjs.org/docs/latest/api/shell
https://github.com/electron/electron/issues/28045
https://github.com/electron/electron/issues/24334
https://github.com/electron/electron/issues/9412
