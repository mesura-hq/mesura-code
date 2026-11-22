# Scratchpad

The scratchpad is a place for quick notes next to your threads: ideas to send later, a list of
next steps, a command you will need again. It opens over the thread as a Neovim buffer, with your
own Neovim configuration and every Neovim key.

## Open and close it

- Press `Alt+Shift+N`, or `Space n` in Vim mode's NORMAL mode, or run **Scratchpad** from the
  command palette.
- Click the **Scratchpad** card under the thread details. It shows the first lines of the
  project's notes.
- Press `Esc` in Neovim's NORMAL mode, press `Alt+Shift+N` again, or click outside the card to
  close it.

The scratchpad always opens in NORMAL mode. Press `i` to write.

## Scopes

The scratchpad has three scopes, shown as tabs at the top:

- **General**: one set of notes for every thread.
- **Project**: one set of notes per project. This is where it opens.
- **Thread**: notes for this thread only. A new thread gets this scope once its first message
  is sent.

Press `Tab` and `Shift+Tab` in NORMAL mode to move between them. In INSERT mode, `Tab` indents as
usual.

## Where the notes are kept

Every scope is a Markdown file on the host, saved as you type, without `:w`. The files are in the
`scratchpads` folder of the host's data directory (`~/.mesura-code/userdata/scratchpads`
by default): `general.md`, `projects/<project id>.md` and `threads/<thread id>.md`. A closed
browser, a lost connection or a restarted host does not lose them.

Each browser tab edits through its own Neovim, and every opening reads the file from the host
again. If two devices edit the same note at the same moment, the later save wins.
