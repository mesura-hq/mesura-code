# Keybindings

Edit keybindings from **Settings** → **Keybindings**. That page lists every command, its current
shortcut, whether it is a default or your own, and warns about conflicts.

The same configuration lives in `~/.mesura-code/userdata/keybindings.json` on the machine running
the server, if you prefer editing it directly. Mesura Code writes the built-in defaults into that
file on first run, and adds any new defaults on later startups unless a rule of yours already
claims the command or the shortcut.

New defaults reach an existing file two ways, and both run once.

A release that _moves_ a default onto a different key rewrites the old rule, but only when it still
matches the retired default exactly, key and command and `when` together. A rule you changed
yourself is never touched.

A release that gives an already-bound command a _second_ default adds that rule the first time you
start the new build. Offering it once is the whole contract: delete the shortcut afterwards and it
stays deleted, because startup records what it has already offered in a `keybindings.applied.json`
beside your config. An old default you removed is never resurrected — only defaults introduced
after your file was written are offered at all.

Either way, when the key involved already belongs to a rule of yours, nothing is changed: stacking
two commands on one chord would quietly disable one of them, so the server leaves your rule alone
and logs a warning instead.

The file is a JSON array of rules.

```json
[
  { "key": "mod+g", "command": "terminal.toggle" },
  { "key": "mod+shift+g", "command": "terminal.new", "when": "terminalFocus" }
]
```

Invalid rules are ignored. An invalid file is ignored entirely, and the server logs a warning.

## Rule Shape

- `key` (required): shortcut string, like `mod+j`, `ctrl+k`, `cmd+shift+d`
- `command` (required): the command ID to run
- `when` (optional): boolean expression controlling when the shortcut is active

## Key Syntax

Modifiers: `mod` (`cmd` on macOS, `ctrl` elsewhere), `cmd` / `meta`, `ctrl` / `control`, `shift`,
`alt` / `option`.

Examples: `mod+j`, `mod+shift+d`, `ctrl+l`, `cmd+k`.

`tab` is usable as a key, but only with a modifier. The recorder in **Settings** → **Keybindings**
passes a bare `Tab` and `Shift+Tab` through so they keep moving focus; a `Tab` held with Ctrl, Alt,
or Cmd records normally.

Shortcuts on `tab` reach the desktop app but not the web app. Browsers keep `Ctrl+Tab` and
`Ctrl+Shift+Tab` for switching their own tabs and never deliver them to a page, so a rule using
them works in the desktop app and stays silent in a browser.

## Commands

Commands are IDs like `terminal.toggle`, `commandPalette.toggle`, `preview.refresh`, and
`chat.new`. Project scripts are addressable as `script.{id}.run`, for example `script.test.run`.

`filePicker.toggle` opens file search for the active project and defaults to `mod+p`.
`projectSearch.toggle` searches inside the active project's files and defaults to `mod+shift+g`.
Repeating either shortcut closes that search, and switching shortcuts replaces the open search.
`projectScope.toggle` filters the thread list to one project and defaults to `mod+shift+f`.
`threadSearch.toggle` searches every thread in every project and defaults to `mod+shift+k`. Type
words in any order: each one is matched against the project name, the thread title and the branch,
so `mesura rename` finds **Rename the sidebar** in the **Mesura Code** project. A word is also
matched against what was said inside a thread. The project filter does not narrow this search — it
always reaches every project. With the field empty it lists recent threads, so it doubles as a way
back to what you were reading.
`themeEditor.toggle` opens or closes the floating theme editor and defaults to
`mod+alt+shift+t`. Select a color label to spotlight the elements that use it; select the label
again to clear the spotlight. The swatch and hex field keep that color selected while you edit it.
Advanced mode groups related app tokens into a smaller set of color families. Changing a family
updates its paired text and interaction states while leaving every unrelated imported color intact.
Use **Inspect** to pick an element in the app and reveal its color token. Inspect disarms after one
successful pick; its hover glow and badge preview the element and color family that click will select.
**Cancel** or `Escape` exits Inspect and clears its selection and spotlight.

`rightPanel.toggleMaximized` maximizes or restores the open right panel. It has no default shortcut,
so add one in **Settings** → **Keybindings** if you want to use it.

`usage.peek` shows the subscription-limit panel while you hold its shortcut. It defaults to
`alt+u`. Releasing the main key or a required modifier closes the panel, and `Escape` closes it too.
The panel opens from the thread list's sidebar footer, so the shortcut does nothing on the Settings,
Usage and Pull requests pages, where that footer shows a Back button instead.

`thread.copyReference` copies the active thread's pull request link, or its thread ID when no pull
request is available. Its default shortcut is `mod+shift+c`, and it does not replace terminal copy
while the terminal has focus.

### Command palette

`thread.settle` settles the active thread or restores it when it is already settled. Its default
shortcut is `mod+shift+s`, and it does not run while the terminal has focus.

`thread.pin` pins the active thread to the pinned section of the sidebar, or unpins it when it is
already pinned. Its default shortcut is `mod+shift+p`, and it does not run while the terminal has
focus. See [Organizing threads](./thread-sidebar.md) for how pinned threads are ordered.

The command palette searches settings, active thread titles, projects, branches, user messages, and
final agent responses across connected environments. A setting result opens its exact control or
section. Message matches show one labeled excerpt while keeping the thread's project, branch, and
machine context visible. Message search begins after two characters and uses SQLite's ASCII
case-insensitive matching.

### Composer pickers and question prompts

`modelPicker.toggle` opens the model picker from the composer and defaults to `mod+shift+m`, and
additionally to `alt+m`. While it is open, `mod+1` through `mod+9` select a model directly.

`traitsPicker.toggle` opens the composer control that holds reasoning effort, thinking, fast mode,
context window, and agent. It defaults to `alt+e`. Two cases make it do nothing, both by design:
a provider that exposes none of those traits does not render the control at all, and a narrow
composer folds the traits into its compact controls menu, which has no separate picker to open.

`question.toggleCollapse` folds the question the agent is asking into its header, and unfolds it
again. It defaults to `alt+q`. Folded, the card keeps one line — the question's label, its position
in the set, and the question itself, cut to fit — and gives the rest of the height back to the
thread behind it, which is usually where the answer is. The header is also a button, so a click on
it does the same thing. The shortcut works while you type your own answer, which a click does not.
Two things follow from the fold: the number keys that pick an option are off while the card is
folded, because the numbers they name are not on screen, and the card unfolds by itself when the
prompt moves to its next question.

Two situations make the shortcut do nothing. No question is waiting, so there is nothing to fold.
Or an approval prompt has taken the same panel, and approvals are answered rather than folded. Like
the other `Alt` defaults, it is also off while the terminal has focus.

Six defaults sit on `Alt` with a letter: `alt+e`, `alt+w`, `alt+b`, `alt+m`, `alt+q`, and `alt+u`.
The app claims those chords before the character reaches the composer, which matters on two
platforms. On macOS `Option` composes characters — `Option+E` starts an acute accent, `Option+Q`
types `œ`, and the others type symbols like `∑` and `µ` — so a default may be swallowed or may
suppress a character you wanted. Firefox uses `Alt` with a letter for menu access keys. Rebind any
of them in **Settings** → **Keybindings**.

On a Latin American layout, `AltGr+Q` types `@`. That is a different chord — the app sees `AltGr`
as `Ctrl+Alt` — so `alt+q` never eats it.

### Branch toolbar

`branchPicker.toggle` opens the branch menu above the composer and defaults to `alt+b`. Note that
`mod+alt+b` is a different shortcut: it toggles the right panel.

`workspacePicker.toggle` opens the workspace control beside it — the one choosing between the
current checkout and a new worktree — and defaults to `alt+w`. Three situations make it do nothing.
The choice can no longer change, because the thread already owns a worktree and the control has
become plain text; the project exposes no git controls at all; or the window is narrow enough that
the toolbar collapses into its compact layout, which uses a different control the shortcut does not
reach.

New threads pick their workspace from a setting rather than from the last thread. The resolution
order is the project's own setting, then a `defaultThreadEnvMode` entry in the project's `t3.json`,
then the global default in **Settings**, which ships as the current checkout. Setting it per
project is usually what you want: a repository where every thread is real work benefits from
starting in a worktree, while somewhere you mostly ask questions does not, since each worktree is a
fresh directory that needs its own dependency install. Note also that new worktrees start from
`origin` by default, so a thread opened that way will not see uncommitted work sitting in your
checkout.

### Reading a long thread

`chat.scrollHalfPageUp` and `chat.scrollHalfPageDown` scroll the message timeline and default to
`mod+u` and `mod+d`. Each press travels half the readable height rather than a whole screen, so
half of what you were reading stays visible and you keep your place. The move is animated over
about a fifth of a second and slows as it lands; with the system set to reduce motion, it jumps
instead. Holding a key keeps travelling, because each press aims from where the previous one was
going rather than from the position the animation is passing through. A scroll gesture arriving
mid-animation wins: the wheel, a drag, or a touch stops the move where it is.

Both shortcuts work while the composer has focus, since that is where the cursor usually sits
while you read. They therefore take `mod+u` away from the readline-style "delete to line start"
some text fields offer.

Scrolling up also stops the timeline following the live edge, the same as scrolling with the
wheel. Without that, the next chunk of a streaming reply would pull you back to the bottom.

`diff.toggle` defaults to `mod+shift+d`, which leaves `mod+d` to the pair above.

### Moving between threads

`thread.next` and `thread.previous` default to `mod+shift+]` and `mod+shift+[`, and additionally to
`ctrl+tab` and `ctrl+shift+tab`. The bracket pair works everywhere and is the one the app reports as
the shortcut. The tab pair is desktop-only, because browsers keep those two chords for their own tab
strip; it is also inactive while the terminal has focus, since the terminal encodes `ctrl+tab`
itself. `mod+1` through `mod+9` jump straight to a thread by position.

### Settling a thread

`thread.toggleSettled` settles the open thread, or brings a settled one back to Active, and
defaults to `mod+shift+s`. Note that `mod+s` — the same chord without `Shift` — is a different
shortcut: it stashes the composer draft. Like the other composer shortcuts, it is inactive while
the terminal has focus.

Some browsers keep `Ctrl+Shift` with a letter for themselves, and a web page cannot take those
chords back. If the shortcut does nothing in your browser, look for it in that browser's own
keyboard shortcuts, then rebind it in **Settings** → **Keybindings**. The desktop app is not
affected.

Settling moves the thread out of the sidebar's Active list. The shortcut acts on the same state the
banner above the composer reports and the thread's own menu offers, so the three can never disagree.

A thread with live work cannot be settled: a running or starting session, a pending approval, a
question waiting on you, or a message no turn has picked up yet. Settling one of those would hide
it, so the shortcut reports the refusal instead. Un-settling has no such limit.

A thread you have not sent a message to yet does not exist for the server, so the shortcut does
nothing there. An environment whose server predates settling reports that instead of acting; update
that server to use the shortcut against it.

Un-settling pins the thread Active. The pin holds until real activity clears it, so a merged pull
request or a long silence does not settle the thread again behind you.

A press that arrives while the previous one is still travelling is ignored rather than queued. Over
a remote connection the round trip is long enough to press twice, and the second press would read
the state the first one has not changed yet — queueing it would settle a thread you asked to
un-settle.

### Closing terminals and windows

`terminal.close` defaults to `mod+w` while the terminal has focus. Anywhere else that key does
nothing on Linux and Windows: the desktop window there is the whole application, so closing it
would quit Mesura Code. Quit from **File** → **Quit**, the titlebar, or your window manager
instead. On macOS `Cmd+W` closes a window without quitting the app, as it does everywhere else on
that platform.

### If you upgraded from an older build

Everything below reaches you with nothing to do by hand.

`diff.toggle` used to default to `mod+d`. Its rule is rewritten to `mod+shift+d` on the next start,
which is also what frees `mod+d` for the reading scroll in the same run.

`Ctrl+W` used to close the desktop window, and off macOS that quit the whole application. That one
is a change to the native menu rather than to a keybinding, so it needs nothing from your config:
the key now closes a focused terminal and does nothing otherwise.

`alt+m` for the model picker and the `ctrl+tab` pair for thread navigation are second defaults for
commands your file already binds, so they are added once on that same start. If any of those keys
is already yours, that one is skipped and your rule stands.

The full command list and the current defaults are shown in **Settings** → **Keybindings**, which
always matches the build you are running. Use that rather than a copied list.

Note that `chat.new` and `chat.newLocal` both create a thread through the same path. A new thread
inherits the project you were in, along with model and mode selections. Branch, worktree, and
environment mode always come from your configured defaults, not from the thread you were looking
at. To keep a worktree, use the explicit "new thread in this worktree" action in the branch
toolbar. The only difference between the two commands: with the current sidebar and more than one
project, `chat.new` opens a project chooser first.

Background submission from a new thread is the exception. `mod+enter` starts that thread and opens
another new thread with the same workspace mode and base branch. **New worktree** remains selected,
but the new thread does not reuse the worktree created for the thread that just started.

## `when` Conditions

A `when` expression is evaluated against context keys describing the current UI state. The keys
the app supplies today are `terminalFocus`, `terminalOpen`, `previewFocus`, `previewOpen`, and
`modelPickerOpen`. The set is open and grows over time, so treat that as the current list rather
than a fixed one. Any key the running app does not supply evaluates to `false`.

Operators: `!` (not), `&&` (and), `||` (or), and parentheses.

Examples:

- `"when": "terminalFocus"`
- `"when": "terminalOpen && !terminalFocus"`
- `"when": "!terminalFocus"`

## Precedence

- Rules are evaluated in array order.
- For a key event, the last rule where both `key` matches and `when` evaluates to `true` wins.
- Precedence is across commands, not only within the same command. A later rule for a different
  command can take a key away from an earlier one.
