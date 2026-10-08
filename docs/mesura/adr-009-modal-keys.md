# ADR-009 — A modal key layer: Vim modes, a Space leader, the chat as a buffer

**Status:** Proposed, 2026-10-07. A prototype is built behind the `vimMode`
client setting (off by default) on `t3code/b1ffc179`. The plan and the epic
follow from testing that prototype.

**Scope:** how the web client (and the Linux desktop app, which wraps it) reads
keys: modes, sequences, which-key, the chat timeline as a navigable buffer, Vim
editing in the composer, cite by keyboard, and flash jumps. The phone is out of
scope: it has no keyboard, and the layer is inert there.

## The problem

The app is driven by about seventy modifier chords (`mod+shift+…`,
`mod+alt+…`). They are hard to remember, Zen and Hyprland eat some of them
(`Ctrl+Shift+E`, `Alt+A`), and bare letters cannot be commands because the app
has no modes: ChatView's type-to-focus sends any printable key into the
composer. The chat cannot be read or selected by keyboard, and cite needs a
mouse selection. The keyboard layer is also not one layer: 81 files in
`apps/web/src` handle keys on their own, and about 17 window listeners each
resolve the same keybinding table, ordered by registration and capture phase.

## Decisions taken by the developer

1. Normal mode is the default when a thread opens. `i` / `a` enter the
   composer. Type-to-focus is removed in Vim mode.
2. The leader is Space.
3. The chat cursor: see "The chat buffer" below.
4. Cite drops the comment popover: a cite lands inline as `<chip>: `, the
   comment is ordinary prompt text, and focus stays in the chat. Citing user
   messages is secondary.
5. Vim editing inside the composer: yes.
6. Architecture over merge cost: more upstream conflict is accepted for the
   sound design.
7. Modifier chords are removed once the modal layer is good. Then `AGENTS.md`
   gains a "keyboard first" principle.
8. `Ctrl+1..9` numbers the sidebar rows that are visible, not the first nine.
9. The key engine is extracted from Symmetria's `fm-core/src/keys` into a
   shared package.
10. Prototype first: real code, behind a setting.
11. Panes resize from the keyboard (2026-10-08): a sticky PANE mode on
    `<leader>w`, keys that move a border in their own direction, a step of
    5% of the viewport,
    and the clean design (keyboard-operable separators) over replayed pointer
    drags. Resize only: moving or reordering panes is not wanted.

## Decision

### Three layers

1. **`packages/keys` (`@mesura/keys`)** — pure, no DOM, no React: key tokens
   (`keyToken.ts`), keymap tries per mode and scope (`keymap.ts`), the pending
   sequence machine (`sequence.ts`), flash label assignment (`flash.ts`).
2. **`apps/web/src/keys/`** — the host: one `keydown` listener on `window`,
   capture phase, installed in `main.tsx` before React renders, so it runs
   before every other window listener (same target and phase run in
   registration order). Consumed keys are stopped with
   `stopImmediatePropagation`.
3. **Surfaces** — `chat/chatSurface.ts` and `composer/composerSurface.ts`. Each
   owns its own Vim grammar and reports its mode.

### Modes and scopes

- Scope is read from the DOM on every key, never stored (ADR-004's rule):
  `focusScope.ts` returns `composer`, `insert` (any other text input),
  `passthrough`, `sidebar`, `chat` or `panel`.
- Passthrough is total: the terminal, the Neovim editor, the file tree, any
  open dialog, menu or listbox, and the command palette keep their own keys.
- Insert is derived from focus (Tridactyl's `isTextEditable`), except in the
  composer, which has its own normal mode and so stores one flag.
- Routing for a key in normal or visual mode: a pending surface sequence first
  (Vim `g`, `f`, operators, counts), then the keymap for the leader or a
  pending leader sequence, then the surface's grammar, then the keymap's other
  root keys (`i`, `a`, `s`, `]t`). In the chat, any other printable key is
  swallowed.
- Two engine-wide modes sit above the surfaces while active and take every
  key first: flash (`flashSession.ts`) and PANE (`paneMode.ts`, see
  "Resizing panes"). A passthrough or insert scope ends PANE mode.

### Keymap rules

- **A key is a command or a prefix, never both** (Helix, Tridactyl, Vimium).
  The compiler reports a binding that breaks this. So a prefix never times out,
  which matches Symmetria's chord model. which-key opens after 200 ms and never
  cancels the prefix; Escape cancels, Backspace steps back.
- Group labels and per-binding labels live in the keymap
  (`defaultKeymap.ts`). Helix cannot label user groups, and Zed shows
  "+N keybinds"; both are worse.
- A deeper scope shadows an outer one.

### The chat buffer

Rejected, with the reason:

- **The file editor's Neovim, read-only.** The predicted delay is 20.4 ms per key at the
  tailnet minimum (`docs/internals/editor-session.md`), one session per thread,
  and a second map between a plain-text buffer and the rich rendering.
- **The browser's `Selection.modify()`, the way Vimium and Surfingkeys do it.** Word movement differs between
  operating systems and engines. Firefox (Zen) lacks sentence, paragraph and
  document movement. No extension implements `iw` or `ip`, and none copes with a
  virtualized list.
- **A CodeMirror or Monaco view of the chat.** It loses the rendering the chat
  exists for.

Chosen: **a text projection per row + a pure Vim engine + CSS Highlight
painting.**

- The projection is upstream's own: `readAssistantText` in
  `lib/assistantTextSelection.ts` (block elements become line breaks, every
  character maps back to a `Text` node). The cite pipeline stores offsets into
  the same text, so a visual selection is already a citation.
- An assistant row is read from its `[data-assistant-citation-source]`, not the
  whole row, which keeps the author label out of the buffer. Blank lines
  inside a row are dropped; one empty line separates rows.
- The cursor is stored as `{ rowId, offset }` and the buffer is rebuilt on
  every key, because the list is virtualized. `gg` / `G` and the scroll keys
  scroll first, then place the cursor on the next frame.
- Motions run in **`@vimee/core` 0.3.0** (MIT, a pure
  `processKeystroke(key, ctx, buffer)` over a `TextBuffer`), read-only.
- The cursor is a CSS highlight (`mesura-chat-cursor`). A visual selection is
  the native selection, so copy and the cite pipeline work on it unchanged.
- The chat and the file editor share key meanings, not an implementation.

### Cite

`<leader>c` in chat visual mode asks `AssistantSelectionToolbar` (one
subscription, `chat/chatCiteBus.ts`) to capture the native selection and call
its existing `onCite`. In Vim mode, `ChatComposer.citeAssistantText` appends
`\n<chip>: ` at the end with no popover and no focus.

### The composer

Insert mode is upstream's composer, untouched. Escape enters normal mode: the
prompt is projected with each inline token (mention, citation, skill, context
reference) as one private-use character, run through `@vimee/core`, and written
back through `applyPromptReplacement`. One character per token is the
composer's own collapsed-cursor model, and one code point per token keeps a
token's identity when an earlier one is deleted. A second Escape leaves for the
chat. Rejected: a Neovim-backed composer (tailnet latency, no token model),
and replacing Lexical with CodeMirror (a rewrite of the composer).

The composer in normal or visual mode wears a ring in the mode's colour on
its card (`[data-chat-composer-main-surface]`). A cursor with no character
under it (an empty line, the end of a line) is drawn as an element
(`cursorOverlayStore.ts`), because a highlight needs a character to paint.

`<leader>e` toggles the expanded composer: half the window high, with a
gutter of hybrid line numbers (the cursor's line absolute, the others
relative in normal mode, as Neovim's `number` + `relativenumber`). The
composer is one Lexical paragraph whose lines are `<br>` elements, so CSS
counters cannot number it; `ComposerLineNumbers` measures each line start and
re-measures only on input, the editor's scroll, or a Vim key.

### Navigation by message

`[u` / `]u` jump to the developer's previous or next message, from any scope
in normal mode. The timeline minimap already decides the current turn and
scrolls the virtualized list to one, so the keys ask it (`chatTurnBus.ts`, one
subscription in `TimelineMinimap`) and land the cursor on that message when
the scroll settles.

### Scrolling

`Ctrl+D/U/F/B/E/Y`, `gg` and `G` scroll with the browser's smooth scroll,
then place the cursor once `scrollend` fires (or a timeout passes when the
view was already at the edge). A generation counter lets only the latest
scroll place the cursor. `prefers-reduced-motion` makes them instant. `j`/`k`
reveal the cursor instantly, because an animated step per key lags behind a
held key.

### The mode indicator

It sits at the bottom-left of the route's main panel (`SidebarInset`), not
the window: portalled into the panel, which is looked up again after each
router render because a lazily loaded route replaces the panel after the
location changes.

### Flash

flash.nvim's assignment: home-row labels, minus any character that could
continue the typed pattern at any match, stable while typing, nearest first.
One session module (`flashSession.ts`) owns the keys, labels, match highlight
and backdrop; each surface supplies its targets and its jump. In the chat,
targets are text a reader can see: above the floating composer and not
covered by an overlay. In the composer's normal mode, `s` is flash too, which
gives up Vim's own `s`. Backspace on an empty pattern leaves.

**One look for every flash in the app**, decided by the developer: the file
editor's. That one is flash.nvim inside Neovim with the developer's
colourscheme: the backdrop is `Comment` (grey, italic) faded to 0.4 by the
host, matches and labels are `Search` (#6d94e9 behind #131313). The
`--mesura-flash-*` tokens in `mesura.css` carry those values, and every other
flash reads them: the Vim-mode chat and composer flash, the file tree's, and
the file manager's Miller and overview flashes (the vendored rules are
overridden from fork-owned CSS, so the subtree is untouched). The Vim-mode
backdrop fades by colour through a highlight, not by opacity, so matches
painted above it keep full strength; italic comes from the surface, because a
highlight cannot set `font-style`.

Not unified yet: the code. Four label algorithms exist (flash.nvim's, two in
Symmetria's `fm-core`, and `@mesura/keys/flash`), and they differ in
behaviour: two-character labels, whether the query's own letters are
excluded, cursor-distance order. The natural home for one implementation is
`fm-core/src/flash/labels.ts`, the most complete, as part of the extraction
in decision 9. The editor's colours follow the colourscheme; the tokens do
not, so a colourscheme change needs the tokens changed by hand.

### Resizing panes

Three edges are resizable, each by its own drag code: the sidebar rail
(`SidebarRail` in `ui/sidebar.tsx`), the right panel's handle
(`PreviewPanelShell` through `useResizableWidth`) and the terminal drawer's
top edge (`ThreadTerminalDrawer`). The keyboard reaches all three through one
fork module, `lib/paneEdges.ts`:

- Each owner calls `usePaneEdge` with a `resizeTo(size)` that runs the same
  clamp and persistence as its drag, and a `reset()`. The hook registers the
  edge while it can be dragged (panel open, inline, not maximized; drawer
  visible and not in the panel) and returns the separator's keyboard props.
- **Arrow keys on a focused separator** move the border in the arrow's
  direction. This is the W3C ARIA window splitter pattern
  (https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/). It works with
  Vim mode off, which makes it an accessibility fix upstream could take; if
  upstream takes it, most of the merge cost below goes away.
- **PANE mode** (`keys/paneMode.ts`), entered with `<leader>w`, moves a
  border with the same rule as the arrows: `h` left, `l` right, `k` up, `j`
  down. A count multiplies the step, `=` resets every edge (Neovim's
  `<C-w>=`). It is sticky (`l l l` without the leader again). `Esc`, `q` and
  Enter leave; any other key leaves and then runs as in normal mode, so
  `<leader>w l i` resizes and enters the composer.

The focused pane (or the last focused one after a blur to `<body>`, ADR-004)
only picks which border the key moves:

- sidebar: its right edge.
- right panel: its left edge, so `h` widens it and `l` narrows it.
- chat: the right panel's edge when the panel is open, otherwise the
  sidebar's; `j` / `k` move the terminal drawer's top edge.
- `j` / `k` from the sidebar or the panel: nothing (a notice says so). Only
  the chat column and the drawer share a horizontal edge.

**Rejected after testing: "grow the focused pane"** (Hyprland's
`resizeactive`, where `l` always widens the focused window). The first build
did that. In the chat it looked right, because widening the chat pushes the
panel's border right. On the right panel, whose border is on its left, `l`
moved the border left, against the key, and the developer read it as
backwards. These keys are read as directions on screen, so one rule serves
both paths, and `paneMode.ts` keeps no per-pane sign.

One step is 5% of the viewport along the edge's axis. The owners' own clamps
apply: the panel stops at 360 px and at its row's limit, the sidebar at its
minimum and at the main column's minimum, the drawer between 180 px and 75%
of the viewport height. Persistence is the drag's: the sidebar and panel
widths in `localStorage`, the drawer height in the thread's terminal state.

Rejected: replaying pointer events on the handles (the chord bridge's
technique). It needs no upstream edit, but it fakes input to reach state the
code already owns, and it cannot read the size it is about to change.

Not built: maximize from PANE mode. `rightPanel.toggleMaximized` has no
default chord, so the chord bridge cannot run it; the command registry in the
plan removes that limit.

These are recorded for the plan. Each one cost a debugging round.

- **The chord bridge is a hack.** Leader rows run existing commands by
  replaying their chord as a synthetic `keydown`
  (`keybindingCommandBridge.ts`). The plan replaces it with a command registry
  whose entries own `run()`; the palette then reads the same registry.
- **The composer's editor takes focus whenever it moves its DOM selection**,
  even when asked not to focus. A cite therefore needs `keepFocusInChat`
  (WORKAROUND) to return focus to the chat.
- **Moving the composer caret in the same tick as a write reverts the write.**
  `focusAt` reports the editor's stale text as a change. A write must place
  the caret itself, after the editor has the new prompt.
- **vimee does not report every edit** (`ciw`, a visual `d`) as a
  `content-change`. The composer compares text before and after instead.
- **Live-follow only learns about reading from wheel, touch and pointer
  events.** Upward cursor motion dispatches a synthetic wheel event
  (WORKAROUND) so a streaming reply does not yank the view back.
- **Hit-testing a point to place the cursor misses** between blocks and in the
  centred column's gutter. Placement reads line boxes instead
  (`lineAtOrBelow`).
- **Closing the command palette returns focus to the composer**, which lands
  in insert mode. In Vim mode, focus should return to the scope it left.
- **Screen-reader-only text is in the projection**: each message starts with
  an `sr-only` author heading ("You", "T3 Code"). The buffer drops lines made
  only of such text, or the cursor would land somewhere invisible.
- **Lexical's `<br>` carries no marker**, and a paragraph ending in an empty
  line has one extra placeholder `<br>`. The composer's offset map counts
  every `<br>` except that trailing placeholder.
- **A white letter under a blue block reads as a stray caret** on thin
  glyphs such as "l". The cursor letter takes the page background instead,
  as a terminal block cursor reverses the cell.
- **The file tree's flash did not open in a headless browser**, with Vim mode
  on or off; the tree receives `s` unprevented. Not investigated further; the
  tree's flash styling was checked by setting its flash state by hand.
- A soft line break inside a Markdown paragraph is a `\n` in its text node, so
  it splits one rendered line into two buffer lines.
- `u` in the composer undoes within one normal-mode session only.
- **`resolveKeyScope` returned early for the composer without reading the
  focused pane**, so the pane remembered for a later blur stayed stale. A
  thread opens with the terminal drawer focused; after a click into the
  composer and `Esc Esc`, focus was on `<body>` with the terminal remembered,
  every key passed through, and ChatView's type-to-focus typed `Space w l`
  into the composer. The resolver now reads the focused pane first, on every
  call (`focusScope.ts`).
- **`Ctrl+K` from the terminal lands in the composer in insert mode**: ADR-004
  enters the chat pane at the composer. Resizing from the terminal is
  therefore `Ctrl+K`, `Esc`, `<leader>w`. In Vim mode, entering the chat pane
  should land in normal mode (decision 1).
- **The sidebar rail stays a `button`**, not a `separator`: it also toggles
  the sidebar when collapsed. It gains a tab stop and arrow keys only while it
  can resize, and no `aria-valuenow`, because the rail does not hold the
  width in state.

## Not built in the prototype

The sidebar list primitive (the cursor apart from the open thread, `Ctrl+D/U`
scroll without opening, visible-row numbering), the project filter's Tab to
"All projects", right-panel scopes, the `keymap.json` user config, the
extraction of `fm-core/src/keys`, citing user messages, search (`/`), and
a remembered cursor per thread (the cursor survives only while the same thread
stays open).

## Merge cost

New files: `packages/keys/`, `apps/web/src/keys/`. Seams in upstream files
(commits on `upstream/main` in the three months to 2026-10-07):

- `ChatComposer.tsx` (134): the adapter registration and the Vim cite branch.
- `AssistantSelectionToolbar.tsx` (2): a shared capture helper and the cite
  request subscription.
- `assistantTextSelection.ts` (1): two exports.
- `_chat.tsx` (11), `main.tsx` (10): mounting and installing.
- `settings.ts` (101), `SettingsPanels.tsx`, `settingsSearch.ts`: the setting.
- `MessagesTimeline.tsx` (152): one subscription in `TimelineMinimap` for
  `[u` / `]u`.

Pane resizing (commits in the three months to 2026-10-08):

- `ui/sidebar.tsx` (23): the rail's width code is split into
  `findSidebarElements`, `acceptSidebarWidth` and `commitSidebarWidth`,
  shared by the drag and the keyboard, plus the rail's `usePaneEdge` call and
  an `onResetWidth` option. The largest seam: it moves upstream lines.
- `ThreadTerminalDrawer.tsx` (28): `resizeDrawerTo`, the `usePaneEdge` call,
  and the separator props on its two handle elements.
- `PreviewPanelShell.tsx` (9), `RightPanelResizeHandle.tsx` (0),
  `useResizableWidth.ts` (3): `resizeTo` and `reset` from the hook, the edge
  registration, the handle's focus.
- `AppSidebarLayout.tsx` (35): one line, `onResetWidth`.

`ChatView.tsx` (276) is not edited: the engine pre-empts type-to-focus from
its own listener, and the chat buffer reads the timeline's existing data
attributes.
