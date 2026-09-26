# File manager

> For maintainers. Using Mesura Code? See [docs/user](../user/).

The **file manager** over the window on `Ctrl+Shift+E` is the Symmetria File Manager itself, its
Miller columns, previews, operations and folder overview, consumed from the vendored subtree and
hosted in two halves: its UI (`@symmetria/fm-ui`) renders in the web app inside a layer, and its
privileged half (`@symmetria/fm-main`, scanning, watching, file operations) runs in this server
behind four RPCs. The standalone puts the same two halves in an Electron renderer and main process
and joins them with a preload bridge; here the bridge speaks the WebSocket. The decision and its
costs are ADR-006; the file tree in the files surface is a separate, smaller host
([file-tree.md](./file-tree.md)).

The parts, and the file that owns each:

| Part                                             | File                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| The contract: channels, envelopes, events, codec | `packages/contracts/src/fileManager.ts`                                                 |
| The four RPCs                                    | `packages/contracts/src/rpc.ts` (`fileManager.*`)                                       |
| The service                                      | `apps/server/src/fileManager/FileManagerHost.ts`                                        |
| The transport the registry runs on               | `apps/server/src/fileManager/wsIpcSurface.ts`                                           |
| The host's file operations                       | `apps/server/src/fileManager/hostOperations.ts`                                         |
| The preview route                                | `apps/server/src/fileManager/previewRoute.ts`                                           |
| The browser bridge, and its installer            | `mesuraFileManager/wsBridge.ts`, `bridgeInstall.ts`                                     |
| The open flag, the start target, the toggle      | `mesuraFileManager/fileManagerStore.ts`, `fileManagerTarget.ts`, `fileManagerToggle.ts` |
| Where an activated file goes                     | `mesuraFileManager/openFromFileManager.ts`                                              |
| Whether the layer is up, read from the page      | `mesuraFileManager/isFileManagerOpen.ts`                                                |
| The RPC atoms and the session stream             | `apps/web/src/state/fileManagerRpc.ts`                                                  |
| The layer                                        | `apps/web/src/components/files/mesuraFileManager/MesuraFileManagerLayer.tsx`            |
| The stand-down guard                             | `apps/web/src/keybindings.ts` (`standDownForFileManager`)                               |
| The stylesheet                                   | `apps/web/src/components/files/mesuraFileManager/fileManager.css`                       |

## The contract

The file manager's 28 request channels and 4 push channels are copied as literals into
`FILE_MANAGER_READ_CHANNELS`, `FILE_MANAGER_WRITE_CHANNELS` and `FILE_MANAGER_PUSH_CHANNELS`;
`apps/server/src/fileManager/channels.test.ts` asserts parity with `fm-main`'s tables and with
`fm-core`'s failure codes. The web app takes exactly one module of `@symmetria/fm-main`, that
channel table (`@symmetria/fm-main/ipc/channels`, which imports nothing); any other subpath would
pull `node:fs` or Electron into the browser bundle, and `fmMainBoundary.test.ts` fails on it. Payloads are **not** mirrored as schemas:
`FileManagerQueryInput` and `FileManagerMutateInput` carry `{ sessionId, channel, payload: Unknown }`,
and every payload is decoded by the file manager's own decoders inside the registry, on the server,
exactly as in the standalone. A reply is `{ ok, value }` or `{ ok: false, error: { code, message } }`.

| RPC                           | Scope   | What                                                                                                               |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `fileManager.host`            | read    | `{ homePath }`, the server's home directory: what `~` means to the UI. The start directory is the thread's project |
| `fileManager.query`           | read    | one read channel, for one session                                                                                  |
| `fileManager.mutate`          | operate | one write channel, for one session                                                                                 |
| `fileManager.subscribeEvents` | read    | opens a session; a stream of `{ ready: true }` then `{ channel, payload }`                                         |

A read token therefore reaches any path the server process can read: list, describe, read text,
preview grants. That is the standalone's own reach, granted to whoever holds a read scope; ADR-006
records it.

**The wire codec.** Electron's IPC carries values by structured clone; the WebSocket carries JSON.
`toFileManagerWireValue` and `fromFileManagerWireValue` cross every reply, push and request: a
`Uint8Array` (the `describe` reply's byte head, for the content sniff) travels as
`{ $symmetriaBytes: <base64> }`, and `undefined`, non-finite numbers and bigints become `null`. A
value with nothing to change is returned as the same reference. Without it the first `describe`
died in the RPC encoder as a defect the client could not act on.

## Sessions

A **file manager session** is one mounted file manager in one client. The client chooses an id; the map on the
server is keyed by the RPC client id and that id together, so another connection can neither query
nor receive the pushes of a session it did not open.

- **Opened only by the stream.** `fileManager.subscribeEvents` opens the session and announces
  `{ ready: true }` first, so the bridge holds every call until the session exists; a query for a
  session nobody opened is refused with `invalid_request`.
- **Pushes** go into a sliding queue of 1024 behind the stream: a storm drops its oldest ticks,
  which every consumer coalesces (a later `changed` re-lists the same directory).
- **Released when the stream ends**, watches included, through `createRegistry`'s per-sender
  tables. The client's atom for the stream is read on subscribe (`watchAtom`), which is what
  starts it; a plain subscription never reads and the session never opened.

The registry's Electron-bound pieces are injected (`Dependencies`): the host's `operations`,
the `clipboard` (refused here, the browser owns it), the `searchPool` (absent: the finder answers
"not available here yet"), and the bookmark and listing-options stores, which are the standalone's
own XDG files (`~/.config/symmetria-fm`), shared on purpose.

## The host's operations

`hostOperations.ts` is what the standalone's main process does with Electron's `shell`, without
Electron: `create` and `rename` from `fm-main`'s own `mutate`, `transfer` with a cancel handle per
id, `trash` as `gio trash` in batches of 256, `open` as `xdg-open` detached. A missing command is
reported as "`<cmd>` is not installed on the host"; `gio trash` has a 30 s kill, `xdg-open` is let
go of once it has spawned and never killed. Trash refuses `tmpfs` mounts, which is `gio`'s rule;
`gio`'s own message reaches the status bar.

## Previews over HTTP

The file manager's previews are `<img>`, `<embed>`, `<audio>` and iframe loads, so they need a
same-origin URL rather than bytes over the bridge. The registry mints a **preview token** per path
through `fm-main`'s `previewTokens`, the same grants the standalone serves under its private scheme,
and `previewRoute.ts` serves them under `/api/file-manager/preview/`:

- `<prefix><token>` serves the one file a file token names; `<prefix><token>/<relative>` serves a
  neighbour of a directory token's document (a rendered page's images) and refuses anything that
  resolves outside that directory once symbolic links are followed.
- A token is a capability: unguessable, bounded to the 64 most recent grants, evicted as newer ones
  arrive, no expiry beyond eviction. The route is unauthenticated by design, as the standalone's is.
- HTML and XHTML carry a `Content-Security-Policy` that lets a framed page reach nothing remote, on
  every status. Ranges are honoured (`assetByteRange`, exported from `http.ts` for it), text types
  name their charset, `Cache-Control: private, no-store`.
- The server answers a root-relative URL; the bridge resolves it against the environment's HTTP base
  URL, because a paired browser and the desktop shell reach the server by different origins.

## The bridge and the layer

`createWsBridge(transport, hooks)` implements `fm-core`'s `Bridge` over `FileManagerTransport`:
every send waits for the session's `ready`, a lost session fails fast, listeners are snapshotted
before delivery, `hideWindow` closes the layer, the clipboard is the browser's (`navigator.clipboard`,
an image fetched from its preview first), picker calls are no-ops and nothing outside the page asks
this host to open a path. `installFileManagerBridge` puts it on `window[symmetriaFm]` and refuses a
second one.

`MesuraFileManagerLayer` mounts once from the chat route's `ChatRouteGlobalShortcuts`, renders
nothing while the store is closed, and when open portals to `body` a
`div[data-mesura-file-manager][role=dialog][aria-modal=true]` keyed on `environmentId:cwd`. The
bridge is created and installed in an effect **before** the vendored `App` mounts (its hooks call the
bridge from their mount effects); `App` is `lazy()` so the preview dependencies stay out of the
chat's bundle. Focus is taken on mount and restored on unmount. The start directory is the thread's
worktree or its project root; a momentarily empty projection keeps the last target, and only the
thread leaving the route closes the layer. A file under the project opens through
`useRightPanelStore.openFile` and closes the layer; anything else goes to the host's `open`.
Escape closes the layer through `App`'s `onDismiss`, which hears only the Escape the file manager's
own cascade had no use for: a dialog, a pending chord, flash, a selection and the overview each take
an Escape first. The standalone swallows that last Escape and keeps its window up.

The vendored `useKeyDispatch` stays as it is: it attaches to `window` only while `App` is mounted.
The host's chords stand down through one guard: `resolveShortcutCommand` returns `null` for every
command but `fileTree.miller` while `isFileManagerOpen()` (the root attribute is in the page), and
every `is*Shortcut` helper resolves through it. The right panel's launcher letters have their own
capture listener and its blocking-layer list names the root attribute. One listener resolves
neither way: the account-limits panel matches `usage.peek` (`alt+u`) itself, so that chord still
fires under the layer; the file manager binds nothing on it. The chat view's type-to-focus
already skips `[role="dialog"][aria-modal="true"]`.

## Chords

| Command           | Default       | Where it is decided                           |
| ----------------- | ------------- | --------------------------------------------- |
| `fileTree.miller` | `mod+shift+e` | `runFileManagerToggle` (`mesuraFileManager/`) |

`when: "!terminalFocus"`, dispatched from the tree's window capture-phase listener, and a member of
`APP_SHORTCUTS_THAT_OUTRANK_NEOVIM`. The command replaced `fileTree.overview`; a stored rule with the
old id is rewritten on load by `RENAMED_KEYBINDING_COMMANDS` (`packages/shared`), without a config
issue, so the startup backfill keeps running. The file keeps the old id until the user edits a
binding.

Upstream ships `composer.effort` on the same chord since v0.0.42. The fork withdraws that default
through `DROPPED_KEYBINDING_DEFAULTS`, because `alt+e` (`traitsPicker.toggle`) opens the same picker.
A sync that takes upstream's line back puts two defaults on one chord, and `forkKeybindings.test.ts`
fails on it.

The command palette's **Open file manager** row is the second way in, and the one that always
works: Firefox and Zen keep `Ctrl+Shift+E` for their Network Monitor, so the page never sees it
there. The palette hands focus back to the composer as it closes, after the layer has mounted; its
`finalFocus` calls `focusFileManager()` first, or the file manager's keys would go to the chat.

## Upstream files touched

Everything above is fork-owned except these, measured on 2026-09-14 as commits on `upstream/main`
in the previous three months:

| File                                                 | Commits | What changed here                                   |
| ---------------------------------------------------- | ------: | --------------------------------------------------- |
| `apps/server/src/server.test.ts`                     |      89 | the host layer in the test composition              |
| `apps/server/src/ws.ts`                              |      88 | four handlers                                       |
| `apps/server/src/server.ts`                          |      56 | the host layer and the preview route                |
| `pnpm-workspace.yaml`                                |      44 | `fm-main` as a member; `overrides.electron`         |
| `packages/contracts/src/rpc.ts`                      |      39 | four `WS_METHODS` and four `Rpc.make`               |
| `apps/web/src/components/CommandPalette.tsx`         |      56 | the Open file manager row; one `finalFocus` line    |
| `apps/web/src/components/RightPanelTabs.tsx`         |      37 | one entry in the launcher's blocking-layer list     |
| `packages/shared/package.json`                       |      36 | one subpath export                                  |
| `apps/web/src/components/files/FilePreviewPanel.tsx` |      32 | the overview element and import removed             |
| `apps/web/package.json`                              |      31 | one `workspace:*` dependency                        |
| `apps/server/package.json`                           |      28 | two dependencies                                    |
| `apps/server/src/auth/RpcAuthorization.ts`           |      26 | four scopes                                         |
| `apps/server/src/http.ts`                            |      24 | `assetByteRange` exported                           |
| `packages/contracts/src/index.ts`                    |      14 | one export                                          |
| `packages/client-runtime/src/rpc/client.ts`          |      14 | one member of the subscription tag union            |
| `packages/contracts/src/keybindings.ts`              |      13 | one command id renamed                              |
| `apps/web/src/keybindings.ts`                        |       9 | one import, one call in the loop, one fork function |
| `packages/shared/src/keybindings.ts`                 |       8 | one default renamed; `composer.effort`'s withdrawn  |
| `apps/web/src/routes/_chat.tsx`                      |       8 | one import; the layer returned instead of `null`    |
| `apps/server/src/keybindings.ts`                     |       5 | one import, two call sites wrapped, drops persisted |
