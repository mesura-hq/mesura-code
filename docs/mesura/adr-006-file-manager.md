# ADR-006 — The Symmetria File Manager over the window

**Status:** Accepted, 2026-09-14.

**Scope:** what `Ctrl+Shift+E` opens, where the file manager's privileged half runs, how its UI
reaches it from any client, and what that costs. The architecture is in
`docs/internals/file-manager.md`; the sync commands in
`docs/operations/vendor-symmetria-file-manager.md`. It supersedes the `Ctrl+Shift+E` decision of
ADR-005.

## Decision

**`Ctrl+Shift+E` opens the whole Symmetria File Manager as a layer over the window, at the thread's
project, with all of its operations; the tree-listing overview that answered the chord before is
deleted, and the file manager's own overview is `Ctrl+O` inside it.** The file manager's UI runs in
the web app; its privileged half runs in the Mesura server behind four RPCs and a preview route, so
a remote browser and the desktop get the same file manager against the server's machine.

## The decisions, each with what it rejected

**The host is the server behind the WebSocket, not the Electron preload.** _Rejected: install the
standalone's preload bridge in the desktop shell._ It would work on the desktop alone; the phone and
a paired browser are how this fork is driven. The cost is four RPCs, their scopes, and a server
dependency on `fm-main`.

**Two envelope RPCs and one stream; payloads decoded by `fm-core` on both ends.** _Rejected: an
Effect Schema per channel._ A mirror of 1,114 lines of decoders that drifts on every pull. The
contract carries the channel names as literals, with a parity test, and `Unknown` payloads. The
cost: a wire codec, because JSON carries neither bytes nor `undefined`.

**`createRegistry` gets its Electron-bound pieces injected.** _Rejected: rewrite the registry in
the server._ 793 lines duplicated. _Rejected: dynamic imports of Electron._ They hide the
dependency. The standalone now passes what it used to import, and an import-graph test in the
vendored package keeps the registry Electron-free.

**Sessions are opened only by the event stream, and belong to the connection.** _Rejected: open a
session on the first query._ A watch registered for a sink that does not exist leaks until the
registry is disposed; the stream's end is the one place resources are released. Keyed by the RPC
client id and the client's id together, so two devices cannot collide.

**Trash is `gio trash`, open is `xdg-open`, the clipboard is the browser's.** _Rejected:
reimplement the freedesktop trash specification._ The clipboard belongs to the reader's machine,
which on a phone is not the server's.

**Previews are capability URLs on an unauthenticated route.** _Rejected: bytes over the bridge._
Chromium's PDF viewer refuses a blob URL, and `<img>`/`<audio>`/iframe loads want a URL. The tokens
are the standalone's own policy: unguessable, the 64 most recent, no expiry beyond eviction.

**One stand-down guard in `resolveShortcutCommand`.** _Rejected: a guard in each of the twelve
listeners._ One upstream file with 9 commits in three months instead of twelve edits. The second
guard the plan asked for (`isOpenFavoriteEditorShortcut`) was unnecessary: every `is*Shortcut` helper
already resolves through the first. The right panel's launcher letters have their own listener and
its blocking-layer list names the layer.

**The layer mounts from the chat route.** _Rejected: from the files surface, opening it first._
The file manager does not depend on the files surface; the old "open the surface first" decision
table is deleted with the overview.

**The stylesheet's window rules move to the standalone's renderer entry.** _Rejected: import them
and override._ They restyle the host's `html` and `body`. _Rejected: fork the stylesheet._ It
drifts. The one exception is the scrollbar, global by the file manager's own tested design; the host
aliases its tokens.

**`fileTree.overview` is renamed, not kept beside `fileTree.miller`.** _Rejected: keep the old id
as an alias._ One chord, one meaning. The cost was found by the first run against a real config: an
unknown id is an invalid entry, and an invalid entry stops the startup backfill. `RENAMED_KEYBINDING_COMMANDS`
rewrites the id on load; the file keeps the old id until the user edits a binding.

**`fm-main` joins the workspace with `electron` an optional peer.** _Rejected: copy the registry
into the server._ The root `overrides` pin `electron` to the desktop's version so the vendored dev
dependency cannot install a second one.

**The bookmark and listing stores are the standalone's XDG files.** _Rejected: a store of our
own._ The developer runs both; a bookmark set in one should exist in the other.

## What this costs, accepted knowingly

- **A read scope reaches any readable path on the server**, not only a project's: list, describe,
  read text, preview grants. That is the standalone's reach, handed to every holder of a read token.
  Writes need the operate scope.
- **Previews are unauthenticated capability URLs**, bounded by the token cap of 64 and evicted, never
  expired.
- **`resolveShortcutCommand` gains a guard** and `RightPanelTabs.tsx` (37 upstream commits) one list
  entry; `http.ts` exports one helper; `ws.ts` (89), `server.ts` (57), `rpc.ts` (39) and
  `RpcAuthorization.ts` (26) each gain a block. The full table with counts is in
  `docs/internals/file-manager.md`.
- **The server depends on `fm-main`**, with Electron marked optional, and on `gio` and `xdg-open`
  being installed on the host.
- **`usage.peek` (`alt+u`) does not stand down**: the account-limits panel matches the chord itself
  rather than through the resolver. Harmless, the file manager binds nothing on it; routing that
  listener through `resolveShortcutCommand` is one upstream edit, deferred.
- **The finder is absent.** `f` reports it; it arrives as a finder of its own, reachable from
  anywhere in the application.
- **A remote browser opens outside-project files on the server's desktop**, not the reader's.
- **Toasts sit above the layer** (`z-index: 100` over `60`), as they did over the overview.

## Deferred, and to what

- Pushing the vendored edits back: right after this branch merges, with the runbook's command.
- The finder: a run of its own, as a standalone `Ctrl+F` for the whole application.
- Persisting the renamed command id to `keybindings.json` at startup: not needed while the file
  heals on the next edit; revisit if the rename table ever has to be retired.
- A DOM test environment for `apps/web`, which would let the layer's focus and install order be
  tested without the outside witness.

## What would reverse this

The developer stops using the standalone file manager, as ADR-005 says for the tree. The reversal
is deleting `mesuraFileManager/`, `apps/server/src/fileManager/`, the four RPCs and their scopes,
and `fm-main` from the workspace; the tree and ADR-005 stand on their own.
