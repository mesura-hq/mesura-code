# Reading and editing files

Open **Files** in the right panel to browse the workspace of the project you have open. Choose a
file from the tree, or type part of its name in **Search files** above the tree. The panel opens the
file in an editor with line numbers and syntax colouring.

The editor is for reading and for small changes. It is not a place to write a feature: the agent
does that. Use it to correct a line, adjust a value, or leave a note for the agent about the code in
front of you.

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
