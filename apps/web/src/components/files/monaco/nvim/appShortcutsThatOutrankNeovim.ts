/**
 * App shortcuts that reach the app from a focused modal editor; every other key is Neovim's. The
 * list was measured against the developer's config (`<C-k>`, `<C-b>`, `<C-f>`, `<C-u>`/`<C-d>` stay
 * Neovim's). Pane chords must stay absent: `usePaneNavigation` captures them on the window first.
 * `fileTree.toggle` and `fileTree.miller` are defence only, in case their capture listener moves.
 */
export const APP_SHORTCUTS_THAT_OUTRANK_NEOVIM: ReadonlySet<string> = new Set([
  "filePicker.toggle",
  "fileTree.toggle",
  "fileTree.miller",
  // A file opened from Tree diff leaves the keyboard in the editor; the way
  // back to the list has to work from there.
  "treeDiff.toggle",
  "diff.modeMenu",
]);
