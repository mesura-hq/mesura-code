# `@symmetria/fm-search`

The file finder: a fuzzy search engine and a mountable overlay, shared by the
Symmetria File Manager and by any host that wants the same finding surface
without taking the file manager with it.

## Two entry points, two environments

The package ships both halves of one feature, and they must not be mixed. Each
gets its own type-check context in this repository for that reason.

| Entry | Runs in | May use |
|---|---|---|
| `@symmetria/fm-search/main` | A Node process — a main process, or a utility process | Node. **No DOM.** |
| `@symmetria/fm-search/ui` | A sandboxed renderer | The DOM. **No Node.** |
| `@symmetria/fm-search/ui/styles.css` | The renderer's stylesheet | — |

`test/boundary.test.ts` enforces that split by reading every source file under
each half. It is not a convention; it fails the build.

The `main` half also publishes its pieces individually — `main/pool`,
`main/worker`, `main/client`, `main/store`, `main/rows`, `main/match` — for a
host that wants the lifetime rules without the whole entry.

## The host contract

**A host runs the privileged half itself.** The overlay reaches the engine
through one global on `window`, named by `BRIDGE_KEY` in
`@symmetria/fm-core/bridge`, carrying four methods. Every one takes an untyped
payload and answers with a `Result`, never a thrown error:

| Method | Payload | Answers |
|---|---|---|
| `searchStart` | `{ directory }` | `null` once the index is open, or a failure saying why it never opened |
| `searchQuery` | `{ directory, query }` | `{ rows, matchedQuery, truncated, cap }` |
| `searchRecord` | `{ directory, query, chosenPath }` | `null`. Fire and forget |
| `searchRelease` | `{ directory }` | `null` |

On the privileged side, `createIndexPool` from `main/pool` implements all four
against workers the host spawns. `packages/fm-main/src/search.ts` in this
repository is a working adapter for Electron's `utilityProcess`, and is about
forty lines.

### What you must supply besides the handlers

**Import the stylesheet.** `@symmetria/fm-search/ui/styles.css` ships beside the
components and is not optional — without it the overlay renders as unstyled
text. It is deliberately not self-contained, and needs two things from you:

- **The design tokens it reads**: `--border`, `--accent`, `--foreground`,
  `--muted-foreground`, `--radius-sm`, `--font-mono`, and `--finder-list-share`,
  `--finder-gap`. Declare them with
  those names and the finder takes your palette;
  `packages/fm-ui/src/theme/tokens.css` in this repository is the reference set.
- **`.overlay` and `.overlay__panel`** — the full-screen scrim and the centred
  panel. They are shared with dialogs that belong to the file-manager panel, so
  they are not claimed here. The finder adds shared search modifiers that pin
  the panel at 8% from the top, with 90% window width and 80% window height.
  The host must apply `box-sizing: border-box` so padding stays inside those bounds.

**Two renderer dependencies come with the package.** `@pierre/trees` (the icon
sprite) and `lucide-react` (the five glyphs the sprite has no drawing for) are
plain `dependencies`, so a host that consumes ONLY `./main` still installs them.
That is a deliberate trade-off rather than an oversight: making them optional
peers would push an install obligation onto every UI host to spare an engine-only
host two packages, and the engine-only case is the rarer one.

Mounting is one component:

```tsx
import { FinderOverlay } from "@symmetria/fm-search/ui";

<FinderOverlay
  directory={projectRoot}
  onChoose={(path, isDir) => open(path)}
  onClose={() => setFinderOpen(false)}
  renderPreview={(path) => <YourPreview path={path} />}
/>;
```

- `onChoose` receives an **absolute path with no trailing separator**, and
  `isDir` beside it. The engine spells a directory `/dir/` and keys its own
  store on that; a host is not made to know it.
- `onClose` is called **once** per Escape, and the overlay does **not** unmount
  itself. Closing is the host's decision.
- `renderPreview` is optional. Omit it and the information panel still shows the
  name and the four facts, with nothing beneath them. The file manager passes a
  component that calls its own preview router; a host in an editor is expected
  to pass its own, which is better than inheriting a file manager's.

Icons need nothing from you. `FileIcon` draws from the bundled sprite, and
`@symmetria/fm-core/icons/resolve` is the single table that decides which
extension gets which symbol — edit it and every consumer changes at once. One
limit worth knowing: the sprite is injected into `document.body`, so a host that
renders the overlay into a **shadow root** gets blank icons, because
`<use href="#id">` cannot cross that boundary.

## One index per process

**This is measured, not chosen.** The engine's store refuses a second open
inside one program. Eight indices in eight processes sharing one store all open
cleanly; the same eight in one process do not.

A host that ignores this gets an error about the environment already being open,
and nothing in that message points back here. `main/pool` keys one worker per
absolute directory and retires it after five minutes idle; the host supplies the
`spawn` that turns "a worker for this directory" into a real process.

## Things that will surprise you

- **Recording an open does not teach frecency.** `searchRecord` writes the
  engine's *query tracker*: one record per project-and-query pair holding the
  chosen file and an open count. A later search whose query matches that record
  adds the count times a multiplier. In this application that multiplier is
  zero, so the present gain is zero; the record accumulates against the day it
  is raised.
- **An index is a snapshot, and an open finder does not see an edit.** The scan
  runs when the index opens, and the engine's background watcher was measured
  NOT to close the gap inside an Electron utility process. `main/pool`'s
  `start()` asks the engine to re-scan whenever it is called on an index that is
  already warm — so a fact goes stale only while the finder stays open, and is
  fresh again on the next open. Refreshing per search would put a filesystem
  walk on every keystroke.
- **A directory row carries far less than a file row.** The engine's directory
  item has a path, a name and a frecency score — no size, no modification time,
  no git status. Those arrive as `0` and `""`, and the information panel renders
  them as `dir` and `—` rather than inventing four facts.
- **`showHidden` does not exist here.** The engine governs hidden and ignored
  files through its own ignore model, which is not the same rule set as
  `git check-ignore`. A file a tree view hides can still be findable.

## How it is consumed

**As a git dependency pinned by commit**, not from a registry. There is no
versioning ceremony for a package that moves when this project moves, and a
commit pin is exact:

```json
{ "dependencies": { "@symmetria/fm-search": "github:jc/symmetria-file-manager#<commit>" } }
```

Inside this repository it is a workspace package, so a host developed here takes
`workspace:*` and gets the working tree.

The engine itself is `@ff-labs/fff-node`, a native module. A bundler must leave
it **external** — a `.node` binary cannot be bundled — which means the package
that ships the bundle has to declare the dependency, not merely depend on this
one. pnpm links a package only into the `node_modules` of the workspace package
that declares it, and a bundle resolves from its own location on disk. Getting
that wrong produces a worker that dies at startup with `ERR_MODULE_NOT_FOUND`
while every test stays green; `app/test/workerBundle.test.ts` in this repository
is what holds that line.
