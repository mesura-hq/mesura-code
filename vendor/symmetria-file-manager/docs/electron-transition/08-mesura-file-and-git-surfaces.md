# 08 — Mesura Code: file, preview, diff and git surfaces

Status: **research**. Read-only inventory of `/home/jc/projects/mesura-code` at branch
`main`, commit `0948cc011`. No decision is recorded here.

All paths in this document are absolute. Line numbers are from the commit above.

---

## 1. The app-to-app relationship

**`apps/web` owns every line of React in the product. `apps/desktop` contains no React
at all.** A new file-manager UI belongs in `apps/web`.

### The evidence

- `/home/jc/projects/mesura-code/apps/desktop/package.json` lists **no `react`, no
  `react-dom`, no `@types/react`**. Its dependencies are `electron`, `electron-store`,
  `electron-updater`, `playwright-core`, and the workspace packages.
- `/home/jc/projects/mesura-code/apps/web/package.json:35-36` pins `react` and
  `react-dom` at `19.2.6`. Every `.tsx` component in the product lives under
  `/home/jc/projects/mesura-code/apps/web/src/`.
- `/home/jc/projects/mesura-code/apps/server/package.json:43` declares
  `"@t3tools/web": "workspace:*"`. The server serves the web build.

### The load chain, concretely

1. `apps/web` builds to `apps/web/dist`.
2. The server locates that build:
   `/home/jc/projects/mesura-code/apps/server/src/config.ts:206` `resolveStaticDir`
   tries `<serverDist>/client` first, then falls back to
   `/home/jc/projects/mesura-code/apps/server/src/config.ts:217`
   `resolve(join(import.meta.dirname, "../../web/dist"))`. The HTTP layer mounts it at
   `/home/jc/projects/mesura-code/apps/server/src/http.ts:255-265`.
3. The desktop main process registers a **privileged custom scheme** —
   `t3code://` in production, `t3code-dev://` in development
   (`/home/jc/projects/mesura-code/apps/desktop/src/electron/ElectronProtocol.ts:11-25`,
   `:111-132`).
4. That scheme is a **reverse proxy**, not a file loader:
   `/home/jc/projects/mesura-code/apps/desktop/src/electron/ElectronProtocol.ts:140-183`
   `proxyRequest` forwards every request to `targetOrigin` via `Electron.net.fetch` and
   stamps a Content-Security-Policy header
   (`makeDesktopContentSecurityPolicy`, `:67-96`).
5. `targetOrigin` is chosen at
   `/home/jc/projects/mesura-code/apps/desktop/src/app/DesktopApp.ts:178-186`:
   the Vite dev-server URL in development, otherwise
   `backendConfig.httpBaseUrl` — the local server from step 2.
6. The window loads `t3code://app/`:
   `/home/jc/projects/mesura-code/apps/desktop/src/window/DesktopWindow.ts:333`
   (`getDesktopUrl`) and `:634` (`window.loadURL(applicationUrl)`).

### Renderer sandbox — a hard constraint on the port

`/home/jc/projects/mesura-code/apps/desktop/src/window/DesktopWindow.ts:371-383`:

```
contextIsolation: true,
nodeIntegration: false,
sandbox: true,
webviewTag: true,
```

The renderer therefore **cannot touch `node:fs`**. Every local-filesystem operation must
travel over one of exactly two channels:

- the **server RPC** over WebSocket (`WS_METHODS`, `packages/contracts/src/rpc.ts:197`), or
- the **desktop IPC preload bridge**
  (`/home/jc/projects/mesura-code/apps/desktop/src/ipc/channels.ts`,
  `/home/jc/projects/mesura-code/apps/desktop/src/preload.ts`,
  reached from the renderer through `readLocalApi()` at
  `/home/jc/projects/mesura-code/apps/web/src/localApi.ts`).

`apps/mobile` is an independent Expo / React Native app. It shares `packages/contracts`,
`packages/shared` and `packages/client-runtime` with the web app, but shares **no
component code**. `apps/marketing` is unrelated to the product UI.

---

## 2. File browsing today

### 2.1 The crux: local filesystem versus workspace jail

**Exactly one user-facing surface browses the local filesystem freely, and it lists
directories only.** Everything that shows *files* is jailed to a project or worktree root.

| Surface | Reach | Lists |
|---|---|---|
| Command-palette folder browser + mobile `FolderBrowser` | **Any absolute path, `~`, `/`** | Directories only |
| Native Electron folder dialog | Whole filesystem (OS dialog) | Directories only |
| Everything else (trees, pickers, `@`-mentions, search) | Project / worktree root only | Files and directories, relative paths |

The free-reach path is
`/home/jc/projects/mesura-code/apps/server/src/workspace/WorkspaceEntries.ts:191`
`browse` → `NodeFSP.readdir(parentPath, { withFileTypes: true })` at `:199`. The target is
`path.resolve(expandHomePath(input.partialPath, path))` (`:129-131`) — no allowlist, no
project-membership check. Line `:222` filters to `dirent.isDirectory()`, so files never
appear. `EACCES`/`EPERM` degrade to an empty list (`:208-214`).

The file jail is
`/home/jc/projects/mesura-code/apps/server/src/workspace/WorkspaceFileSystem.ts:135-178`:
`readFile` resolves both the workspace root and the target through `NodeFSP.realpath`, then
rejects anything outside with `WorkspaceFilePathEscapeError`. Symlink escape is closed.
`writeFile` (`:262`) uses the same guard.

**Consequence for the port.** A Symmetria file manager that browses `~`, `/`, or any path
outside a registered project has **no existing server API to call**. It needs either a new
RPC (in the fork's own contract package) or a new desktop IPC channel. The `filesystem.browse`
RPC is close in spirit but returns directories only and has no `stat`, no size, no mtime, no
mime.

### 2.2 Surface-by-surface

#### A. `FileBrowserPanel` — the project file tree (web)

`/home/jc/projects/mesura-code/apps/web/src/components/files/FileBrowserPanel.tsx`

- **Shows.** A nested, expandable tree inside a shadow DOM, plus a refresh button
  (`RefreshFilesButton`, `:53`) and a search box (`FileSearchField`, `:74`). Right-click menu
  offers "Copy mention" / "Add to chat" (`:156-162`). Rows drag into the composer; dropping
  is disabled (`dragAndDrop: { canDrop: () => false }`, `:223`).
- **Data.** `useProjectEntriesQuery(environmentId, cwd)` (`:113`) →
  `/home/jc/projects/mesura-code/apps/web/src/components/files/projectFilesQueryState.ts:32`
  → atom `projectEnvironment.listEntries` → RPC `projects.listEntries`
  (`/home/jc/projects/mesura-code/packages/contracts/src/rpc.ts:202`) → handler
  `/home/jc/projects/mesura-code/apps/server/src/ws.ts:1817` →
  `/home/jc/projects/mesura-code/apps/server/src/workspace/WorkspaceEntries.ts:275` →
  `WorkspaceSearchIndex.list()`
  (`/home/jc/projects/mesura-code/apps/server/src/workspace/WorkspaceSearchIndex.ts:434`).
  **The backend is not `readdir`.** It is an in-process native fuzzy-file index.
- **Tree structure.** The wire type is **flat**:
  `ProjectListEntriesResult = { entries: ProjectEntry[], truncated: boolean }`
  (`/home/jc/projects/mesura-code/packages/contracts/src/project.ts:78`), with
  `ProjectEntry = { path, kind: "file" | "directory" }` (`:28`). The panel converts to a flat
  path array (`treePath`, `:49`, directories carry a trailing `/`) and hands it to
  `model.resetPaths(treePaths)` (`:268`). The library builds the hierarchy.
  **The whole listing arrives in one request; expansion is client-side. There is no lazy
  per-directory fetch.**
- **Virtualisation.** Built into `@pierre/trees` — `dist/model/virtualization.js`, fixed row
  height, `FILE_TREE_DEFAULT_OVERSCAN = 10`.
- **Keyboard.** Handled inside the library: `ArrowUp`/`ArrowDown`/`ArrowLeft`/`ArrowRight`,
  `Home`, `End`, `Enter`, `Escape`, `Space`, `F2` (rename), `F10` and `ContextMenu`. The app
  adds only `Escape` on the search field (`:92-96`).
- **Limits.**
  `WORKSPACE_INDEX_MAX_ENTRIES = 25_000`
  (`/home/jc/projects/mesura-code/apps/server/src/workspace/WorkspaceSearchIndex.ts:28`),
  scan timeout `15 seconds` (`:30-31`), index idle TTL `15 minutes` (`:32`). Over the cap the
  result carries `truncated: true` (`:444-447`).
- **Root.** `cwd` comes from `FilePreviewPanel`
  (`/home/jc/projects/mesura-code/apps/web/src/components/files/FilePreviewPanel.tsx:1075`),
  which gets it from `ChatView`'s `activeWorkspaceRoot` =
  **`activeThreadWorktreePath ?? activeProjectCwd`**
  (`/home/jc/projects/mesura-code/apps/web/src/components/ChatView.tsx:2730`, passed at
  `:6440`). So the tree is **worktree-aware by construction**.

#### B. `ProjectFilePicker` — the Cmd-P file picker (web)

`/home/jc/projects/mesura-code/apps/web/src/components/files/ProjectFilePicker.tsx`

Flat result list inside the command palette, files only
(`ProjectFilePicker.logic.ts:58`). Query is `projects.searchEntries` →
`WorkspaceSearchIndex.search` → `finder.fileSearch`. Limit
`PROJECT_FILE_PICKER_RESULT_LIMIT = 200` (`.logic.ts:4`); debounce
`PROJECT_PATH_SEARCH_DEBOUNCE_MS = 120`
(`/home/jc/projects/mesura-code/apps/web/src/state/queries.ts:34`). **Not virtualised.**
Fuzzy ranking happens in the native engine; the client only recomputes highlight offsets
(`findMatchIndices`, `.logic.ts:22`).

#### C. Command-palette folder browser (web) — the free-filesystem surface

`/home/jc/projects/mesura-code/apps/web/src/components/CommandPalette.tsx:905-912`
calls `filesystemEnvironment.browse`. Entry condition is `isFilesystemBrowseQuery`
(`/home/jc/projects/mesura-code/packages/client-runtime/src/state/projects.ts:80-91`):
`./`, `../`, `/`, `~/`, or a Windows absolute path. The Add-Project flow seeds the query
with `"~/"` (`CommandPalette.tsx:863`). Wire type
`FilesystemBrowseResult = { parentPath, entries: { name, fullPath }[] }`
(`/home/jc/projects/mesura-code/packages/contracts/src/filesystem.ts:12-22`) — **absolute
paths**, one directory per request, strictly lazy. Not virtualised. No entry cap, no
truncation, no gitignore.

#### D. Native folder dialog (desktop)

`/home/jc/projects/mesura-code/apps/desktop/src/electron/ElectronDialog.ts:114,124`
`Electron.dialog.showOpenDialog` with `properties: ["openDirectory", "createDirectory"]`.
IPC method at
`/home/jc/projects/mesura-code/apps/desktop/src/ipc/methods/window.ts:170`, channel
`PICK_FOLDER_CHANNEL` (`/home/jc/projects/mesura-code/apps/desktop/src/ipc/channels.ts:1`).
Reached from `CommandPalette.tsx:2259`.

#### E. `ChangedFilesTree` — the per-turn changed-files tree (web)

`/home/jc/projects/mesura-code/apps/web/src/components/chat/ChangedFilesTree.tsx`

A **hand-rolled** recursive tree over `TurnDiffFileChange` (=
`OrchestrationCheckpointFile = { path, kind, additions, deletions }`,
`/home/jc/projects/mesura-code/packages/contracts/src/orchestration.ts:311`). Built by
`buildTurnDiffTree`
(`/home/jc/projects/mesura-code/apps/web/src/lib/turnDiffTree.ts:113`) into
`TurnDiffTreeDirectoryNode | TurnDiffTreeFileNode` (`:8`, `:16`). **Not virtualised.**
Auto-expand caps at
`CHANGED_FILES_AUTO_EXPAND_FILE_LIMIT = 5` and
`CHANGED_FILES_AUTO_EXPAND_LINE_LIMIT = 200`
(`/home/jc/projects/mesura-code/apps/web/src/components/chat/changedFilesPresentation.ts:4-5`).
Rendered inside the chat transcript by `MessagesTimeline.tsx:69`.

#### F. Mobile trees

`/home/jc/projects/mesura-code/apps/mobile/src/features/files/fileTree.ts` holds the only
**nested** tree model in the repo: `FileTreeNode { path, name, kind, children,
searchSegments, searchWords }` (`:4`) plus a flat render type
`VisibleFileTreeNode { node, depth }` (`:13`). `buildFileTree` (`:87`) folds the flat
`ProjectEntry[]`; `flattenFileTree` (`:195`) re-flattens the expanded subset.
`FileTreeBrowser.tsx` renders it in a React Native `FlatList` (`:243`,
`initialNumToRender = 20`, `maxToRenderPerBatch = 12`, `windowSize = 5`). Search is
**client-side** here, via `scoreQueryMatch` from `@t3tools/shared/searchRanking`
(`fileTree.ts:142`). Hosts: `thread-file-navigator-pane.tsx:36-41` and
`ThreadFilesRouteScreen.tsx:254-261`, both on `projects.listEntries`.

### 2.3 The fuzzy engine already in the product

`/home/jc/projects/mesura-code/apps/server/package.json:30` pins
**`"@ff-labs/fff-node": "0.9.4"`**, patched at
`/home/jc/projects/mesura-code/patches/@ff-labs__fff-node@0.9.4.patch` (the patch teaches
the binary loader to resolve `.asar.unpacked` paths inside a packaged Electron app).

`/home/jc/projects/mesura-code/apps/server/src/workspace/WorkspaceSearchIndex.ts:306-316`:

```
FileFinder.create({
  basePath: cwd,
  disableMmapCache: true,
  disableContentIndexing: variant !== "content",
  aiMode: false,
  enableFsRootScanning: true,
  enableHomeDirScanning: true,
})
```

**This is the same `fff` engine the Symmetria file manager links from Rust** (see doc 04).
Mesura already ships it, already packages the native binary, and already exposes
`mixedSearch` (`:437`), `fileSearch` (`:457`), `directorySearch` (`:463`), `grep` (`:490`)
and `scanFiles` (`:408`). Ignore rules, hidden-file policy and frecency all live inside that
binary — there is no ignore-rule code in this repo.

Note `enableFsRootScanning: true` and `enableHomeDirScanning: true`. The engine is already
configured to tolerate a root of `/` or `~`; only the *callers* restrict it.

### 2.4 A protocol gap worth recording

`projects.listEntries` accepts an arbitrary client-supplied `cwd`
(`/home/jc/projects/mesura-code/apps/server/src/ws.ts:1817` →
`WorkspacePaths.normalizeWorkspaceRoot`, which only resolves and stats). There is **no check
that `cwd` is a registered project or worktree**. The UI always passes one; the protocol
does not require it. Combined with §2.3's scanning flags, a crafted `listEntries` with
`cwd: "/"` would index the filesystem, capped at 25 000 entries and a 15 s scan.
`resolveRelativePathWithinRoot` guards *file reads*, not *listings*.

This is simultaneously a hardening item for the product and the cheapest possible foothold
for a local file manager.

---

## 3. File preview today

Owner: `/home/jc/projects/mesura-code/apps/web/src/components/files/FilePreviewPanel.tsx`
(1 100+ lines). Mounted lazily from
`/home/jc/projects/mesura-code/apps/web/src/components/ChatView.tsx:449` and rendered at
`:6437`.

### 3.1 Preview types and how each is detected

**Every type decision is an extension test on the client.** There is no mime lookup and no
server-provided kind flag. The only server type signal is negative: binary rejection.

| Type | Detection | Renderer |
|---|---|---|
| **Image** (`.avif .gif .ico .jpeg .jpg .png .svg .webp`) | `isWorkspaceImagePreviewPath` (`/home/jc/projects/mesura-code/packages/shared/src/filePreview.ts:3-12,23`), used at `FilePreviewPanel.tsx:783` | `WorkspaceImagePreview` (`:131`) → signed HTTP URL. Branch at `:997`. Note `:784` also **disables the readFile query** for images |
| **Markdown** (`.md .mdx`) | `isMarkdownPreviewFile` = `/\.(?:md\|mdx)$/i` (`/home/jc/projects/mesura-code/apps/web/src/components/files/filePreviewMode.ts:1`), used at `:800` | `RenderedMarkdownSurface` (`:703`) → `ChatMarkdown` (react-markdown). Toggle is a **user preference** in localStorage key `t3code.renderMarkdown` (`:84`, `:788`), not per file. A pending line-reveal forces source back (`:802-806`) |
| **Text / code, truncated** | Server flag `file.data.truncated`, not extension | Plain `<File>` inside `<Virtualizer>` (`:1023-1048`) — **read-only** |
| **Text / code, editable** | Fall-through catch-all | `EditableFileSurface` (`:434`), branch at `:1050` |
| **HTML / PDF** (`.htm .html .pdf`) | `isBrowserPreviewFile` = `/\.(?:html?\|pdf)$/i` (`/home/jc/projects/mesura-code/apps/web/src/browser/openFileInPreview.ts:25`) + `isPreviewSupportedInRuntime()` (`:808`) | **Not rendered in the panel.** Only an "open in preview browser" action (`:945-963` → `handleOpenInBrowser`, `:835`) |
| **Binary** | Server-side: `fileBytes.includes(0)` → `WorkspaceBinaryFileError` (`/home/jc/projects/mesura-code/apps/server/src/workspace/WorkspaceFileSystem.ts:82`, thrown at `:231`) | Error string at `FilePreviewPanel.tsx:1005-1008` |

There is **no** archive preview, no spreadsheet preview, no video preview, no audio preview,
no notebook preview, no HEIC/ICNS decoding, and no fallback hex view. `.ipynb` is JSON text
with no NUL bytes, so it renders as raw JSON. Relative to the Symmetria file manager, this is
a much smaller preview set.

Mobile branches differently, in `FileContent` at
`/home/jc/projects/mesura-code/apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx`:
SVG → `WorkspaceFileWebPreview` (`:103`, because React Native `Image` cannot do SVG), other
images → `WorkspaceFileImagePreview` (`:106`), HTML/PDF → `WorkspaceFileWebPreview` (`:114`),
markdown → `FileMarkdownPreview` (`:147`), everything else → `SourceFileSurface` (`:150`).
Mobile is **read-only** — no editor, no `writeFile`.

### 3.2 Syntax highlighting

- Library: **Shiki**, reached through `@pierre/diffs`, not imported directly by the web app.
  `/home/jc/projects/mesura-code/apps/web/src/lib/syntaxHighlighting.ts:15-20` calls
  `getSharedHighlighter({ themes, langs, preferredHighlighter: "shiki-js" })`. The engine is
  the **pure-JS regex engine**, not WASM, unless `preferredHighlighter: "shiki-wasm"` is asked
  for.
- Themes: exactly two — **`pierre-light`** and **`pierre-dark`**
  (`/home/jc/projects/mesura-code/apps/web/src/lib/diffRendering.ts:4-13`,
  `DIFF_THEME_NAMES` / `resolveDiffThemeName`). They ship inside `@pierre/theming` and are
  registered in a module-level loop in the library's `shared_highlighter.js`. **All app-side
  restyling is CSS-variable overrides injected as `unsafeCSS`** —
  `DIFF_SURFACE_THEME_UNSAFE_CSS` (`diffRendering.ts:194`) and
  `FILE_LINK_REVEAL_UNSAFE_CSS` (`FilePreviewPanel.tsx:87`). Everything renders into a
  `<diffs-container>` custom element with a **shadow root**, so ordinary CSS classes do not
  reach it.
- Languages load **lazily, one at a time**, cached in `highlighterPromiseCache`
  (`syntaxHighlighting.ts:9`), with a fallback to `"text"` when a language is unsupported
  (`:21-28`). The extension → language map is the library's `EXTENSION_TO_FILE_FORMAT`
  (`@pierre/diffs/dist/utils/getFiletypeFromFileName.js`, hundreds of extensions), also
  exported as `getFiletypeFromFileName` and used directly by
  `/home/jc/projects/mesura-code/apps/web/src/components/search/HighlightedSearchLine.tsx:1`.
- **It runs in a worker pool.** `DiffWorkerPoolProvider`
  (`/home/jc/projects/mesura-code/apps/web/src/components/DiffWorkerPoolProvider.tsx:48`)
  wraps the whole surface, and `FilePreviewPanel` is inside it via
  `ChatView.tsx:6968`. Pool size is `clamp(2..6, hardwareConcurrency / 2)` (`:51-55`);
  `totalASTLRUCacheSize: 240` (`:72`); `tokenizeMaxLineLength: 1_000` (`:76`);
  `useTokenTransformer: true` (`:77`).
- Web transitive pin: `pnpm-workspace.yaml` `overrides` sets
  `"@pierre/diffs>@shikijs/transformers": "^4.2.0"`; `shiki` resolves to `4.2.0`.
- Mobile has a **separate, hand-rolled** Shiki stack: `@shikijs/core`,
  `@shikijs/engine-javascript`, `@shikijs/langs`, `@shikijs/themes` all at `4.2.0`, plus
  `react-native-shiki-engine@^0.3.12` and `shiki@4.2.0`
  (`/home/jc/projects/mesura-code/apps/mobile/package.json:60-63,115,119`), driven by
  `/home/jc/projects/mesura-code/apps/mobile/src/features/review/shikiReviewHighlighter.ts`.
  Themes there are `github-light-default` / `github-dark-default` (`:57-60`). Seven languages
  load eagerly (`:77`), about sixty lazily (`:97-160`). No worker — highlighting runs on an
  Effect atom (`sourceHighlightingState.ts:29-48`, idle TTL 5 min). Chunking constants at
  `shikiReviewHighlighter.ts:71-74`.

### 3.3 Image handling

Images never travel through the RPC. `WorkspaceImagePreview`
(`FilePreviewPanel.tsx:131-150`) asks for a **signed, expiring HTTP URL**:

- Resource schema `AssetResource` tagged `"workspace-file"` with `{ threadId, path }`
  (`/home/jc/projects/mesura-code/packages/contracts/src/assets.ts:9-12`).
- The server mints `AssetCreateUrlResult { relativeUrl, expiresAt, sourcePath }` (`:30`) and
  serves it under `ASSET_ROUTE_PREFIX = "/api/assets"`
  (`/home/jc/projects/mesura-code/apps/server/src/assets/AssetAccess.ts:45`, workspace-file
  branch at `:183`, URL shape at `:388`).
- Path length cap `ASSET_PATH_MAX_LENGTH = 1024` (`assets.ts:6`).
- Route: `GET /api/assets/*` at
  `/home/jc/projects/mesura-code/apps/server/src/http.ts:201`, resolving the token (`:217`)
  and streaming `HttpServerResponse.file` (`:224`). Headers from `assetResponseHeaders`
  (`:48`): `Cache-Control: private, max-age=3600`, `X-Content-Type-Options: nosniff`, plus a
  CSP for SVG.
- **Server-side type gate**: `isWorkspacePreviewEntryPath` at `AssetAccess.ts:212` — only
  image and html/pdf extensions can ever be issued a URL.
- Rendered as a plain `<img src={assetUrl.url}>` (`FilePreviewPanel.tsx:154`) with an
  `onError` failure latch (`:157`).
- Mobile adds an explicit prefetch layer: `workspaceFileImageAtom`
  (`/home/jc/projects/mesura-code/apps/mobile/src/features/files/workspace-file-image-cache.ts:21-46`)
  calls `Image.prefetch` before rendering; idle TTL 30 min (`:5`); render uses
  `{ uri, cache: "force-cache" }` (`WorkspaceFileImagePreview.tsx:18`).

Two constraints for the port: the token is **thread-scoped**, and the server refuses any
extension outside the image / html / pdf lists. A file manager with no thread context and a
wider type set needs a new `AssetResource` variant **and** a widened gate.

### 3.4 Size limits

| Constant | Value | Location |
|---|---|---|
| `PROJECT_READ_FILE_MAX_BYTES` | `1024 * 1024` (1 MiB) | `/home/jc/projects/mesura-code/apps/server/src/workspace/WorkspaceFileSystem.ts:28` |
| Read clamp | `Math.min(stat.size, MAX)` | `WorkspaceFileSystem.ts:216` |
| `truncated` flag | `stat.size > MAX`; `byteLength` is the **full** size | `:243`, `:242` |
| `PROJECT_READ_FILE_PATH_MAX_LENGTH` | `512` | `/home/jc/projects/mesura-code/packages/contracts/src/project.ts:12` |
| Web banner | "Preview limited to the first 1 MB of a N byte file." | `FilePreviewPanel.tsx:985-989` |
| `REVEAL_MAX_ATTEMPTS` | `30` | `FilePreviewPanel.tsx:201` |
| `FILE_SAVE_DEBOUNCE_MS` | `500` | `FilePreviewPanel.tsx:85` |
| Per-line tokenize cap (web) | `1_000` (library default is `100_000`) | `DiffWorkerPoolProvider.tsx:76` |
| Mobile highlight preload cap | `MAX_HIGHLIGHT_PRELOAD_CHARACTERS = 256 * 1024` | `/home/jc/projects/mesura-code/apps/mobile/src/features/files/preload-workspace-file.ts:12` |
| Mobile document cache | `MAX_CACHED_DOCUMENTS = 8`, `MAX_CACHED_CHARACTERS = 4 * 1024 * 1024` | `/home/jc/projects/mesura-code/apps/mobile/src/features/files/source-file-document.ts:3-4` |

A **truncated file becomes read-only**: the panel renders `Virtualizer` + `File`
(`:1023-1046`) instead of the editor (`:1048`).

**There is no max-line-count limit.** Long files are handled by virtualisation, not by
truncation.

### 3.5 The preview is an editor

`/home/jc/projects/mesura-code/apps/web/src/components/files/FilePreviewPanel.tsx:8-10`:

```
import { VirtualizedFile, type SelectedLineRange } from "@pierre/diffs";
import { Editor } from "@pierre/diffs/editor";
import { EditProvider, File, type FileOptions, Virtualizer } from "@pierre/diffs/react";
```

The editor is `@pierre/diffs`'s own — **not Monaco, not CodeMirror**.
`EditableFileSurface` builds a `new Editor<FileCommentAnnotationGroup>(...)` (`:466-499`,
`persistState: true`, `persistStateStorage: "inMemory"`) inside an `<EditProvider>` (`:643`).
The DOM surface is `<File ... contentEditable>` (`:695`). Line-range selection drives inline
review comments (`beginComment`, `:564`; `DiffCommentAnnotation` from
`apps/web/src/components/diffs/DiffCommentAnnotation.tsx`).

Save path: `Editor.onChange` (`:471`) → optimistic `setProjectFileQueryData` (`:472`) →
`saveCoordinator.change(...)` (`:473`) → `FileSaveCoordinator`
(`/home/jc/projects/mesura-code/apps/web/src/components/files/fileSaveCoordinator.ts:10`,
coalescing in-flight saves at `:48`, flushing on `dispose()` at `:28-32`) →
`projectEnvironment.writeFile` (`WS_METHODS.projectsWriteFile`,
`/home/jc/projects/mesura-code/packages/contracts/src/rpc.ts:206`; client atom serialised per
`environmentId + cwd + relativePath` at
`/home/jc/projects/mesura-code/packages/client-runtime/src/state/projectCommands.ts:97`;
route `apps/server/src/ws.ts:1848`) → `WorkspaceFileSystem.writeFile`
(`/home/jc/projects/mesura-code/apps/server/src/workspace/WorkspaceFileSystem.ts:262`, which
creates parent directories and then calls `workspaceEntries.refresh`).

Reconciliation: `confirmProjectFileQueryData` (`projectFilesQueryState.ts:72`). The
optimistic overlay lives in its own atom family `projectEnvironment.optimisticFile` (`:21`),
read back at `:188-194` so the editor never flickers to server contents.

Rendered markdown is editable in one narrow way: checkbox toggling writes through the same
coordinator (`onTaskListChange`, `FilePreviewPanel.tsx:735-743`, using
`setMarkdownTaskChecked`).

**The patch on `@pierre/diffs` exists to make this work.**
`/home/jc/projects/mesura-code/patches/@pierre%2Fdiffs@1.3.0-beta.10.patch` has five effects:

1. Upstream force-disables `enableGutterUtility`, `enableLineSelection` and
   `lineHoverHighlight` whenever an editor is attached. The patch strips that. **Without it,
   line selection and inline comments on an editable file are dead code**
   (`FilePreviewPanel.tsx:666-670`).
2. Skips the gutter `pointerdown` handler when `enableLineSelection === true`, so a gutter
   click starts a comment instead of the editor's own behaviour.
3. Syncs `fileInstance.file.contents` after render, which `useFileLineReveal` depends on
   (`FilePreviewPanel.tsx:251`, `:363`).
4. Makes `#setSelectedLinesSafe` bail when `controlledSelection === true`, keeping React the
   source of truth (`FilePreviewPanel.tsx:636`).
5. Adds three subpath exports the app needs: `./types`,
   `./utils/getFiletypeFromFileName`, `./utils/parsePatchFiles`.

Any bump of `@pierre/diffs` must re-apply all five, or the file preview silently loses
comments and reveal.

### 3.6 Where content comes from

RPC `projects.readFile` → `ProjectReadFileResult { relativePath, contents, byteLength,
truncated }` → `WorkspaceFileSystem.readFile` reading the **server's local disk**, jailed to
the workspace root. Never an agent session, never a database.

---

## 4. Diff and review UI

### 4.1 The renderer

**`@pierre/diffs`, version `1.3.0-beta.10`** (catalog entry in
`/home/jc/projects/mesura-code/pnpm-workspace.yaml`), patched at
`/home/jc/projects/mesura-code/patches/@pierre%2Fdiffs@1.3.0-beta.10.patch`.
It is Pierre's diff-and-code viewer: Shiki highlighting, virtualised rendering, an editor
mode, and a Web Worker pool.

Imports in use:

| Import | Site |
|---|---|
| `parsePatchFiles`, `FileDiffMetadata` | `/home/jc/projects/mesura-code/apps/web/src/lib/diffRendering.ts:1-2` |
| `getSharedHighlighter`, `DiffsHighlighter`, `SupportedLanguages` | `/home/jc/projects/mesura-code/apps/web/src/lib/syntaxHighlighting.ts:1-5` |
| `VirtualizedFile`, `SelectedLineRange`, `Editor`, `EditProvider`, `File`, `FileOptions`, `Virtualizer` | `/home/jc/projects/mesura-code/apps/web/src/components/files/FilePreviewPanel.tsx:8-10` |
| `CodeView`, `CodeViewHandle`, `CodeViewProps`, `ControlledCodeViewProps`, `UncontrolledCodeViewProps` | `/home/jc/projects/mesura-code/apps/web/src/components/diffs/StyledDiffCodeView.tsx:2-8` |
| `FileDiffContentsLoader` | `/home/jc/projects/mesura-code/apps/web/src/lib/diffFileContents.ts:1`, `/home/jc/projects/mesura-code/apps/web/src/components/DiffPanel.tsx:2` |
| `@pierre/diffs/worker/worker.js?worker` | `/home/jc/projects/mesura-code/apps/web/src/components/DiffWorkerPoolProvider.tsx:2` |

`StyledDiffCodeView.tsx:1` carries an `oxlint-disable eslint/no-restricted-imports` with the
comment *"This is the single styled adapter around Pierre's raw viewer."* — there is a lint
rule forcing every consumer through that adapter.

### 4.2 The data format

**The server sends unified patch text. The client parses it.**

Server-side source schema, `ReviewDiffPreviewSource`
(`/home/jc/projects/mesura-code/packages/contracts/src/review.ts:16-26`):

```
{ id, kind: "working-tree" | "branch-range", title,
  baseRef: string | null, headRef: string | null,
  diff: Schema.String,   // raw unified patch
  diffHash: string,      // SHA-256 of the patch, used as the render cache key
  truncated: boolean }
```

- Produced by `git diff --patch --no-color --no-ext-diff --no-textconv --minimal` at
  `/home/jc/projects/mesura-code/apps/server/src/vcs/GitVcsDriverCore.ts:2190-2200`
  (working tree vs `HEAD`) and `:2226-2235` (`<baseRef>...HEAD`). Untracked files use
  `git diff --no-index /dev/null <path>` (`:2137-2148`). Hash at `:2251-2264`. Service at
  `/home/jc/projects/mesura-code/apps/server/src/review/ReviewService.ts:89`.
- Client parses with `parsePatchFiles` into `FileDiffMetadata[]`, wrapped as
  `RenderablePatch = { kind: "files", files } | { kind: "raw", text, reason }`
  (`/home/jc/projects/mesura-code/apps/web/src/lib/diffRendering.ts:44-53`); the raw fallback
  renders as a `<pre>` at `DiffPanel.tsx:969-984`. Parsing happens in a `useMemo` on the
  **main thread** (`DiffPanel.tsx:393-399`).
- `FileDiffMetadata` = `{ name, prevName?, lang?, mode?, type, hunks, splitLineCount,
  unifiedLineCount, isPartial, deletionLines, additionLines, cacheKey? }` with
  `type ∈ 'change' | 'rename-pure' | 'rename-changed' | 'new' | 'deleted'`.
  `isPartial: true` means "parsed from a patch; hunk expansion needs hydration". The library
  flips it to `false` after `loadDiffFiles` runs.
- App-side offset fix for virtualised partial patches: `compactPartialHunkOffsets`
  (`diffRendering.ts:84`), applied only when `selectedTurnId === null`
  (`DiffPanel.tsx:395-398`).
- View-model handed to the renderer: `CodeViewDiffItem<T> = { id, type: 'diff', fileDiff,
  annotations?, version?, collapsed?, edit? }`, built at
  `/home/jc/projects/mesura-code/apps/web/src/components/diffs/AnnotatableCodeView.tsx:126-167`.
  `version` is an FNV-1a of collapse state plus annotations (`:155-163`), so the viewer knows
  when to re-render.
- Render caching is content-addressed: `buildPatchCacheKey` uses a **double** FNV-1a of the
  trimmed patch (`diffRendering.ts:33-41`).
- Context expansion loads full file contents through `FileDiffContentsLoader`
  (`createGitDiffFileContentsLoader`,
  `/home/jc/projects/mesura-code/apps/web/src/lib/diffFileContents.ts:79`; wired at
  `DiffPanel.tsx:314-334`, passed as `options.loadDiffFiles` at `:965`), backed by
  `review.getDiffFileContents` (`{ oldContents, newContents }`, `review.ts:28-43`) or
  `pullRequest.getDiffFileContents`.
- Two sibling sources use the same format: **checkpoint / turn diffs** (`useCheckpointDiff`,
  `/home/jc/projects/mesura-code/apps/web/src/lib/checkpointDiffState.ts:8`) and
  **pull requests** (`PullRequestDiffResult = { patch, truncated, nextCursor,
  omittedFileStats? }`,
  `/home/jc/projects/mesura-code/packages/contracts/src/pullRequest.ts:769`, cursor-paginated).
- The server also parses patches with the same library, for checkpointing:
  `/home/jc/projects/mesura-code/apps/server/src/checkpointing/Diffs.ts:1`.

### 4.3 Worker pool — highlighting only

`/home/jc/projects/mesura-code/apps/web/src/components/DiffWorkerPoolProvider.tsx` creates a
pool of `@pierre/diffs` workers (`workerFactory`, `:60`; `poolSize`, `:71`) and pushes theme
changes into them (`setRenderOptions`, `:35`).

**The worker protocol is render-only.** Its messages are `InitializeWorkerRequest`,
`SetRenderOptionsWorkerRequest`, `RenderFileRequest` and `RenderDiffRequest`, returning
`ThemedFileResult` / `ThemedDiffResult` — token ASTs. **There is no "compute diff" message.**
Diff computation is `git` on the server; patch parsing is synchronous on the main thread.

### 4.4 Modes, virtualisation, collapse

**Modes.** `diffStyle: diffRenderMode === "split" ? "split" : "unified"`
(`DiffPanel.tsx:959`). Store type `DiffRenderMode = "stacked" | "split"`
(`/home/jc/projects/mesura-code/apps/web/src/diffPanelStore.ts:13`), default `"stacked"`
(`:40`), persisted through zustand `persist` (`:36`, partialised at `:135`). Toggle group at
`DiffPanel.tsx:768-785`. The pull-request tab keeps its own local copy
(`PullRequestCodeTab.tsx:219`, applied at `:742`). Word wrap:
`overflow: wordWrap ? "wrap" : "scroll"` (`DiffPanel.tsx:961`, `FilePreviewPanel.tsx:671`).

**Virtualisation.** Two mechanisms. `CodeView` virtualises internally, and the geometry is
pinned app-side in `StyledDiffCodeView` `itemMetrics`
(`/home/jc/projects/mesura-code/apps/web/src/components/diffs/StyledDiffCodeView.tsx:303-317`
— `diffHeaderHeight: 32`, `hunkSeparatorHeight: 24`, `spacing: 0`, `paddingTop: 0`,
`paddingBottom: 8`). The comment at `:310-316` warns that a wrong `paddingBottom`
desynchronises virtual and rendered heights. The file preview instead uses the standalone
`<Virtualizer>` (`overscrollSize: 600`, `intersectionObserverMargin: 1200`,
`FilePreviewPanel.tsx:647-650`, `:1027-1030`).

**Collapse is app-owned, not library-owned.** State `CollapsedDiffFilesState { scopeKey,
fileKeys }` (`DiffPanel.tsx:82-87`), scope key `env:thread:section` (`:213-215`) so collapse
resets on turn or scope change. Toggle-all bumps `codeViewRevision` (`:487`) to force a
remount, because collapse changes total geometry. Helpers in
`/home/jc/projects/mesura-code/apps/web/src/lib/diffCollapse.ts`. The header click is
intercepted in a capture-phase handler (`:883-913`): filename opens the editor, elsewhere
toggles collapse. The pull-request tab deliberately starts folded and stores the reader's
choice as a delta from the toolbar's last command (`DiffFoldOverride`,
`/home/jc/projects/mesura-code/apps/web/src/components/pullRequest/pullRequestDiff.logic.ts:25-44`).

**Inline comments.** `AnnotatableCodeView` (`:99`) anchors drafts and persisted comments by
`{ side, lineNumber }` (`appendAnnotationEntry`, `:45`) and renders each with
`DiffCommentAnnotation` — explicitly "the shared inline comment treatment for file previews,
thread diffs, and pull-request diffs". While a draft is open it disables gutter and line
selection (`:250-251`).

### 4.5 Reusability for a file manager's compare view

**Yes — and the library already exports the exact API for it, unused.**

`@pierre/diffs` exports
`parseDiffFromFile(oldFile: FileContents | null, newFile: FileContents | null, options?,
throwOnError?) => FileDiffMetadata` from the package root. A grep over `apps/` and
`packages/` finds **zero call sites** for `parseDiffFromFile`, `MultiFileDiff`, `PatchDiff`
and `UnresolvedFile`. The product only ever goes patch-text → `parsePatchFiles`, because its
diffs always come from git.

A two-file compare view needs:

1. Two `FileContents` objects — `{ name, contents, cacheKey?, lang? }`. `name` alone drives
   language inference.
2. `parseDiffFromFile(oldFile, newFile)` → one `FileDiffMetadata`, already **complete**
   (`isPartial: false`), so context expansion works with **no `loadDiffFiles` at all**. This
   is simpler than the git path. Do not apply `compactPartialHunkOffsets` (it early-returns
   on non-partial files anyway).
3. Render with either `<FileDiff fileDiff={...} options={{ diffStyle, theme, themeType }} />`
   — already used inline in chat at
   `/home/jc/projects/mesura-code/apps/web/src/components/chat/MessagesTimeline.tsx:2061-2069`
   — or `<StyledDiffCodeView items={[{ id, type: "diff", fileDiff, collapsed: false,
   version }]} />` for the full styled surface.
4. Optionally wrap in `<DiffWorkerPoolProvider>`; `disableWorkerPool` exists if not.

**Blockers, in order of severity:**

1. **No RPC reads two arbitrary paths.** `projects.readFile` takes `{ cwd, relativePath }`;
   `review.getDiffFileContents` is git-revision-oriented
   (`{ cwd, sourceKind, changeType, baseRef, headRef, oldPath, newPath }`). Neither accepts
   two independent absolute paths.
2. **Workspace confinement on both sides.** `WorkspaceFileSystem.readFile` realpaths and
   rejects escapes (`:167-179`); `ReviewService.assertWorkspaceBoundCwd` rejects any cwd
   outside `config.cwd` / `config.worktreesDir`
   (`/home/jc/projects/mesura-code/apps/server/src/review/ReviewService.ts:65-87`).
3. **The 1 MiB cap and binary rejection apply to both sides.** A truncated side silently
   produces a wrong diff, so a caller must check `truncated` on both and refuse.
4. **`cacheKey` discipline.** The render cache is keyed by `cacheKey`. Follow the existing
   content-addressed convention (`projectFileCacheKey` =
   `cwd:path:fnv1a(contents)`,
   `/home/jc/projects/mesura-code/apps/web/src/components/files/fileContentRevision.ts:10`),
   or two files with the same name and different contents will render each other's tokens.
5. **`AnnotatableCodeView` is coupled** to `composerDraftTarget` and `useComposerDraftStore`
   (`:110-114`). A plain compare view should use `StyledDiffCodeView` directly and skip the
   annotation layer.

**Nothing in the renderer itself blocks this.** `StyledDiffCodeView` takes plain `items`
(`:241-247`) with no thread, no environment and no git assumption. The blocker is entirely
the workspace jail on the content side (§2.1).

---

## 5. Git integration today

### 5.1 Shape of the thing

- **No git library anywhere.** No `isomorphic-git`, `simple-git`, `nodegit`, `dugite` in any
  `package.json`. Every operation is a `git` subprocess.
- **All git code lives in `apps/server`.** `apps/desktop`, `apps/web` and `apps/mobile`
  contain none — they consume RPC only.
- **Four spawn sites** in the whole monorepo.

| # | Site | Primitive |
|---|---|---|
| 1 | `/home/jc/projects/mesura-code/apps/server/src/vcs/GitVcsDriverCore.ts:739` | `ChildProcess.make("git", args, { cwd, env })` inside `executeRaw` — the main engine |
| 2 | `/home/jc/projects/mesura-code/apps/server/src/vcs/GitVcsDriver.ts:431` | `process.run({ command: "git", args: ["-C", cwd, ...] })` — helper `gitCommand` at `:415` |
| 3 | `/home/jc/projects/mesura-code/apps/server/src/project/RepositoryIdentityResolver.ts:99,125` | `processRunner.run` — bypasses both drivers |
| 4 | `/home/jc/projects/mesura-code/apps/server/src/sourceControl/SourceControlDiscovery.ts:43-48` | `git --version` availability probe (sibling `jj` entry marked `implemented: false`) |

Process layer: `/home/jc/projects/mesura-code/apps/server/src/vcs/VcsProcess.ts:105`.
`DEFAULT_TIMEOUT_MS = 30_000` (`:52`), `DEFAULT_MAX_OUTPUT_BYTES = 1_000_000` (`:53`),
truncation marker `"\n\n[truncated]"` (`:54`). Non-zero exits are classified into
`authentication | rate-limited | not-found | command-failed` (`:56`).

### 5.2 The status commands and their parsers

The pair a "our own git status" feature would extend:

| Command | Site | Parser |
|---|---|---|
| `git status --porcelain=2 --branch` | `GitVcsDriverCore.ts:1573,1596` | inline `:1685-1708`; `parseBranchAb` (`:156`, `/^\+(\d+)\s+-(\d+)$/`); `parsePorcelainPath` (`:189`, handles `1 ` `2 ` `u ` `? ` `! ` prefixes and tab-split renames) |
| `git diff HEAD --numstat --` | `:1614,1656` | `parseNumstatEntries` (`:165`), handles the `old => new` rename arrow |
| `git diff --numstat` / `git diff --cached --numstat` | `:1623,1627` | same, unborn-HEAD fallback |
| `git rev-list --left-right --count HEAD...<upstream>` | `:1528` | split on `/\s+/` → `aheadCount`, `behindCount` |
| `git rev-list --count <base>..HEAD` | `:1463` | `computeAheadCountAgainstBase` (`:1451`) |
| `git status --porcelain` | `:2859` | cleanliness gate before a branch refresh |

Worktree discovery:
**`git --git-dir <d> worktree list --porcelain -z`** at `:2497`, parsed by
`parseWorktreeBranchPaths` (`:245`) into `Map<branchName, worktreePath>`; entries are then
`fs.stat`-filtered at `:2530`.

Refs snapshot: **`git for-each-ref --format=%(refname)%09%(committerdate:unix)%09%(symref)
refs/heads refs/remotes`** at `:2472` (16 MiB cap, 30 s), parsed at `:2543-2580`.

Worktree lifecycle:
`git worktree add [-b <new>] <path> <ref>` (`:2771-2772`,
`WORKTREE_ADD_TIMEOUT_MS = 300_000` at `:45`) and
`git worktree remove [--force] <path>` (`:2985`, 15 s).
The base branch is recorded as git config `branch.<new>.gh-merge-base` (`:2786`) and read
back at `:1405`.

Other families, all in `GitVcsDriverCore.ts`: repository paths (`rev-parse
--git-common-dir` / `--show-toplevel` / `symbolic-ref`), remotes and config, commit / push /
pull, range and review (`git log`, `git diff --stat`, `git diff --patch`, `git show
<rev>:<path>`, `git ls-files --others --exclude-standard -z`), branch operations
(`checkout`, `branch -m`, `branch --set-upstream-to`, `merge --ff-only`, `update-ref`).
`GitVcsDriver.ts` adds the checkpoint machinery (`read-tree`, `write-tree`, `commit-tree`,
`update-ref`, `restore`, `clean`) run against a temporary `GIT_INDEX_FILE`.
`GitManager.ts:618` reads recent commit subjects with
`git log -n 20 --no-merges --pretty=format:%s`.

Instrumentation: `createTrace2Monitor` (`GitVcsDriverCore.ts:468`) sets
`GIT_TRACE2_EVENT` to a temp file (`:621`) and tails it to surface hook progress
(`hook_started` / `hook_output` / `hook_finished`).

### 5.3 Caching and refresh

`GitVcsDriverCore.ts` TTL constants at `:41-81`:

| Cache | Key | TTL |
|---|---|---|
| `repositoryPathsCache` (`:1103`) | normalized absolute `cwd` | 10 min; 1 s on a `null` result |
| `defaultBranchCache` (`:1136`) | `gitCommonDir` | 5 min |
| `originExistsCache` (`:1162`) | `gitCommonDir` | 5 min |
| `statusRemoteRefreshCache` (`:1236`) | `{ gitCommonDir, remoteName }` | 15 s on success; exponential 30 s → 15 min on failure |
| `listRefsSnapshotCache` (`:2632`) | `{ gitCommonDir, epoch }` | 2 min, epoch-bumped by mutations |

`GitManager.ts`: `localStatusResultCache` (`:891`) and `remoteStatusResultCache` (`:1144`),
both keyed on `realPath(cwd)` with `STATUS_RESULT_CACHE_TTL = 1s`, capacity 2048;
`prLookupCache` (`:947`) at 2 min with exponential failure backoff.

**The poller** is `/home/jc/projects/mesura-code/apps/server/src/vcs/VcsStatusBroadcaster.ts`.
`makeRemoteRefreshLoop` (`:382`) runs every
`DEFAULT_VCS_STATUS_REFRESH_INTERVAL = 30s` (`:28`), backing off to 15 min on failure
(`:29-30`). Pollers are **refcounted per subscriber** (`retainRemotePoller` `:465`,
`releaseRemotePoller` `:514`). Payloads are fingerprinted (`fingerprintStatusPart`, `:173`)
so identical states do not re-publish. The interval is user-configurable:
`DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL = Duration.seconds(30)`
(`/home/jc/projects/mesura-code/packages/contracts/src/settings.ts:551`).

**There is no filesystem watcher on `.git`.** Invalidation is event-driven:
`ProviderCommandReactor.ts:834` → `refreshStatus(cwd)`,
`CheckpointReactor.ts:540` → `refreshLocalStatus(cwd)`,
`ws.ts:379` `refreshGitStatus(cwd)`.

### 5.4 The wire model

`/home/jc/projects/mesura-code/packages/contracts/src/git.ts` (461 lines). The types a file
manager would consume or extend:

- **`VcsRef`** (`:76`) — `{ name, isRemote?, remoteName?, current, isDefault, worktreePath }`
- **`VcsWorktree`** (`:86`) — `{ path, refName }`
- **`VcsStatusLocalResult`** (`:238`) — `{ isRepo, sourceControlProvider?, hasPrimaryRemote,
  isDefaultRef, refName, hasWorkingTreeChanges, workingTree: { files: [{ path, insertions,
  deletions }], insertions, deletions } }`
- **`VcsStatusRemoteResult`** (`:241`) — `{ hasUpstream, aheadCount, behindCount,
  aheadOfDefaultCount?, pr }`
- **`VcsStatusStreamEvent`** (`:250`) — tagged union `snapshot | localUpdated | remoteUpdated`
- `GitActionProgressEvent` (`:452`) — the streaming progress union

**Note the shape of `workingTree.files`: `{ path, insertions, deletions }`.** It carries no
per-file status letter (M / A / D / R / ?). The porcelain status codes are parsed
(`parsePorcelainPath`, `GitVcsDriverCore.ts:189`) but **collapsed away before the wire**.
A Symmetria-style per-row git badge (`M`, `??`, `A`) therefore **cannot be built from the
existing contract** — it needs either a schema extension or a new RPC.

`/home/jc/projects/mesura-code/packages/contracts/src/vcs.ts` holds the driver abstraction:
`VcsDriverKind = "git" | "jj" | "unknown"` (`:4`), `VcsDriverCapabilities` (`:22`), and the
process-error union (`:272`). The product is already structured for a second VCS.

Shared helpers: `/home/jc/projects/mesura-code/packages/shared/src/git.ts` —
`mergeGitStatusParts` (`:226`), `applyGitStatusStreamEvent` (`:262`),
`normalizeGitRemoteUrl` (`:114`), `WORKTREE_BRANCH_PREFIX = "t3code"` (`:13`).

### 5.5 RPC surface

Method names: `WS_METHODS` at
`/home/jc/projects/mesura-code/packages/contracts/src/rpc.ts:197`. Handlers in
`/home/jc/projects/mesura-code/apps/server/src/ws.ts`.

| Wire method | Handler | Implementation |
|---|---|---|
| `subscribeVcsStatus` (stream) | `ws.ts:1953` | `VcsStatusBroadcaster.streamStatus` (`:556`) |
| `vcs.refreshStatus` | `ws.ts:1963` | `VcsStatusBroadcaster:368` |
| `vcs.listRefs` | `ws.ts:2022` | `GitVcsDriverCore:2700` |
| `vcs.createWorktree` | `ws.ts:2026` | `GitVcsDriverCore:2763` |
| `vcs.removeWorktree` | `ws.ts:2032` | `GitVcsDriverCore:2982` |
| `vcs.createRef` / `vcs.switchRef` / `vcs.init` | `ws.ts:2038,2044,2050` | `GitVcsDriverCore:3099,3017,3113` |
| `vcs.pull` | `ws.ts:1971` | `GitVcsDriverCore:2022` |
| `git.runStackedAction` (stream) | `ws.ts:1983` | `GitManager:2154` |
| `git.resolvePullRequest` / `git.preparePullRequestThread` | `ws.ts:2006,2014` | `GitManager:1839,1852` |
| `review.getDiffPreview` / `review.getDiffFileContents` | `ws.ts:2058,2062` | `GitVcsDriverCore:2166,2403` |

### 5.6 UI consumers

`GitActionsControl.tsx` (78 KB) + `.logic.ts`, `BranchToolbar.tsx` (21 KB) +
`BranchToolbarBranchSelector.tsx` (32 KB), `DiffPanel.tsx` (41 KB),
`components/pullRequest/` (`PullRequestDetailPanel.tsx` 90 KB,
`PullRequestCodeTab.tsx` 57 KB), `ThreadStatusIndicators.tsx`,
`chat/ChangedFilesTree.tsx`, `settings/SourceControlSettings.tsx`. Client state lives in
`/home/jc/projects/mesura-code/packages/client-runtime/src/state/vcs.ts`,
`gitActions.ts`, `vcsAction.ts`, `vcsRefInvalidation.ts`.

Also present: full GitHub / GitLab / Bitbucket / Azure DevOps CLI integrations under
`/home/jc/projects/mesura-code/apps/server/src/sourceControl/`, all spawning `gh`, `glab`
and `az` through the same `VcsProcess`.

---

## 6. Shared primitives worth reusing

Versions are quoted from `/home/jc/projects/mesura-code/apps/web/package.json` unless noted.

### 6.1 Tree component — the headline find

**`@pierre/trees` `1.0.0-beta.4`** (`apps/web/package.json:29`), Apache-2.0, a web component
with a React wrapper. Used at
`/home/jc/projects/mesura-code/apps/web/src/components/files/FileBrowserPanel.tsx:4,6`.

What it already ships, from `dist/index.d.ts`:

- **Virtualisation** — `model/virtualization.js`, `FILE_TREE_DEFAULT_ITEM_HEIGHT`
- **Keyboard** — arrows, `Home`, `End`, `Enter`, `Escape`, `Space`, `F2`, `F10`, `ContextMenu`
- **Context menus** — `FileTreeContextMenuItem`, `ContextMenuOpenContext`, trigger modes
- **Drag and drop** — `FileTreeDragAndDropConfig`, `FileTreeDropTarget`, `FileTreeDropResult`
- **Mutations** — `FileTreeAddEvent`, `FileTreeRemoveEvent`, `FileTreeRenameEvent`,
  `FileTreeMoveEvent`, `FileTreeBatchOperation`
- **`GitStatus` / `GitStatusEntry`** — `'added' | 'deleted' | 'ignored' | 'modified' |
  'renamed' | 'untracked'` (`dist/publicTypes.d.ts`). **The component already supports
  per-row git decoration, and the product does not use it** — `grep gitStatus` over
  `apps/web/src/components/files/` returns nothing.
- Sorting (`FileTreeSortComparator`), density presets, search modes, row decorations,
  SSR payloads, icon resolution.

Styling is injected as shadow-DOM CSS through a `unsafeCSS` attribute — see
`TREE_UNSAFE_CSS` at `FileBrowserPanel.tsx:37-47`, which overrides `--trees-bg-override`,
`--trees-selected-bg-override`, `--trees-hover-bg-override`,
`--trees-border-color-override`, `--trees-font-family-override`,
`--trees-font-size-override`. **Theming is limited to the variables the library exposes** —
a Miller-column layout or a Symmetria-specific row design is not reachable through them.

### 6.2 Virtualised lists

- **`@legendapp/list` `3.3.5`** (catalog; patched at
  `patches/@legendapp__list@3.3.5.patch`). Used by
  `apps/web/src/components/chat/MessagesTimeline.tsx`,
  `BranchToolbarBranchSelector.tsx`, `chat/ModelPickerContent.tsx`,
  `settings/FontFamilyPicker.tsx`.
- **`@pierre/diffs` `Virtualizer`** — the code/diff virtualiser
  (`FilePreviewPanel.tsx:10`, used at `:1023`).
- **`@pierre/trees`** — internal tree virtualiser (§6.1).
- Mobile uses React Native `FlatList`.
- **There is no `@tanstack/react-virtual`, `react-window` or `react-virtuoso`.**

### 6.3 Keyboard and hotkeys

A **central, user-configurable, VS Code-style registry**:

- Command literals: `STATIC_KEYBINDING_COMMANDS`
  (`/home/jc/projects/mesura-code/packages/contracts/src/keybindings.ts:50`), plus
  `THREAD_KEYBINDING_COMMANDS` (`:37`) and `MODEL_PICKER_KEYBINDING_COMMANDS` (`:44`);
  the union is `KeybindingCommand` (`:88`).
- Defaults: `DEFAULT_KEYBINDINGS`
  (`/home/jc/projects/mesura-code/packages/shared/src/keybindings.ts:21`) — rows like
  `{ key: "mod+p", command: "filePicker.toggle", when: "!terminalFocus" }`.
- `when` expressions are a real parsed grammar (`WhenToken`, `keybindings.ts:13`;
  `MAX_WHEN_EXPRESSION_DEPTH` in contracts).
- Matching: `/home/jc/projects/mesura-code/apps/web/src/keybindings.ts` (552 lines) with
  `ShortcutMatchContext { terminalFocus, terminalOpen, previewFocus, previewOpen, [key]:
  boolean }` (`:29`) and a physical-key fallback (`EVENT_CODE_KEY_ALIASES`, `:51`).
- Server side persists and validates: `/home/jc/projects/mesura-code/apps/server/src/keybindings.ts`
  (25 KB), settings UI at
  `/home/jc/projects/mesura-code/apps/web/src/routes/settings.keybindings.tsx`.

This is the closest analogue to Symmetria's `KeyRegistry.js`, and it is **richer** — it has a
`when`-expression language and user overrides, which Symmetria does not.

**There are no chords.** Every binding is a single key plus modifiers. A `gg`/`yy`/`dd` chord
layer has no home in this registry and would need its own dispatcher.

### 6.4 Command palette

`/home/jc/projects/mesura-code/apps/web/src/components/CommandPalette.tsx` (87 KB) +
`CommandPalette.logic.ts` (15 KB). Built on Base UI `Autocomplete` primitives wrapped in
`apps/web/src/components/ui/command.tsx`. Commands are **not** a registry array — they are
hard-coded JSX branches with a mode machine (project browse, file picker, thread search,
folder browse). Result rows are capped at 200. **There is no extension point**; adding a
command means editing that file.

An event bus exists for opening it: `apps/web/src/commandPaletteBus.ts`.

### 6.5 Context menus

Two-tier. `readLocalApi()` (`/home/jc/projects/mesura-code/apps/web/src/localApi.ts:40-42`)
calls the **native Electron menu** through `window.desktopBridge.showContextMenu(items,
position)` when running in the desktop shell, and falls back to a DOM implementation
`showContextMenuFallback`
(`/home/jc/projects/mesura-code/apps/web/src/contextMenuFallback.ts:204`) in a browser.
The item schema is `ContextMenuItem<T>` with nested `children`
(`/home/jc/projects/mesura-code/packages/contracts/src/ipc.ts:105-140`).
In-page menus use **`@base-ui/react` `^1.4.1`** through
`apps/web/src/components/ui/menu.tsx`.

### 6.6 Resizable panels

**Hand-rolled, no library.** `useResizableWidth`
(`/home/jc/projects/mesura-code/apps/web/src/hooks/useResizableWidth.ts`) plus
`RightPanelResizeHandle`
(`/home/jc/projects/mesura-code/apps/web/src/components/preview/RightPanelResizeHandle.tsx`)
and `PreviewPanelShell`
(`/home/jc/projects/mesura-code/apps/web/src/components/preview/PreviewPanelShell.tsx`),
which persists width under a `widthStorageKey`.

### 6.7 Icons

- **`lucide-react` `^0.564.0`** — the general icon set, imported directly per component.
- `/home/jc/projects/mesura-code/apps/web/src/components/Icons.tsx` (56 KB) and
  `JetBrainsIcons.tsx` (32 KB) — inline SVG for brand and editor logos.
- **File-type icons already exist**:
  `/home/jc/projects/mesura-code/apps/web/src/pierre-icons.ts` uses
  `createFileTreeIconResolver` + `getBuiltInSpriteSheet` from `@pierre/trees` and adds a
  custom sprite (`T3_FILE_ICON_SPRITE`) for `package.json`, `tsconfig`, `AGENTS`, Claude,
  `README` and `pnpm`. Exported as `T3_PIERRE_ICONS`, consumed by
  `FileBrowserPanel.tsx:20` and by `PierreEntryIcon` on both web and mobile.

### 6.8 Theme tokens

- **Tailwind CSS v4** (`@tailwindcss/vite` `^4.0.0`), `tailwind-merge` `^3.4.0`,
  `class-variance-authority` `^0.7.1`. Utility `cn` at `apps/web/src/lib/utils.ts`.
- Token definitions: `/home/jc/projects/mesura-code/apps/web/src/index.css` (2 359 lines) —
  `@theme` and `@theme inline` blocks map `--color-*` Tailwind tokens onto plain CSS
  variables; `@custom-variant dark (&:is(.dark, .dark *))` at `:3`.
- Runtime palette: `/home/jc/projects/mesura-code/apps/web/src/themePalette.ts` (75 KB).
  `APP_THEME_VARIABLES` (`:1766`) maps each `ThemeColorRole` to a CSS custom property
  (`canvas → --app-theme-canvas`, `surface → --app-theme-surface`,
  `toolbar → --app-theme-toolbar`, …). `applyThemePalette` (`:1854`) writes them onto
  `document.documentElement`.
- Theme definitions: `/home/jc/projects/mesura-code/packages/shared/src/themePalettes.ts`
  (36 KB) — `THEME_COLOR_ROLES` (`:18`), `ThemeDefinition` (`:81`), and five built-ins
  (`t3-chat`, `grove`, `ocean`, `ember`, `iris`, `:95-729`).
- **Users can import VS Code themes** —
  `/home/jc/projects/mesura-code/apps/web/src/openVsxThemes.ts` (28 KB) and
  `vscodeThemeImport.ts` (18 KB).
- Hook: `useTheme()` (`/home/jc/projects/mesura-code/apps/web/src/hooks/useTheme.ts:461`)
  returns `resolvedTheme: "light" | "dark"`.

Symmetria's `color-scheme.json` model has no counterpart here. Matching the Symmetria look
inside Mesura means writing a `ThemeDefinition`, not shipping a JSON the app reads from disk.

### 6.9 State and data layer

A new panel imports:

- `@effect/atom-react` (catalog `4.0.0-beta.103`) — `useAtomValue`, `useAtomRefresh`.
- `~/rpc/atomRegistry` → `appAtomRegistry`.
- Environment-scoped atom families from
  `@t3tools/client-runtime/state/*` (e.g. `projectEnvironment`, `vcsEnvironment`,
  `filesystemEnvironment`), instantiated in `apps/web/src/state/*.ts`.
- `~/state/use-atom-command` and `~/state/use-atom-query-runner` for mutations.
- `zustand` `^5.0.11` with `persist` for local UI state (`rightPanelStore.ts`,
  `diffPanelStore.ts`).

`@tanstack/react-router` `^1.160.2` for routing, `@tanstack/react-pacer` `^0.19.4` for
debouncing, `@dnd-kit/*` for drag and drop, `@formkit/auto-animate` `^0.9.0` for list
transitions, `culori` `^4.0.2` for colour maths, `jszip` `3.10.1`, `jsonc-parser` `3.3.1`,
`react-markdown` `^10.1.0` with `remark-gfm` / `remark-breaks` / `rehype-raw` /
`rehype-sanitize`, `lexical` + `@lexical/react` `^0.41.0` for the composer editor.

### 6.10 The right-panel extension point

This is where a file-manager tab would plug in.

`/home/jc/projects/mesura-code/apps/web/src/rightPanelStore.ts:17-25`:

```
export const RIGHT_PANEL_KINDS = [
  "diff", "files", "file", "preview", "terminal", "pull-request", "agents",
] as const;
```

`RightPanelSurface` (`:28-65`) is a discriminated union over those kinds. Adding a surface
means touching, at minimum:

1. `RIGHT_PANEL_KINDS` and `RightPanelSurface` (`rightPanelStore.ts`)
2. `singletonSurface` (`:130`) and the persisted-state migration (`migratePersistedRightPanelState`, `:248`) — note the storage key is versioned, `"t3code:right-panel-state:v2"` at `:67`, with a migration log at `:68-70`
3. The tab-bar switch in
   `/home/jc/projects/mesura-code/apps/web/src/components/RightPanelTabs.tsx`
   (`case` blocks at `:485-500` and `:546-567`) plus the `onAdd*` prop set (`:73-78`)
4. The render switch in
   `/home/jc/projects/mesura-code/apps/web/src/components/ChatView.tsx:6378-6455`

All four are upstream-maintained files. See §8.

---

## 7. Replacement analysis

| # | Existing surface | Verdict | Reasoning |
|---|---|---|---|
| 1 | `FileBrowserPanel.tsx` — project file tree | **REPLACE (carefully) or COEXIST** | It is the closest analogue to the Symmetria tree, but it is thread-scoped, feeds the composer with `@`-mentions, and its rows drag into the chat. Replacing it means re-implementing mention drag (`fileTreeDragMention.ts`) and the reveal-sync contract with `FilePreviewPanel`. Safer first move: add a Symmetria surface beside it, then retire this one. |
| 2 | `ProjectFilePicker.tsx` — Cmd-P picker | **COEXIST** | It is a chat-composer affordance bound to `mod+p` in the shared keybinding defaults. A Symmetria fuzzy finder inside a file-manager window is a different surface with a different scope (local filesystem vs project). Replacing it would break the palette's file mode. |
| 3 | Command-palette folder browser (`filesystem.browse`) | **EXTEND** | This is the only free-filesystem API that exists. A Symmetria browser needs files, `stat`, mime and mtime — extend the contract rather than add a parallel one, or the product ends up with two directory-listing protocols. |
| 4 | Native folder dialog (`PICK_FOLDER_CHANNEL`) | **IGNORE** | It is the OS dialog. Nothing to port. A Symmetria picker could eventually replace it, but that is a separate decision. |
| 5 | `FilePreviewPanel.tsx` — file viewer/editor | **COEXIST, reuse the renderer** | It is an *editor* with inline review comments wired into the composer and the save coordinator, and the `@pierre/diffs` patch exists specifically to keep that combination working (§3.5). The Symmetria preview is a read-only viewer with a much wider type set. Reuse `@pierre/diffs` `File` + `Virtualizer` inside the Symmetria panel; do not replace this one. **Replacing it breaks inline review comments and file editing.** |
| 6 | `ChangedFilesTree.tsx` — per-turn changed files | **IGNORE** | Tightly coupled to the chat transcript and to checkpoint diffs. Not a file browser. |
| 7 | `DiffPanel.tsx` + `components/diffs/` | **COEXIST, reuse** | The renderer is generic (§4.5) and `@pierre/diffs` already exports `parseDiffFromFile` for two-file compare, unused today. A Symmetria compare view should call that plus `StyledDiffCodeView`, not build a second diff stack. Replacing the panel breaks turn diffs, branch diffs and pull-request review. |
| 8 | `components/pullRequest/` | **IGNORE** | Forge integration, out of scope for a file manager. |
| 9 | Git status pipeline (`VcsStatusBroadcaster`, `GitVcsDriverCore`) | **EXTEND** | Reuse the 30 s poller, the caches and the `subscribeVcsStatus` stream. **The wire schema drops per-file status letters** (`workingTree.files` is `{ path, insertions, deletions }`), so a per-row `M`/`??`/`A` badge needs a schema extension. Do not fork the driver — a second `git status` poller on the same repo doubles the process cost and desynchronises. |
| 10 | Worktree lifecycle (`vcs.createWorktree` / `removeWorktree`) | **COEXIST** | Worktrees here are a *thread* concept, created under `<serverBaseDir>/worktrees`. A file manager should show and navigate them, not create them. |
| 11 | `@pierre/trees` | **REUSE or REPLACE, decide early** | It already has virtualisation, keyboard, context menus, drag and drop, rename/move events and a `GitStatus` decoration API. But it is a shadow-DOM web component themed only through its own CSS variables, and it is a `1.0.0-beta.4` third-party beta. Miller columns are not expressible in it. |
| 12 | `@ff-labs/fff-node` fuzzy index | **REUSE** | Same engine as Symmetria's Rust `fff`. Already packaged, already patched for asar. Reuse `WorkspaceSearchIndex` rather than adding a second index process — LMDB and the mmap cache do not like two owners. |
| 13 | Keybinding registry (`contracts` + `shared` + `apps/web/src/keybindings.ts`) | **EXTEND** | Add Symmetria commands to `STATIC_KEYBINDING_COMMANDS` and `DEFAULT_KEYBINDINGS`. **No chord support exists** — a `gg`/`dd` layer needs its own dispatcher scoped to the file-manager surface. |
| 14 | `CommandPalette.tsx` | **IGNORE** | 87 KB with no extension point. Any Symmetria command entry means editing an upstream god-file. Prefer a dedicated surface. |
| 15 | Context-menu bridge (`localApi.contextMenu.show`) | **REUSE** | Gives native OS menus on the desktop for free, with a DOM fallback. |
| 16 | Theme system (`themePalette.ts`, `themePalettes.ts`) | **EXTEND** | Ship a Symmetria `ThemeDefinition`. Do not add a second palette mechanism reading `color-scheme.json` from disk. |
| 17 | Right-panel surface registry | **EXTEND** | The only sane mount point for an embedded file manager. Four upstream files must change (§6.10). |
| 18 | Asset URL service (`/api/assets`, `workspace-file`) | **EXTEND** | Image bytes need a signed URL. The existing tag is **thread-scoped**; a file manager with no thread needs a new `AssetResource` variant. |
| 19 | `revealInFileExplorerLabel` + `revealArtifact` | **REPLACE (small)** | `shell.showItemInFolder` at `/home/jc/projects/mesura-code/apps/desktop/src/preview/Manager.ts:3669` opens the OS file manager. Once Symmetria exists, this should open Symmetria instead. One-line change, high symbolic value. |
| 20 | Mobile file surfaces | **IGNORE** | React Native, no shared components. Out of scope. |

### Breakage flags

- **Replacing `FilePreviewPanel`** removes file editing, the save coordinator, inline review
  comments, and the markdown task-checkbox toggle (`setMarkdownTaskChecked`).
- **Replacing `FileBrowserPanel`** removes composer `@`-mention drag-and-drop
  (`fileTreeDragMention.ts`) and the reveal-selected-file contract used by search results and
  by terminal path links (`resolvePathLinkTarget`).
- **Replacing `DiffPanel`** removes turn diffs, branch/unstaged scope switching, and the
  pull-request code tab.
- **Forking the git status pipeline** doubles `git status --porcelain=2` and
  `git rev-list` invocations per repo per 30 s, and the two copies will disagree during the
  1 s status cache window.
- **Adding a `RIGHT_PANEL_KINDS` entry** changes persisted state. The store already carries a
  migration ladder (`v9`, `v10`, `v11` comments at `rightPanelStore.ts:68-70`); a new kind
  needs its own migration rung or old sessions will restore a surface the switch cannot
  render.

---

## 8. Upstream-fork risk

The repo tracks `upstream = https://github.com/pingdotgg/t3code.git`. Merge base with
`upstream/main` is `8f7da3b99e48ffb678d3426a1b5fb602ecdd50f7`. The fork is 33 commits ahead
and 15 behind at the time of writing.

### 8.1 Files a port would touch that upstream also maintains

| File | Upstream? | Fork already edits it? | Why a port touches it |
|---|---|---|---|
| `apps/web/src/rightPanelStore.ts` | yes | no | new surface kind + migration |
| `apps/web/src/components/RightPanelTabs.tsx` | yes | **yes** | tab rendering + `onAdd*` prop |
| `apps/web/src/components/ChatView.tsx` (268 KB) | yes | **yes** | the render switch at `:6378` |
| `packages/contracts/src/keybindings.ts` | yes | **yes** | new command literals |
| `packages/shared/src/keybindings.ts` | yes | **yes** | new default bindings |
| `apps/web/src/keybindings.ts` | yes | **yes** | new `when` context flags |
| `packages/contracts/src/rpc.ts` | yes | **yes** | new `WS_METHODS` entries |
| `apps/server/src/ws.ts` (102 KB) | yes | **yes** | new RPC handlers |
| `packages/contracts/src/filesystem.ts` | yes | no | extended browse result |
| `packages/contracts/src/git.ts` | yes | no | per-file status letters |
| `apps/server/src/workspace/WorkspaceEntries.ts` | yes | no | file-listing browse |
| `apps/server/src/auth/RpcAuthorization.ts` | yes | **yes** | scope for new methods |
| `apps/web/src/index.css` | yes | no | any new token |
| `apps/web/src/components/CommandPalette.tsx` (87 KB) | yes | no | only if a palette entry is added |

**The three worst offenders are `ChatView.tsx` (268 KB), `ws.ts` (102 KB) and
`CommandPalette.tsx` (87 KB).** They are churn-heavy upstream and huge, so every conflict is
expensive to resolve. `Sidebar.tsx` (167 KB) and `LegacySidebar.tsx` (138 KB) are in the same
class if a sidebar entry is ever added.

### 8.2 The layout the fork already uses — follow it

The fork has an established, working pattern for exactly this problem:

| Fork-owned path | Exists upstream? |
|---|---|
| `apps/web/src/symmetria/` | **no** |
| `apps/desktop/src/symmetria/` | **no** |
| `packages/symmetria-broker-contract/` | **no** |
| `tests/` (workspace `@symmetria/acceptance-tests`) | **no** |

Those directories hold all fork logic. The touch on upstream files is deliberately kept to
**single import lines**:

```
apps/web/src/components/AppSidebarLayout.tsx:27:  import { useThreadFeed } from "../symmetria/useThreadFeed";
apps/web/src/components/ChatView.tsx:221:      import { useSttDelivery } from "../symmetria/useSttDelivery";
```

And the keybinding additions are one array row each:

```
packages/contracts/src/keybindings.ts:  + "usage.peek",
packages/shared/src/keybindings.ts:     + { key: "alt+u", command: "usage.peek" },
```

`pnpm-workspace.yaml` even carries a comment naming the `tests` entry as
*"the one upstream line this work touches"*.

### 8.3 Recommended layout for a file-manager port

1. **New code goes in fork-owned directories.**
   - `apps/web/src/symmetria/filemanager/` — every React component, hook and store.
   - `apps/desktop/src/symmetria/filemanager/` — any main-process IPC (local `fs`, window
     spawning, `shell.showItemInFolder` override).
   - `packages/symmetria-filemanager-contract/` — a **new workspace package** for the wire
     schemas. Do **not** add to `packages/contracts/src/filesystem.ts` or `git.ts`: those are
     upstream files and every schema change is a permanent conflict. A sibling package
     conflicts with nothing.
   - `tests/unit/symmetria-filemanager-*.test.ts` — acceptance tests, following the existing
     phase-test convention.

2. **Prefer desktop IPC over server RPC for local-filesystem work.**
   A new RPC method costs edits to `packages/contracts/src/rpc.ts`, `apps/server/src/ws.ts`
   and `apps/server/src/auth/RpcAuthorization.ts` — three upstream files, two of them large.
   A new desktop IPC channel costs edits to
   `apps/desktop/src/ipc/channels.ts`, `preload.ts`, `DesktopIpcHandlers.ts` and
   `packages/contracts/src/ipc.ts` — also upstream, but the first three are small and the
   fork already edits `channels.ts` and `preload.ts`. **The lowest-conflict option is a
   fork-owned Unix socket**, which is precisely what `apps/desktop/src/symmetria/` already
   does for the STT bridge and the thread feed (`unixSocket.ts`, `socketFiles.ts`) — zero
   upstream files touched.

3. **Budget exactly four upstream edit sites for the embedded surface**, and keep each to a
   single line or a single `case`:
   - `rightPanelStore.ts` — one kind literal, one union member, one migration rung
   - `RightPanelTabs.tsx` — one `case` in each of the two switches
   - `ChatView.tsx` — one branch in the render switch, delegating immediately to a
     `symmetria/` component
   - `packages/shared/src/keybindings.ts` + `packages/contracts/src/keybindings.ts` — one row
     each

4. **Keep every non-trivial decision inside the fork-owned component.** The upstream file
   should contain a mount point and nothing else, so a conflict is always resolvable by
   re-inserting one line.

5. **Do not modify `apps/web/src/index.css`.** Scope Symmetria styling to the fork-owned
   component tree with Tailwind utilities and a component-local `<style>` or a
   `ThemeDefinition` registered through the existing theme API.

6. **A standalone Symmetria window (goal one) has zero upstream conflict surface** if it
   lives entirely in `apps/desktop/src/symmetria/` plus its own renderer entry. That is the
   cheaper first target, and it defers every conflict in this section to goal two.

---

## 9. The five facts that decide the port

1. **All React lives in `apps/web`; the desktop shell only proxies a URL into a sandboxed
   renderer with no Node access.** New UI goes in `apps/web`; new filesystem power goes
   behind IPC or a socket.
2. **Nothing browses local files today.** One surface browses local *directories* for the
   Add-Project flow. Every file surface is jailed to a workspace root by a realpath check.
   A file manager needs a new listing and reading path, whatever the UI looks like.
3. **The `fff` engine is already here** (`@ff-labs/fff-node@0.9.4`, patched for asar), and
   `@pierre/trees` already has virtualisation, keyboard, context menus, drag-and-drop,
   rename/move events and an unused `GitStatus` decoration API.
4. **The diff renderer is git-agnostic and already exports the two-file compare entry point
   the product never calls** (`parseDiffFromFile`).
5. **The git status wire schema drops per-file status letters.** Symmetria-style per-row
   badges cannot be built from `VcsStatusLocalResult` as it stands.

---

## Open items

- No measurement was taken of tree, preview or diff performance. Every performance statement
  here is read from a constant in the source, not from a benchmark.
- `Sidebar.tsx` (167 KB) and `LegacySidebar.tsx` (138 KB) were not read. If a file-manager
  entry is ever wanted in the sidebar rather than the right panel, they need their own pass.
- The `t3ProjectFile` schema (`packages/contracts/src/t3ProjectFile.ts`) declares
  project-level settings and setup scripts. It was not examined as a place to carry
  file-manager configuration.
