# ADR-005 — The Symmetria file tree replaces the T3 tree

**Status:** Accepted, 2026-09-14. Partly superseded by ADR-006 (the `Ctrl+Shift+E` chord and the
tree-listing overview); the rest stands, and the counts below are the record as of this decision.

**Scope:** which file tree the files surface of the right panel shows, where its code comes from,
how it gets its data, and which chords reach it.

## Decision

**The files surface renders the Symmetria File Manager's tree, and T3 Code's tree is deleted.**
The tree is consumed from the file manager's repository as a git subtree under
`vendor/symmetria-file-manager`, pinned by commit, with three of its packages in the pnpm
workspace. A pure adapter turns the server's existing flat file list into the folder map the
library renders; nothing crosses the wire that did not already. `Ctrl+E` reaches and leaves the
tree; `Ctrl+Shift+E` opens the file manager over the window (ADR-006). The architecture is in
`docs/internals/file-tree.md`; the sync commands in
`docs/operations/vendor-symmetria-file-manager.md`.

The model is the Symmetria IDE, which embedded the same file manager's Qt predecessor as a
consumed module plus a thin layer of glue, and which learned two lessons this design keeps: the
library grows a prop and the host binds it, in paired commits; and root and restored state reach
the tree together.

## The decisions, each with what it rejected

**Delete the T3 tree entirely** — `FileBrowserPanel.tsx`, `fileTreeExpansion.ts`,
`fileTreeDragMention.ts` and their tests. _Rejected: leave the file in place, unmounted, so
upstream's diff-panel tree keeps compiling at the next sync._ The developer chose deletion for full
ownership of the tree, against the recommendation to disable rather than delete. The accepted
price: upstream commit `1aa44a071` ("feat(web): add a file tree to the diff panel and pull request
code tab") modifies `FileBrowserPanel.tsx` and adds `DiffFileTree.tsx` importing it, so the next
sync meets a delete-versus-modify conflict and a broken import, and has to decide between
restoring the file for the diff panel or porting the diff-panel tree onto ours. `FileBrowserPanel.tsx`
had 15 upstream commits in the three months before this decision. `replacesT3Tree.test.ts`
guards the deletion so the sync's conflict is a decision, not an accident.

**A git subtree, three packages in the workspace.** _Rejected: a git dependency on the package._
Measured on 2026-09-14: `pnpm add "git+file:///home/dev/symmetria-file-manager#<sha>&path:packages/fm-ui"`
fails with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`, because `fm-ui` depends on
`@symmetria/fm-core@workspace:*`, which only resolves inside a workspace. _Rejected: a git
submodule._ CI checks out with sparse-checkout and no `submodules: true` in four jobs of `ci.yml`
(12 upstream commits in three months), and every agent worktree would need an init step upstream's
worktree code does not run. _Rejected: copy the tree's files into `apps/web`._ The developer's own
call: it forks the tree from the standalone application they use daily. Only `fm-core`, `fm-ui`
and `fm-search` join the workspace; `app/` would install a second Electron and `fm-main` is the
scanner the adapter replaces.

**The tree renders `projects.listEntries` through a client-side adapter.** _Rejected: port the
file manager's scanner and watchers into the server behind new contracts._ Materially more work,
and a duplicate of an index the server already keeps for the file picker and project search. The
adapter gives every remote client the tree for free and keeps the tree's universe identical to
`Ctrl+P`'s. The file manager's finer load states collapse to `Loaded`, which is correct for a
fully indexed root; a truncated listing shows a notice and stops persisting the shape.

**The library gains seams; the host does not undo defaults through the DOM.** `autoFocus`,
optional `onMiller`, `showScope` and `onShapeChange`, each defaulting to today's behaviour, in
the vendored copy, pushed back after this branch merges. _Rejected: work around them in the host._
A tree that focuses its viewport on mount steals the composer every time the panel mounts, and a
toolbar advertising "Miller · Esc" names a surface this application does not have.

**`Ctrl+E` is `fileTree.toggle`**, default `mod+e` when the terminal is not focused, and a member
of the set of app shortcuts that outrank Neovim. _Rejected: keep the editor's `<C-e>` (scroll one
line) by making the chord context-sensitive._ The host owns the chord layer, as ADR-004 already
holds; one chord, one meaning everywhere. From outside the tree it opens the files surface if
needed and focuses the tree; from inside, it hides the tree behind the editor, or focuses the
composer when only the tree is shown. _Rejected: close the files surface from inside the tree._
Larger than "toggle" implies, and a files surface without its tree is empty.

**`Ctrl+Shift+E` was `fileTree.overview`**, the tree-listing overview graph over the window.
_Superseded by ADR-006:_ the chord is `fileTree.miller` and opens the whole file manager, whose own
overview is `Ctrl+O` inside it. The tree-listing overview and its host modules are deleted.

**Host-owned key tables drive the ports.** _Rejected: mount the file manager's `useKeyDispatch`._
It attaches to `window` and swallows keys, which would fight every chord this application owns;
the `TreePort`/`TreeController` and `OverviewPort` seams exist so a host can own dispatch. The
chat view's type-anywhere listener is told to leave `[role="tree"]` and an `aria-modal` dialog
alone, which is the one upstream edit the key model needs.

**Shape and view persist in local storage, keyed by environment and root.** _Rejected: a
server-side setting synced across devices._ No contract change is in scope, and the T3 tree's own
open flag already lived in local storage; its key is kept so the preference carries over.

## What this costs, accepted knowingly

- **The next upstream sync pays for the deletion**, as above. Recorded here so the sync does not
  re-litigate it.
- **`<C-e>` no longer scrolls one line inside the embedded editor.**
- **The vendored packages install `fm-ui`'s preview dependencies** (`highlight.js`,
  `music-metadata`, `xlsx`) that nothing here imports. A dedicated `fm-tree` package in the file
  manager would remove them; deferred to when a second host appears.
- **Drag a tree row into the composer as a mention is gone** with `fileTreeDragMention.ts`. The
  file manager's rows have no drag affordance; the right shape is a library prop, deferred to a
  follow-up.
- **Toasts sit above the overview.** The application's toast portal is `z-index: 100`, the
  overview `60`; a persistent toast covers the overview toolbar's corner. Toasts must stay
  reachable over any modal, so this stands.

## Deferred, and to what

- Pushing the vendored edits back to the file manager: right after this branch merges, with the
  runbook's command.
- `Ctrl+D`/`Ctrl+U` inside the tree: to ADR-004, which scopes the chat timeline's capture listener
  to `chatFocus`; the tree's table already carries both.
- The diff panel's file tree: to the next upstream sync.
- Focus entry registration beyond what `Ctrl+E` needs: to ADR-004's implementation, which reuses
  `focusTargets.ts`.

## What would reverse this

The developer stops using the standalone file manager, so that keeping its tree in step with a
repository they no longer maintain costs more than the tree is worth. The reversal is not
"restore `FileBrowserPanel.tsx`": it is taking upstream's current tree, which by then includes the
diff-panel tree, and deleting `vendor/` and `mesuraTree/`.
