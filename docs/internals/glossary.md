# Glossary

> For maintainers. Using T3 Code? See [docs/user](../user/).

This is a living glossary for T3 Code. It explains what common terms mean in this codebase.

## Table of contents

- [Project and workspace](#project-and-workspace)
- [Thread timeline](#thread-timeline)
- [Orchestration](#orchestration)
- [Provider runtime](#provider-runtime)
- [Dictation](#dictation)
- [Symmetria integration](#symmetria-integration)
- [Checkpointing](#checkpointing)
- [Appearance](#appearance)
- [Pane focus](#pane-focus)
- [Editor delegation](#editor-delegation)
- [Pull requests](#pull-requests)
- [Composer context](#composer-context)
- [Pull requests](#pull-requests)
- [Composer context](#composer-context)

## Concepts

### Project and workspace

#### Project

The top-level workspace record in the app. In [the orchestration contracts][1], a project has a `workspaceRoot` and a title. It does not contain threads: `OrchestrationProject` and `OrchestrationThread` are separate arrays on the read model, and a project can have zero threads. See [workspace-layout.md][2].

#### Workspace root

The root filesystem path for a project. In [the orchestration model][1], it is the base directory for branches and optional worktrees. See [workspace-layout.md][2].

#### Worktree

A Git worktree used as an isolated workspace for a thread. If a thread has a `worktreePath` in [the contracts][1], it runs there instead of in the main working tree. Git operations live behind the VCS driver contract in `apps/server/src/vcs/VcsDriver.ts`, implemented by [GitVcsDriverCore.ts][3].

#### Project file watch

A server-side watch on the one file a client currently has open, which streams a revision token to that client whenever the file changes on disk. It watches the file's directory rather than the file, because an editor or a `git` operation that replaces a file by rename leaves a watch on the old inode. The token is the file's modification time and size, so a rewrite with identical bytes still produces a new token and still costs the client a re-read; the editor then compares contents and applies nothing. See [WorkspaceFileWatcher.ts][25]. The client side is in `apps/web/src/components/files/projectFileWatchRefresh.ts`, which decides when a revision is worth acting on.

#### Background scope

A declared interest a client reports while it is looking at something: version-control status, diagnostics, or a thread. Scopes travel in the client's activity lease and are read by the server's background policy, which uses them to decide what work is worth doing while nobody is waiting on it. A scope is explicitly retained by the view that shows the thing, not derived from whether a subscription is open: subscriptions outlive the view that opened them, so deriving the scope would report a thread as watched for minutes after the user left it. See `apps/web/src/lib/backgroundActivityReporter.ts`.

### Thread timeline

#### Thread

The main durable unit of conversation and workspace history. In [the orchestration contracts][1], a thread holds messages, activities, checkpoints, and session-related state. See [projector.ts][4].

#### Turn

A single user-to-assistant work cycle inside a thread. It starts with user input and ends when the session leaves `running` status, which [projector.ts][4] treats as the authoritative completion signal (`settledTurnStateForSessionStatus`). Checkpoint and diff work may settle afterward without changing when the turn ended. See [the contracts][1] and [ProviderRuntimeIngestion.ts][5].

#### Activity

A user-visible log item attached to a thread. In [the contracts][1], activities cover important non-message events like approvals, tool actions, and failures. They are projected into thread state in [projector.ts][4].

### Orchestration

Orchestration is the server-side domain layer that turns runtime activity into stable app state. The main entry point is [OrchestrationEngine.ts][7], with core logic in [decider.ts][8] and [projector.ts][4].

#### Aggregate

The domain object a command or event belongs to. In [the contracts][1], that is usually `project` or `thread`. See [decider.ts][8].

#### Command

A typed request to change domain state. In [the contracts][1], commands are validated in [commandInvariants.ts][9] and turned into events by [decider.ts][8].
Examples include `thread.create`, `thread.turn.start`, and `thread.checkpoint.revert`.

#### Domain Event

A persisted fact that something already happened. In [the contracts][1], events are the source of truth, and [projector.ts][4] shows how they are applied.
Examples include `thread.created`, `thread.message-sent`, and `thread.turn-diff-completed`.

#### Decider

The pure orchestration logic that turns commands plus current state into events. The core implementation is in [decider.ts][8], with preconditions in [commandInvariants.ts][9].

#### Projection

A read-optimized view derived from events. See [projector.ts][4], [ProjectionPipeline.ts][11], and [ProjectionSnapshotQuery.ts][10].

#### Projector

The logic that applies domain events to the read model or projection tables. See [projector.ts][4] and [ProjectionPipeline.ts][11].

#### Read model

The current materialized view of orchestration state. In [the contracts][1], it holds projects, threads, messages, activities, checkpoints, and session state. See [ProjectionSnapshotQuery.ts][10] and [OrchestrationEngine.ts][7].

#### Reactor

A side-effecting service that handles follow-up work after events or runtime signals. Examples include [CheckpointReactor.ts][6], [ProviderCommandReactor.ts][12], and [ProviderRuntimeIngestion.ts][5].

#### Runtime receipt

A typed signal emitted when an async milestone completes, such as `checkpoint.baseline.captured`, `checkpoint.diff.finalized`, or `turn.processing.quiesced`. Receipts are a test-only mechanism: the production `RuntimeReceiptBusLive` publish is a no-op and only the test layer is PubSub-backed. Do not build production behavior on them. See [RuntimeReceiptBus.ts][13] and [CheckpointReactor.ts][6].

#### Quiesced

"Quiesced" means a turn has gone quiet and stable: follow-up work such as [CheckpointReactor.ts][6] has settled. It appears in [the receipt schema][13], so in practice it is something tests wait on rather than a production signal.

### Provider runtime

The live backend agent implementation and its event stream. The main service is [ProviderService.ts][14], the adapter contract is [ProviderAdapter.ts][15], and the overview is in [providers.md][16].

#### Provider

The backend agent runtime that actually performs work. Five drivers ship built in: Codex, Claude, Cursor, Grok, and OpenCode. See [ProviderService.ts][14], [ProviderAdapter.ts][15], and [CodexAdapter.ts][17] as a representative adapter.

#### Session

The live provider-backed runtime attached to a thread. Session shape is in [the orchestration contracts][1], and lifecycle is managed in [ProviderService.ts][14].

#### Runtime mode

The safety/access mode for a thread or session. [The contracts][1] define four values: `approval-required`, `auto-accept-edits`, `auto`, and `full-access`. See [permission modes][18].

#### Interaction mode

The agent interaction style for a thread. In [the contracts][1], the values are `default` and `plan`.

#### Assistant delivery mode

Controls how assistant text reaches the thread timeline. In [the contracts][1], `streaming` updates incrementally and `buffered` accumulates text. Buffered delivery is not held until the turn completes: it spills once accumulated text would exceed 24,000 characters, and flushes at approval and user-input boundaries. See [ProviderRuntimeIngestion.ts][5].

#### Snapshot

A point-in-time view of state. The word is used in multiple layers, including orchestration, provider, and checkpointing. See [ProjectionSnapshotQuery.ts][10], [ProviderAdapter.ts][15], and [CheckpointStore.ts][19].

### Dictation

#### Dictation job

One server transcription of one uploaded recording, with its mode, target and text. Jobs live in
server memory for 24 hours and stream to every client of that environment. See [dictation.md][27]
and [DictationJobs.ts][28].

#### Dictation marker

The pending-transcription link `[Transcribing](t3-context://v1/dictation/<jobId>)`, dropped into
a draft at the caret when a recording stops. The job with that id replaces it with the transcript.
Code also calls it a dictation slot.

#### Armed draft

A draft set to send itself once no dictation marker remains in its text. Send mode and a Send
press with a pending marker both arm it.

### Symmetria integration

#### File tree

The Symmetria File Manager's tree, rendered in the files surface of the right panel from the
server's file listing through a client-side adapter. It replaced T3 Code's `FileBrowserPanel`
(ADR-005). See [file-tree.md](./file-tree.md).

#### File manager

The whole Symmetria File Manager, Miller columns, previews, operations and its own folder
overview, opened over the window on `Ctrl+Shift+E` at the thread's project. Its UI runs in the
client; its privileged half runs in the server behind four RPCs. See
[file-manager.md](./file-manager.md).

#### File manager session

One mounted file manager's connection to the server's registry: opened by the client's
`fileManager.subscribeEvents` stream, named by a client-chosen id private to that RPC connection,
and released with every watch it holds when the stream ends. Queries and mutations name their
session. See [file-manager.md](./file-manager.md).

#### Preview token

An unguessable grant the registry mints for one path (or one document's directory) so the browser
can load a preview as a same-origin URL under `/api/file-manager/preview/`. Bounded to the 64 most
recent grants, evicted as newer ones arrive. See [file-manager.md](./file-manager.md).

#### Vendor

`vendor/symmetria-file-manager`, the file manager's repository as a git subtree. Four of its
packages are pnpm workspace members; the rest is inert here. Never formatted, linted or tested from
this repository. Runbook: [vendor-symmetria-file-manager.md](../operations/vendor-symmetria-file-manager.md).

#### Model manifest

The per-driver list of current model slugs that decides which models land in the model picker's legacy section. Bundled at `apps/server/src/provider/model-manifest.json` and refreshed at runtime from the same file on `main`, so classification updates ship as commits instead of releases. See the [provider architecture][16] model manifest section.

### Checkpointing

Checkpointing captures workspace state over time so the app can diff turns and restore earlier points. The main pieces are [CheckpointStore.ts][19], [CheckpointDiffQuery.ts][20], and [CheckpointReactor.ts][6].

#### Checkpoint

A saved snapshot of a thread workspace at a particular turn. In practice it is a hidden Git ref in [CheckpointStore.ts][19] plus a projected summary from [ProjectionCheckpoints.ts][21]. Capture and lifecycle work happen in [CheckpointReactor.ts][6].

#### Checkpoint ref

The durable identifier for a filesystem checkpoint, stored as a Git ref. It is typed in [the contracts][1], constructed in [Utils.ts][22], and used by [CheckpointStore.ts][19].

#### Checkpoint baseline

The starting checkpoint for diffing a thread timeline. This flow is surfaced through [RuntimeReceiptBus.ts][13], coordinated in [CheckpointReactor.ts][6], and supported by [Utils.ts][22].

#### Checkpoint diff

The patch difference between two checkpoints. Query logic lives in [CheckpointDiffQuery.ts][20], diff parsing lives in [Diffs.ts][23], and finalization is coordinated by [CheckpointReactor.ts][6].

#### Turn diff

The file patch and changed-file summary for one turn. It is usually computed in [CheckpointDiffQuery.ts][20], represented in [the contracts][1], and recorded into thread state by [projector.ts][4].

### Appearance

#### Environment theme

A theme an environment's machine publishes for clients to follow, one file per theme under `themes/` in that environment's state directory; the filename is the theme id. [environmentTheme.ts][25] watches the directory and streams the set over `subscribeServerConfig`; clients render each as a library card, generating a full palette when the file carries seed colors and using the palette directly when it is a standard exported theme file. A desktop that retints its apps when the system theme changes rewrites its file, so T3 Code follows along without a restart. See [environment-theme.md][26].

#### Default theme

The environment's theme, held in its `settings.json` as `defaultTheme` (with `defaultThemeSetAt`
as the set-generation) and set with `t3 theme set <id>`. Web and desktop clients apply each set
once — live when connected, on the next connect otherwise — so setting it switches them, while a
theme a user picks in Settings afterwards sticks until the next set. Naming a published [environment theme](#environment-theme) is how a desktop
ships T3 Code already matching it.

### Pane focus

#### Pane

One of the four regions of the web client that can hold keyboard focus: the sidebar, the chat
column, the right panel, and the terminal drawer. Exactly one holds it at any moment, and which
one decides what the pane chords and the pane-scoped keybindings do. A pane is a view position,
not an identity: it is never persisted, it is not addressable, and it is not a
[project](#project) — one window shows many projects and the panes do not change with them (see
[ADR-002](../mesura/adr-002-one-window-many-projects.md)). Derived from the browser's own focus
tree by [paneFocus.ts][pane-focus-ts] rather than stored, so nothing can disagree with where a
keystroke will actually be delivered. See [Pane focus](./pane-focus.md).

#### Pane chord

`Ctrl+H` and `Ctrl+L` move focus left and right across the sidebar, the chat and the right
panel; `Ctrl+J` and `Ctrl+K` move down into the terminal drawer and back up. The application
claims all four on the window in the capture phase, so a chord means one thing wherever it is
typed, the embedded editor and a terminal included. The vertical pair disables itself where
there is no neighbour, which is what leaves `Ctrl+J` free to open the drawer.

### Editor delegation

#### Editor session

One headless Neovim process the server runs on behalf of a thread, so the developer's own
configuration, plugins and remapped keys are what edit the file while Monaco stays the thing on
screen. A session belongs to a thread rather than to a file — the developer switches file inside one
Neovim, the way they would in a terminal. Not event-sourced: it follows the terminal's precedent
rather than the orchestration's, because its state is a live process and not a history. Sixteen
sessions are kept once nobody is attached, thirty-two buffers inside each. See
[editor-session.md](./editor-session.md).

#### Host plugin

The Lua the server writes to disk and prepends to Neovim's runtimepath, in
[hostPlugin.ts][ed-host]. It forces the gutter off, forces syntax and the treesitter highlighter
off, and turns `:w` into a `BufWriteCmd` that asks the host to save instead of writing the file
itself. The gutter options are not cosmetic: they keep grid column N equal to buffer column N,
which is the equality that [virtual cell](#virtual-cell) detection rests on.

#### Virtual cell

A cell on Neovim's drawn grid whose character differs from the buffer's character at that column —
so it is something drawn _over_ the text rather than the text. It is how flash labels, inline
diagnostics and any other virtual text are found and sent to the client as decorations, and it is
why the host plugin forces every option that would shift a column. [GridModel.ts][ed-grid] does the
comparison.

#### Modal editing

The client setting that turns delegation on, `modalEditing`, on by default. With it off the file
panel is the plain Monaco editor it was before. With it on and Neovim unavailable, the panel falls
back to that same plain editor and says in its status strip what is missing and how to fix it,
rather than failing. See [the file panel](../user/file-panel.md).

##### Pull requests

| Term                 | Meaning                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull request link    | A persisted thread association identified by host, repository, and number. Links can cross projects within an environment and carry a server-maintained snapshot.                        |
| Pull request sync    | The reactor that refreshes each distinct linked review once per cadence and discovers native stack layers. Explicit refreshes and failed stack reads trigger another read.               |
| Current pull request | The link used by single-review controls and older clients. Open work takes precedence; a completed single chain points at its top layer. Unrelated terminal links use the latest update. |

##### Composer context

| Term                 | Meaning                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Context record       | The typed payload behind a composer chip, keyed by `contextId` in `message.context.records`. It never holds bytes.                  |
| Context reference    | One occurrence of a record in message text: `[label](t3-context://v1/<kind>/<contextId>)`. Several references can share one record. |
| Attachment binding   | The link from an image or file record to its server-owned attachment. Its attachment ID can change without changing `contextId`.    |
| Attachment inventory | The ordered image records shown as thumbnails above the prose, including images with no inline references.                          |

See [composer context references](./composer-context-references.md) for the contract and lifecycle.

### Pull requests

| Term                 | Meaning                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull request link    | A persisted thread association identified by host, repository, and number. Links can cross projects within an environment and carry a server-maintained snapshot.                        |
| Pull request sync    | The reactor that refreshes each distinct linked review once per cadence and discovers native stack layers. Explicit refreshes and failed stack reads trigger another read.               |
| Current pull request | The link used by single-review controls and older clients. Open work takes precedence; a completed single chain points at its top layer. Unrelated terminal links use the latest update. |

### Composer context

| Term                 | Meaning                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Context record       | The typed payload behind a composer chip, keyed by `contextId` in `message.context.records`. It never holds bytes.                  |
| Context reference    | One occurrence of a record in message text: `[label](t3-context://v1/<kind>/<contextId>)`. Several references can share one record. |
| Attachment binding   | The link from an image or file record to its server-owned attachment. Its attachment ID can change without changing `contextId`.    |
| Attachment inventory | The ordered image records shown as thumbnails above the prose, including images with no inline references.                          |

See [composer context references](./composer-context-references.md) for the contract and lifecycle.

## Practical Shortcuts

- If you see `requested`, think "intent recorded".
- If you see `completed`, think "result applied".
- If you see `RuntimeReceiptBus`, think "async milestone signal, for tests".
- If you see `checkpoint`, think "workspace snapshot for diff/restore".
- If you see `quiesced`, think "all relevant follow-up work has gone idle".

## Related Docs

- [Architecture overview][24]
- [Provider architecture][16]
- [Permission modes][18]
- [Workspace layout][2]
- [Editor session](./editor-session.md)
- [File tree](./file-tree.md)
- [Pane focus](./pane-focus.md)
- [Reading and editing files](../user/file-panel.md)

[pane-focus-ts]: ../../apps/web/src/lib/paneFocus.ts
[ed-host]: ../../apps/server/src/editor/hostPlugin.ts
[ed-grid]: ../../apps/server/src/editor/GridModel.ts
[1]: ../../packages/contracts/src/orchestration.ts
[2]: ./workspace-layout.md
[3]: ../../apps/server/src/vcs/GitVcsDriverCore.ts
[4]: ../../apps/server/src/orchestration/projector.ts
[5]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[6]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
[7]: ../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts
[8]: ../../apps/server/src/orchestration/decider.ts
[9]: ../../apps/server/src/orchestration/commandInvariants.ts
[10]: ../../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts
[11]: ../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts
[25]: ../../apps/server/src/workspace/WorkspaceFileWatcher.ts
[12]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[13]: ../../apps/server/src/orchestration/Services/RuntimeReceiptBus.ts
[14]: ../../apps/server/src/provider/Layers/ProviderService.ts
[15]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[16]: ./providers.md
[17]: ../../apps/server/src/provider/Layers/CodexAdapter.ts
[18]: ../user/permission-modes.md
[19]: ../../apps/server/src/checkpointing/CheckpointStore.ts
[20]: ../../apps/server/src/checkpointing/CheckpointDiffQuery.ts
[21]: ../../apps/server/src/persistence/Services/ProjectionCheckpoints.ts
[22]: ../../apps/server/src/checkpointing/Utils.ts
[23]: ../../apps/server/src/checkpointing/Diffs.ts
[24]: ./overview.md
[27]: ./dictation.md
[28]: ../../apps/server/src/dictation/DictationJobs.ts
[25]: ../../apps/server/src/environmentTheme.ts
[26]: ../user/environment-theme.md
