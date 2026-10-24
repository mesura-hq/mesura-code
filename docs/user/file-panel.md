# Reading and editing files

Open **Files** in the right panel to browse the workspace of the project you have open. Choose a
file from the tree, or press `Ctrl+P` and type part of its name. The panel opens the file in an
editor with line numbers and syntax colouring.

The editor is for reading and for small changes. It is not a place to write a feature: the agent
does that. Use it to correct a line, adjust a value, or leave a note for the agent about the code in
front of you.

## The tree

The tree is the one from the Symmetria File Manager, so its keys are the file manager's keys. It
lists every file the project has, in the same order the file manager uses: folders first, then
names.

`Ctrl+E` takes you to it from anywhere in a thread. If the files panel is not open, it opens;
if the tree is hidden behind a file, it shows. Press `Ctrl+E` again from inside the tree to leave
it: the tree hides behind the file you have open and the editor takes the keyboard, or, when no
file is open, the composer does. `Escape` leaves the tree the same way.

Inside the tree:

- `j` and `k`, or the arrow keys, move the cursor. `h` closes the folder you are in or moves to
  its parent; `l` opens a folder or moves into it.
- `o` opens or closes the folder under the cursor. `Enter` opens a file in the editor, or opens
  and closes a folder.
- `G` jumps to the last row, `Home` and `End` to the first and last, `PgUp` and `PgDn` a page at a
  time.
- `/` searches the names in the tree as you type. `n` and `N` step through the matches.
- `s` is the flash jump: every visible row gets a short label; type the first letters of a name to
  narrow them, then the label, and the cursor lands there.

`Ctrl+D` and `Ctrl+U` inside the tree currently scroll the chat. They move to the tree with the
pane-focus work.

Right-click a row for **Copy mention**, which puts an `@` mention of the file on the clipboard,
and **Add to chat**, which appends it to the composer.

The folders you close stay closed: the tree remembers its shape per project, across a reload.

**When the project is large**, the server lists part of it, the tree says so under its last row,
and what is missing from the tree is missing from `Ctrl+P` too.

## The file manager

`Ctrl+Shift+E` opens the Symmetria File Manager over the whole window, in the project of the thread
you have open. It is the same file manager you run on its own, with its Miller columns: the folder
you are in, its parent to the left, and what is under the cursor to the right. Press `Ctrl+Shift+E`
again to put it away, or close its last tab with `Ctrl+Q`. You return to where you were, with the
keyboard where it was.

While it is open, its keys are the file manager's keys and the application's own shortcuts wait,
`Ctrl+Shift+E` apart (and `Alt+U`, the usage peek, which has no meaning in the file manager). `?` shows every key. The ones you will use first:

- `j` and `k` move the cursor, `h` goes up a directory, `l` and `Enter` go into a folder.
- `Enter` on a file under the project opens it in the editor and closes the file manager. On a
  file outside the project it opens the file with the desktop's own application for it, and the
  file manager stays.
- The pane on the right previews the file under the cursor: text, code, images, video, audio,
  PDF, rendered markdown and HTML, spreadsheets, archives.
- `a` creates a file or a folder, `r` renames, `d` moves to the desktop's trash after a
  confirmation. `y` copies, `x` cuts, `p` pastes; `Space` marks several entries first.
- `c` starts the copy-to-clipboard chord: the path, the name, or an image itself.
- `g` starts the go-to chord: your bookmarks, `gg` for the top. `~` goes home and `z` jumps to a
  frecent directory, each on its own.
- `t` opens a tab, `[` and `]` move between tabs, `Ctrl+Q` closes one.
- `/` searches the names in the column as you type; `s` is the flash jump.
- `.` shows hidden files; `,` starts the sort chord.

`Ctrl+O` opens the folder overview: the project as a graph of folders you can zoom and pan. `Esc`
or `Ctrl+O` closes it and returns to the columns.

The file manager's bookmarks, sort and hidden-files preferences are the ones of the file manager
you run on its own, on the machine the server runs on: set a bookmark in one and the other has it.

Two things are not there yet. `f`, the fuzzy finder, says so when you press it; it arrives as a
finder of its own, reachable from anywhere in the application. And a remote browser opens files
outside the project on the server's desktop, not on yours.

## Editing and saving

There is no save command. The file is written about half a second after you stop typing, and the
panel shows that a write is pending until the server confirms it.

Word wrap, the code font, and the font size all follow your appearance settings. Change them in
**Settings → Appearance** and the open editor follows without losing your place.

## Modal editing

The file panel edits with the Neovim on this machine, using your own configuration. Keys, motions,
operators, plugins and mappings are the ones you already have; the panel draws them.

**Modal editing** in Settings → Appearance turns it on and off. It is on to begin with. Off gives
the panel a plain editor with its own undo and its own keys, which is what it was before.

**Neovim configuration directory** in the same place says where that Neovim reads its configuration.
Leave it empty to use `~/.neovim`.

The row under the editor shows the mode, the command line while you type one, and the last message
Neovim wrote.

`:w` writes the file now rather than waiting for the automatic save.

Your configuration can tell it is running here: `vim.g.mesura` is set before anything of yours
loads, in the same way `vim.g.neovide` is. Use it to turn off what does not belong in an editor
inside another application — an update checker, a file-change watcher, a start screen.

**When Neovim cannot start**, the row says so and why: a configuration directory that is not there,
a Neovim too old, or one that is not installed. The panel still edits, exactly as it does with the
setting off. Fix the setting and press **Retry**.

Two things are not drawn: completion menus and any other floating window Neovim opens. Completion
in the panel is the editor's own.

## Leaving a comment for the agent

Press on a line number and drag to select a range of lines. When you release, a comment form opens
below the last line you selected. Write the comment and choose **Comment**, or press `mod+enter`.

The comment is attached to the composer as a quote of those lines, so your next message carries the
code you are talking about. Choose **Cancel**, or press `Escape`, to drop a comment you have not
sent. Delete a comment you already made from the icon on its right.

A comment follows its lines. When the agent writes to the file above your comment, the comment moves
down with the code it points at, and the quote in the composer follows. When the lines it covers are
deleted, the comment goes with them.

## When the agent writes to a file you have open

The panel watches the file you are reading. When anything outside the editor writes to it — an agent
turn, a `git` operation, another program — the new contents appear without a refresh, and without
disturbing what you were doing:

- Your cursor stays where it was, even when the change was above it.
- Your undo history survives. `mod+z` takes you back through the agent's change to your own last
  edit.

## Moving between files

Switching to another file and back returns you to where you were: the same scroll position, the same
cursor, and the same undo history. This holds for the last few dozen files you opened.

A file you return to shows what is on disk now. If an agent rewrote it while you were reading
something else, you see the new contents, and undo still reaches the version you left.

Leaving the thread entirely — opening Settings, or moving to another thread — does start the editor
again. Your files are saved, so nothing is lost, but the undo history from before you left is not
available when you come back.

## Files you cannot edit

A file larger than one megabyte opens for reading only. The panel shows its first megabyte and says
so above the file. This is deliberate: the editor only ever received part of the file, so letting
you save it would write that part over the whole file.

Images and videos render as themselves rather than as text.

A markdown file has a second view. Use the toggle above the file to switch between the rendered
document and its source; you edit in the source view.

Changes made by an agent are a different view. Use **Diff** in the right panel to review what a
thread changed, rather than comparing files by eye.

## Tree diff and Files diff

**Tree diff** answers "what is uncommitted, and where is it?". It is the first mode of **Diff** in the
right panel, and it lists every changed file in the working tree as a tree. Each file carries a
letter for how it changed — `M` modified, `A` added, `D` deleted, `R` renamed, `?` untracked — and
its added and removed line counts. Above the tree, the branch and a summary show how many files and
lines are staged, unstaged and untracked.

Tree diff follows the disk by itself. When an agent, a shell, or a `git add` or `git commit` changes
the working tree, the tree updates without waiting for a turn to end. A change usually
shows within about a second; in a very large repository it can take several seconds.

Click a file to open it in its own tab, beside the Diff tab. That tab opens without the explorer, so
the file has the whole column. To bring the explorer back on that tab, use the folder button in the
file's header, or press `Ctrl+E` (`Cmd+E` on macOS). Only a file that still exists inside the
project opens: a deleted file, or a changed file outside the project's folder, stays in the list but
does not open. Read those changes in Files diff.

**Files diff** shows the same uncommitted work as full patches: every changed line of every file, in
one scroll. Use Tree diff to see where the changes are, and Files diff to read them.

Two keys reach both modes from anywhere in a thread, the editor included:

- `Alt+G` opens Diff on Tree diff. Press it again on Tree diff to close the panel.
- `Alt+C` opens the menu of Diff modes. Type a mode's first letter and press `Enter`. `T` selects
  Tree diff, and a second `T` moves to Turn.

Tree diff is also in the command palette, as **Show tree diff**.
