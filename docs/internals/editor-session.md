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

Not built yet. A client will open a session for a file in a thread, attach to a stream of its state,
send keys, viewport, cursor and text replacements, and close it. This section is filled in when that
lands.

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
- **One application shortcut outranks Neovim: the file picker.** `<C-p>` is unmapped in his
  configuration, so the picker costs Neovim nothing. Every other collision goes the other way, and
  the measurements are why — `<C-k>` is `TmuxNavigateUp`, `<C-b>` is Telescope, `<C-f>` is his file
  finder, `<C-u>` and `<C-d>` are half the scrolling. The application's own version of those is
  reached by pressing Escape in normal mode first, which releases the editor.
- **Escape in plain normal mode belongs to the panel**, and in every other mode to Neovim. Leaving
  insert, visual or an operator is what Escape is for, and a host that blurred the editor instead
  would strand him in that mode with the keyboard elsewhere. In normal mode there is nothing to
  leave, and `<Esc>` is unmapped there in his configuration, so it dismisses as it always did.

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

## Known limitations

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
