# Editor session

> For maintainers. Using Mesura Code? See [docs/user](../user/).

An **editor session** is one embedded Neovim process that the server drives on behalf of a file open
in a client. It exists so the developer's own Neovim — their configuration, their plugins, their
remapped keys — is what edits the file, while [Monaco](../user/file-panel.md) stays the thing on
screen.

The parts, and the file that owns each:

| Part                                                                     | File                                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| msgpack-RPC framing over the process's pipes                             | `apps/server/src/editor/NvimRpc.ts`                           |
| Spawning, behind a service so sessions build without an operating system | `apps/server/src/editor/NvimAdapter.ts`, `NodeNvimAdapter.ts` |
| Deciding argv and environment before anything spawns                     | `apps/server/src/editor/NvimLaunch.ts`                        |
| The Lua the host forces on every session                                 | `apps/server/src/editor/hostPlugin.ts`                        |
| The session: the mirrored buffer, the cursor, the mode, the grid         | `apps/server/src/editor/NvimBridge.ts`                        |
| Reading the drawn screen back against the buffer                         | `apps/server/src/editor/GridModel.ts`                         |

## The process and its launch

The configuration directory is a server setting, `neovimConfigDirectory`, defaulting to `~/.neovim`.
It is machine-local and deliberately absent from `SHARED_SERVER_SETTING_KEYS`: it names a path on one
machine's disk, and pushed to another environment it would name a directory that is not there.

`resolveNvimLaunch` turns that setting into argv and an environment. The hard part is not the
argument list, it is `stdpath('config')`, because the directory the host must load is not the one
Neovim reads by default. Three obvious levers do not work:

- `-u <dir>/init.lua` leaves `stdpath('config')` at `~/.config/nvim` and the directory's own `lua/`
  off the runtime path, so `require('jc.core')` fails on the first line.
- `NVIM_APPNAME` moves config **and** data together, so every plugin installs a second time.
- Copying the directory is a copy that goes stale.

Neovim resolves its configuration as `$XDG_CONFIG_HOME/nvim`, so the lever is `XDG_CONFIG_HOME`. When
the configured directory already is that path, nothing is built. Otherwise the launch points
`XDG_CONFIG_HOME` at a scratch config home under the server state directory, holding a symlink named
`nvim`. Data, state and cache are untouched, so plugins installed for a terminal Neovim are reused.

A `git` entry is mirrored beside it, marked `WORKAROUND` in the source: git reads its own
configuration from `$XDG_CONFIG_HOME/git`, and moving that variable would take it away from every git
the session spawns — gitsigns and lazy.nvim's update checker both run one.

Two facts about argv that were measured rather than assumed, both of which failed silently first:

- **The runtime path is not a place a host can stand.** lazy.nvim replaces `runtimepath` wholesale
  while `init.lua` runs, so a directory added with `--cmd 'set runtimepath^=…'` is gone before Neovim
  scans for plugin files, and an `after/plugin/` file under it is never sourced. `getscriptinfo()`
  listed no host script at all and every forced option quietly did nothing. The host plugin is
  therefore sourced by name with `-c`, which is argv rather than state.
- **A file to open goes in argv, not over RPC.** A configuration that shows a dashboard does so from
  a callback deferred past `VimEnter`, so a file opened right after connecting is opened and then
  taken away again, leaving the session on a scratch buffer that is not even modifiable.

Failures are data, not exceptions: `NvimLaunchError` carries
`'binary-missing' | 'version' | 'config-missing' | 'spawn-failed' | 'runtime-unwritable'`. A missing
directory never falls back to `--clean`; a bare Neovim pretending to be the developer's is worse than
an error that says why. The version floor is 0.12.0, because `jumpoptions+=view` restores a jump to
the wrong view below it and reports nothing.

## The host plugin, and why it owns what it owns

`GridModel` recovers meaning from a drawing. Neovim's UI protocol reports cells — characters and
highlight ids at screen positions — and nothing in it says which characters are the file and which
are decoration a plugin painted over it. The classification compares each cell against the buffer
line underneath it: a cell whose character differs from the buffer's is virtual text (a flash label,
inline diagnostics, a git blame); a cell that matches but carries a highlight is the file's own text
marked (a search match); a blank is neither.

**That only holds while grid column N is buffer column N.** With line numbers left on, every
character on a line differs from the one it is compared against: the prototype measured a single
flash jump producing 132 phantom labels. So the host forces `number`, `relativenumber`, `signcolumn`,
`foldcolumn`, `numberwidth` and `wrap`, and also `list` and `conceallevel`, which break the same
equality from the other direction — `list` paints a character where the buffer holds a space, and
`conceallevel` replaces buffer text with something of a different width.

Setting an option once is not owning it. The developer's settings load first, plugins such as
statuscol set window options per window afterwards, and lazy-loaded plugins arrive later still, so
the host re-applies them from autocommands on `BufWinEnter`, `BufEnter`, `WinNew`, `WinEnter` and
`VimEnter`. The treesitter **highlighter** is stopped per buffer — the parser is left alone, so
flash's treesitter mode still works.

The host also picks the grid of the window the developer is in. Taking the most recently reported
`win_pos` looks equivalent and is not: a real configuration opens a file tree and a symbol list, and
a sidebar read against the file's lines is virtual text on every column.

## The wire

Seven methods, all in `packages/contracts/src/editorSession.ts` and `rpc.ts`. Every one of them
carries a `threadId`, because a session belongs to a thread rather than to a file: the developer
switches file inside one Neovim, the way they would in a terminal.

| Method                      | Carries                                 | Answers                 |
| --------------------------- | --------------------------------------- | ----------------------- |
| `editorSession.open`        | `cwd`, `relativePath`, the file's lines | `EditorSessionSnapshot` |
| `editorSession.attach`      | nothing but the thread                  | a **stream** of events  |
| `editorSession.input`       | `keys`, in Neovim notation              | nothing                 |
| `editorSession.viewport`    | `topline`, `rows`, `cols`               | nothing                 |
| `editorSession.setCursor`   | `line`, `col`                           | nothing                 |
| `editorSession.replaceText` | `edits`, each a range and its text      | nothing                 |
| `editorSession.close`       | nothing but the thread                  | nothing                 |

`open` hands Neovim the **lines**, never the path. Neovim is told the name so `:w`, `%` and the
status line say something true, and it never reads or writes the file itself — the host owns the
disk. The path is still resolved against `cwd` the way a read is, so one that climbs out of the
project is refused; a name the developer did not ask for is still a name.

Both text-carrying payloads are bounded: `keys` at 1024 characters, `edits` at a thousand entries
and each entry's `text` at a megabyte, which is where the file-read path truncates and therefore the
largest replacement that can honestly arrive.

Errors are the union of `EditorSessionError` and `EnvironmentAuthorizationError`. Authorization is
the terminal's `AuthTerminalOperateScope`, for all seven — a session is a subprocess on the
developer's machine reading and writing their files, which is the authority the terminal already
carries rather than a new one to invent.

### The event union

`attach` streams `EditorSessionEvent`, a union of twelve tagged members. The client folds them into
absolute state in `apps/web/src/state/editorSessionFold.ts`; nothing downstream may read "the last
event", for the reason under **Traps** below.

| Event            | What it says                                                             |
| ---------------- | ------------------------------------------------------------------------ |
| `snapshot`       | the whole session: path, lines, cursor, mode, topline, highlight defs    |
| `lines`          | one `nvim_buf_lines_event`: zero-based, half-open, `last === -1` for all |
| `cursor`         | where the caret is                                                       |
| `mode`           | the short mode name Neovim reports                                       |
| `viewport`       | the top line Neovim is showing                                           |
| `visual`         | the selection, or `null` outside visual mode                             |
| `decorations`    | everything drawn over the text, by row                                   |
| `hlDefs`         | the colours those drawings refer to, by highlight id                     |
| `cmdline`        | the command line Neovim is showing, or `null` when it closed             |
| `message`        | the last message Neovim wrote, and its kind                              |
| `writeRequested` | Neovim asked the host to write the file — this is what `:w` becomes      |
| `exited`         | the process ended. In the contract; see **Known limitations**            |

**`rows` on a decorations event is not a hint, it is the erase list.** It names the rows this event
replaces, so the client drops what it held for those rows and takes these instead. Without it a
decoration that went away sends nothing at all, and a flash label stays on screen after the jump it
belonged to is over.

## Who owns what

Three owners, and every defect in this area was one of them reaching into another's half.

- **The host owns the file on disk.** It holds the save coordinator, its debounce and the retention
  record that tells our own writes from an agent's. The host plugin turns `:w` into a
  `BufWriteCmd` that notifies rather than writes, so Neovim never lands underneath those three.
- **Neovim owns the text and the undo stack while it is driving.** The client does not edit the
  Monaco model directly in modal editing; it reconciles the model to what the fold says Neovim
  holds. `setValue` is specifically forbidden — see **Traps**.
- **The host owns the viewport, the gutter, the status line and the selection.** Neovim draws the
  text and nothing else, which is what the options in `hostPlugin.ts` enforce and why each of them
  is there.

## Lifetimes

- **A session lives per thread**, evicted once there are more than sixteen with nobody attached
  (`DEFAULT_MAX_SESSIONS` in `Manager.ts`).
- **A buffer lives per file inside a session**, capped at thirty-two (`MAX_BUFFERS_PER_SESSION`),
  oldest first. The cap is what keeps a long session from holding every file the developer opened
  all day.
- **On the client the Monaco models live per project**, in a module-level registry that outlives
  React (`monacoFileModelRegistry.ts`, four projects retained). The undo stack lives in the model,
  and the panel unmounts for three ordinary things — the spinner while a file is read, opening
  Settings, and switching to a thread in another project — so a cache owned by any component would
  be destroyed by exactly the actions it exists to survive.

## Traps

Each of these was found the expensive way, and each looks like a correct piece of code.

- **The gutter is not cosmetic.** A cell is read as drawn-over text when its character differs from
  the buffer's at that column. Anything Neovim paints in the margin shifts every column on the line,
  and `list` and `conceallevel` break the same equality from the other side. With line numbers left
  on, one flash jump produced **132** phantom labels against the 30 that were real. `hostPlugin.ts`
  forces the whole set as window-local options _and_ as globals, and
  `tests/unit/editor-session-wired.test.ts` holds them there.
- **Neovim's working directory is the thread's project, never the server's.** The configuration's
  plugins root themselves at it. Spawned in the installed service's own directory (the home
  directory), neo-tree built a tree of all of it and re-rendered it on every edit: 100% CPU, 1.7 GB,
  and every key queued behind it for ten seconds or more, which reads as "the editor ignores me".
- **Three column units meet here, and the wire speaks only one.** The grid counts screen cells (a
  tab is `tabstop` cells, a wide character two), Neovim's cursor and `nvim_buf_set_text` count
  bytes, and Monaco counts UTF-16 units. The wire is UTF-16 throughout; the conversion happens in
  the Lua that reads or writes a position (`vim.str_utfindex`, `vim.str_byteindex`), and
  `classifyRow` in `GridModel.ts` walks cells and text together. Index-for-index comparison read
  every character after the first accent or tab on a line as a phantom label.
- **`grid_scroll` moves rows Neovim will not send again.** A scroll redraws only the rows that came
  into view. A grid model that ignores it compares stale rows against the lines now under them —
  one `<C-d>` produced 915 phantom overlays and put a closing tag from the top of the file in the
  middle of the screen.
- **The `neovim` npm package is not the way in.** It routes through its own session object and
  hides the UI events this needs. The framing is ours, in `NvimRpc.ts`, and it is about two hundred
  lines.
- **Never replace the whole model.** Monaco 0.56's `setValue` destroys every decoration before it
  clears the undo history — the line is literally commented "Destroy all my decorations" in
  `textModel.js` — so a whole-model write takes the file's comment anchors with it. Reconcile with
  `applyEdits`, which also records no undo element of its own.
- **`stdpath('config')` is not a lever.** Neovim resolves its configuration as
  `$XDG_CONFIG_HOME/nvim`, so the environment variable is what moves it, and the configured
  directory has to be pointed at as that variable's `nvim` child. `NvimLaunch.ts` owns the
  arithmetic.
- **`useSyncExternalStore` hands a component the current value, not a queue.** Two events that land
  between two renders produce one render carrying the second, and the first is never applied. A
  state that carried only the latest event is therefore correct exactly until the machine is busy.
  Everything folds to absolute state — the lines themselves, the cursor, the mode, the decorations —
  or to a counter, as `writeRequests` does. A `:w` immediately followed by any other event shares
  one render, and a consumer reading the latest event sees the other one, so the write is never
  flushed and the developer is told their file is saved.
- **A `nvim_buf_lines_event` with a null `changedtick` is an `inccommand` preview, not a change.**
  `:help nvim_buf_lines_event` says so. Applied as a delta, `:%s/two/TWO\rMORE/` piles up fragments
  as the developer types the command. `NvimBridge.ts` drops them.
- **Neovim will not hold a window that hides the cursor.** `winrestview({topline})` on its own snaps
  straight back, and reads correct from inside the same Lua call, which is what makes it convincing.
  The cursor has to be clamped into the range in the same call; `SET_VIEWPORT_LUA` does it.
- **Edits handed to `nvim_buf_set_text` must be applied last-first, and sorted.** Out-of-order
  edits that change length corrupt each other's positions. `APPLY_EDITS_LUA` sorts before it walks
  backwards.
- **`nvim_input` is asynchronous and nothing in the protocol says when a key was consumed.** Code
  that has to know uses the session's `type`, which feeds keys with `nvim_feedkeys`'s `x` flag — at
  the cost of aborting an incomplete command, so it takes whole sequences only.
- **The editor sits under the app's own overlays and must stay there.** Monaco's widgets take a
  z-index of their own, and the command palette, the file picker and the dialogs are the app's.
  Meta never reaches Neovim (`nvimKeymap.ts` returns null for it) for the same reason: an editor
  that swallowed it would take the app's shortcuts away wherever it happened to have focus.

## The desktop app, and the PATH question

The worry is specific: an Electron app launched from a desktop entry does not inherit a login
shell's `PATH`, so a Neovim installed in `~/.local/bin` would be invisible to the server the app
bundles, and every session would fail with `binary-missing` for a Neovim that is plainly installed.

**It does not happen, and the reason is upstream's.** `fixPath` in `apps/server/src/os-jank.ts`
runs at server start: it reads `PATH` from a login shell and _merges_ it with the process's own
(`mergePathEntries`). The bundled server therefore sees the developer's real `PATH` whatever the
launcher had.

Measured on this machine. The desktop build was started with `PATH=/tmp/nonvim-bin`, a directory
holding only `sh`, `bash`, `node`, `git`, `env` and `timeout` — no `nvim`. The backend process's
own `PATH` read back as the full login-shell value with `/tmp/nonvim-bin` merged into the middle of
it, `/usr/bin` still present, and the session started normally against `/usr/bin/nvim`.

So `binary-missing` cannot be provoked through the desktop by stripping the launcher's `PATH`. What
that fallback does when it _is_ reached is proved by `nvimFallback.test.ts` and by
`NodeNvimAdapter`'s classifier, not by this route.

## Monaco's language services, and the alias that removes them

`apps/web` imports a curated Monaco entry rather than the package's own, so the
CSS, HTML, JSON and TypeScript language services are never registered and their
worker chunks are never built. A single `resolve.alias` on the bare
`monaco-editor` specifier points at it.

`optimizeDeps.include` still names `monaco-editor`, because the file panel is
lazy-loaded and the dependency scanner would otherwise not see roughly two
thousand ESM modules until the first file is opened — minutes of waterfall over
a tailnet origin.

**That entry resolves through the alias, and it was measured rather than
assumed.** Vite has not always applied `resolve.alias` during the dependency
scan, and if it did not here, dev would silently pre-bundle the whole package
while production builds stayed correct. After a real `vp run dev`:

- `apps/web/node_modules/.vite/deps/monaco-editor.js` is 2.1 MB,
- it contains `createTokenizationSupport`, which exists only in the curated
  entry's JSON exception,
- and it contains none of `typescriptDefaults`, `cssDefaults`, `htmlDefaults`,
  `jsonDefaults`, `monaco-lsp-client`, or the
  `languages/features/{typescript,css,html}` paths.

Re-check those strings after a Vite bump; the behaviour is Vite's, not ours.
Kept here rather than in `apps/web/vite.config.ts`, which upstream edits often —
that file carries the one-line alias and a pointer back to this section.

## Running the conformance harness

The suite in `apps/server/src/editor/conformance/` drives a real Neovim. It is the only thing in
this area that proves anything about vim rather than about our arithmetic.

```bash
# Against a scratch configuration — runs anywhere nvim is on PATH.
cd apps/server && vp test run src/editor/conformance --max-workers=2

# Against the developer's own configuration, plugins and remaps.
cd apps/server && MESURA_NVIM_CONFIG_DIR=~/.neovim vp test run src/editor/conformance --max-workers=2
```

Two files are gated on `MESURA_NVIM_CONFIG_DIR` and skip without it, `realConfig.test.ts` and
`insertModeLatency.test.ts`. They skip rather than fail because there is no second machine and no
continuous integration that has that directory — but the skip is itself asserted, so a harness that
silently stopped running when the variable _is_ set fails instead of passing quietly.

**Tracing a live session.** Start the server with `MESURA_EDITOR_TRACE=<file>` and every call from a
client and every event sent back is appended to that file as JSONL (`editorTrace.ts`). `waitedMs` is
time queued behind the thread's lock and `tookMs` is Neovim's answer time; a frozen editor shows up
as `tookMs` in the seconds.

**No test in this area may wait on a clock.** `editorBridgeContract.test.ts` enforces it by reading
the sources for `Effect.sleep`, `setTimeout` and `TestClock`. A text-sync harness that waits on a
clock passes on a fast machine for the wrong reason and fails on a loaded one for no defect, which
is worse than no harness at all. The one exemption is the latency bench, which asserts no duration
and therefore has no threshold to be wrong about; the exemption is a named list, so widening it is
an edit somebody reads.

## Insert mode

The question: do keys typed in insert mode go to Neovim like every other key (**naive**), or does
Monaco edit locally and hand the result over when insert mode ends (**delegated**)?

It is a question about time, so it is answered with measurements. The rule was fixed before the
numbers were read, so it could not be argued afterwards:

> Predicted keystroke-to-paint = measured server-side p95 + 6.4 ms browser share. At or under
> 16.7 ms — one frame at 60 Hz — **naive**. Over it, **delegated**.

The browser share is a constant from the prototype (7.0 ms end to end for insert-mode typing, minus the 0.60 ms insert-mode floor; the 0.50 ms figure often quoted beside it is the normal-mode one), not
re-measured here.

### Measured

`apps/server/src/editor/conformance/insertModeLatency.test.ts`, gated on `MESURA_NVIM_CONFIG_DIR`.
Neovim 0.12.4, the developer's configuration with 55 plugins, a 300-line TypeScript buffer, second
run of two so lazy.nvim's first-start work is not in the numbers.

| run                            | n   | p50 ms | p95 ms | max ms | median cells | median buffer events |
| ------------------------------ | --- | ------ | ------ | ------ | ------------ | -------------------- |
| insert characters, 25 ms apart | 200 | 1.77   | 2.84   | 32.56  | 3            | 1                    |
| normal mode `j`/`k`            | 50  | 0.46   | 0.63   | 0.65   | 476          | 0                    |
| flash `s`+`e`, to the labels   | 20  | 2.20   | 3.06   | 3.06   | 88           | 0                    |

Predicted keystroke-to-paint, from the insert p95 of 2.84 ms:

| one-way link delay                 | predicted ms |
| ---------------------------------- | ------------ |
| 0 (local)                          | 9.24         |
| 5.6 (tailnet minimum)              | 20.44        |
| 50 (tailnet average)               | 109.24       |
| 250 (tailnet under sustained load) | 509.24       |

**How much to trust these.** Under this configuration Neovim flushes about every four
milliseconds whether or not anything is happening — 114 frames in 500 idle milliseconds, nearly all
of them drawing nothing. A bench that timed "the next frame after a key" would therefore be timing
that stream and not the key, and an earlier version of this one did exactly that: it reported a p50
of 1.73 ms, which is about half the gap between two empty frames. The bench now waits for a frame in
which a cell was drawn **or** the cursor moved, and it publishes its own error bar: of the 200 gaps
between keys, **33 saw something happen with no key in flight**. That is the rate at which a timing
could still be somebody else's frame.

### What the tailnet numbers mean, and why they do not change the verdict

At the tailnet minimum a keystroke is predicted at 20.44 ms — already over one frame — and under
sustained load from the phone it is half a second. That is a real number for a remote browser and it
does not move this decision, because the two surfaces this fork is used on are the desktop host,
where the link delay is zero, and the Android app, which has no modal input this cycle.

If a remote browser later gets modal editing, this is the number that cycle starts from, and
optimistic local echo is the candidate mechanism: Monaco paints the character immediately and
reconciles when Neovim's version of the line arrives. That is not built here.

### The plugins that run on every inserted character

Read out of a live session, from inside insert mode, rather than from the plugin list:

| event           | groups                                              |
| --------------- | --------------------------------------------------- |
| `InsertCharPre` | `autopairs_insert_1`                                |
| `TextChangedI`  | `matchparen`, `___cmp___`                           |
| `CursorMovedI`  | `lualine_stl_refresh`, `matchparen`, `___cmp___`    |
| `InsertEnter`   | `cmp_nvim_lsp`, `___cmp___`                         |
| `InsertLeave`   | `lint`, `nvim-ts-autotag-1`, `___cmp___`, `luasnip` |

Under **naive**, which is what was chosen, the developer keeps all of them: autopairs inserts the
closing bracket, nvim-cmp offers completions, LuaSnip expands, nvim-ts-autotag closes the tag,
nvim-lint runs on leaving insert. Under **delegated** they would all stop running for the duration of
an insert, because Neovim would never see the individual characters — that is the price the
delegated branch pays for typing that feels local at any link delay, and the numbers said it did not
have to be paid.

One consequence of autopairs worth recording, because it broke the bench twice: **many inserted
characters draw no cells at all.** Typing the `)` that autopairs already inserted only moves the
cursor. Roughly one key in twelve of ordinary code is such a closer, so an instrument that waits for
a frame that _drew something_ puts every one of them in its tail — measured that way the bench
reported a p50 of 1.8 ms beside a p95 of 515 ms, and the whole tail was its own bug.

## The client, and which keys it keeps

With modal editing on, the file panel routes every key through `toNvimKey` and sends it. Three rules
decide the exceptions, and each one was measured against the developer's own configuration rather
than argued.

- **Shift is a modifier for a named key and never for a printable one.** On a Latin-American layout
  `/` is `Shift+7` and `event.key` already says `/`, so sending `<S-/>` would mean nothing while `/`
  means search. `Tab` is `Tab` however it was typed, and his configuration maps `<S-Tab>` and
  `<Tab>` to `vim.snippet.jump` backwards and forwards — two different commands. Escape is the one
  named key Shift is dropped for: nothing maps `<S-Esc>`, and a Shift held a moment too long would
  otherwise leave him in insert mode.
- **The pane chords never reach Neovim, and are not on the list below.**
  `Ctrl+H` and `Ctrl+L` are claimed on the window in the capture phase by
  `apps/web/src/lib/usePaneNavigation.ts`, so Monaco is never offered them and
  the whitelist has nothing to say about them. Neovim's own window commands
  stay reachable as `<C-w>h` and `<C-w>l`, because a prefix chord is never
  captured. Leaving the editor is a pane chord now, not only Escape. The
  vertical pair, `Ctrl+J` and `Ctrl+K`, moves between the chat and its
  terminal drawer and has no bearing on the editor: the right panel has no
  vertical neighbour, so neither chord is claimed while the editor has focus.
  The whole model is in [Pane focus](./pane-focus.md).
- **One application shortcut outranks Neovim among the keys Monaco does
  receive: the file picker.** `<C-p>` is unmapped in his
  configuration, so the picker costs Neovim nothing. Every other collision goes the other way, and
  the measurements are why — `<C-k>` is `TmuxNavigateUp`, `<C-b>` is Telescope, `<C-f>` is his file
  finder, `<C-u>` and `<C-d>` are half the scrolling. The application's own version of those is
  reached by leaving the editor first — Escape in normal mode releases it to the panel, and
  `Ctrl+H` from there reaches the chat, which is the pane `Ctrl+U` and `Ctrl+D` scroll. They are
  scoped to that pane rather than to "not the terminal" precisely so the editor keeps them; see
  [Pane focus](./pane-focus.md).
- **Escape in plain normal mode belongs to the panel**, and in every other mode to Neovim. Leaving
  insert, visual or an operator is what Escape is for, and a host that blurred the editor instead
  would strand him in that mode with the keyboard elsewhere. In normal mode there is nothing to
  leave, and `<Esc>` is unmapped there in his configuration, so it dismisses as it always did —
  except while flash waits for a label. Neovim reports plain `n` then, so the session reads flash's
  own extmark namespace alongside the mode and sends `jumping`; without it Escape was taken as a
  dismissal and the labels stayed up. The same flag drives the strip's FLASH label and fades every
  highlight with no background (flash's backdrop) so the labels stand out.

**The session state the client holds is absolute, not the last event.** Every event other than
`snapshot` is a delta, and a client that kept only the latest one would be correct exactly as long
as every event reached a render — which `useSyncExternalStore` does not promise. Two events landing
between two renders produce one render carrying the second, and the delta after that is then
measured against text that has already drifted. So the fold keeps the lines themselves, the way the
terminal's fold keeps the whole buffer rather than the last chunk, and the driver reconciles Monaco
to them. The line-range edit is still taken as a shortcut when the driver can see it missed nothing,
and the result is checked against the state afterwards — a delta is an optimisation over a truth,
never the truth.

**A `nvim_buf_lines_event` with a null `changedtick` is a preview, not a change.** `inccommand`
defaults to `nosplit`, so every keystroke of a `:s` replacement being typed makes Neovim report what
each line _would_ become. The buffer does not move — `nvim_buf_get_lines` answers the old text
throughout — and every preview names the same range against the original, so they are not deltas and
they do not compose. `:%s/two/TWO\rMORE/` turns one line into a growing pile of half-typed fragments
if they are applied. The bridge drops them, which is the one place that has to know: the wire event
carries no tick, so a client cannot tell. The committed event arrives with a real tick, and so does
the initial snapshot `nvim_buf_attach` sends.

## The window, and who decides where it is

Monaco owns the scrolling a pointer or a wheel caused; Neovim owns the scrolling a key caused. Three
things in that exchange were measured rather than reasoned about, and each one was wrong first.

- **`winrestview({ topline })` on its own does not hold.** Neovim will not keep a window that hides
  the cursor, so the view snaps back the moment the call returns — and it reads as the requested
  value from inside the same Lua call, which is what makes it look like it worked. The cursor
  therefore moves into the window, and only when it would otherwise be outside it. That is what
  Vim's own mouse wheel does.
- **The grid to resize is the buffer's, not the outer one.** With `ext_multigrid` the outer grid is
  the whole screen, and resizing it leaves the window inside it the size it was. The id is assigned
  by the redraw stream rather than fixed, so the bridge reports it and the manager uses that.
- **An echo is a topline either side sent recently, not the last one it sent.** A wheel produces
  scrolls faster than the round trip answers them, so a developer can scroll away and back before
  the first answer lands; with one slot remembered, the stale echo scrolls the editor back to a
  position they had already left.

**An agent's write goes to Neovim, not to the model.** One `nvim_exec_lua` applying every edit, so
the whole write is one undo step — two `nvim_buf_set_text` calls and one `u` leaves the second edit
in place, which is half of somebody else's change undone and no way to tell. The edits are sorted
inside that Lua rather than trusted from the caller: they have to be applied from the end backwards,
and an out-of-order batch that also changes lengths corrupted the text silently while keeping undo a
single step.

**Undo has one owner and nothing is taken away to keep it that way.** `Ctrl+Z` reaches `toNvimKey`
and is stopped before Monaco's keybinding service sees it, and every edit from Neovim goes through
`applyEdits`, which records nothing. An earlier version also cleared the model's history on each
activation with `setValue`, which is the only public way to clear it — and which destroys every
decoration on the model first, taking the file comments' anchors with it.

## What Neovim draws, and how it reaches the screen

Everything on the buffer grid that is not the file's own text is classified by phase 1's rule — a
cell whose character differs from the buffer's is a drawing, a cell that matches but carries a
highlight is the text marked — and reaches Monaco as one of two things.

- **Overlays are content widgets**, one per run of adjacent cells on one highlight, named by their
  position so the same node survives a label changing. They take the editor's font inline, because a
  content widget sits outside `.view-lines` and inherits the interface font. Flash rewrites its
  labels on every keystroke of a search, and a widget removed and added again flickers.
- **Highlight runs are decorations** with an inline class, and the class is the highlight id. The
  colours are the developer's own colourscheme, written as one CSS rule per id into a stylesheet
  scoped to that editor — two file panels on two threads are two Neovims, and id 7 means something
  different in each.
- **A visual selection is Monaco's selection**, not a decoration, which is why `Visual` is on the
  classifier's deny list. Both ends come from Neovim because either can be the earlier one, and the
  three modes are three different shapes: character-wise gains a column because Vim's selection
  includes the character under the cursor, line-wise takes whole lines, and a block is one range per
  line because that is the only way Monaco draws a column.

**`rows` on a decorations event names the lines it replaces, and nothing else.** A host that took
each event as the whole picture would clear every flash label the moment one unrelated row redrew,
and under the developer's configuration a row redraws constantly.

**A client reads state, never the last event.** Every event the fold receives lands in a named field
that survives a coalesced render: the lines themselves, the cursor, the selection, the drawing per
row — and a _count_ for `:w`, because a write request has no state to summarise and reading it off
the latest event loses it whenever anything else arrives in the same render. That has now been the
same defect three times in this cycle, in three different places, and the shape is always a consumer
asking what just happened instead of what is true.

## Known limitations

- **The `version` reason is never driven by a test.** Proving it needs a Neovim older than the floor,
  and there is one Neovim on this machine. The comparison is field by field over
  `{major, minor, patch}` rather than a string match, which is the shape that does not rot — but it
  is read rather than measured, and the classifier beside it that _was_ a string match had been
  broken since it was written.
- **A Neovim that exits is replaced, not reported.** `:q`, a crash or a kill ends the process's
  output; `NvimRpc` then fails every waiting and later request, and the manager starts a new Neovim
  in the same session (`restartSession`), reopens the file with the mirror's text and sends a
  snapshot, so the client's attachment keeps working. Undo history from before is lost, and after
  three restarts the session is dropped. The wire's `exited` event is still never sent. A Neovim that
  hangs rather than exits is not detected; the trace shows it as calls whose `tookMs` climbs.
- **A visual selection assumes `selection=inclusive`.** His configuration uses the default, measured,
  and `virtualedit` is empty. Under `selection=exclusive` the drawn selection would be one character
  too long, and under `virtualedit=block` a block past the end of a short line would be clipped where
  Vim would not clip it. Neither is plumbed through, deliberately: the option would have to be read
  per buffer and carried on the wire for a setting he does not use.
- **`/` does not leave a search highlight under his configuration.** flash owns the key and clears
  `hlsearch` when its jump finishes, so a search that moved the cursor leaves nothing marked. The
  run-reporting path is real and is exercised by setting the search register directly; what is
  absent is Vim's own after-the-fact highlight, and it is absent because he replaced it.
- **The command-line window is not drawn in the strip.** `q:` and `<C-f>` from the command line open
  a real window, and `ext_cmdline` reports it as the command line closing. The text is visible
  because the window draws like any other, but the strip shows nothing while the developer edits a
  command in it.
- **A `flush` does not mean something changed.** Under the developer's configuration Neovim emits
  roughly 230 flushes a second while completely idle, nearly all of them drawing no cells at all.
  Anything downstream that reacts per frame — pushing state over the wire, recomputing a delta —
  must key off whether the drawing actually changed, not off the frame arriving. `GridModel` keeps
  per-row hashes and cell and cursor counters for exactly this.

- **Floating windows are not drawn.** nvim-cmp's completion menu and which-key's popup report
  `win_float_pos` and are deliberately ignored, so they do not appear over Monaco. Completion is
  Monaco's own for now.
- **lazy.nvim's update checker and change detection hold the process open at exit.** With a UI
  attached, a plain `SIGTERM` on the process id is caught and the exit path never finishes, because
  both leave libuv handles open. The spawner signals the process group, which does stop it, and
  `kill` passes `forceKillAfter` so a session that ends can end regardless.
- **The configuration has no `vim.g.mesura` branch yet.** The host sets the flag from its first
  `--cmd` so the configuration can turn off what it does not want under a GUI host — the update
  checker above being the obvious candidate — in the way `vim.g.neovide` and `vim.g.symmetria_ide`
  already are. That branch is the developer's to write; nothing here depends on it.
- **A `dev = true` plugin whose directory is absent makes lazy open its own UI** over the buffer at
  every start, which no host can drive through. It is not a defect in this code, but it is the first
  thing to check when a session comes up showing something other than the file.
- **`nvim_input` is asynchronous and nothing in the protocol says when a key has been consumed.**
  Code that has to know uses the session's `type`, which feeds keys with `nvim_feedkeys`'s `x` flag
  and answers only once they have run — at the cost of aborting an incomplete command, so it takes
  whole sequences only.
