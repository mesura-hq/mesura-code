# Keybindings

Customize shortcuts in **Settings → Keybindings** on web and desktop. That page
also lists the command IDs and defaults available in your version.

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

## Composer controls

Use `mod+shift+m` to choose a model and `mod+shift+h` to choose a host.
Use `mod+shift+e` for effort, `mod+shift+a` for access mode, `mod+shift+x` for the
workspace, and `mod+shift+g` for the Git branch. The workspace menu includes the
current checkout, a new worktree, and the previous worktree when available.
Use `mod+shift+l` to reuse the previous worktree directly.

In the model picker, press Left in an empty search field or Shift+Tab to reach
the provider list. Use Up/Down to move and Enter to choose. Right returns to
model search. `mod+shift+up` and `mod+shift+down` switch providers directly and clear the
search. These provider shortcuts can also be changed in Settings.

These shortcuts run inside the focused web or desktop client. `mod` uses Command
on macOS and Ctrl on Windows and Linux, including GNOME, KDE Plasma, Niri, and
Hyprland. If a custom desktop shortcut takes the same keys, choose another binding
in Settings.

## Copy pull request references

With a PR open in the right panel or on the Pull Requests page, use `mod+shift+c`
to copy its URL and `mod+shift+k` to copy its number with a `#` prefix.
Both shortcuts can be changed in Settings. Search for “Copy Link or Thread ID”
or “Copy Number”. They copy the selected PR and leave terminal input alone.

## iPad

With a hardware keyboard, use `Cmd+1` through `Cmd+9` to open the first nine
displayed threads. The shortcuts follow the current list filters and order.
`Cmd+K` opens the command palette to search commands, projects, and threads.
Use the arrow keys and Return to choose a result, or `Cmd+1` through `Cmd+9` to
choose directly. Escape or `Cmd+K` closes the palette. Start a search with `>`
to show only actions.

In the composer, Return sends and `Shift+Return` inserts a new line. `Cmd+Return`
also sends. To make Return insert a new line instead, change the Return key
behavior in Settings → Keyboard.

## Edit the configuration file

Keybindings live on the environment's machine, in
`~/.t3/userdata/keybindings.json` by default. You can edit this file directly.
It is a JSON array of rules:

```json
[
  { "key": "mod+g", "command": "terminal.toggle" },
  { "key": "mod+shift+g", "command": "terminal.new", "when": "terminalFocus" }
]
```

T3 Code creates the file with its defaults and adds new defaults on later startups.
New defaults do not replace commands you customized. If a new default overlaps one
of your shortcuts, [rule order](#precedence) decides which runs.
Invalid rules are ignored; if the file cannot be parsed, T3 Code uses defaults.

## Rule shape

Each rule requires a `key` shortcut and a `command` ID. An optional `when`
expression restricts when it runs.

Project scripts use `script.{id}.run`, such as `script.test.run`.

## Key syntax

Join modifiers and a key with `+`, such as `mod+shift+d` or `ctrl+l`.
`mod` means Command on macOS and Control elsewhere. Other modifiers are
`cmd` / `meta`, `ctrl` / `control`, `alt` / `option`, and `shift`.

`tab` is usable as a key, but only with a modifier. The recorder in **Settings** → **Keybindings**
passes a bare `Tab` and `Shift+Tab` through so they keep moving focus; a `Tab` held with Ctrl, Alt,
or Cmd records normally.

Shortcuts on `tab` reach the desktop app but not the web app. Browsers keep `Ctrl+Tab` and
`Ctrl+Shift+Tab` for switching their own tabs and never deliver them to a page, so a rule using
them works in the desktop app and stays silent in a browser.

## Commands

`filePicker.toggle` opens file search for the active project and defaults to `mod+p`.
`fileTree.toggle` reaches the file tree in the files panel and leaves it again; it defaults to
`mod+e`. `fileTree.miller` opens the file manager over the window and closes it again; it defaults
to `mod+alt+e`, and it keeps working while the file manager is open, when the other shortcuts
wait.
Both reach the app from inside the editor, and neither runs while the terminal has focus.
`projectSearch.toggle` searches inside the active project's files and defaults to `mod+alt+g`.
Repeating either shortcut closes that search, and switching shortcuts replaces the open search.
`projectScope.toggle` filters the thread list to one project and defaults to `mod+shift+f`.
`threadSearch.toggle` searches every thread in every project and defaults to `mod+alt+k`. Type
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

`question.toggleCollapse` defaults to `alt+q`. On web and desktop it jumps to the first pending
request in the conversation and focuses its first unanswered field or option. If all answers are
complete, it focuses the first question. The command keeps its existing name for saved keybindings;
question cards stay expanded. With a question's option focused, number keys 1–9 select its options.
Number keys typed in a text field remain text.

The shortcut does nothing when no question is pending or when the terminal has focus.

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

Both shortcuts work while the chat column has focus, which includes the composer, since that is
where the cursor usually sits while you read. They therefore take `mod+u` away from the
readline-style "delete to line start" some text fields offer, in that column only.

They no longer work while the file editor has focus. `Ctrl+U` and `Ctrl+D` are half the scrolling
inside that editor, and taking them there made it worse at the thing it is for. Press `Escape` to
leave the editor and `Ctrl+H` to reach the chat, and the pair works again.

Scrolling up also stops the timeline following the live edge, the same as scrolling with the
wheel. Without that, the next chunk of a streaming reply would pull you back to the bottom.

`diff.toggle` defaults to `mod+shift+d`, which leaves `mod+d` to the pair above.

### Moving between threads

`thread.next` and `thread.previous` default to `mod+shift+]` and `mod+shift+[`, and additionally to
`ctrl+tab` and `ctrl+shift+tab`. The bracket pair works everywhere and is the one the app reports as
the shortcut. The tab pair is desktop-only, because browsers keep those two chords for their own tab
strip; it is also inactive while the terminal has focus, since the terminal encodes `ctrl+tab`
itself. `mod+1` through `mod+9` jump straight to a thread by position.

With the sidebar focused, the list also walks under your fingers: `j` opens the next thread and
`k` the previous one, and `mod+d` and `mod+u` step five at a time, stopping at the ends rather
than wrapping. These are the only single letters the app binds to anything, so they apply in the
sidebar and nowhere else — typed in the composer, in a terminal or in the file editor they are
letters. Inside the sidebar's own search box they are letters too, so you can still search for a
thread whose name has a `j` in it.

Focus stays in the sidebar as you walk, on the row of the thread you just opened, so you can keep
going. Clicking a thread with the mouse still puts the cursor in the composer, as before.

### Moving between panes

`mod+h` and `mod+l` move focus left and right across the three columns — the sidebar, the chat and
the right panel — and `mod+j` and `mod+k` move down into the terminal drawer and back up. A pane
that is closed or collapsed is stepped over, and at the edge the chord does nothing rather than
wrapping round to the other side.

The app claims these four everywhere, including inside a terminal and inside the file editor, so
each one means the same thing wherever you type it. That is the point of them: leaving the editor
used to mean `Escape` and then the mouse. The editor's own window commands are unaffected, since
a chord starting with `Ctrl+W` is never claimed.

`mod+j` and `mod+k` keep whatever else they do in panes with no vertical neighbour. In the sidebar
and the right panel there is nothing above or below, so the chord falls through untouched — which
is how `mod+j` still opens the terminal drawer when none is open, and enters it when one is.

Three defaults moved to make room, and an existing config is rewritten on the next start:

- the command palette to `mod+o`,
- open-in-favourite-editor to `alt+o`,
- the preview's address bar to `mod+alt+l`.

Inside a terminal, `Ctrl+L` no longer clears the screen, because it now moves to the right panel.
Type `clear` instead.

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

The command palette, open-in-favourite-editor and the preview's address bar move to `mod+o`,
`alt+o` and `mod+alt+l`, because `mod+k` and `mod+l` are now pane chords. Those three rules are
rewritten in place on the next start, so a chord you had already changed yourself is left alone.

Four more move because this release adds composer controls on `mod+shift+` with a letter, and each
of those letters was already taken here. The file tree's Miller view goes to `mod+alt+e`, the
thread search to `mod+alt+k`, the project's content search to `mod+alt+g`, and the preview's
address bar to `mod+alt+l`. Each keeps its letter and changes only a modifier, and each rule is
rewritten in place on the next start.

`alt+m` for the model picker, the `ctrl+tab` pair for thread navigation, and `j` and `k` for the
sidebar's list are second defaults for commands your file already binds, so they are added once on
that same start. If any of those keys is already yours, that one is skipped and your rule stands.

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
the app supplies today are `terminalFocus`, `terminalOpen`, `previewFocus`, `previewOpen`,
`modelPickerOpen`, `sidebarFocus`, `chatFocus`, `panelFocus`, and `sidebarSearchFocus`. The set is
open and grows over time, so treat that as the current list rather than a fixed one. Any key the
running app does not supply evaluates to `false`.

`sidebarFocus`, `chatFocus` and `panelFocus` name which region holds the keyboard. At most one of
those three is true at a time, and all three are false while a terminal has focus, which
`terminalFocus` already speaks for.

`sidebarSearchFocus` is a fourth key and not one of that set: it says the cursor is in a box you
type into inside the sidebar, so it is true at the same time as `sidebarFocus`. That pairing is
the point of it — it lets a single letter be a shortcut on a thread row and a letter in the search
field, written as `"sidebarFocus && !sidebarSearchFocus"`.

Operators: `!` (not), `&&` (and), `||` (or), and parentheses.

Examples:

- `"when": "terminalFocus"`
- `"when": "terminalOpen && !terminalFocus"`
- `"when": "!terminalFocus"`

## Precedence

The last rule whose key and condition both match wins, even if it belongs to a
different command. Put a more specific rule after a general one when they share
a shortcut.

## Commands with special behavior

`thread.stop` interrupts the running turn in the focused thread. It has no default
shortcut; assign one in **Settings → Keybindings**.

`chat.new` may ask you to choose a project when there is more than one.
`chat.newLocal` skips that chooser. Both use your
[new-thread defaults](./thread-sidebar.md#start-a-thread).

## Reserved shortcuts

In the desktop app, `mod+w` closes the focused terminal or the active right-panel
tab. When nothing remains to close, it closes the window. In a browser, `mod+w`
closes the browser tab; rebind `rightPanel.close` and `terminal.close` to an available
shortcut such as `alt+w`.

Many defaults include `!terminalFocus` so they do not intercept terminal input.
Keep that condition when remapping them if you want the same behavior.

## Desktop quit shortcut

Use `Cmd+Q` on macOS or `Ctrl+Q` on Windows and Linux. In the default **Hold** mode,
hold for 1.2 seconds or press twice within 500 milliseconds. Holding requires
keyboard repeat; if repeat is disabled, use two presses or the application menu.

Change **Settings → General → Confirmations → Quit shortcut** to **Direct** for a
single press or **Double press** for two presses only. Choosing **Quit** from the
application menu always quits immediately.
