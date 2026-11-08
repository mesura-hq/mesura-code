# Editor session

> For maintainers. Using Mesura Code? See [docs/user](../user/).

An **editor session** is one embedded Neovim process that the server drives on behalf of a file open
in a client. It exists so the developer's own Neovim — their configuration, their plugins, their
remapped keys — is what edits the file, while [Monaco](../user/file-panel.md) stays the thing on
screen.

The server half lives in `apps/server/src/editor/` (`Manager.ts` owns sessions, the per-thread lock
and key receipts; `NvimBridge.ts` the session itself), the contract in
`packages/contracts/src/editorSession.ts`, and the client's key lane in
`apps/web/src/state/editorSession.ts`.

## Where Neovim runs

Neovim runs on the environment's host, never on the client. The developer's real setup is a remote
host: they edit from the laptop's desktop app, whose environment is vigilia-home's live server, so
Neovim runs on vigilia-home and every key crosses the tailnet (a direct LAN path, about 4 ms round
trip). The phone uses the web client against the same host. A design that is correct only at zero
link delay is therefore wrong for the one user this fork has; the key lane, the caret delivered with
its text and Escape decided by the input answer all exist because of the round trip.

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

### The grid width, and the window's `leftcol`

With `nowrap`, a cursor that reaches the grid's last column scrolls the window sideways, and every
cell after that is read against the wrong buffer character. Typing at the end of a long Markdown
line did it on every key: 882 phantom overlays and 35.5 KB of editor events per key. Two rules hold
the equality, and with both the same typing draws no overlay and costs about 1.26 KB per key.

- **The host owns the grid width, not the client.** Only the host sees every key; a client sizes
  its request to what it shows and sends one only when it scrolls, so its `cols` is a floor. The
  host gives Neovim the widest line the cursor can reach (the window and one window either side)
  plus 128 spare columns, bounded at 2,048 (`gridWidth.ts`). It grows the grid **before** a key
  batch that would bring the widest line near the edge, because Neovim sends a change and the
  scroll it caused in one burst: a host that grows on hearing of the change is already too late.
  Keys whose expansion the host cannot predict — a put, `.`, a macro, `J`, an Ex command, a
  counted insert — reserve the whole 2,048 columns for the next 20 batches.
- **`GridModel` classifies against the window's `leftcol`**, which the host plugin pushes with the
  cursor, using one width model that matches Neovim's drawing (`<200b>` spellings of unprintable
  characters, the `<` marker for a cut wide character, tabs). A line wider than the bound still
  scrolls the window; it is then read correctly, at the cost of every row redrawing.

## The wire

The methods and their payloads are defined in `packages/contracts/src/editorSession.ts` and
`rpc.ts`; read them there. Every one carries a `threadId`, because a session belongs to a thread
rather than to a file: the developer switches file inside one Neovim, the way they would in a
terminal.

`open` hands Neovim the **lines**, never the path. Neovim is told the name so `:w`, `%` and the
status line say something true, and it never reads or writes the file itself — the host owns the
disk. The path is still resolved against `cwd` the way a read is, so one that climbs out of the
project is refused; a name the developer did not ask for is still a name.

Both text-carrying payloads are bounded: `keys` at 1024 characters, `edits` at a thousand entries
and each entry's `text` at a megabyte, which is where the file-read path truncates and therefore the
largest replacement that can honestly arrive.

Errors are the union of `EditorSessionError` and `EnvironmentAuthorizationError`.
`EditorSessionInputLostError` is the one a client must not retry; see **Keys, and how they travel**.
Authorization is
the terminal's `AuthTerminalOperateScope`, for every method — a session is a subprocess on the
developer's machine reading and writing their files, which is the authority the terminal already
carries rather than a new one to invent.

### The event union

`attach` streams `EditorSessionEvent`, a tagged union defined in the contract. Every event other
than `snapshot` is a delta. The client folds them into absolute state in
`apps/web/src/state/editorSessionFold.ts`; nothing downstream may read "the last event", for the
reason under **Traps** below. `writeRequested` is what `:w` becomes, because the host, not Neovim,
writes the file.

**`rows` on a decorations event is not a hint, it is the erase list.** It names the rows this event
replaces, so the client drops what it held for those rows and takes these instead. Without it a
decoration that went away sends nothing at all, and a flash label stays on screen after the jump it
belonged to is over.

## Keys, and how they travel

A client that sends one `input` per key pays one round trip per key, and keys typed faster than
the round trip queue behind each other. At 60 ms one-way delay with keys 80 ms apart, that put
insert-mode keystroke-to-paint at a p95 of 4,964 ms. The rules below brought it to 247 ms, with the
text always ending correct.

- **One lane per thread, one request in flight.** `editorKeyLane` is the only sender of a thread's
  keys. Keys typed while a request is in flight go out together as the next batch, split in order
  at the contract's 1,024-character bound and only between keys (`<Es` then `c>` is five letters,
  not Escape). A click or an agent's edit takes its place in the same lane, so it lands between the
  keys around it. The lane is module-level per registry, because the panel remounts per file and
  the keys in flight belong to the thread.
- **A batch is applied once.** Each carries a `sequence`, a lane id and an index counting upwards.
  The server keeps one receipt per lane and skips a batch it already applied, answering it as a
  success: a disconnect may have lost only the reply. It records the submission uninterruptibly,
  and when Neovim's input buffer takes only part of a batch it resumes from where it stopped.
  Receipts are kept for at most 16 lanes per session (`MAX_INPUT_LANES`), the oldest evicted first.
  A lane is one client registry's stream for the thread, so a window or a reload is a new lane; a
  lane evicted by sixteen newer ones loses its receipt, and a re-send from it is applied again as
  a new batch rather than skipped.
- **A receipt belongs to one Neovim.** It records which generation of the session's Neovim took
  the batch. A re-send of a batch that a since-replaced Neovim took fails with
  `EditorSessionInputLostError`: taking a key is not running it, so the restored text may or may not
  hold it, and sending it again could type it twice.
- **Keys are never dropped silently.** After a transport failure the lane waits for the session to
  come back and re-sends the unacknowledged batch first, under the same sequence number. A session
  gone for 60 s, six failures in a row that the server answered, or an `EditorSessionInputLostError`
  drop the queued keys, and the status strip says `KEYS LOST` (and `KEYS NOT SENT, RETRYING` while it
  retries), because a key that did not arrive changes what the next one does.
- **The text and the caret arrive together.** The host plugin pushes the cursor, the mode and
  `leftcol` with `rpcnotify` (`mesura:cursor`) from `CursorMoved`, `CursorMovedI`, `ModeChanged` and
  `WinScrolled`. Neovim runs those after the key and before the redraw, and not while typeahead is
  pending, so a batch pushes once and ahead of its frame. The manager sends a lines event, its
  cursor and its drawing in one attach-stream chunk, so a key no longer costs a cursor read and the
  caret paints in the frame that paints the letter. A cursor read stays as the fallback for what
  moves the cursor without those autocommands.
- **Escape is decided by the input answer, not by the attach stream.** Each `input` answers with
  where Neovim is after it consumed the batch: the mode from `nvim_get_mode`, which Neovim orders
  behind pending input (neovim#6247); `blocking` when a command waits for a key (`f`, `r`, a count,
  a mapping prefix, or a plugin's `getcharstr()`, which shows only in `state()`); and `jumping` while
  flash labels targets. The client releases the editor on Escape only when its lane is empty and
  the last answer said plain `n`, not blocking, not jumping. The stream's own `mode` event can arrive
  after that answer, and a client that read it released on a NORMAL older than the keys. On the
  bench at 60 ms one-way, Escape stranded Neovim in insert mode in 2 tries of 8 at `288064922e`, with
  4 probe keys reaching the chat composer instead; after the fix 0 of 8, with none. The
  investigation's own repro script, run before the developer's configuration was fixed, had
  stranded it 8 tries of 8. `open` answers with the
  same state, so Escape right after opening a file releases; a snapshot never confirms a mode.

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
- **`nvim_input` is asynchronous and nothing in the protocol says when a key was consumed.** A
  `nvim_get_mode` sent after it is the one call Neovim orders behind pending input, so its answer
  comes once the keys ran, or at once with `blocking` set when a command waits for a key; that is
  how `input` answers. The tests also use the session's `type`, which feeds keys with
  `nvim_feedkeys`'s `x` flag — at the cost of aborting an incomplete command, so it takes whole
  sequences only.
- **While Neovim waits for the rest of a command, a non-fast request never answers.** After `g`,
  `Z` or an operator, `nvim_get_mode().blocking` is true and Neovim defers every non-fast request,
  `nvim_exec_lua` included, until the key arrives. That request holds the thread's lock, and the key
  arrives through `input`, which takes the same lock, so the thread stopped taking keys for good
  ("2 requests waiting longer than 15s", every later key lost). So when the last batch left Neovim
  waiting, `open` and `replaceText` first cancel the pending command with `<Esc>` through
  `nvim_input` (which Neovim takes while it waits), because a refusal would lose a file or an
  agent's write; `setCursor` and `viewport` refuse instead (`cancelPendingCommand` and
  `refuseWhileWaitingForKey` in `Manager.ts`). Nothing retries a refused call: the key lane
  finishes a queued call on failure as on success. A click while a command is pending is dropped,
  and Neovim's window stays where it was until the next viewport change sends a fresh viewport.
  That is a known limitation, accepted because the half-typed command is still waiting for its key.
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

The question: do keys typed in insert mode go to Neovim like every other key (**naive**, the hybrid
this fork runs), or does Monaco edit locally and hand the result over when insert mode ends
(**delegated**, vscode-neovim's design)?

**Every key goes to Neovim.** Neovim answers an insert key in about a millisecond and the
developer's link is a LAN round trip of about 4 ms, so the cost of a key is the round trip, and the
key lane pays it once per batch rather than once per key. Delegated insert would stop every
per-character plugin for the length of an insert (see below) to save those few milliseconds.

**Revisit the decision when either of these holds:**

- On the developer's real link, insert keystroke-to-paint p95 stays above two round trips plus one
  frame (about 25 ms at a 4 ms round trip) with the key lane and the fixes below in place.
- The developer works over a high-latency link.

Delegated insert mode is then the candidate. Optimistic local echo — Monaco paints the character
at once and reconciles when Neovim's version of the line arrives — is the smaller step between the
two. Neither is built.

### Measured end to end

On a bench outside the repository (`/home/dev/projects/factory-runs/editor-latency-fixes/bench/` on
vigilia-home, method in its `METHOD.md`): the production client in headless Chromium against a copy
of the developer's home, the developer's Neovim configuration, a TCP proxy that adds a one-way
delay, and keys 80 ms apart. Keystroke-to-paint is keydown to the frame that painted the key's text.

| condition                                                 | before                         | after                             |
| --------------------------------------------------------- | ------------------------------ | --------------------------------- |
| insert typing at 60 ms one-way, p95                       | 4,964 ms                       | 247 ms, text always correct       |
| insert typing with no added delay, p95                    |                                | 12.2 ms                           |
| Escape at 60 ms one-way: Neovim stranded in insert mode   | 2 of 8, 4 keys to the composer | 0 of 8, none                      |
| typing at the end of a long Markdown line                 | 882 overlays, 35.5 KB per key  | 0 overlays, about 1.26 KB per key |
| insert typing beside ten streaming agents, p95, streaming | about 37 ms                    | 25–28 ms                          |
| the same, after the streams settle, p95                   | 36.4 ms                        | about 14 ms                       |

What a key cost besides Neovim was most of the difference in the last two rows. One editor key now
renders only the file panel — sidebar rows and tooltips no longer commit per key, and the file tree
measures no text while typing (`AppRoot.editorKeySidebarCost.fence.test.tsx` holds it) — and the
pull-request sweep no longer runs git against unchanged repositories (311 git processes per steady
sweep on a copy of the developer's database, now 0). The streams' remaining cost is the server's
SQLite commit `fsync` on the event loop, about 2 ms per commit under the default
`synchronous = FULL`. `NORMAL` measured about 15 ms, but whether to trade that durability is an
open decision, not a settled one.

### Neovim's own share

`apps/server/src/editor/conformance/insertModeLatency.test.ts`, gated on `MESURA_NVIM_CONFIG_DIR`.
Neovim 0.12.4, the developer's configuration at `~/.neovim` commit `c730dae`, a 300-line TypeScript
buffer, the second of two runs. The time is from a key to the frame that showed it, inside the
server, with no client and no link.

| run                            | n   | p50 ms | p95 ms | max ms | median cells | median buffer events |
| ------------------------------ | --- | ------ | ------ | ------ | ------------ | -------------------- |
| insert characters, 25 ms apart | 200 | 1.12   | 1.67   | 2.35   | 3            | 1                    |
| normal mode `j`/`k`            | 50  | 0.43   | 0.79   | 0.97   | 585          | 0                    |
| flash `s`+`e`, to the labels   | 20  | 5.43   | 9.86   | 9.86   | 4,896        | 0                    |

The test still prints the verdict of the rule this decision was first taken by — predicted local
keystroke-to-paint, the server p95 plus a 6.4 ms browser share from the prototype, at or under one
frame means naive. The end-to-end numbers above replace that prediction, which assumed a link with
no delay.

**How much to trust these.** The bench waits for a frame in which a cell was drawn **or** the
cursor moved, never for "the next frame", and it publishes its own error bar: the 25 ms gaps
between keys in which something happened with no key in flight. Now 0 of 200. That matters because
a configuration can flush with nothing to draw. Before the developer's configuration stopped
loading plugins under Mesura that raised errors and redrew constantly (cmp-nvim-lsp, lspconfig),
Neovim flushed about every 4 ms while idle — 114 frames in 500 ms — and 33 of 200 gaps saw
something happen; an earlier version of the bench that timed the next frame reported a p50 of
1.73 ms, about half the gap between two empty frames. With commit `c730dae`, an idle Neovim emits no
frame at all: none in 15 s in normal mode and none in 10 s in insert mode.

### The plugins that run on every inserted character

Read out of a live session under Mesura, from inside insert mode, rather than from the plugin list:

| event           | groups                      |
| --------------- | --------------------------- |
| `InsertCharPre` | `autopairs_insert_1`        |
| `TextChangedI`  | `matchparen`                |
| `CursorMovedI`  | `matchparen`, `MesuraHost`  |
| `InsertEnter`   | `flash_char`                |
| `InsertLeave`   | `lint`, `nvim-ts-autotag-1` |

Under **naive** the developer keeps all of them: autopairs inserts the closing bracket,
nvim-ts-autotag closes the tag, nvim-lint runs on leaving insert. Under **delegated** they would all
stop running for the length of an insert, because Neovim would never see the individual characters.
nvim-cmp and its sources are absent because the configuration leaves them out under Mesura
(`vim.g.mesura`, `~/.neovim/lua/jc/mesura.lua`): its menu is a float this host never draws, so it
inserted completions nobody saw. `MesuraHost` is the host plugin's own cursor push.

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
  means search. `Tab` is `Tab` however it was typed, and their configuration maps `<S-Tab>` and
  `<Tab>` to `vim.snippet.jump` backwards and forwards — two different commands. Escape is the one
  named key Shift is dropped for: nothing maps `<S-Esc>`, and a Shift held a moment too long would
  otherwise leave them in insert mode.
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
  receive: the file picker.** `<C-p>` is unmapped in their
  configuration, so the picker costs Neovim nothing. Every other collision goes the other way, and
  the measurements are why — `<C-k>` is `TmuxNavigateUp`, `<C-b>` is Telescope, `<C-f>` is their file
  finder, `<C-u>` and `<C-d>` are half the scrolling. The application's own version of those is
  reached by leaving the editor first — Escape in normal mode releases it to the panel, and
  `Ctrl+H` from there reaches the chat, which is the pane `Ctrl+U` and `Ctrl+D` scroll. They are
  scoped to that pane rather than to "not the terminal" precisely so the editor keeps them; see
  [Pane focus](./pane-focus.md).
- **Escape in plain normal mode belongs to the panel**, and in every other mode to Neovim. Leaving
  insert, visual or an operator is what Escape is for, and a host that blurred the editor instead
  would strand them in that mode with the keyboard elsewhere. In normal mode there is nothing to
  leave, and `<Esc>` is unmapped there in their configuration, so it dismisses as it always did —
  except while flash waits for a label. Neovim reports plain `n` then, so the session reads flash's
  own extmark namespace alongside the mode and sends `jumping`; without it Escape was taken as a
  dismissal and the labels stayed up. The same flag drives the strip's FLASH label and fades every
  highlight with no background (flash's backdrop) so the labels stand out. Which mode Neovim is in
  is read from the last `input` answer with the key lane empty, never from the attach stream; see
  **Keys, and how they travel**.

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

Monaco owns the scrolling a pointer or a wheel caused; Neovim owns the scrolling a key caused. Four
things in that exchange were measured rather than reasoned about, and each one was wrong first.

- **`winrestview({ topline })` on its own does not hold.** Neovim will not keep a window that hides
  the cursor, so the view snaps back the moment the call returns — and it reads as the requested
  value from inside the same Lua call, which is what makes it look like it worked. The cursor
  therefore moves into the window, and only when it would otherwise be outside it. That is what
  Vim's own mouse wheel does.
- **Only a pointer scroll moves the cursor.** A viewport request carries its `source`. `pointer` (a
  wheel, a scrollbar, a touch) is a scroll Neovim never saw, so the cursor follows it. `keys`, or no
  source, is the client following a scroll a key made, and the request can be older than keys
  Neovim already ran over the link, so a cursor pulled back by it undoes typing.
- **The grid to resize is the buffer's, not the outer one.** With `ext_multigrid` the outer grid is
  the whole screen, and resizing it leaves the window inside it the size it was. The id is assigned
  by the redraw stream rather than fixed, so the bridge reports it and the manager uses that. Its
  width is the host's, not the request's; see **The grid width, and the window's `leftcol`**.
- **Under word wrap, Monaco does not follow a Neovim topline that would hide the caret.** Neovim
  never wraps and Monaco may, so Neovim's N rows can be more than Monaco shows, and Neovim's
  topline can put the caret below Monaco's window (`followingHidesCaret` in `nvimViewport.ts`).
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
  snapshot, so the client's attachment keeps working. Undo history from before is lost. After
  three restarts without an `open` in between, the session is dropped with `exited` reason
  `gave-up`, and the client falls back to the plain editor with a Retry rather than reopening. A
  Neovim that hangs rather than exits is not detected; the trace shows it as calls whose `tookMs`
  climbs.
- **A lost session is reopened by the client, not rebuilt by the server.** A server restart (the
  desktop app replaces its backend without reloading the window) takes every session with it, and
  only the client still holds the file, the project and the text. So an attachment that fails with
  `EditorSessionLookupError` makes the client open the file again and then attach afresh — in that
  order, because an attachment that reaches the server first finds no session. `exited` carries a
  reason because the right answer differs: `replaced` attaches again, `stopping` waits for the
  reconnect, and `closed` and `gave-up` fall back to the plain editor with Retry. The decision is
  `nvimSessionRecovery.ts`. Neovim state (undo, registers, marks) does not survive a reopen. The
  attach stream is `attachEventStream`, and it must not be `Stream.callback`: that runs its
  registration on a fiber nothing watches, so a failed attach left the client on a silent stream.
- **A visual selection assumes `selection=inclusive`.** Their configuration uses the default, measured,
  and `virtualedit` is empty. Under `selection=exclusive` the drawn selection would be one character
  too long, and under `virtualedit=block` a block past the end of a short line would be clipped where
  Vim would not clip it. Neither is plumbed through, deliberately: the option would have to be read
  per buffer and carried on the wire for a setting they do not use.
- **`/` does not leave a search highlight under their configuration.** flash owns the key and clears
  `hlsearch` when its jump finishes, so a search that moved the cursor leaves nothing marked. The
  run-reporting path is real and is exercised by setting the search register directly; what is
  absent is Vim's own after-the-fact highlight, and it is absent because they replaced it.
- **The command-line window is not drawn in the strip.** `q:` and `<C-f>` from the command line open
  a real window, and `ext_cmdline` reports it as the command line closing. The text is visible
  because the window draws like any other, but the strip shows nothing while the developer edits a
  command in it.
- **A `flush` does not mean something changed.** With the developer's configuration at `~/.neovim`
  commit `c730dae`, an idle Neovim emits no frame at all (none in 25 s, normal and insert mode). An
  earlier state of the same configuration, with plugins that raised errors and redrew under Mesura,
  emitted roughly 230 flushes a second while idle, nearly all of them drawing no cells — and any
  configuration can do that again. Anything downstream that reacts per frame — pushing state over
  the wire, recomputing a delta — must key off whether the drawing actually changed, not off the
  frame arriving. `GridModel` keeps per-row hashes and cell and cursor counters for exactly this.

- **Floating windows are not drawn.** nvim-cmp's completion menu and which-key's popup report
  `win_float_pos` and are deliberately ignored, so they do not appear over Monaco. Completion is
  Monaco's own for now.
- **lazy.nvim's update checker and change detection hold the process open at exit.** With a UI
  attached, a plain `SIGTERM` on the process id is caught and the exit path never finishes, because
  both leave libuv handles open. The spawner signals the process group, which does stop it, and
  `kill` passes `forceKillAfter` so a session that ends can end regardless.
- **What a configuration loads under Mesura is the configuration's choice.** The host sets
  `vim.g.mesura` from its first `--cmd`, the way `vim.g.neovide` and `vim.g.symmetria_ide` are set.
  The developer's configuration branches on it (`~/.neovim/lua/jc/mesura.lua`) and leaves out the
  plugins this host never shows or that misbehave behind it: pickers whose invisible prompt
  swallows the next keys, nvim-cmp, the status line, neo-tree. A configuration without such a
  branch still works, and pays for those plugins on every key. Nothing here depends on it.
- **A `dev = true` plugin whose directory is absent makes lazy open its own UI** over the buffer at
  every start, which no host can drive through. It is not a defect in this code, but it is the first
  thing to check when a session comes up showing something other than the file.
