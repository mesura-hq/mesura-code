# Keybindings

Edit keybindings from **Settings** → **Keybindings**. That page lists every command, its current
shortcut, whether it is a default or your own, and warns about conflicts.

The same configuration lives in `~/.mesura-code/userdata/keybindings.json` on the machine running
the server, if you prefer editing it directly. Mesura Code writes the built-in defaults into that
file on first run, and adds any new defaults on later startups unless a rule of yours already
claims the command or the shortcut.

That last condition has a consequence worth knowing. Startup only backfills defaults for commands
your file does not mention. When a release _moves_ a default onto a different key, and your file
already has a rule for that command, the move does not reach you: your old rule stays and keeps
the old key. Nothing warns you, and the shortcut that was supposed to take the key over looks
broken instead. If a documented default does not work, compare it against your file first.

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
`projectSearch.toggle` searches inside the active project's files and defaults to `mod+shift+f`.
Repeating either shortcut closes that search, and switching shortcuts replaces the open search.
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

### Command palette

The command palette searches active thread titles, projects, branches, user messages, and final
agent responses across connected environments. Message matches show one labeled excerpt while
keeping the thread's project, branch, and machine context visible. Message search begins after two
characters and uses SQLite's ASCII case-insensitive matching.

### Composer pickers

`modelPicker.toggle` opens the model picker from the composer and defaults to `mod+shift+m`. While
it is open, `mod+1` through `mod+9` select a model directly.

`traitsPicker.toggle` opens the composer control that holds reasoning effort, thinking, fast mode,
context window, and agent. It defaults to `alt+e`. Two cases make it do nothing, both by design:
a provider that exposes none of those traits does not render the control at all, and a narrow
composer folds the traits into its compact controls menu, which has no separate picker to open.

On macOS, `Option+E` is the dead key that starts an acute accent, so that default may be swallowed
before the app sees it. Rebind the command in **Settings** → **Keybindings** if you type accented
characters.

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

### Closing terminals and windows

`terminal.close` defaults to `mod+w` while the terminal has focus. Anywhere else that key does
nothing on Linux and Windows: the desktop window there is the whole application, so closing it
would quit Mesura Code. Quit from **File** → **Quit**, the titlebar, or your window manager
instead. On macOS `Cmd+W` closes a window without quitting the app, as it does everywhere else on
that platform.

### If you upgraded from an older build

`diff.toggle` used to default to `mod+d`, and `Ctrl+W` used to close the desktop window. Both
changed. The `diff.toggle` move does not reach an existing keybindings file — see the warning near
the top of this page — so edit that rule by hand if `mod+d` still opens the diff for you.

The full command list and the current defaults are shown in **Settings** → **Keybindings**, which
always matches the build you are running. Use that rather than a copied list.

Note that `chat.new` and `chat.newLocal` both create a thread through the same path. A new thread
inherits the project you were in, along with model and mode selections. Branch, worktree, and
environment mode always come from your configured defaults, not from the thread you were looking
at. To keep a worktree, use the explicit "new thread in this worktree" action in the branch
toolbar. The only difference between the two commands: with the current sidebar and more than one
project, `chat.new` opens a project chooser first.

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
