---
name: project-electron-v1-built
description: "2026-08-30 — the ten-phase Electron cycle is BUILT and committed on branch t3code/map-electron-file-manager; what is done, what is not, and the traps that cost the most"
metadata: 
  node_type: memory
  type: project
  originSessionId: 93ba8dd0-4f8f-4159-b85f-f81992fa0bf0
  modified: 2026-08-30T20:16:47.429Z
---

On 2026-08-30 the whole `symmetria-fm-electron-v1` plan was built and committed
on branch `t3code/map-electron-file-manager` — ten phases, ten commits,
`2dc15d4` last. **430 tests**, both deterministic gates clean at every commit.
Every phase was verified against the running Electron binary under `xvfb-run`,
not only against its tests. See [[project-electron-transition]] for the
direction and the dossier.

**What exists now.** A sandboxed Electron window on its own `symmetria-fm://`
scheme; the filesystem in the main process; a typed bridge; Miller columns with
virtualisation; the full 54-binding keyboard registry ported as data; tabs;
text/code/image/document previews; the twelve file operations; the borrowed
icon set and a token palette.

**What is NOT built**, and each says so in the interface rather than doing
nothing: the fuzzy finder, flash jump, search, bookmarks, zoxide, the tree view,
sorting controls, hidden-file toggle, the context menu, audio, and undo.

## The traps that cost the most, none findable from a diff

- **A component tree nothing mounted.** Five correct components, 76 passing
  tests, and the window still showed the previous phase's placeholder. A
  component test cannot detect an orphaned component.
- **`@parcel/watcher` has no non-recursive mode** despite a comment claiming
  one. Opening on `$HOME` exhausted the inotify budget. Replaced by
  `node:fs.watch`; the app now ships **zero native modules**, worth keeping.
- **Chromium's PDF viewer refuses a `blob:` URL from a custom scheme** and the
  `<embed>` resolves to `chrome-error://chromewebdata` — invisible in the DOM,
  silent at the console, visible only in the frame tree. Needs `plugins: true`
  AND a same-origin URL. Previewed files are now served by token from the app's
  own scheme, which also removed a 64 MB copy per preview.
- **`shell.openPath` is NOT confined by a virtual display or a scratch `HOME`.**
  A headless verification run opened a real editor window on the live Hyprland
  session. Never exercise "open" from an automated run — assert the route
  instead. The warning is at the top of `app/src/main/ops/open.ts`.
- **CSS cascade defects are invisible to a headless DOM.** The mark colour sat
  on `.row__name` while the icon was that element's sibling, so the icon stayed
  white beside a coloured name. Only a screenshot found it.

## Two documentation defects corrected in CLAUDE.md

There is **no chord timer** (it claimed 500 ms in two places), and the Escape
order has **eight** steps with search decided by focus rather than by the
cascade. Both now say what they used to say, so nobody re-applies the old text.
