# Preview subsystem — feature inventory for the Electron/TypeScript port

Scope: every file type the Symmetria File Manager can display, how it decides,
how it renders, what it caps, what it caches, and how it fails. Paths are
relative to the repository root. Line references use `path:line`.

Read this document together with `CLAUDE.md` → "Preview Routing (shared)".

---

## 1. The routing decision tree

### 1.1 The two consumers

One router serves both preview surfaces.

| Consumer | File | How it obtains `entry` |
|---|---|---|
| Miller third column | `qml/Symmetria/FileManager/UI/modules/filemanager/PreviewPanel.qml` | A real `FileSystemEntry` from the pane's `FileSystemModel` |
| Fuzzy-finder info pane | `qml/Symmetria/FileManager/UI/modules/filemanager/FuzzyFinderInfoPanel.qml` | A path only; the panel mints an entry via the `FileInfo` element (`FuzzyFinderInfoPanel.qml:39`) |

Both wrap `PreviewContent.qml`. `PreviewContent` owns NO debounce, NO background,
and NO metadata strip (`PreviewContent.qml:8-17`). Each consumer adds those. A new
preview type added to the router therefore appears in both surfaces at once.

`entry` is duck-typed. A real `FileSystemEntry` and a `FileInfo.entry` expose the
same properties (`PreviewContent.qml:16-17`).

### 1.2 The exact order of checks

`PreviewContent.qml:49-79` computes `_previewType`. The order is load-bearing.

```
1.  !entry                                       -> _typeNone        (0)
2.  entry.isDir
      2a. entry.isRemoteMount                    -> _typeRemoteDir   (9)
      2b. otherwise                              -> _typeDirectory   (1)
3.  entry.isImage                                -> _typeImage       (2)
4.  entry.isVideo                                -> _typeVideo       (3)
5.  FileManagerService.isAudioFile(mimeType)     -> _typeAudio       (8)
6.  FileManagerService.isArchiveFile(mimeType)   -> _typeArchive     (6)
7.  FileManagerService.isSpreadsheetFile(mime)   -> _typeSpreadsheet (7)
8.  _htmlRenderActive                            -> _typeHtmlRender  (10)
9.  entry.isText                                 -> _typeText        (4)
10. (catch-all)                                  -> _typeFallback    (5)
```

Two orderings carry design intent.

- Check 8 runs **before** check 9 because `text/html` is `isText`. Toggling
  `Ctrl+R` flips the same file between `_typeText` (highlighted source) and
  `_typeHtmlRender` (WebEngine render).
- Check 9 is the catch-all for every non-binary file. Any text-like type previews
  its contents even when no syntax definition exists. `_typeFallback` is reserved
  for real binaries.

Every branch is a `Loader` with `active: root._previewType === root._type<X>` and
`asynchronous: true` (`PreviewContent.qml:115-334`). Only one Loader is active at a
time, so only one preview component ever exists.

### 1.3 `_htmlRenderActive`

`PreviewContent.qml:45-47`:

```qml
readonly property bool _htmlRenderActive: !!entry && !entry.isDir
    && !!windowState && windowState.htmlRenderActive
    && FileManagerService.isHtmlFile(entry.mimeType)
```

The `!!windowState` guard is why the finder info pane always shows HTML source: it
has no key handler that could set `htmlRenderActive`.

`PreviewContent.qml:113` resets render mode on every `entry` change
(`windowState.resetHtmlRender()`), so Chromium never spins up during plain `j`/`k`
navigation.

### 1.4 How `isText` is computed in C++

Single source of truth: `FileSystemEntry.isText`, produced by `isTextLike()` in
`plugin/src/Symmetria/FileManager/Models/filesystemmodel.cpp:82-88`.

```cpp
static bool isTextLike(const QMimeType& mime, const QString& path) {
    if (mime.inherits(QStringLiteral("text/plain")))
        return true;
    if (!mime.isValid() || mime.name() == QStringLiteral("application/octet-stream"))
        return looksLikeText(path);
    return false;
}
```

Rule 1 — **MIME inheritance**. `QMimeType::inherits("text/plain")` walks the
freedesktop shared-mime-info inheritance graph. This is structural, not a hand-kept
list. It captures `application/yaml`, `application/toml`, `text/csv`,
`application/json`, `application/xml`, `text/html`, and every registered `text/*`
subtype without naming any of them. `CLAUDE.md` records why: the previous QML-side
string list rotted after the `application/x-yaml` → `application/yaml` rename, and
YAML silently stopped previewing.

Rule 2 — **the NUL-byte sniff fallback**, `looksLikeText()` at
`filesystemmodel.cpp:66-74`. It fires only when the MIME database is invalid or
returns exactly `application/octet-stream`.

- Open the file read-only. Failure to open → `false`.
- Read the first **4096 bytes**.
- Empty read → `false`. A 0-byte unknown gets the metadata fallback card, which is
  more useful than an empty text pane.
- Return `!head.contains('\0')`.

In practice the sniff is nearly unreachable for readable ASCII: Qt's content magic
classifies plain ASCII as `text/plain` first, so rule 1 already matched. The test
`FileInfoTest::extensionlessConfigIsText` (`plugin/tests/FileInfoTest.cpp:202`)
documents exactly this, and the comment at `filesystemmodel.cpp:58-63` states that
isolating the sniff in a unit test is impractical for the same reason.

Directories never compute `isText`; `buildCachedEntryData` skips the whole MIME
block when `fileInfo.isDir()` (`filesystemmodel.cpp:117-130`).

### 1.5 How the other entry predicates are computed

`buildCachedEntryData()` (`filesystemmodel.cpp:104-133`) runs on a worker thread and
pre-computes everything so the QML-facing accessors are trivial field reads.

- `mimeType` = `QMimeDatabase::mimeTypeForFile(path).name()`. Qt uses extension plus
  content magic.
- `isVideo` = `mimeType.startsWith("video/")` (`filesystemmodel.cpp:121`).
- `isImage` = `isCustomDecodedImage(path) || QImageReader(path).canRead()`
  (`filesystemmodel.cpp:124-129`). `QImageReader::canRead()` opens the file and asks
  every installed Qt image plugin.
- `isCustomDecodedImage()` (`filesystemmodel.cpp:96-102`) force-flags
  `.rpgmvp`, `.png_`, `.icns`, `.heic`, `.heif` as images even though
  `canRead()` says no. The comment demands it stay in sync with
  `PreviewImageHelper::needsCachedDecode` / `::isHeifFormat`.
- `isRemoteMount` = directory whose `statfs` f_type is a remote magic AND differs
  from its parent's f_type (`filesystemmodel.cpp:40-47`, `112`). Only the mount root
  is flagged.
- `isSymlink` / `symlinkTarget` come straight from the cached `QFileInfo`
  (`filesystemmodel.cpp:245-254`).
- `iconPath` = `IconThemeResolver::resolveForFile(...)` (`filesystemmodel.cpp:175`).

All `FileSystemEntry` properties are declared `CONSTANT`
(`filesystemmodel.hpp:70-85`). Entries are immutable snapshots; the model destroys
and recreates them on any filesystem change.

### 1.6 The QML-side MIME predicates

All in `qml/Symmetria/FileManager/UI/services/FileManagerService.qml`.

- `isArchiveFile` (line 212) — membership in the `_archiveMimeTypes` object
  (lines 185-210).
- `isAudioFile` (line 222) — `mimeType.startsWith("audio/") || mimeType === "application/ogg"`.
- `isHtmlFile` (line 230) — exactly `text/html` or `application/xhtml+xml`. It gates
  only the render TOGGLE, never the default classification.
- `isSpreadsheetFile` (line 234) — a six-entry list.
- `iconNameForMime` (line 245) — Material glyph fallback: `text/*` → `article`,
  `video/*` → `movie`, audio → `music_note`, `application/pdf` → `picture_as_pdf`,
  else `description`.

Lines 216-220 carry an explicit prohibition: never reintroduce a QML text-mime list.

---

## 2. One section per preview type

Each section ends with a **Port to Electron** line.

### 2.1 No selection (`_typeNone`)

- Trigger: `entry` is null or undefined.
- Component: `PreviewStateIndicator` with `iconName: "description"`, message
  `"No preview"` (`PreviewContent.qml:118-127`).
- No I/O, no C++ backing.
- `PreviewPanel` clears this state instantly, bypassing the debounce
  (`PreviewPanel.qml:29-33`).

**Port to Electron:** a static React component. **easy.**

### 2.2 Directory (`_typeDirectory`)

- Trigger: `entry.isDir && !entry.isRemoteMount`.
- Component: inline `Item` in `PreviewContent.qml:130-195`, holding a `ListView`
  whose model is a full second `FileSystemModel` instance
  (`PreviewContent.qml:177-184`).
- C++ backing: `FileSystemModel` (`filesystemmodel.cpp`), async directory scan.
- Configuration of the sub-model: `showHidden` from `Config.fileManager.showHidden`,
  `sortBy` / `sortReverse` mirrored from `WindowState` (defaults
  `FileSystemModel.Modified` + reverse), and **`watchChanges: false`** — the preview
  listing does not arm an inotify watch.
- Delegate: `FileListItem`, including flash-navigation label and match-offset
  plumbing (`PreviewContent.qml:186-192`).
- Outputs: `directoryEntries` and `directoryPath` are re-exported for cross-column
  flash navigation (`PreviewContent.qml:25-27`), and `PreviewPanel` forwards them
  (`PreviewPanel.qml:21-22`).
- Empty state: `PreviewStateIndicator` `folder_open` / "Empty folder", shown only
  when `count === 0 && !model.loading` (`PreviewContent.qml:136-150`).
- Loading state: `PreviewLoadingIndicator` while `model.loading`
  (`PreviewContent.qml:152-163`).
- Limits: whatever `FileSystemModel` enforces for the main pane; the preview does not
  add its own cap.

**Port to Electron:** `fs.promises.opendir` in the main process, streamed over IPC
to a virtualized list (`react-window` / TanStack Virtual). **easy.**

### 2.3 Remote directory (`_typeRemoteDir`)

- Trigger: `entry.isDir && entry.isRemoteMount`. Remote-ness is decided by `statfs`
  f_type against a remote-magic set, and only at the mount root
  (`filesystemmodel.cpp:40-47`).
- Component: a static `ColumnLayout` — `lan` icon, "Remote directory", "Press Enter
  to browse" (`PreviewContent.qml:198-229`).
- Deliberately performs **no I/O**. This exists so the preview pane never blocks on
  an unresponsive SSHFS/NFS mount during `j`/`k` navigation.

**Port to Electron:** read `/proc/self/mountinfo` (or `statfs` via a native addon /
`fs.statfs` on modern Node) and compare the filesystem type to a remote list.
**medium** — Node's `fs.statfs` exposes `type` but the magic constants must be
hard-coded, exactly as the C++ does.

### 2.4 Images — the general path (`_typeImage`)

- Trigger: `entry.isImage`.
- Component: `ImagePreview.qml`.
- C++ backing: `PreviewImageHelper` (`previewimagehelper.cpp`).
- Third-party libraries: Qt's image-format plugins.

Formats reachable through `QImageReader::canRead()` on the target machine, taken
from `/usr/lib/qt6/plugins/imageformats/`:

| Plugin | Formats |
|---|---|
| built into QtGui | PNG, JPEG, BMP, PPM/PGM/PBM, XBM, XPM |
| `libqgif.so` | GIF |
| `libqjpeg.so` | JPEG |
| `libqico.so` | ICO, CUR |
| `libqicns.so` | ICNS (present, but the FM bypasses it — see 2.6) |
| `libqjp2.so` | JPEG 2000 |
| `libqmng.so` | MNG |
| `libqsvg.so` | SVG, SVGZ |
| `libqtga.so` | TGA |
| `libqtiff.so` | TIFF |
| `libqwbmp.so` | WBMP |
| `libqwebp.so` | WebP |
| `libqpdf.so` | PDF (first page rasterized) |

This list is discovered at runtime, not declared in the source. Any plugin the user
installs widens the supported set with no code change. That is a real behavioural
property the port has to decide whether to reproduce.

Render path in `ImagePreview.qml`:

- `PreviewImageHelper.source = entry.path` (line 18-21).
- A QML `Image` binds `source: previewHelper.resolvedUrl`, `asynchronous: true`,
  `fillMode: PreserveAspectFit`, `smooth: true`, `mipmap: true` (lines 23-38).
- **Decode cap**: `sourceSize` is `max(root.width, 1) * 2` by
  `max(root.height, 1) * 2`. The 2× factor keeps HiDPI crispness while capping the
  decoded pixel buffer (lines 35-38).
- `naturalSize` is exported for the metadata strip only when
  `status === Image.Ready` (lines 12-14).
- Fade-in via `Behavior on opacity { Anim {} }` (lines 40-44).
- Loading state covers **both** phases: C++ cached decode (`previewHelper.loading`)
  and Qt's own decode (`Image.Loading`) (lines 49-55).
- Error state: `PreviewStateIndicator` `broken_image` / "Cannot preview", shown only
  when the helper is done AND `Image.Error` (lines 58-67).

Animated GIF/WebP: `ImagePreview` uses `Image`, **not** `AnimatedImage`. Animated
files therefore render as their **first frame only**, static. No code path enables
animation.

**Port to Electron:** a plain `<img src="file://...">` covers PNG/JPEG/GIF/WebP/SVG/
BMP/ICO natively and animates GIF/WebP for free. TIFF, TGA, JP2, MNG, WBMP,
PPM/XPM need `sharp` (libvips) to transcode to PNG in the main process. **easy** for
the common set, **medium** for the long tail.

### 2.5 PDF (routed as image)

- Trigger: `entry.isImage` is true for `.pdf` because `libqpdf.so` makes
  `QImageReader::canRead()` succeed. There is no explicit PDF branch in the router.
- `needsCachedDecode()` returns true for `.pdf`
  (`previewimagehelper.cpp:139-147`), so the file takes the cached-decode path.
- Decode: `generateCachedPreview()` falls through to the default branch
  (`previewimagehelper.cpp:191-199`):
  - `QImageReader reader(sourcePath);`
  - `reader.setBackgroundColor(Qt::white);` — this is the **background compositing**
    step. Without it a PDF with a transparent page background renders as
    dark-on-dark.
  - `reader.read()` returns page 1 only.
  - `image.save(cachePath, "PNG")`.
- Cache: see §2.11. Cache key includes the file's mtime.
- Failure: `generateCachedPreview` returns an empty string; `processSource` then
  falls back to the raw `file://` source URL (`previewimagehelper.cpp:127-133`),
  which yields `Image.Error` and the "Cannot preview" card.
- **Open policy**: `resolvePathForOpen()` returns the **source** path for PDFs, not
  the cache (`previewimagehelper.cpp:247-267`). The header comment records the
  regression this fixed — returning the cached PNG misrouted PDFs into the image
  viewer instead of the user's configured reader (e.g. sioyek). Tests
  `resolvePathForOpen_cachedPdf_returnsSoucePath` and
  `resolvePathForOpen_uncachedPdf_returnsSourcePath` pin it
  (`plugin/tests/PreviewImageHelperTest.cpp:106`, `:121`).

**Port to Electron:** PDF.js renders page 1 to a `<canvas>` with a white fill, no
native dependency, and gives multi-page scroll for free. **easy** — this is a case
where the browser platform is strictly better than Qt.

### 2.6 ICNS

- Trigger: `.icns` suffix, case-insensitive. Force-flagged as image at
  `filesystemmodel.cpp:99`, force-flagged for cached decode at
  `previewimagehelper.cpp:145`.
- C++ backing: `IcnsDecoder::extractLargestPng` (`icnsdecoder.cpp:38-129`).
- Third-party library: **none**. The decoder is hand-rolled binary parsing.
- Algorithm:
  - Require file size ≥ 8. Read the 8-byte header, require magic `"icns"`, read the
    big-endian declared total size.
  - `endOffset = min(declaredSize, actualFileSize)` — tolerates truncation.
  - Walk chunks from offset 8. Each chunk is an 8-byte header (4-byte big-endian tag
    + 4-byte big-endian size that INCLUDES the header) followed by data.
  - Score the tag against a fixed priority list of PNG-bearing chunk types, best
    first (`icnsdecoder.cpp:18-27`): `ic10` (1024²), `ic14` (512²@2x),
    `ic09` (512²), `ic13` (256²@2x), `ic08` (256²), `ic12` (64²@2x),
    `ic07` (128²), `ic11` (32²@2x). Break early on priority 0.
  - A malformed chunk uses `continue`, not `break`, so one bad chunk does not abort
    the scan. A zero-size chunk does `break` to avoid an infinite loop.
  - Validate the extracted payload against the full 8-byte PNG signature.
  - Write the bytes to the cache path verbatim — no re-encode.
- Failure: any check returns an empty string, and a partial write is removed
  (`icnsdecoder.cpp:121-125`).
- Qt HAS an ICNS plugin (`libqicns.so`) on this machine, yet the code bypasses it.
  The reason is the deliberate "extract the largest embedded PNG" policy — the
  decoder picks the highest-resolution variant rather than whatever the plugin
  selects.
- **Open policy**: source path, not cache (`previewimagehelper.cpp:169-171`).

**Port to Electron:** `icns-lib` or `@fiahfy/icns` parse the same container in pure
JS; the fallback is 40 lines of `Buffer` parsing that mirror the C++ exactly.
**easy.**

### 2.7 HEIC / HEIF

- Trigger: `.heic` / `.heif` suffix, case-insensitive
  (`previewimagehelper.cpp:152-155`, `filesystemmodel.cpp:100-101`).
- C++ backing: `HeifDecoder::decodeToPng` (`heifdecoder.cpp:22-104`).
- Third-party library: **libheif** (`PkgConfig::Libheif` in
  `plugin/src/Symmetria/FileManager/Models/CMakeLists.txt:27`).
- Why a custom decoder at all: Arch's `qt6-imageformats` is built WITHOUT libheif,
  so Qt exposes no HEIF image plugin and `QImageReader::canRead()` returns false.
  Recorded in `CLAUDE.md` and in `filesystemmodel.cpp:90-95`.
- Algorithm:
  - `HeifInitGuard` calls `heif_init(nullptr)` on entry and `heif_deinit()` on every
    return path. libheif ≥ 1.13 needs the explicit init because decoder plugins
    (libde265 and friends) are dynamically loaded on some distros. init/deinit are
    refcounted and thread-safe, so concurrent decodes are safe.
  - `heif_context_read_from_file` → `heif_context_get_primary_image_handle` →
    `heif_decode_image(..., heif_colorspace_RGB, heif_chroma_interleaved_RGBA, ...)`.
  - Wrap the libheif plane as `QImage::Format_RGBA8888` and immediately `.copy()` so
    the QImage owns its pixels before the libheif buffers are released.
  - **Downscale cap**: `kMaxPreviewDim = 2048` (`heifdecoder.cpp:17`). If either
    dimension exceeds it, scale with `KeepAspectRatio` +
    `SmoothTransformation`. Rationale in the header comment: phone HEICs are 12 MP+
    and the preview pane never shows that detail; opening the file launches the real
    viewer.
  - `image.save(cachePath, "PNG")`. On save failure, remove the partial file, matching
    the ICNS/RPGMV cleanup discipline (`heifdecoder.cpp:95-101`).
- Tests: `HeifDecoderTest` covers a valid decode, parent-directory creation, a
  missing source, and corrupt data (`plugin/tests/HeifDecoderTest.cpp:54-112`).
- **Open policy**: source path, not cache — pinned by
  `resolvePathForOpen_cachedHeic_returnsSourcePath`
  (`plugin/tests/PreviewImageHelperTest.cpp:311`).

**Port to Electron:** `sharp` decodes HEIF **only** when its libvips build includes
libheif — the prebuilt npm binaries historically do not. The reliable options are
`libheif-js` / `heic-decode` (Emscripten build of libheif, pure WASM, no native
build step) or `heic-convert`. **medium** — the code is simple but licensing
(HEVC patents) and bundle size are the real friction, and a WASM decode of a 12 MP
image is materially slower than native.

### 2.8 RPGMV encrypted game assets (`.rpgmvp` / `.png_`)

Undocumented in `CLAUDE.md`; found only in the source.

- Trigger: `.rpgmvp` or `.png_` suffix (`previewimagehelper.cpp:160-163`).
- C++ backing: `PreviewImageHelper::decryptRpgmvp`
  (`previewimagehelper.cpp:202-245`).
- Third-party library: none.
- Algorithm: the file layout is `[16-byte RPGMV signature][16-byte XOR-encrypted PNG
  header][rest of PNG]`. The first 16 plaintext bytes of ANY PNG are constant (8-byte
  magic + 4-byte IHDR length + `"IHDR"`), so the decoder skips 32 bytes, writes the
  known 16-byte prefix, and appends the untouched remainder. **No XOR key is needed.**
- Minimum size 32 bytes; empty remainder → failure; a partial write is removed.
- **This is the only format whose cache IS the user-facing artifact.**
  `cacheIsOpenableArtifact()` returns true only here
  (`previewimagehelper.cpp:169-171`), so `resolvePathForOpen` redirects to the cache
  and, on a cache miss, generates it synchronously on the GUI thread — documented as
  <1 ms even for large files (`previewimagehelper.cpp:261-266`).
- `resolvePathForPreview` deliberately does NOT generate: for RPGMV a cache miss
  returns the raw encrypted path that Qt cannot decode, and the caller must ensure a
  live `PreviewImageHelper` is populating the cache asynchronously
  (`previewimagehelper.hpp:38-43`). Pinned by
  `resolvePathForPreview_uncachedRpgmvp_returnsSourcePathWithoutDecrypting`.

**Port to Electron:** trivial `Buffer` slicing plus a `Buffer.concat` with the
constant 16-byte PNG prefix. **easy.**

### 2.9 SVG

- Trigger: no special branch. `libqsvg.so` makes `QImageReader::canRead()` succeed,
  so SVG is an ordinary `_typeImage`, rasterized by Qt at `sourceSize`.
- The SVG is re-rasterized whenever `sourceSize` changes, so it stays crisp on
  resize.
- Icons are a separate, deliberate SVG story — see §4.

**Port to Electron:** `<img>` renders SVG as vector, which is strictly better than
Qt's rasterization. **easy.** One caveat: an `<img>`-sourced SVG cannot execute
script, which is the desired sandbox; do NOT inline untrusted SVG into the DOM.

### 2.10 Video (`_typeVideo`)

- Trigger: `mimeType.startsWith("video/")`.
- Component: `VideoPreview.qml`.
- Backing: Qt's `QtMultimedia` `MediaPlayer` + `VideoOutput`; the decoder underneath
  is FFmpeg or GStreamer depending on the Qt build.
- Behaviour: `autoPlay: true`, `loops: MediaPlayer.Infinite`
  (`VideoPreview.qml:19-26`). The preview plays a silent loop — there is no
  `audioOutput`, so video previews are muted by construction.
- `naturalSize` is read from `metaData.value(MediaMetaData.Resolution)`, with
  `mediaStatus` touched first purely to make the binding re-evaluate when metadata
  arrives (`VideoPreview.qml:12-17`).
- `fillMode: PreserveAspectFit`, fade-in on `hasVideo && sourceRect.width > 0`.
- Loading state covers `LoadingMedia`, `BufferingMedia`, `StalledMedia`
  (`VideoPreview.qml:43-51`).
- Error state: `videocam_off` / "Cannot preview".
- No byte cap, no timeout, no cache.
- URL construction is `encodeURI("file://" + path)` — note this is **less** careful
  than `HtmlPreview`'s escaping (see §2.14); a `%` or `#` in a video filename is a
  latent bug here.

**Port to Electron:** `<video autoplay loop muted src="file://...">`. Chromium plays
MP4/H.264, WebM, and Ogg out of the box; MKV, AVI, and many codecs do NOT play in a
stock Electron build. **medium** — the fix is a `ffmpeg`/`ffprobe` sidecar that
extracts a poster frame, which is arguably a better preview anyway.

### 2.11 The cached-decode image pipeline (shared by PDF, ICNS, HEIF, RPGMV)

All in `plugin/src/Symmetria/FileManager/Models/previewimagehelper.cpp`.

**Gate.** `needsCachedDecode(path)` (lines 139-147) is a pure suffix test —
deliberately, so the GUI thread never opens the file:

```
.pdf | .rpgmvp | .png_ | .icns | .heic | .heif
```

Everything else is passthrough: `resolvedUrl = "file://" + source`, zero overhead
(lines 89-92).

**Cache key.** `buildCacheKey()` (lines 16-22) is
`SHA1(path + ":" + mtimeSecondsSinceEpoch)` rendered as hex. Including mtime means a
file edited in place produces a different key, so a stale thumbnail is never served.
Old entries are never evicted — **the cache grows without bound.** No eviction,
no size cap, no TTL exists anywhere in the codebase.

**Cache location.** `cacheDir()` (lines 277-282) is
`QStandardPaths::writableLocation(CacheLocation) + "/preview"`. On this machine that
resolves to `~/.cache/symmetria-fm/preview/`. Computed once per process. Files are
`<sha1hex>.png`.

**Flow of `processSource()`** (lines 64-137):

1. Cancel any in-flight watcher: `disconnect()` first, then `cancel()`, then
   `deleteLater()`, then null the pointer. The disconnect-before-null ordering is
   explicitly commented as preventing a `finished` signal from firing against a stale
   `this` (lines 65-73).
2. Empty source → clear `resolvedUrl` and `loading`, return.
3. Not `needsCachedDecode` → passthrough, return.
4. **Cache hit** (`QFileInfo::exists(cachePath)`) → apply the cached URL immediately.
   No thread is spawned.
5. Cache miss → set `loading = true`, spawn
   `QtConcurrent::run(generateCachedPreview, source, cachePath)`.
6. On finish: if `m_source != capturedSource` the result is **discarded** (line 118).
   This helper uses a captured-source comparison rather than an integer generation
   counter — see §3.
7. On empty result, fall back to `"file://" + m_source` so the QML `Image` gets a
   chance and produces a real error state (lines 127-133).

**`generateCachedPreview()` dispatch** (lines 177-200), in order:
RPGMV → ICNS → HEIF → default PDF/QImageReader branch. It calls
`QDir().mkpath()` first so every handler can assume the directory exists.

**Two resolution helpers, deliberately asymmetric:**

| Function | Purpose | Generates a cache? |
|---|---|---|
| `resolvePathForOpen` (lines 247-267) | path handed to `xdg-open`, used by `FileOpener.qml:19` | Only for RPGMV, synchronously |
| `resolvePathForPreview` (lines 269-275) | path the preview pane should render | Never |

**Port to Electron:** a main-process cache directory under `app.getPath('cache')`,
keyed by `sha1(path + ':' + mtimeMs)`, with the decode dispatched to a worker thread
(`worker_threads`) or a `utilityProcess`. **easy** as infrastructure; the per-format
decoders carry the risk, not the cache.

### 2.12 Plain text and syntax-highlighted code (`_typeText`)

Same component, same pipeline — highlighting is simply absent when
KSyntaxHighlighting has no definition for the file.

- Trigger: `entry.isText` and no earlier branch matched.
- Component: `TextPreview.qml`.
- C++ backing: `SyntaxHighlightHelper` (`syntaxhighlighthelper.cpp`).
- Third-party library: **KF6::SyntaxHighlighting** (KSyntaxHighlighting, the Kate
  engine, ~350 XML language definitions).

**Limits** (`syntaxhighlighthelper.hpp:78-80`):

| Constant | Value | Meaning |
|---|---|---|
| `MaxBytes` | 65536 | Bytes read from the file. Reading exactly this many sets `truncated`. |
| `MaxLines` | 500 | Line cap. Truncation reports `lineCount = MaxLines + 1 = 501`. |
| `BinaryScanBytes` | 8192 | NUL-byte scan window for binary detection. |

**`computeHighlight()`** (`syntaxhighlighthelper.cpp:145-209`), on a worker thread:

1. Open the file. Failure → `isError = true`, return.
2. `file.read(MaxBytes)`. `byteTruncated = (raw.size() == MaxBytes)`.
3. **Binary detection**: scan `min(raw.size(), 8192)` bytes for `'\0'`. Any NUL →
   `isError = true`, return immediately. Note this is a SECOND, stricter NUL check
   than `isTextLike`'s 4096-byte sniff, and it runs on every text preview including
   files that `isTextLike` accepted by MIME inheritance. A `text/plain`-inheriting
   file containing a NUL still renders the error card. Pinned by
   `SyntaxHighlightHelperTest::binaryFileReturnsError`.
4. Decode with `QStringDecoder(Utf8)` — invalid sequences become replacement
   characters, never an error.
5. Truncate at the 500th `'\n'`, keeping that newline.
6. `lineCount = truncated ? 501 : newlineCount + 1`.
7. `truncated = byteTruncated || linesTruncated`.
8. `language = def.translatedName()` when a definition matched, else empty.

**Rendering** in `TextPreview.qml`:

- A `TextEdit` in `textFormat: TextEdit.RichText`, `readOnly`, `selectByMouse: false`,
  `activeFocusOnPress: false`, `wrapMode: NoWrap`, mono font at
  `FmTheme.font.size.xs`, `renderType: QtRendering` (lines 35-50).
- Inside a `Flickable` with `interactive: false` — the preview does **not** scroll.
  Only the first screenful is reachable.
- Explicit `x`/`y`/`width`/`height` instead of `anchors.margins`, per the Loader
  quirk (`QUIRKS.md` §1), commented at lines 20-21.
- The QML `color` property is deliberately NOT set; the colour comes from the
  injected `<pre style="color:...">`. In RichText mode the HTML wins (lines 47-48).
- Error card: `block` / "Cannot preview" when `helper.error`.

**Port to Electron:** `shiki` (TextMate grammars, the same family Kate's XML
definitions compete with, and the closest match in output fidelity) or
`highlight.js` for a lighter bundle; `tree-sitter` if incremental parsing is ever
needed. Read the first 64 KiB with a bounded `fs.read`, NUL-scan the first 8 KiB,
`TextDecoder('utf-8', {fatal:false})` for the lossy decode. **easy** — and the web
version gets real scrolling, selection, and search for free.

### 2.13 Markdown

There is **no Markdown-specific preview**. `.md` files are `isText`, take the
`_typeText` branch, and render as syntax-highlighted **source** using
KSyntaxHighlighting's Markdown definition. `SyntaxHighlightHelperTest` line 76
confirms the intent: it asserts that a Markdown heading picks up the Wine theme's
`Function` colour. No renderer, no `marked`, no `cmark` anywhere in the tree.

**Port to Electron:** if the port keeps parity, nothing changes. If it adds a
rendered view, `marked` or `markdown-it` plus `DOMPurify` gives a real Markdown
preview cheaply — a capability Qt made expensive enough that the project never
built it. **easy**, and a straight upgrade.

### 2.14 HTML render (`_typeHtmlRender`)

- Trigger: `_htmlRenderActive` — an `.html`/`.xhtml` file (MIME `text/html` or
  `application/xhtml+xml`) whose `WindowState.htmlRenderActive` is true.
- Toggle: `Ctrl+R`, registry row `miller.htmlRender`
  (`qml/Symmetria/FileManager/UI/modules/filemanager/handlers/KeyRegistry.js:352-357`).
  Its `when()` gates on `isHtmlFile`, so `Ctrl+R` falls through (is NOT consumed) on
  any other file, and so it never clashes with `op.pickerSaveEdit`, which is also
  `Ctrl+R` but gated on `pickerSaveMode` and scanned earlier in `CORE`.
- Per-file, never sticky: `PreviewContent.qml:113` resets the flag on every entry
  change. Chromium spins up only on deliberate intent.
- Component: `HtmlPreview.qml`. It is isolated in its own file precisely so
  `import QtWebEngine` and the Chromium view instantiate only when the Loader
  activates (`PreviewContent.qml:284-297`).
- Backing: `QtWebEngine` (Chromium).

**Sandbox settings** (`HtmlPreview.qml:61-86`), each one load-bearing:

| Setting | Value | Why |
|---|---|---|
| `profile.offTheRecord` | `true` | no cookies, no history |
| `profile.httpCacheType` | `NoCache` | zero disk trace |
| `settings.javascriptEnabled` | `Config.fileManager.htmlPreviewJavaScript`, default **false** (`config/FileManagerConfig.qml:12`) | static pages render; JS-built pages render blank unless opted in |
| `settings.localContentCanAccessRemoteUrls` | `false` | the page cannot fetch ANY remote resource — no trackers, no beacons, cannot phone home |
| `settings.localContentCanAccessFileUrls` | `true` | sibling css/img/js load from disk. Accepted trade-off: a hostile file CAN reference other local files, but with remote access and JS both off there is no exfiltration channel |
| `settings.focusOnNavigationEnabled` | `false` | never steal focus |
| `settings.javascriptCanOpenWindows` | `false` | |
| `settings.pluginsEnabled` | `false` | |
| `settings.screenCaptureEnabled` | `false` | |
| `settings.errorPageEnabled` | `false` | the component draws its own error card |
| `activeFocusOnPress` | `false` | the Miller list keeps keyboard focus so `Ctrl+R` and `j`/`k` always reach `Keys.onPressed` |
| `backgroundColor` | `"white"` | browsers default pages to white; the dark FM backdrop would otherwise bleed through pages that assume white |

`onNavigationRequested` ignores everything except `TypedNavigation`
(lines 83-86) — link clicks, form submits, and any hop to another document are
blocked. This stays a preview, not a mini-browser.

WebEngine reads `settings.*` at page-LOAD time, so flipping the JS config re-applies
only on the next render, not to an already-loaded page (lines 66-68).

**URL escaping** (lines 36-39) — the ordering is a fixed bug:

```qml
"file://" + encodeURI(entry.path.replace(/%/g, "%25"))
    .replace(/#/g, "%23").replace(/\?/g, "%3F")
```

A literal `%` is escaped FIRST because `encodeURI` does not touch `%` and would
leave a stray `%NN`-looking sequence — `50%.html` failed to load. Then `encodeURI`
handles spaces. Then `#` and `?` are escaped last so a filename containing them is
not parsed as a fragment or query.

- Loading state: `PreviewLoadingIndicator` while `webView.loading`.
- Error state: `_loadFailed`, flipped by `onLoadingChanged` on
  `LoadFailedStatus` and cleared on `LoadStartedStatus`; shows
  `block` / "Cannot render".
- Mode hint: a `Rectangle` at top-right reading "Rendered · Ctrl+R to exit".

**Host requirement.** Instantiating a `WebEngineView` requires the host to have
called `QtWebEngineQuick::initialize()` in `main()` before the QML engine loads. The
standalone host does; an embedding host (the IDE) must do it itself or the render
fails. Importing the module alone is harmless.

**Port to Electron:** a sandboxed `<webview>` or a `BrowserView` with
`nodeIntegration: false`, `contextIsolation: true`, `javascript: false`, plus a
`session.webRequest.onBeforeRequest` handler that blocks every non-`file:` scheme.
**easy** — this is the single biggest architectural simplification of the whole
port: Electron already IS Chromium, so a whole heavyweight optional dependency
disappears.

### 2.15 Archives (`_typeArchive`)

- Trigger: `isArchiveFile(mimeType)` — an explicit 24-entry MIME set at
  `FileManagerService.qml:185-210`:

```
application/zip                              application/x-tar
application/x-7z-compressed                  application/x-rar
application/x-rar-compressed                 application/vnd.rar
application/x-cpio                           application/vnd.ms-cab-compressed
application/x-xar                            application/x-compressed-tar
application/x-bzip-compressed-tar            application/x-xz-compressed-tar
application/x-zstd-compressed-tar            application/x-lzma-compressed-tar
application/gzip                             application/x-gzip
application/x-bzip2                          application/x-xz
application/zstd                             application/x-zstd
application/x-iso9660-image                  application/x-debian-package
application/java-archive                     application/epub+zip
```

- Component: `ArchivePreview.qml`.
- C++ backing: `ArchivePreviewModel` (a `QAbstractListModel`).
- Third-party library: **libarchive**.

**Reader configuration** (`archivepreviewmodel.cpp:116-122`):
`archive_read_support_filter_all` + `archive_read_support_format_all` +
`archive_read_support_format_raw`. The raw format is what makes single-file
compressed streams (`.gz`, `.bz2`, `.xz`) listable. Block size 10240.

**Tree construction.** Archive entries are flat paths; `ensurePath()`
(lines 73-102) materializes every intermediate directory, then `flattenTree()`
(lines 41-69) emits depth-first with **directories before files at each level**,
each group sorted by name via `std::map` ordering. Pinned by
`ArchivePreviewModelTest::directoriesBeforeFiles`.

**Entry normalization** (lines 133-154):
- Prefer `archive_entry_pathname_utf8`; fall back to `archive_entry_pathname`
  decoded as local 8-bit. Best-effort for Latin-1 / Shift-JIS archives; exotic cases
  may produce replacement characters.
- Chop trailing slashes; skip empty and `"."` entries.
- Size is taken only when `archive_entry_size_is_set()` — ZIP with data descriptors
  and RAW streams report 0, and those must not pollute `totalSize`.

**Cap.** `MaxEntries = 5000` (`archivepreviewmodel.hpp:82`). `flattenTree` stops
emitting at the cap; `totalEntries` stays the uncapped raw scan count;
`truncated = entries.size() < totalEntries` (line 181). The UI shows
"Showing %1 of %2 entries" (`ArchivePreview.qml:116-125`).

**Errors.** `archive_errno() != 0` after the read loop populates `error`, even when
some entries were read — a mid-archive failure means the listing is partial, and the
caller sees both. Password-protected archives land here. Tests:
`corruptedArchiveGracefulFailure`, `nonExistentFileReportsError`.

No timeout exists. A pathological archive blocks its worker thread until libarchive
returns.

**QML notes.** `_isEmpty` is updated **imperatively** from a `Connections` block
(`ArchivePreview.qml:25-41`) rather than as a declarative binding, because the C++
model emits several NOTIFY signals in one batch and QML re-enters the binding. The
delegate indents by `depth * 18` px.

**Port to Electron:** no single library covers this range.
- ZIP → `yauzl` (streaming, no extraction) or `adm-zip`.
- TAR + gz/bz2/xz/zstd → `tar-stream` plus `zlib` / `lzma-native` / `@napi-rs/zstd`.
- 7z, RAR, ISO, CAB, XAR, CPIO, DEB → `node-7z` shelling out to a `7z` binary, or
  `libarchive.js` (an Emscripten build of the very same libarchive).
- **hard.** `libarchive.js` is the only option that preserves the exact format
  coverage, and it moves the whole decompression into WASM. Shelling out to `7z`
  adds an external binary dependency the current app does not have.

### 2.16 Spreadsheets (`_typeSpreadsheet`)

- Trigger: `isSpreadsheetFile(mimeType)`, exactly six types
  (`FileManagerService.qml:234-243`):
  `application/vnd.ms-excel` (.xls),
  `…spreadsheetml.sheet` (.xlsx),
  `…spreadsheetml.template` (.xltx),
  `…ms-excel.sheet.macroEnabled.12` (.xlsm),
  `…ms-excel.template.macroEnabled.12` (.xltm),
  `…ms-excel.sheet.binary.macroEnabled.12` (.xlsb).
- Component: `SpreadsheetPreview.qml`.
- C++ backing: `SpreadsheetPreviewModel` (a `QAbstractTableModel`).
- **Dual library, selected by extension**, not by MIME
  (`spreadsheetpreviewmodel.cpp:26-28`):
  - `.xls` (case-insensitive) → **libfreexl** (BIFF binary).
  - everything else → **QXlsx** (ZIP-of-XML).
  - Note the gap: `.xlsb` matches the MIME gate but is routed to QXlsx, which does
    not read the binary BIFF12 format. It will surface "Failed to open spreadsheet".

**Caps.** `MaxRows = 200`, `MaxCols = 50` (`spreadsheetpreviewmodel.hpp:53-54`).
`truncatedRows` / `truncatedCols` are computed as `total > capped`. The UI renders
"Showing %1 of %2 rows, %1 of %2 columns" (`SpreadsheetPreview.qml:185-205`).

**Cell conversion.** Values are converted to display strings on the **worker
thread**, so `data()` is a pure array read with zero per-cell formatting on the GUI
thread (`spreadsheetpreviewmodel.hpp:16-19`). The freexl branch converts each
`FreeXL_CellValue` by type: `INT` → `QString::number`, `DOUBLE` →
`QString::number(v, 'g', 10)`, `TEXT`/`SST_TEXT`/`DATE`/`DATETIME`/`TIME` → UTF-8
string, `NULL` → empty.

**Multi-sheet.** `sheetNames` is exported; `activeSheet` is writable from QML and
**re-runs the whole async read** (`spreadsheetpreviewmodel.cpp:211-217`). Setting
`filePath` resets `activeSheet` to 0. The sheet-tab bar is visible only when
`sheetCount > 1` (`SpreadsheetPreview.qml:59-102`).

**Grid.** `TableView` + `HorizontalHeaderView`, fixed `_colWidth: 120` and
`_rowHeight: 22`, `interactive: false` (no scrolling), `alternatingRows: true`, plus
manual per-row alternating fill in the delegate. Column headers are Excel letters
produced by `columnLetter()` (`spreadsheetpreviewmodel.cpp:228-235`): 0→A, 25→Z,
26→AA.

**Errors.** `"Failed to open spreadsheet"`, `"No sheets found"`,
`"Failed to select sheet"`. An empty but valid sheet (invalid `dimension()`) is NOT
an error — it returns clean and the `grid_off` / "Empty spreadsheet" card shows.

**Port to Electron:** `exceljs` reads .xlsx/.xlsm/.xltx and streams rows, which suits
a 200-row cap perfectly. `.xls` (BIFF) needs `xlsx` (SheetJS) — its community build
reads legacy BIFF, though the license and the CVE history deserve a look. Render
into an HTML `<table>` or TanStack Table. **medium** — .xlsx is easy, .xls is the
awkward half, and .xlsb stays unsupported in both worlds.

### 2.17 Audio (`_typeAudio`)

- Trigger: `mimeType.startsWith("audio/") || mimeType === "application/ogg"`.
- Component: `AudioPreview.qml`.
- C++ backing: `AudioWaveformModel` (`audiowaveformmodel.cpp`).
- Libraries: `QtMultimedia`'s `MediaPlayer` for playback and metadata,
  `QAudioDecoder` for the waveform.

**Waveform pipeline** (`audiowaveformmodel.cpp`):
- `QAudioDecoder` decodes the file incrementally; each `bufferReady` delivers a
  `QAudioBuffer`.
- On the first buffer, bin width is estimated: `samplesPerBin = max(1, totalSamples /
  TargetBinCount)` where `totalSamples = sampleRate * durationMs / 1000`. If the
  decoder reports no duration, it assumes **180000 ms (3 minutes)** and corrects on
  finish (lines 124-146).
- `processBuffer` handles `Int16`, `Float`, and `Int32` sample formats. Multi-channel
  input is reduced to mono by taking the max absolute value across channels. `UInt8`
  is skipped silently (line 215).
- `TargetBinCount = 300` (`audiowaveformmodel.hpp:46`). `finalizePeaks()` resamples
  the raw bins to exactly 300, normalizing by the global max, taking the max within
  each mapped range. When `rawCount < TargetBinCount` (short files) the range would
  be empty, so it falls back to nearest-neighbour — lines 271-282 record this as a
  fixed silent-bars bug.
- Silent files (global max < 1e-6) fill 300 zeros rather than divide by zero.
- Duration is corrected after decode from the actual sample count.

**UI.** Album art from `MediaMetaData.ThumbnailImage` at `sourceSize` 100×100, with a
`music_note` fallback; title and artist from metadata; a `Canvas` drawing mirrored
bars (`barWidth: 2`, `gap: 1`) with played bars in `palette.primary` and unplayed at
0.15 alpha; a 50 ms repaint timer running only while playing; click-to-seek;
`Ctrl+P` play/pause routed through `WindowState.audioPlaybackToggle()`.

`autoPlay: false` — audio does NOT start on selection, unlike video.

**Port to Electron:** `<audio>` for playback and `AudioContext.decodeAudioData` plus
`getChannelData` for peaks — the Web Audio API gives the exact same
max-absolute-per-bin reduction in about 20 lines. `wavesurfer.js` does the whole
waveform, seek, and progress paint out of the box. Metadata and album art via
`music-metadata`. **easy** — genuinely easier than the Qt version.

### 2.18 Binary / unknown (`_typeFallback`)

- Trigger: nothing else matched — the file is not a directory, not an image, not a
  video, not audio, not an archive, not a spreadsheet, and not `isText`. In practice:
  a binary with NUL bytes, or an unreadable/0-byte file with an unknown MIME.
- Component: `FallbackPreview.qml`. Pure metadata card, no file I/O beyond the stat
  already in the entry.
- Contents:
  - `FileIcon` at `font.size.xxl * 4`, using `entry.iconPath` when
    `Config.fileManager.iconMode === "system"`, else the Material glyph from
    `FileManagerService.iconNameForMime()`.
  - Filename, wrapped, `ElideMiddle`, max 3 lines.
  - Formatted size (`FileManagerService.formatSize` — B/K/M/G, one decimal).
  - Raw MIME type string.
  - A 2-column grid: Modified (relative — "just now", "12m ago", "3h ago", "2d ago",
    then `MMM d`), Permissions (a 10-char `ls`-style string built by
    `buildPermissions()` at `filesystemmodel.cpp:222-239`), Owner (hidden when
    empty), and Target (only for symlinks).

**Port to Electron:** `fs.stat` + a MIME lookup (`mime-types` or `file-type` for
magic sniffing) rendered as a React card. **easy.**

### 2.19 Symlinks

Symlinks are NOT a preview type. They are handled two ways.

- `QFileInfo` in `FileSystemEntry` follows the link for `isDir`, `size`, `mimeType`,
  and every predicate, so a symlink previews as whatever it points at.
- `isSymlink` / `symlinkTarget` surface as decorations: a `link` icon in the metadata
  strip (`PreviewMetadata.qml:43-48`) and a "Target" row in the fallback card
  (`FallbackPreview.qml:129-145`).
- `buildPermissions()` writes `l` as the first character, checked BEFORE `isDir()`
  because a symlink to a directory satisfies both (`filesystemmodel.cpp:226-228`).
- A broken symlink resolves to nothing: `isImage`/`isText` are false, so it lands in
  `_typeFallback`.

**Port to Electron:** `fs.lstat` for the link itself, `fs.stat` for the target,
`fs.readlink` for the target path; a failing `stat` means broken. **easy.**

### 2.20 The metadata strip

`PreviewMetadata.qml`, rendered by `PreviewPanel` only (not by the finder pane).
It is a single row of conditionally-visible cells fed from `PreviewContent`'s
exported properties (`PreviewPanel.qml:68-81`):

| Cell | Source | Visible when |
|---|---|---|
| `link` icon | `entry.isSymlink` | symlink |
| filename | `entry.name` | always |
| `W×H` | `mediaNaturalSize` (image or video) | width > 0 |
| language badge | `textLoader.item.language` | non-empty |
| `%1 lines` | `textLoader.item.lineCount` | > 0 |
| sheet/`R×C` | spreadsheet loader | totalRows > 0 |
| `%1 dirs, %1 files` | archive loader | either count > 0 |
| duration `m:ss` | audio loader | non-empty |

All eight are read through optional chaining with `?? 0` / `?? ""` defaults
(`PreviewContent.qml:97-108`), so a Loader that is inactive contributes nothing.

---

## 3. Async, cancellation, and the 150 ms debounce

Three independent mechanisms stack. Understanding which one guards what matters for
the port.

### 3.1 Layer 1 — the QML debounce (150 ms)

Two implementations, deliberately parallel:

- `PreviewPanel.qml:26-42`. `previewEntry` changes → restart a 150 ms `Timer` →
  on trigger set `_committedEntry`. `PreviewContent` binds to `_committedEntry`, not
  to `previewEntry`. **Clearing bypasses the debounce**: a null entry stops the timer
  and clears immediately, so "No preview" appears without delay.
- `FuzzyFinderInfoPanel.qml:27-42`. Same 150 ms, but it debounces the **path** fed
  into the `FileInfo` element, so fast `j`/`k` does not construct a
  `FileSystemEntry` per keystroke.

Consequence: holding `j` down produces **zero** preview work. Only the row the user
settles on for 150 ms triggers any I/O.

### 3.2 Layer 2 — the Loader

Every preview type sits behind `Loader { active: ...; asynchronous: true }`. Changing
`_previewType` destroys the previous component outright, which cancels its work by
destroying the C++ helper that owns it. `asynchronous: true` means component
instantiation itself does not block the render thread.

### 3.3 Layer 3 — generation counters in C++

Four classes implement the pattern. Each owns a **private `int m_generation`
member**; there is no shared counter.

| Class | Member | Incremented in | Checked in |
|---|---|---|---|
| `SyntaxHighlightHelper` | `m_generation` (`syntaxhighlighthelper.hpp:105`) | `loadFile()` line 72 | the `QFutureWatcher::finished` lambda, line 117 |
| `ArchivePreviewModel` | `m_generation` (`archivepreviewmodel.hpp:102`) | `readArchive()` line 240 | finished lambda, line 282 |
| `SpreadsheetPreviewModel` | `m_generation` (`spreadsheetpreviewmodel.hpp:103`) | `readSpreadsheet()` line 239 | finished lambda, line 284 |
| `FileInfo` | `m_generation` | `rebuild()` (`fileinfo.cpp:36`) | finished lambda, line 73 |

The shape is identical everywhere:

```cpp
const int generation = ++m_generation;          // on the GUI thread, before dispatch
...
const auto future = QtConcurrent::run([captured...]() { return compute(...); });
auto* watcher = new QFutureWatcher<Result>(this);
connect(watcher, &QFutureWatcher<Result>::finished, this, [this, generation, watcher]() {
    watcher->deleteLater();
    if (generation != m_generation) return;      // stale — drop it
    ... publish result ...
});
watcher->setFuture(future);
```

What it guards: the **publish** step, not the computation. The worker still runs to
completion and burns its CPU; only its result is discarded. The watcher is parented
to the model, so it is collected with it.

`AudioWaveformModel` uses the same `m_generation` but guards **four** signal
handlers instead of one future (`audiowaveformmodel.cpp:80-110`) — `bufferReady`,
`finished`, `error`, and `durationChanged` each carry the captured generation,
because `QAudioDecoder` streams results rather than returning one.

`PreviewImageHelper` is the **exception**: it compares the captured source string
instead of an integer (`previewimagehelper.cpp:118`,
`if (m_source != capturedSource) return;`). It also actively cancels — `disconnect()`
then `cancel()` then `deleteLater()` on the previous watcher
(`previewimagehelper.cpp:65-73` and again in the destructor, lines 32-35). The
disconnect-before-null ordering is commented as the fix for a `finished` signal
firing against a stale `this`.

Tests pin the behaviour: `ArchivePreviewModelTest::generationCounterDiscardsStale`,
`SyntaxHighlightHelperTest::generationCounterDiscardsStale`,
`FileInfoTest::staleBuildDiscarded`.

### 3.4 What runs where

| Work | Thread |
|---|---|
| Definition + theme lookup for highlighting | GUI (cheap, cached `Repository` data) |
| File read, NUL scan, decode, `QTextDocument` highlight, HTML build | worker (`QtConcurrent::run`) |
| libarchive header walk + tree build | worker |
| QXlsx / freexl read + cell → string conversion | worker |
| PDF/ICNS/HEIF/RPGMV decode + PNG write | worker |
| `buildCachedEntryData` (stat, MIME, `QImageReader::canRead`) | worker |
| `FileSystemEntry` QObject construction | GUI |
| `IconThemeResolver` | **GUI only** — its static caches are unsynchronized (`iconthemeresolver.hpp:34-36`) |

**Port to Electron:** the debounce is a plain `setTimeout` in the renderer. The
generation counter maps to an `AbortController` per request plus a monotonic request
id checked before `setState` — and unlike Qt, `AbortController` can actually stop the
work, not just discard the result. Heavy decodes belong in `worker_threads` or a
`utilityProcess` so the renderer never blocks. **easy**, and structurally cleaner
than the Qt version.

---

## 4. Icons

### 4.1 Three resolvers, one principle

| Entry point | Purpose | Context dirs searched | Extensions |
|---|---|---|---|
| `IconThemeResolver::resolveForFile(fileInfo, mimeType)` | file / folder icon for an entry | via `resolve()` | `.svg` only |
| `IconThemeResolver::resolve(iconName)` | raw XDG icon-name lookup | `mimes/`, `places/` | `.svg` only |
| `IconThemeResolver::resolveApp(iconName)` | application icon from a `.desktop` `Icon=` | `apps/` | `.svg`, `.png`, `.xpm` |

### 4.2 Why it returns paths, not `QIcon`

Recorded in `CLAUDE.md` and enforced by `FileIcon.qml`. `QIcon::fromTheme(...).pixmap()`
**rasterizes** the SVG at a fixed size and loses the vector. A QML
`Image { source: "file://<path>.svg" }` renders the SVG source crisply at whatever
`sourceSize` the component asks for. Returning the real path on disk is the only way
to keep the vector all the way to the scene graph. A consequence the comment calls
out: a newly installed `.desktop` app resolves automatically with no QML change.

### 4.3 Search paths and theme discovery

`iconSearchPaths()` (`iconthemeresolver.cpp:18-42`), built once:

1. `$XDG_DATA_HOME/icons` (`QStandardPaths::GenericDataLocation` writable location).
2. Each `$XDG_DATA_DIRS/<dir>/icons`, de-duplicated.
3. `/usr/share/pixmaps` as the legacy flat fallback.

`ensureInitialised()` (lines 171-209):

- Take `QIcon::themeName()` and **verify the directory actually exists on disk**.
- If it does not, scan every search path for the first theme directory containing
  `mimes/scalable`, and adopt that.
- If nothing is found, `s_activeTheme` stays empty and every lookup returns "".

### 4.4 `index.theme` parsing

`parseTheme()` (lines 56-169) is a **hand-rolled INI parser**. The comment at line 72
states why: `QSettings` fails on long values and on group names containing spaces —
both routine in `index.theme` files.

It collects the `[Icon Theme] Directories=` list and the `Inherits=` list, then for
each directory reads its `Context` and `Type` and `Size`. Only `MimeTypes`,
`Places`, and `Applications` contexts are kept, bucketed into `mimeDirs`,
`placesDirs`, `appsDirs`.

**Sort order** (lines 146-154): scalable first, then descending `Size`. Prefer a
vector icon; failing that, the largest raster available.

### 4.5 Lookup

`findInTheme()` (lines 211-256):

- **Apps** — for each `appsDir` in preference order, try `.svg`, `.png`, `.xpm`.
- **MimePlaces** — decide the bucket by icon name. Names starting with `folder`, plus
  `user-home`, `user-desktop`, `user-trash`, are *places*; everything else is
  *mimes*. Search that bucket, then **fall back to the opposite bucket**, because
  some themes file folder icons under `mimes/`.

`findRecursive()` (lines 258-282) walks the `Inherits` chain depth-first with a
`visited` set to break cycles, caching each parsed theme in `s_themes`.

### 4.6 `resolveForFile` — the MIME → icon chain

`iconthemeresolver.cpp:284-303`, in order:

1. Directory → the `folder` icon, done.
2. `mime.iconName()` — e.g. `text/x-python` → `text-x-python`.
3. `mime.genericIconName()` — e.g. `text-x-generic`.
4. Each entry of `mime.parentMimeTypes()`, taking that parent's `iconName()`.
5. "" if nothing matched.

### 4.7 `resolveApp` — the application chain

`iconthemeresolver.cpp:328-396`, in order:

1. An **absolute** `Icon=` path (Steam, Flatpak, some bundled apps) is used verbatim
   if the file exists.
2. Strip a trailing `.png`/`.svg`/`.xpm` from the name — sloppy `.desktop` entries
   include one, and searching for `foo.png.svg` would fail.
3. The active theme's `apps/` dirs plus its inheritance chain.
4. **`hicolor` explicitly**, because it is the XDG-mandated implicit fallback where
   most app icons live even when the active theme does not declare it via `Inherits`.
5. `/usr/share/pixmaps/<stripped><ext>` for each of `.png`, `.svg`, `.xpm`.
6. `/usr/share/pixmaps/<original name>` last, covering files stored with no
   recognised extension.

### 4.8 `AppIconProvider`

`appiconprovider.cpp`, a `QML_SINGLETON` (`appiconprovider.hpp:28`) consumed by the
"Open With" menu (`ContextMenuPopup.qml:103`).

- `locateDesktopFile()` — append `.desktop` if absent, then search each
  `QStandardPaths::ApplicationsLocation` dir. Fallback per the XDG spec: a dash may
  encode a subdirectory, so `org.kde.foo-bar.desktop` is also tried at
  `org/kde/foo-bar.desktop`.
- `readIconKey()` — line-by-line parse taking `Icon=` **only** from the
  `[Desktop Entry]` group, ignoring action groups like
  `[Desktop Action new-window]`. Pinned by
  `AppIconProviderTest::iconKeyInActionGroupIsIgnored`.
- `iconForDesktopId()` — memoized in `m_cache`, including negative results.

### 4.9 Caching

Three static caches, all unbounded, all never invalidated
(`iconthemeresolver.hpp:58-62`): `s_cache` (MIME/places), `s_appCache` (apps),
`s_themes` (parsed `ThemeInfo`). Negative results are cached too, so a missing icon
costs one filesystem walk per process lifetime. Changing the system icon theme
requires a restart.

### 4.10 What a web renderer would have to do instead

The browser has **no** access to the XDG icon theme. Three viable strategies:

1. **Reimplement the resolver in Node** and serve the resolved file through a custom
   `protocol.handle('app-icon://')` scheme, returning the SVG bytes with
   `Content-Type: image/svg+xml`. This preserves the vector end to end and is the
   closest match. The INI parsing, the inheritance walk, the scalable-first sort, and
   the places/mimes fallback all have to be ported — roughly 400 lines.
2. **Use Electron's `app.getFileIcon(path)`**, which returns a `NativeImage`. On
   Linux this goes through GTK and yields a **raster** PNG at a fixed size — exactly
   the loss of fidelity the C++ code was written to avoid.
3. **Ship an icon set** (Material Symbols, Lucide, VSCode's `seti` icons) and map
   MIME → glyph in JS, dropping system-theme integration entirely. `FileIcon.qml`
   already supports this mode: `Config.fileManager.iconMode === "material"`.

**Port risk: hard** for strategy 1 (the XDG spec has many edge cases and this
implementation already encodes several hard-won ones), **easy** for strategy 3 at the
cost of a visible feature regression. Strategy 2 is a trap — it silently downgrades
every icon to a bitmap.

---

## 5. Syntax highlighting

### 5.1 The KF6 pipeline

`plugin/src/Symmetria/FileManager/Models/syntaxhighlighthelper.cpp`.

1. **Definition selection**, on the GUI thread because the lookups are cheap reads of
   cached `Repository` data (lines 95-103):
   - `m_repository.definitionForFileName(QFileInfo(path).fileName())` — matches the
     filename glob patterns in the KSyntaxHighlighting XML definitions (`*.py`,
     `CMakeLists.txt`, `.bashrc`, …).
   - If invalid, `m_repository.definitionForMimeType(...)` using
     `mimeDb.mimeTypeForFile(path, QMimeDatabase::MatchExtension).name()`. Note the
     **extension-only** match mode here — no content magic.
   - An invalid definition is not an error. `computeHighlight` then wraps
     HTML-escaped plain text in `<pre>` (lines 202-206) and reports an empty
     `language`.
2. **Theme resolution** — `previewTheme()` (lines 34-39).
3. **Dispatch** — `QtConcurrent::run` with the `Definition` and `Theme` copied by
   value. Both are copyable value types, safe to hand to a worker.
4. **Compute** — `computeHighlight` (see §2.12 for limits).
5. **Highlight** — `buildHighlightedHtml` (lines 241-309).

### 5.2 The embedded "Wine" theme

- Source file: `plugin/src/Symmetria/FileManager/Models/themes/wine.theme`, 174 lines
  of KSyntaxHighlighting theme JSON, `metadata.name = "Wine"`.
- Embedded as a Qt resource by
  `plugin/src/Symmetria/FileManager/Models/CMakeLists.txt:46-49`, prefix
  `/symmetria-fm-syntax`, so the resource path is
  `:/symmetria-fm-syntax/themes/wine.theme`.
- Discovered by
  `m_repository.addCustomSearchPath(":/symmetria-fm-syntax")` in the constructor
  (`syntaxhighlighthelper.cpp:25`). KF6 appends `/themes` to each custom search path
  automatically — that suffix is why the resource lives one level down.
- Embedding rather than installing to an XDG data dir means every consumer of the
  plugin inherits the theme with no install-path coordination, mirroring how KF6
  ships its own built-in themes (CMakeLists comment, lines 39-45).
- **Fallback**: if `theme("Wine")` is invalid, `previewTheme()` returns
  `defaultTheme(Repository::DarkTheme)`, so previews never render black on black.
  Pinned by `SyntaxHighlightHelperTest::previewThemeFallbackIsSafe`.
- The palette deliberately mirrors the user's NeoVim Lush colorscheme at
  `~/.config/nvim/lua/jc/plugins/theme/wine_theme/lua/lush_theme/wine_theme.lua`.
  `CLAUDE.md` requires the two files change together.
- Representative token colours: `Normal` `#dddddd`, `Keyword` `#c28b12` bold,
  `Function` `#fdd888` bold+italic, `ControlFlow` `#c28b12` bold+italic, `String`
  `#62ba46`, `Comment` `#9e9e9e` italic, `DataType`/`BuiltIn` `#c75828`,
  `DecVal`/`Float`/`Constant` `#e1d797`, `Error` `#d2602d` underlined, editor
  background `#131313`.

### 5.3 The HTML output shape

`buildHighlightedHtml` produces deliberately minimal markup. Per `QTextBlock`, it
reads `block.layout()->formats()` and for each range emits:

```html
<span style="color:#RRGGBB;font-weight:bold;font-style:italic;text-decoration:underline;">escaped</span>
```

Only the attributes that actually apply are written; a range with no colour and no
style contributes bare escaped text. Blocks are joined with a literal `\n`. The whole
document is wrapped by `computeHighlight` in:

```html
<pre style="margin:0;padding:0;color:#dddddd">…</pre>
```

The `color` on the `<pre>` is the theme's `Normal` text colour. Without it, Qt's
RichText mode defaults to black per the HTML standard and the text is invisible on
the dark background (lines 192-197). **No font information is emitted** — the QML
`TextEdit`'s own font properties are the base. All text is `toHtmlEscaped()`; pinned
by `SyntaxHighlightHelperTest::htmlEscapesSpecialChars`.

### 5.4 Three Qt-specific constraints the port does not inherit

All three are documented in `QUIRKS.md` §4-§6 and restated in
`syntaxhighlighthelper.hpp:8-21`.

1. **Highlight on a temporary `QTextDocument`, never on the QML `TextEdit`'s
   document.** `QSyntaxHighlighter::rehighlight()` calls
   `QTextDocument::markContentsDirty()`, which disrupts `QQuickTextEdit`'s internal
   rendering state. The first file renders; every subsequent file shows blank text.
   This is a fundamental incompatibility between `QSyntaxHighlighter` (built for
   `QTextEdit` widgets) and `QQuickTextEdit` (scene-graph renderer).
2. **Read formats from `QTextBlock::layout()->formats()`, not from `QTextFragment`.**
   `QSyntaxHighlighter` writes to the `QTextLayout` *additional formats* layer, not to
   the document's character-format layer. Iterating fragments returns the document's
   base formatting, which is always empty.
3. **`setTheme()` must be called BEFORE `setDefinition()`.** `setDefinition()`
   triggers a rehighlight; with no valid theme, `Format::toTextCharFormat()` resolves
   every colour to `#000000`, and those black formats persist in the `QTextLayout`
   even after a later `setTheme()` rehighlight, because Qt's `applyFormatChanges()`
   optimization fails to detect the difference. Pinned by
   `SyntaxHighlightHelperTest::themeBeforeDefinitionOrder` and
   `usesWineThemeColors`.

**Port to Electron:** `shiki` is the closest analogue — it ships TextMate grammars
and VS Code themes, runs the same tokenize-then-emit-spans model, and outputs
`<pre><code><span style="color:…">`. The Wine theme converts to a VS Code
`tokenColors` JSON almost mechanically, since both are token-name → colour maps.
`highlight.js` is lighter but has coarser token granularity. `tree-sitter` is
overkill unless the port later adds an editor. All three Qt quirks above simply
vanish. **easy** — and this is where the port gains the most: real scrolling,
selection, copy, and in-preview search, none of which the current `Flickable {
interactive: false }` provides.

---

## 6. The image pipeline in detail

### 6.1 `needsCachedDecode` — the fork

`previewimagehelper.cpp:139-147`. A **suffix-only** test, deliberately, so the GUI
thread never opens a file. The comment states the alternative explicitly: a
reader-based format detection would perform synchronous I/O on the GUI thread.

```
needsCachedDecode(path) := .pdf | .rpgmvp | .png_ | .icns | isHeifFormat(path)
isHeifFormat(path)      := .heic | .heif
```

`false` → passthrough: `resolvedUrl = "file://" + source`, zero overhead.
`true` → cache lookup, then async generation on a miss.

The suffix list is duplicated in `filesystemmodel.cpp:96-102`
(`isCustomDecodedImage`) so the router flags these as `isImage` despite
`QImageReader::canRead()` returning false. The comment demands the two stay in sync —
**this is a real duplication hazard the port should collapse into one table.**

### 6.2 `generateCachedPreview` — the dispatch

`previewimagehelper.cpp:177-200`, in order:

1. `QDir().mkpath(dirname(cachePath))` — every handler may assume the directory
   exists.
2. RPGMV → `decryptRpgmvp`.
3. `.icns` → `IcnsDecoder::extractLargestPng`.
4. HEIF → `HeifDecoder::decodeToPng`.
5. **Default (PDF and anything else that reaches here)** —
   `QImageReader reader(sourcePath); reader.setBackgroundColor(Qt::white);
   reader.read(); image.save(cachePath, "PNG");`

Returns the cache path on success, an empty `QString` on any failure.

### 6.3 Background compositing

The only compositing step is `QImageReader::setBackgroundColor(Qt::white)` in the
default branch. It exists for PDF: a page with a transparent background would
otherwise render as dark-on-dark against the FM's near-black surface.
`ImagePreview.qml:16-17` names this explicitly and notes that normal images pass
through untouched with zero overhead.

HEIF decodes to straight (non-premultiplied) RGBA and composites nothing — HEIC
photos are opaque. ICNS copies PNG bytes verbatim, preserving alpha.

### 6.4 Sizing

Two independent caps:

| Where | Cap | Applies to |
|---|---|---|
| `HeifDecoder::kMaxPreviewDim` (`heifdecoder.cpp:17`) | 2048 px on the larger dimension, `KeepAspectRatio` + `SmoothTransformation` | HEIC/HEIF only, applied before PNG encode, so the **cached file itself** is capped |
| `ImagePreview.qml:37-38` `sourceSize` | `paneWidth * 2` × `paneHeight * 2` | every image, at Qt decode time, so the **decoded buffer** is capped |

PDF, ICNS, and RPGMV caches are written at native resolution. Only the QML
`sourceSize` limits their in-memory cost.

### 6.5 Animated images

There is no animated path. `ImagePreview.qml` instantiates `Image`, not
`AnimatedImage`. An animated GIF or WebP shows its first frame, frozen. No code
anywhere reads frame counts or drives a frame timer.

**Port to Electron:** `<img>` animates GIF and WebP with no work at all. This is a
capability the browser hands over for free that Qt made a deliberate omission.

### 6.6 Error and fallback ladder

1. `generateCachedPreview` returns "" → `processSource` sets
   `resolvedUrl = "file://" + source` (`previewimagehelper.cpp:127-133`).
2. The QML `Image` tries the raw source. For `.heic` it will fail (no Qt plugin); for
   `.pdf` it will retry the same decode Qt already failed at.
3. `Image.status === Image.Error` and `!previewHelper.loading` → the
   `broken_image` / "Cannot preview" card (`ImagePreview.qml:58-67`).

Partial cache files are removed by HEIF and ICNS and RPGMV on write failure, because
the cache-hit check upstream is a bare `QFileInfo::exists()` and would otherwise
serve a truncated PNG forever. The PDF branch does **not** do this cleanup — a failed
`image.save()` returns "" but leaves whatever `QImage::save` wrote behind. That
asymmetry looks like a latent bug worth noting for the port.

**Port to Electron:** `sharp` covers the compositing (`.flatten({background:'#fff'})`),
the resize (`.resize(2048, 2048, {fit:'inside'})`), and the PNG encode in one chain,
and it already runs off the event loop on libuv's threadpool. **easy** for the
pipeline; the format-specific decoders carry all the risk.

---

## 7. Consolidated port-risk table

| Preview type | Web/Node equivalent | Risk | One-line reason |
|---|---|---|---|
| No selection | React component | easy | static markup |
| Directory | `fs.opendir` + virtualized list | easy | direct mapping |
| Remote directory | `fs.statfs` + magic constants | medium | magic numbers must be hard-coded |
| Images (common) | `<img>` | easy | native, and animates GIF/WebP for free |
| Images (TIFF/TGA/JP2/MNG/WBMP/XPM) | `sharp` transcode to PNG | medium | native module, per-format coverage varies |
| PDF | PDF.js | easy | no native dep, multi-page for free |
| ICNS | `@fiahfy/icns` or hand-rolled Buffer parse | easy | pure container parsing |
| HEIC/HEIF | `libheif-js` / `heic-decode` (WASM) | medium | `sharp` prebuilds usually lack libheif; WASM is slow on 12 MP |
| RPGMV `.rpgmvp` / `.png_` | Buffer slice + constant prefix | easy | 10 lines |
| SVG | `<img>` | easy | stays vector, better than Qt |
| Video | `<video>`, plus `ffmpeg` poster-frame sidecar | medium | Chromium refuses MKV/AVI and many codecs |
| Text / code | `shiki` (or `highlight.js`) | easy | better result than Qt; all three Qt quirks vanish |
| Markdown | `markdown-it` + `DOMPurify` | easy | a free upgrade; today it is source-only |
| HTML render | sandboxed `<webview>` / `BrowserView` | easy | Electron IS Chromium; a whole dependency disappears |
| Archives | `yauzl` + `tar-stream` + `libarchive.js` or `node-7z` | **hard** | no single library matches libarchive's 24-MIME coverage |
| Spreadsheets (.xlsx) | `exceljs` | easy | streaming rows suit a 200-row cap |
| Spreadsheets (.xls BIFF) | `xlsx` (SheetJS) | medium | legacy-format support, license and CVE history |
| Spreadsheets (.xlsb) | — | — | already broken today; the MIME gate accepts it and QXlsx cannot read it |
| Audio + waveform | `<audio>` + Web Audio, or `wavesurfer.js` | easy | easier than the Qt version |
| Binary / unknown | `fs.stat` + `mime-types` | easy | metadata card |
| Symlinks | `fs.lstat` / `fs.readlink` | easy | direct mapping |
| System icons (XDG themes) | custom `protocol.handle` + ported resolver | **hard** | no browser access to XDG themes; `app.getFileIcon` silently rasterizes |
| Async cancellation | `AbortController` + request ids | easy | strictly better — it can actually cancel |
| Preview cache | `app.getPath('cache')` + sha1(path:mtime) | easy | same key scheme |

### 7.1 Flagged: no clean web equivalent

- **XDG icon-theme resolution.** The browser cannot see the theme. Every option is a
  compromise: reimplement ~400 lines of spec-walking in Node, accept rasterized icons
  via `app.getFileIcon`, or drop system integration for a bundled icon set.
- **libarchive's format breadth.** RAR, ISO9660, CPIO, XAR, CAB, and DEB have no
  maintained pure-JS reader. The honest options are `libarchive.js` (Emscripten,
  large WASM payload) or shelling out to a `7z` binary the app would have to ship.
- **`QImageReader`'s runtime-extensible plugin set.** Today, installing a Qt image
  plugin widens the supported formats with no code change. A web renderer's format
  list is fixed at build time; the port must decide whether to lose that property or
  fake it with a user-configurable transcode hook.

### 7.2 Flagged: capabilities the browser gives for free that Qt made hard

- **Animated GIF/WebP.** `<img>` animates. `ImagePreview` shows one frozen frame.
- **A real Markdown render.** Two npm packages. Today the project has none.
- **Scrolling, selection, and find-in-preview for text.** The current
  `Flickable { interactive: false }` shows one screenful with no selection.
- **The whole `HtmlPreview` sandbox.** Electron is already Chromium; the
  `qt6-webengine` build/runtime dependency and its `QtWebEngineQuick::initialize()`
  host contract both disappear.
- **PDF multi-page.** `QImageReader` returns page 1 only. PDF.js gives every page.
- **True cancellation.** Qt's generation counters discard results but let the worker
  finish. `AbortController` plus a `utilityProcess` can actually stop the work.
