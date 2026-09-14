# File tree

> For maintainers. Using Mesura Code? See [docs/user](../user/).

The **file tree** in the files surface of the right panel is the tree of the Symmetria File
Manager, consumed as a library and driven by a thin host layer in `apps/web`. It replaced T3 Code's
`FileBrowserPanel` (ADR-005). The folder **overview** on `Ctrl+Shift+E` is the same library's graph
over the same data.

The parts, and the file that owns each:

| Part                                                   | File                                                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| The library, as a git subtree                          | `vendor/symmetria-file-manager` (runbook: `docs/operations/vendor-symmetria-file-manager.md`) |
| The tree component and its seams                       | `@symmetria/fm-ui/tree` (`packages/fm-ui/src/tree/index.ts`)                                  |
| The overview layer and its port                        | `@symmetria/fm-ui/overview` (`packages/fm-ui/src/overview/index.ts`)                          |
| The host layer                                         | `apps/web/src/components/files/mesuraTree/`                                                   |
| The focus registry the chords use                      | `apps/web/src/lib/focusTargets.ts`                                                            |
| Chords that reach the app from inside a focused Neovim | `apps/web/src/components/files/monaco/nvim/appShortcutsThatOutrankNeovim.ts`                  |

## The host layer, module by module

Everything under `apps/web/src/components/files/mesuraTree/` is fork-owned. Each module has one
job:

| Module                        | Job                                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `MesuraFileTree.tsx`          | Mounts `FileTree`; owns the tree record cache, the reveal route, the port, the context menu, and `revealInTree` for the overview |
| `MesuraFolderOverview.tsx`    | Mounts `OverviewLayer` in a portal on `body` while the store says the overview is open; owns its port                            |
| `useProjectOverviewModel.ts`  | The `projects.listEntries` query and the workspace-mutation refresh, as an `OverviewModel`                                       |
| `overviewModelFromEntries.ts` | The pure adapter from the server's flat listing to the library's folder map; `relativeToCwd`, `entryKindAt`                      |
| `keyInput.ts`                 | `KeyInput`, `Binding`, `commandForKey`, and `routeKey`, shared by the tree and the overview                                      |
| `treeKeymap.ts`               | The tree's key table, over `TreeCommand`                                                                                         |
| `overviewKeymap.ts`           | The overview's key table, over `OverviewCommand`                                                                                 |
| `treeReveal.ts`               | When a `selectedPath` / `selectedPathRevealId` pair is a new reveal request                                                      |
| `fileTreeStore.ts`            | zustand: `explorerOpen` (persisted under the T3 key), `pendingFocus`, `overviewOpen`                                             |
| `fileTreeShortcutDecision.ts` | The pure decision tables for `Ctrl+E` and `Ctrl+Shift+E`                                                                         |
| `fileTreeFocusMoves.ts`       | `leaveFileTree`, `runFileTreeToggle`, `runOverviewToggle`: the effects those decisions name                                      |
| `useFileTreeShortcut.ts`      | The window capture-phase listener that resolves the two commands                                                                 |
| `fileTreeContextMenu.ts`      | Copy mention / Add to chat, ported from the T3 tree                                                                              |
| `treeShapeStorage.ts`         | The persisted tree shape (cursor and collapsed folders), with a coalescing persister                                             |
| `overviewViewStorage.ts`      | The persisted overview view (selection, collapsed, camera, boxes), per graph root                                                |
| `schemaLocalStorage.ts`       | Local storage behind an Effect schema that never throws at the caller                                                            |
| `writeCoalescer.ts`           | The delay-and-flush writer both storages use                                                                                     |
| `fileTree.css`                | The tokens the library reads and `index.css` lacks, plus panel sizing; see `docs/mesura/styling.md`                              |

`replacesT3Tree.test.ts` asserts that the five T3 tree files stay deleted and nothing under
`apps/web/src` imports `@pierre/trees/react`.

## The adapter contract

The tree never reads a filesystem. It renders `projects.listEntries`, the same flat list the file
picker and project search use, through `overviewFoldersFromEntries(cwd, entries)`:

- Input: the absolute project root and `ProjectEntry[]` (`{ path, kind }`, paths relative to the
  root, `kind` is `"file" | "directory"`).
- Output: `ReadonlyMap<string, OverviewFolder>`, keyed by **absolute** path. There is one folder
  for the root, one per listed directory, and one per intermediate directory a file path implies,
  so a truncated listing still nests.
- Entries are sorted directories first, then `localeCompare` on the name, which is the order the
  file manager's own scanner produces. `isHidden` is `name.startsWith(".")`; `isSymlink` is false.
- Every folder's status is `Loaded`. The file manager's finer states (`Queued`, depth limits)
  describe its own scanner and have no server equivalent.
- `foldersForListing` yields an **empty map until the listing exists**. A synthesised empty root
  reads as a complete listing to the library's pruning, which then drops every restored fold
  (`pruneTreeShape`: only a complete `Loaded` parent listing proves removal). Keep it that way.
- When the server reports `truncated`, the host shows a notice and stops persisting the shape.

`useProjectOverviewModel` wraps the adapter with the query state: `loading` while there is no data,
`refreshing` on a refetch, `inspected` as the entry count, `refresh` composed with the file panel's
own refresh so the toolbar's Refresh re-reads the open file too.

## The ports and who drives them

The library exposes two seams and the host owns both ends of each chord:

- **`TreePort` / `TreeController`.** The tree calls `port.connect(controller)` on mount; the host
  keeps the controller and sends it `TreeCommand`s. `MesuraFileTree` also registers the controller
  in a module-level map keyed by `projectTreeKey(environmentId, cwd)` so `revealInTree` can move
  the cursor from outside; with no tree mounted, the reveal is stored on the tree record and
  resolved on the tree's first render.
- **`OverviewPort`.** `connect` for `OverviewCommand`s, `reveal(path)` (close, reveal in the tree,
  open when it is a file), `focus(path)` (re-root the graph; the layer remounts on its root key),
  and the flash port.

The file manager's own window-level dispatcher (`useKeyDispatch`) is **not mounted**. It attaches
to `window` and swallows keys, which would fight every chord this application owns. Instead each
wrapper's `onKeyDown` goes through `routeKey`: flash mode first, then native activation for buttons
and disclosures, then Escape (inside a text field it blurs the field; elsewhere it is the host's),
then the command table. The tables are copies of the file manager's `TREE` and `OVERVIEW_ONLY`
registry rows, minus what belongs to the file manager alone. `Symbol` rows accept Shift and AltGr,
as the file manager's `matchKey` does, and refuse Ctrl and Alt chords.

The chat view's type-anywhere listener would otherwise take the letters: `[role="tree"]` and
`[role="dialog"][aria-modal="true"]` are in its interactive selector for that reason.

## Focus

`focusTargets.ts` is a registry of `tree`, `editor` and `composer`, each a function returning
whether it took focus. The tree registers `tree` and `composer` while mounted;
`MonacoFileSurface.tsx` registers `editor`. `leaveFileTree` focuses the editor **before** hiding
the tree so focus never lands on `body`, and falls back to the composer with the tree left in
place. ADR-004 (pane focus) is meant to reuse this registry.

The overview layer's `useDialogFocus` (vendored) focuses the dialog on mount and restores the
previous element on unmount, which is how `Escape` and the chord return focus to where they were.

## Storage

| Key                                              | Value                                                      | Written by           |
| ------------------------------------------------ | ---------------------------------------------------------- | -------------------- |
| `t3code.fileExplorerOpen`                        | boolean, the T3 key kept so a preference carries           | `fileTreeStore`      |
| `mesura.fileTree.<environmentId>:<cwd>`          | `{ selected, collapsed[] }`, collapsed sorted              | `treeShapePersister` |
| `mesura.fileTreeOverview.<environmentId>:<root>` | `{ selected, collapsed[], zoom, origin, scroll, boxes[] }` | `overviewViewStore`  |

Both persisters coalesce writes behind 300 ms and flush on `pagehide`; the library reports a
change on every cursor move and every scroll frame. The tree persister also skips a shape equal to
the last one written and the default shape of a project that stored nothing, and retries a write
that failed. Values are decoded with `Schema.is`, so a corrupt value is forgotten rather than
thrown. Keys are never evicted.

## Chords

| Command             | Default       | Where it is decided      |
| ------------------- | ------------- | ------------------------ |
| `fileTree.toggle`   | `mod+e`       | `decideFileTreeShortcut` |
| `fileTree.overview` | `mod+shift+e` | `decideOverviewShortcut` |

Both are `when: "!terminalFocus"`, dispatched from one window capture-phase listener installed by
the chat route, and members of `APP_SHORTCUTS_THAT_OUTRANK_NEOVIM` as defence should that listener
ever move. `Ctrl+D`/`Ctrl+U` are in the tree's table but the chat timeline's capture listener takes
them first; ADR-004 scopes that listener and the tree then gets them with no change here.

## Upstream files touched

Everything above is fork-owned except these, measured on 2026-09-14 as commits on `upstream/main`
in the previous three months:

| File                                                 | Commits | What changed here                                                                         |
| ---------------------------------------------------- | ------: | ----------------------------------------------------------------------------------------- |
| `apps/web/src/components/ChatView.tsx`               |     221 | two selector entries in `TYPE_TO_FOCUS_INTERACTIVE_SELECTOR` (that block: 1)              |
| `apps/web/src/components/files/FilePreviewPanel.tsx` |      32 | one import and one element swapped, one element added; explorer state read from the store |
| `apps/web/package.json`                              |      31 | three `workspace:*` dependencies                                                          |
| `pnpm-workspace.yaml`                                |      44 | three vendored package paths                                                              |
| `vite.config.ts`                                     |      15 | `vendor/**` excluded from fmt, lint and test                                              |
| `packages/contracts/src/keybindings.ts`              |      13 | two command ids                                                                           |
| `packages/shared/src/keybindings.ts`                 |       8 | two default bindings                                                                      |
| `apps/web/src/routes/_chat.tsx`                      |       – | one hook call                                                                             |

Deleted: `FileBrowserPanel.tsx` (15), `fileTreeExpansion.ts`, `fileTreeDragMention.ts` and their
tests. The accepted cost of that deletion is recorded in ADR-005.
