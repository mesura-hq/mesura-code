/**
 * The application shortcuts that reach the app from inside a focused editor.
 *
 * With modal editing on, every key the editor sees is Neovim's, and the
 * application's own chords are reached by pressing Escape in normal mode
 * first. The exceptions are listed here, and the list is short because it was
 * measured rather than guessed. In the developer's configuration `<C-p>` is
 * unmapped, so the file picker costs Neovim nothing. `<C-e>` scrolls one line
 * in Neovim; the file tree takes it, which is the trade the file-tree design
 * records. `<C-k>` is `TmuxNavigateUp`, `<C-b>` is Telescope, `<C-f>` is the
 * developer's file finder and `<C-u>`/`<C-d>` are the scrolling half the
 * motion set depends on — every one of those stays Neovim's.
 *
 * `fileTree.toggle` and `fileTree.overview` are listed as defence only: their
 * listener is capture-phase on the window and stops propagation before Monaco
 * sees the key, so the entries matter only if that listener ever moves.
 * `<C-S-e>` is not a Neovim binding.
 */
export const APP_SHORTCUTS_THAT_OUTRANK_NEOVIM: ReadonlySet<string> = new Set([
  "filePicker.toggle",
  "fileTree.toggle",
  "fileTree.overview",
]);
