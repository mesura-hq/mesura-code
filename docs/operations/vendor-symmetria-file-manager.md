# Syncing the vendored Symmetria File Manager

> For maintainers. Using Mesura Code? See [docs/user](../user/).

The Symmetria File Manager lives in this repository as a **git subtree** under
`vendor/symmetria-file-manager`. It is the source of the file tree and the folder overview
(`docs/internals/file-tree.md`). A subtree is plain files: every checkout, worktree and CI job has
them with no init step and no auth, and changes flow both ways with two commands.

## The two remotes

- **Local checkout**, the default source: `/home/dev/symmetria-file-manager`. Use it because the
  local `main` may be ahead of `origin/main`.
- **GitHub**, the alternative when the local checkout is not on this machine:
  https://github.com/jc-caceres/symmetria-file-manager

The vendored copy was cut from commit `7df9480b9322e00531dd06e58f9d48a9a02e6e72` of `main`
(`git log --grep="add symmetria-file-manager as a subtree"` shows the merge).

## Take new file manager commits

From the repository root, on a clean tree:

```bash
git subtree pull --prefix vendor/symmetria-file-manager /home/dev/symmetria-file-manager main --squash
```

Then run the three vendored suites, each from inside its package, before anything else:

```bash
cd vendor/symmetria-file-manager/packages/fm-core && vp test run --max-workers=3
cd ../fm-ui && vp test run --max-workers=3
cd ../fm-search && vp test run --max-workers=3
```

and `vp run --filter @t3tools/web typecheck`, because the vendored sources type-check under
`apps/web`'s program.

## Send the vendored edits back

The edits below exist only in the vendored copy until this runs. Push them as a branch and merge
that branch in the file manager's repository:

```bash
git subtree push --prefix vendor/symmetria-file-manager /home/dev/symmetria-file-manager mesura-code-sync
```

Then, in `/home/dev/symmetria-file-manager`, review and merge `mesura-code-sync` into `main`.

### Edits pending push-back

As of 2026-09-14 (`git diff --stat <subtree merge> HEAD -- vendor/` lists them):

- `packages/fm-ui/package.json`: `./tree`, `./overview` and `./overview/styles.css` exports; React
  moved from dependencies to peer and dev dependencies pinned to the host's versions; `vitest`
  as a dev dependency.
- `packages/fm-search/package.json`, `packages/fm-core/package.json`: the same dev dependency and
  peer pins.
- `packages/fm-core/vitest.config.ts`: a worker bound.
- `knip.json`: the two new index files as entries.
- `packages/fm-ui/src/tree/`: `FileTree` gained `autoFocus`, optional `onMiller`, `showScope` and
  `onShapeChange`, each defaulting to the old behaviour; `TreeToolbar`, `useTreeController` and
  `useTreeState` carry them; `index.ts` is the subpath surface.
- `packages/fm-ui/src/overview/`: `index.ts` is the subpath surface; `Overview.tsx` types its model
  props as `OverviewModel`.
- `packages/fm-ui/test/renderer/tree-host.test.tsx`, `test/tree-exports.test.ts`: the tests for the
  above.

Every edit is written so that the file manager's own `App.tsx` and its existing tests need no
change. A maintainer of the file manager should be able to accept the branch as is.

## Rules

- **Never format, lint or test the vendored tree from here.** The root `vite.config.ts` excludes
  the `vendor` directory from `fmt`, `lint` and `test`; the file manager has its own biome and
  anti-slop configuration, and edits are formatted with its biome:
  `/home/dev/symmetria-file-manager/node_modules/.bin/biome format --write <file>`.
- **Only three packages are workspace members**: `fm-core`, `fm-ui` and `fm-search`, listed by
  explicit path in `pnpm-workspace.yaml`. `app/` is not, because it would install a second
  Electron beside the desktop's. `fm-main` is not, because it is the scanner the host's adapter
  replaces.
- **The nested `pnpm-workspace.yaml` and `CLAUDE.md` inside `vendor/symmetria-file-manager` belong
  to the file manager.** pnpm reads the root workspace file only; the nested one is inert here and
  is kept so the subtree pushes back clean. Do not read the nested `CLAUDE.md` as instructions for
  this repository.
- **A git dependency does not work** and this was measured: pnpm's
  `git+…&path:packages/fm-ui` install fails with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`, because the
  package's siblings are `workspace:*` dependencies. That is why this is a subtree.
- **Pinning React.** The vendored manifests pin `react`, `react-dom` and their types to the host's
  versions. If `pnpm why react` ever shows a second copy after a pull, re-pin before anything else:
  two Reacts crash every hook at first render.
