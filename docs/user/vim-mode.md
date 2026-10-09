# Vim mode

Vim mode lets you drive Mesura Code from the keyboard with Vim-style modes. You can read and
select the chat, cite an answer, jump anywhere on screen, edit your prompt and resize panes
without the mouse. It is on by default in the web and desktop apps. On a phone it does
nothing, because a touch screen has no keyboard.

The indicator at the bottom-left of the chat shows the mode you are in.

## Modes

- **NORMAL** is where you start. Keys are commands, not text: you move through the chat, open
  menus and run actions. Letters you type here do not go into the composer.
- **INSERT** is for typing your prompt. Press `i` or `a` to enter the composer.
- **VISUAL** (`v`) and **V-LINE** (`V`) select text, in the chat or in the composer.
- **FLASH** labels places on screen so that you can jump to one with two or three keys.
- **PANE** resizes the sidebar, the right panel and the terminal.

The terminal, the file editor, open dialogs and the command palette keep their own keys. Vim mode
does not change how you use them. A tree (the file tree, the Diff's file list) keeps its keys too,
but `Space` still opens the key menu from inside it.

When the keyboard goes to the right panel (`Ctrl+L`, a launcher letter, `Ctrl+Tab`), it lands in
the surface itself: the tree, the diff or the editor, not the tab. Use the arrows to move and
`Ctrl+D` / `Ctrl+U` to move half a page; `Enter` opens the file under the cursor in a tree.

## The leader and the key menu

`Space` is the leader. Press it in NORMAL mode and wait a moment: a menu shows the keys that
can follow, grouped by what they do.

- `Space f` finds things: files, a grep of the project, threads, commands.
- `Space t` acts on the thread: new thread, rename, pin, settle, copy its reference.
- `Space p` opens the right panel's launcher, the same one as the panel's `+` button. Type a
  letter: `t` terminal, `f` files, `d` diff, `b` browser and the rest of the list, or a panel
  action: `z` maximize or restore, `x` close the tab, `o` hide the panel, `e` file tree, `c` file
  manager. A row that cannot open here says why on the row, and its letter shows the reason.
  `Esc` closes the launcher.
- `Space m` controls the composer: model, effort, agent mode, host, stash, attach files.
- `Space b` toggles the sidebar. `Space o` opens the project in your editor.
- `Space ?` lists every key.

You do not have to wait for the menu. Type the whole sequence and it runs at once. `Escape`
cancels a sequence, and `Backspace` steps back one key.

`]t` and `[t` open the next and previous thread.

## Read and cite the chat

In NORMAL mode the chat works like a read-only Vim buffer with a block cursor:

- Move with `h` `j` `k` `l`, words with `w` `b` `e`, lines with `0` and `$`.
- `gg` and `G` go to the start and the end of the thread. `Ctrl+D`, `Ctrl+U`, `Ctrl+F` and
  `Ctrl+B` scroll by half a page or a page.
- `[u` and `]u` jump to your previous and next message.
- `y` with a motion copies text, for example `yiw` for a word. In VISUAL mode, `y` copies the
  selection.

To cite part of an answer, press `Space c` in NORMAL mode. A label appears at the start of each
sentence on screen: type the label where the cite starts. Labels then appear at the end of each
sentence from there to the end of that answer: type the one where the cite ends. Labels are one
or two characters, and `Esc` cancels.

To cite an exact piece of text instead, select it in VISUAL mode and press `Space c`.

Either way, the cited text flashes briefly, the citation goes to the end of your prompt as
`<citation>: `, and the composer opens in INSERT mode, so you type or dictate your comment right
away. Press `Esc` twice to go back to the chat
and cite more. Only assistant text can be cited.

Each thread remembers where its cursor was while the app stays open, so you return to the same
place.

## Jump with flash

Press `s` in NORMAL or VISUAL mode, in the chat or in the composer. Type the first characters
of the place you want. Each match gets a label; type the label to move the cursor there.
`Backspace` on an empty search and `Escape` leave flash.

## Edit in the composer

- `i` and `a` enter the composer in INSERT mode at the end of your prompt, where you type as
  usual.
- `Escape` switches the composer to NORMAL mode. A ring around the composer shows the mode.
  Vim motions, operators, counts and VISUAL mode work on your prompt. Mentions, citations and
  skills count as one character each.
- `u` undoes and `Ctrl+R` redoes. Each typing session and each NORMAL-mode change is one step,
  and the history goes back across sessions until you send the prompt.
- A second `Escape` leaves the composer for the chat.
- `Space e` expands the composer to half the window, with line numbers.

## Resize panes

Press `Space w` to enter PANE mode. Each key moves a border in its own direction:

- `h` moves it left and `l` moves it right.
- `k` and `j` move the terminal's top edge up and down.
- A count moves further: `3l` moves three steps.
- `=` returns every pane to its default size.

The focused pane chooses the border: the sidebar's edge, the right panel's edge or the
terminal's edge. PANE mode stays on, so you can press `l l l`. `Escape`, `q` or `Enter` leaves
it. Any other key leaves it and then runs as usual. New sizes are saved, as they are when you
drag.

You can also resize without Vim mode: press `Tab` to focus a resize handle, then use the arrow
keys.

## Turn Vim mode off

Open **Settings → Appearance** and turn off **Vim mode** in the Typography section. Every
shortcut, the composer and typing to focus the composer then work as they do without Vim mode.
Turn it back on in the same place.

See [Keybindings](./keybindings.md) for the shortcuts that work in both modes.
