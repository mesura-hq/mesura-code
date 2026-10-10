# ADR-009 — A modal key layer: Vim modes, a Space leader, the chat as a buffer

**Status:** Accepted, 2026-10-08. The production cycle (#86) hardened the
prototype on `t3code/design-vim-keyboard-navigation`: a command registry
replaced the chord replay, Vim mode is on by default, and the six prototype
bugs are fixed. Round 2 (2026-10-10) hardened the second prototype the same way:
cite by two flash picks, the sidebar keys, the panel launcher as the right
panel's one menu, `Ctrl+Tab` and `Ctrl+Q` in the panel, and one focus per
panel surface. `tests/unit/modal-keys-wired.test.ts` guards every seam of both
rounds in an upstream file.

**Scope:** how the web client (and the Linux desktop app, which wraps it) reads
keys: modes, sequences, which-key, the chat timeline as a navigable buffer, Vim
editing in the composer, cite by keyboard, flash jumps, keyboard pane
resizing, the sidebar's list keys and the right panel's tabs, launcher and
focus. The phone is out of scope: it has no keyboard, and the layer is
inert on touch screens. The user guide is `docs/user/vim-mode.md`.

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
4. Cite drops the comment popover: a cite lands inline as `<chip>: ` and the
   comment is ordinary prompt text. Every cite then puts the keys in the
   composer in insert mode, so the comment is typed straight away. `<leader>c`
   cites without a selection in chat normal mode (two flash picks, see
   "Cite"), and cites the selection in visual mode. Citing user messages is
   secondary.
5. Vim editing inside the composer: yes.
6. Architecture over merge cost: more upstream conflict is accepted for the
   sound design.
7. Modifier chords are removed once the modal layer is good. Then `AGENTS.md`
   gains a "keyboard first" principle (#83).
8. `Ctrl+1..9` numbers the sidebar rows that are visible, not the first nine
   (#79).
9. The key engine is extracted from Symmetria's `fm-core/src/keys` into a
   shared package (#82).
10. Prototype first: real code, behind a setting.
11. Panes resize from the keyboard: a sticky PANE mode on `<leader>w`, keys
    that move a border in their own direction, a step of 5% of the viewport,
    and keyboard-operable separators over replayed pointer drags. Resize
    only: moving or reordering panes is not wanted.

Decisions of the production cycle:

12. Harden the committed prototype, do not rebuild it. The front end stays
    one-to-one with the prototype's look; the widened cursor on a narrow
    glyph is the one agreed visual change.
13. Vim mode is on by default. A stored `false` stays off.
14. The command registry replaces the chord replay in this cycle, not later.
    Only the key engine calls it; the chord listeners and the palette keep
    their own dispatch until #87.
15. All six prototype bugs are fixed in this cycle. Everything else the
    prototype did not build is deferred, each item to its own issue (see
    "Not built").
16. The right panel has one menu: its launcher ("Open a surface"). It is the
    empty panel, it opens over the tabs from `<leader>p`, `mod+t` in the
    panel and the tab bar's `+`, and it carries the panel actions as well as
    the surfaces, each on one letter. Which-key does not list them. A row that
    cannot run shows its reason on the row and in a notice when its letter is
    pressed: no reason may need a hover (`lib/panelLauncher.ts`).
17. A surface is navigable the moment it shows, with no click first. Every
    keyboard way into the right panel (`Ctrl+L` and the other pane moves, a
    launcher letter, `Ctrl+Tab`, a close, a file opened from a tree) puts
    focus on the element that owns the active surface's keys, never on a
    toolbar button. There the arrows move and `Ctrl+D` / `Ctrl+U` move half
    a page. The Browser and Device surfaces are the exception: their content
    is a native view or a remote screen with its own input, so focus stays on
    their tab title (see "Landing in normal mode"). A tree keeps its own
    keys, but `Space` stays the leader in it (`lib/panelSurfaceFocus.ts`).
18. Focus moves only by the app's keys, as in a native desktop app. A bare
    `Tab` or `Shift+Tab` that no element claims does nothing, and no focus
    outline or ring is drawn, with Vim mode on or off (`keys/nativeFocus.ts`,
    `mesura.css`). An element that owns `Tab` (a terminal, the composer's
    menus, the selection toolbar) keeps it. A confirmation's focused button
    keeps its mark, because `Enter` acts on it. Rejected: keeping the tab walk
    with a neutral outline, as round 2 built it; the developer reaches any
    control with a keyboard hint tool instead.

## Decision

### Three layers

1. **`packages/keys` (`@mesura/keys`)** — pure, no DOM, no React: key tokens
   (`keyToken.ts`), keymap tries per mode and scope (`keymap.ts`), the pending
   sequence machine (`sequence.ts`), flash label assignment (`flash.ts`).
2. **`apps/web/src/keys/`** — the host: one `keydown` listener on `window`,
   capture phase, installed in `main.tsx` before the router and React exist,
   so it runs before every other window listener (same target and phase run
   in registration order). Consumed keys are stopped with
   `stopImmediatePropagation`. `KeyEngineHost.tsx`, mounted in the chat route
   layout, turns the engine on while Vim mode is on and the chat layout is
   mounted, so Space on a Settings control presses it instead of starting a
   leader sequence.
3. **Surfaces** — `chat/chatSurface.ts` and `composer/composerSurface.ts`. Each
   owns its own Vim grammar and reports its mode.

### Modes and scopes

- Scope is read from the DOM on every key, never stored (ADR-004's rule):
  `focusScope.ts` returns `composer`, `insert` (any other text input),
  `passthrough`, `tree`, `sidebar`, `chat` or `panel`. It reads the focused
  pane first, on every call, before any early return (see "Traps").
- Passthrough is total: the terminal, the Neovim editor, any open dialog,
  menu or listbox, and the command palette keep their own keys.
- A tree (`role="tree"`: the file tree, a Pierre diff file list) is the
  `tree` scope: every key is the tree's except the leader and the sequence it
  starts, so the panel launcher opens from inside a tree.
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

### Landing in normal mode

Decision 1 holds on every way into the chat, not only on thread open:

- **Pane entry.** While Vim mode is on, `KeyEngineHost` registers the chat's
  pane entry through `registerPaneEntry` (`lib/paneFocus.ts`). `Ctrl+K` from
  the terminal and `Ctrl+L` from the sidebar land in the chat buffer in
  normal mode, with visual mode and pending keys cleared and the cursor kept.
  With Vim mode off, ADR-004's entry at the composer applies unchanged.
- **The right panel.** `RightPanelTabs` registers the panel's pane entry,
  `enterPanel` (`lib/panelSurfaceFocus.ts`). Every surface marks the element
  that owns its keys with `data-pane-entry`, ranked when it shows two (the
  editor or a preview, 2, over its file tree, 1): files, Diff and its file
  list, Agents, the pull request list, a pull request's detail and its Code
  tab, a Software Factory run, and an attachment's preview. A surface's empty
  state is an entry too, so an empty Agents or pull request list still takes
  the keyboard. A terminal tab takes focus in its input. Any other surface
  without an entry, the Browser and the Device today, leaves focus on its
  tab title, where no key reaches it.
  - An entry that is not focusable itself gets its first visible scroll
    region focused, so the browser's arrows scroll it. A region under
    `visibility: hidden` is skipped: a pull request keeps its other tabs
    mounted but hidden, and a hidden region takes no focus.
  - An entry whose rows live in a shadow root (Pierre's tree,
    `diffs/pierreTreeKeys.ts`) names its own focus.
  - A file preview (rendered Markdown, an image) registers its entry as the
    `editor` focus target while it shows (`previewFocusTargetRef`), so leaving
    the file tree lands in the preview as it lands in the editor for source.
  - The same rule runs when the active surface changes while the keyboard is
    in the panel. It waits for a lazy surface's entry to render, with the tab
    title holding focus meanwhile. Any `focusin` elsewhere ends the wait, so
    a key the developer pressed in the meantime is never overruled when the
    surface renders. A drop to `<body>` fires no `focusin` and keeps it.
  - The desktop browser tab is a native view drawn above the page.
    `PreviewPanel` hides it while the launcher is open
    (`usePanelLauncherOpen`), or it would cover the launcher.
- **The command palette.** The engine records the scope and the composer mode
  the palette opened from. On close, `restorePaletteOrigin()` (one fork check
  in the palette's `finalFocus`) returns to the chat in normal mode, or to
  the composer in normal mode at the same offset. Opened from composer insert
  mode or anywhere else, the palette's own focus target applies. The
  composer keeps a restored normal mode while focus arrives more than once on
  close; the engine ends that resume at the next key, so `Esc` then `i` still
  enters insert mode.

### Keymap rules

- **A key is a command or a prefix, never both** (Helix, Tridactyl, Vimium).
  The compiler reports a binding that breaks this. So a prefix never times out,
  which matches Symmetria's chord model. which-key opens after 200 ms and never
  cancels the prefix; Escape cancels, Backspace steps back.
- Group labels and per-binding labels live in the keymap
  (`defaultKeymap.ts`). Helix cannot label user groups, and Zed shows
  "+N keybinds"; both are worse.
- A deeper scope shadows an outer one.

### The command registry

A leader row names a keybinding command (`thread.pin`, `rightPanel.toggle`,
…). The engine runs it through `apps/web/src/commands/commandRegistry.ts`:

- Each owner of a command calls `useCommandHandlers` with the same function
  its chord branch already calls. Where the branch body was inline, it moved
  into one named local function that the branch and the block both call, so
  a leader key and a chord have one effect.
- The registry keeps a stack per command: the latest registration runs, and
  unmounting restores the previous one. Two owners can be mounted together
  (the chat route and the pull requests route both own the right panel); the
  inner one wins. An owner passes `undefined` for a command that does not
  apply in its current state.
- A leader key with no mounted owner shows "<command> is not available here".
- Commands that are the engine's own (`composer.insert`, `chat.cite`,
  `flash.jump`, `pane.resizeMode`, …) are not keybinding commands and run in
  `keyEngine.ts`.

Rejected: replaying the command's chord as a synthetic `keydown` so the
existing listener runs it. The prototype did that. It cannot run a command
that has no chord, it runs the wrong owner when a chord means two things, and
it fakes input to reach code the app already owns.
`tests/unit/modal-keys-command-registry.test.ts` keeps the replay out.

### The chat buffer

Rejected, with the reason:

- **The file editor's Neovim, read-only.** The predicted delay is 20.4 ms per
  key at the tailnet minimum (`docs/internals/editor-session.md`), one session
  per thread, and a second map between a plain-text buffer and the rich
  rendering.
- **The browser's `Selection.modify()`, the way Vimium and Surfingkeys do it.**
  Word movement differs between operating systems and engines. Firefox (Zen)
  lacks sentence, paragraph and document movement. No extension implements
  `iw` or `ip`, and none copes with a virtualized list.
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
  inside a row are dropped. One empty line separates rows, and that separator
  is a cursor position of its own, so `k` from a message's first line crosses
  into the previous message and `j` comes back.
- Whitespace reads as the browser renders it. A newline that the element's
  `white-space` collapses (`normal`, `nowrap`) reads as one space, one
  character for one, so a soft break does not split a rendered line;
  `pre` and `pre-wrap` still split. Collapsible whitespace at a line start is
  skipped; a no-break space is kept.
- The cursor is stored as `{ rowId, offset }` and the buffer is rebuilt on
  every key, because the list is virtualized. `gg` / `G` and the scroll keys
  scroll first, then place the cursor on the next frame.
- The cursor is remembered per thread, in memory only, for the 50 most recent
  threads, keyed from the router params in `KeyEngineHost`. A thread opened
  for the first time starts on the first visible line. On a return the
  remembered cursor is painted without scrolling. A key pressed while the
  remembered row is not rendered yet does not overwrite the remembered
  position.
- Motions run in **`@vimee/core` 0.3.0** (MIT, a pure
  `processKeystroke(key, ctx, buffer)` over a `TextBuffer`), read-only: a key
  that would enter insert mode is answered with an Escape.
- The cursor is a CSS highlight (`mesura-chat-cursor`). A visual selection is
  the native selection, so copy and the cite pipeline work on it unchanged.
  The letter under the cursor takes the page background, as a terminal block
  cursor reverses the cell; a white letter under the blue block read as a
  stray caret on thin glyphs.
- On a glyph narrower than half an em the cursor is an overlay instead
  (`blockCursor.ts`), because a highlight paints only its glyph's box and
  cannot set a width. The overlay is half an em wide, centred on the glyph,
  with the glyph redrawn inside in its own font and the highlight's colours.
  It is drawn inside the glyph's own container (the timeline row), placed
  from an `aria-hidden` out-of-flow anchor there, so the timeline clips it
  and the composer or a dialog covers it exactly where they clip and cover
  the glyph; inner clipping is a `clip-path`. Rejected: a fixed overlay above
  every layer, which showed through the composer and the palette. It is
  measured again on scroll, on a resize of its container (a pane resize
  reflows the text) and on composer layout changes, in the event, with no
  frame loop. A thread change clears it.
- The chat and the file editor share key meanings, not an implementation.

### Cite

Both ways to cite end in `citeRange` (`chat/chatSurface.ts`), which sets the
native selection and asks `AssistantSelectionToolbar` (one subscription,
`chat/chatCiteBus.ts`) to capture it and call its existing `onCite`:

- In chat visual mode, `<leader>c` cites the selection.
- In chat normal mode, `<leader>c` runs two flash picks (`startFlashPick` in
  `flashSession.ts`): every target is labelled up front, one or two
  characters each (`assignJumpLabels` in `@mesura/keys/flash`, after
  hop.nvim), with no search pattern. The first pick labels the first
  character of every sentence of assistant prose on screen, the second the
  last character of every sentence from there to the end of the same message.
  A cite never spans two messages, because a citation belongs to one.
  Sentences are split per buffer line by `sentenceSpans` (`chatBuffer.ts`).
  With no assistant text on screen, an empty thread included, `<leader>c`
  shows the notice "no assistant text on screen to cite" instead of doing
  nothing.

In Vim mode, `ChatComposer.citeAssistantText` appends `\n<chip>: ` at the end
of the prompt with no popover, and the composer takes focus with its caret
after the chip, which is insert mode. With Vim mode off, upstream's cite at
the caret with its comment popover applies.

Every cite flashes the cited text for 900 ms (`chat/citeFlash.ts`, one
opacity animation in `mesura.css`, removed when it ends), so the reader sees
what was cited after the keys or the eye leave it. There is one path:
`citeAndFlash` wraps `onCite` in `AssistantSelectionToolbar`, and both the
mouse's Cite button and the keys' cite requests go through it, so each cite
flashes once and looks the same. The flash is drawn from the
captured range, which outlives the native selection the toolbar clears.

Focus once stayed in the chat after a cite. That needed a WORKAROUND, because
the composer's editor takes focus whenever it moves its DOM selection, even
when asked not to. The developer chose the composer instead, which removed
the workaround and the fork's `focusEditor` option on `insertComposerText`.

### The composer

Insert mode is upstream's composer, untouched. Escape enters normal mode: the
prompt is projected with each inline token (mention, citation, skill, context
reference) as one private-use character, run through `@vimee/core`, and written
back through `applyPromptReplacement`. One character per token is the
composer's own collapsed-cursor model, and one code point per token keeps a
token's identity when an earlier one is deleted. A second Escape leaves for the
chat. Rejected: a Neovim-backed composer (tailnet latency, no token model),
and replacing Lexical with CodeMirror (a rewrite of the composer).

Undo is the composer's own, not vimee's (`composer/composerUndo.ts`; the
vimee buffer records no snapshots):

- A per-draft history of the prompt, in memory: an insert session is one
  step, each normal-mode change is one step. `u` and `Ctrl+R` walk it across
  sessions, with a count; a new change clears the redo steps. At most 200
  states per draft and 50 drafts.
- Each state stores where its change starts, so the cursor after `u` and
  `Ctrl+R` lands at the edit's leftmost offset, also for visual deletes,
  backward operators and repeated text. Tokens come back as the same tokens.
- The history resets in `clearComposerContent` (`composerDraftStore.ts`), the
  one action every send path consumes a draft through (the composer form, a
  preview annotation, a directed dictation). A failed send keeps the history,
  a restored draft gets it back, and a thread's history survives a return to
  that thread. The adapter's `draftKey` names the draft.

The composer in normal or visual mode wears a ring in the mode's colour on
its card (`[data-chat-composer-main-surface]`, anchored on the
`data-mesura-composer-vim` attribute; the fork's styling guard forbids
`:has()` there). A cursor with no character under it (an empty line, the end
of a line) is drawn as an element (`cursorOverlayStore.ts`), because a
highlight needs a character to paint; it keeps its own look
(`bg-sky-500/80`). A cursor on a narrow glyph is widened as in the chat,
drawn in the editor's host because Lexical owns the editable content; the
editor's scrolling clips it through a `clip-path`.

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
highlight cannot set `font-style`. The editor's colours follow the
colourscheme; the tokens do not, so a colourscheme change needs the tokens
changed by hand.

Not unified: the code. Four label algorithms exist (flash.nvim's, two in
Symmetria's `fm-core`, and `@mesura/keys/flash`), and they differ in
behaviour: two-character labels, whether the query's own letters are
excluded, cursor-distance order. The natural home for one implementation is
`fm-core/src/flash/labels.ts`, the most complete, as part of #82.

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
  upstream takes it, most of the pane-resizing merge cost goes away.
- **PANE mode** (`keys/paneMode.ts`), entered with `<leader>w`, moves a
  border with the same rule as the arrows: `h` left, `l` right, `k` up, `j`
  down. A count multiplies the step, `=` resets every edge (Neovim's
  `<C-w>=`). It is sticky (`l l l` without the leader again). `Esc`, `q` and
  Enter leave; any other key leaves and then runs as in normal mode, so
  `<leader>w l i` resizes and enters the composer.
- **The sidebar rail stays a `button`**, not a `separator`: it also toggles
  the sidebar when collapsed. It gains a tab stop and arrow keys only while
  it can resize, and no `aria-valuenow`, because the rail does not hold the
  width in state. Its keyboard reset runs the layout's `onResetWidth`, the
  same reset as the rail's double-click.

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

Rejected: replaying pointer events on the handles. It needs no upstream edit,
but it fakes input to reach state the code already owns, and it cannot read
the size it is about to change.

## Traps

Each of these cost a debugging round and still shapes the code. Read the
entry before changing the code it names.

- **Moving the composer caret in the same tick as a write reverts the write.**
  `focusAt` reports the editor's stale text as a change. The adapter's
  `write` places the caret itself, on the next frame, after the editor has
  the new prompt.
- **vimee does not report every edit** (`ciw`, a visual `d`) as a
  `content-change`. The composer compares text before and after instead.
- **Live-follow only learns about reading from wheel, touch and pointer
  events.** Upward cursor motion dispatches a synthetic wheel event (a marked
  WORKAROUND, `breakLiveFollow` in `chatSurface.ts`) so a streaming reply does
  not yank the view back.
- **Hit-testing a point to place the cursor misses** between blocks and in the
  centred column's gutter. Placement reads line boxes instead
  (`lineAtOrBelow`).
- **Screen-reader-only text is in the projection**: each message starts with
  an `sr-only` author heading ("You", "T3 Code"). The buffer drops lines made
  only of such text, or the cursor would land somewhere invisible.
- **Lexical's `<br>` carries no marker**, and a paragraph ending in an empty
  line has one extra placeholder `<br>`. The composer's offset map counts
  every `<br>` except that trailing placeholder.
- **`resolveKeyScope` must read the focused pane before any early return.**
  The prototype returned early for the composer, so the pane remembered for a
  later blur stayed stale: after `Esc Esc` from the composer, focus was on
  `<body>` with the terminal remembered, every key passed through, and
  type-to-focus typed `Space w l` into the composer. `focusScope.test.ts`
  pins the order.
- **The file tree's flash does not open in a headless browser**, with Vim
  mode on or off; the tree receives `s` unprevented. Not investigated; check
  the tree's flash styling by setting its flash state by hand.

## Not built

Each item has its own issue on `mesura-hq/mesura-code`, tracked by #86:

- #79: feat(keys): sidebar thread list as a keyboard list in Vim mode. Round
  2 built three parts in `lib/sidebarThreadViewport.ts`, over rows marked
  `data-mesura-thread-key` in `Sidebar.tsx`: `Ctrl+D/U` scroll the list
  without opening a thread, `Ctrl+1..9` number the rows on screen, and
  Up/Down move focus over the rows (the details tooltip, no open) while
  Enter opens. Still open: a Vim-mode cursor kept apart from the open
  thread. The legacy sidebar gets none of these.
- #80: feat(keys): keyboard scopes inside the right panel: each surface's own
  keys beyond moving and half-page moves (Diff modes, the file tree toggle,
  Markdown preview or edit), and `j`/`k` in Pierre's trees, where the arrows
  move today.
- #81: feat(keys): user keymap file for the modal key layer.
- #82: refactor(keys): extract the fm-core key engine and unify the flash
  label algorithms.
- #83: chore(keys): remove the modifier chords and add a keyboard-first
  principle.
- #84: feat(keys): cite your own messages and search the chat buffer (`/`).
- #85: feat(keys): maximize the right panel from PANE mode. Built as `Z` in
  the panel launcher instead (`<leader>p z`, `rightPanel.toggleMaximized`,
  registered by `ChatView`); PANE mode itself still has no key for it, and
  the command has no default chord.
- #87: refactor(keys): one command list for the palette, the chords and the
  modal keys — the chord listeners and the palette rows reading the registry.

Known limits of round 2, with no issue of their own:

- An image attachment cannot be opened in a panel tab from the UI, so the
  attachment preview's entry (`AttachmentFilePreview.tsx`) is reached only by
  its tests.
- A pull request's Code tab returns to Summary after `Ctrl+Tab` leaves the
  pull request and comes back, because upstream keeps the selected tab in
  component state (`PullRequestDetailPanel.tsx`), which resets when the
  surface mounts again. Focus lands in Summary's entry then.
- Other confirmations keep Cancel as their initial focus; only closing a
  terminal opens on Confirm (`initialFocus: "confirm"`).
- With no tab walk, a confirmation's other button is reached only by the
  pointer or a hint tool. `Escape` still cancels and `Enter` still answers
  the focused button.

## Merge cost

Fork-owned files carry no merge cost: `packages/keys/`, `apps/web/src/keys/`,
`apps/web/src/commands/`, `apps/web/src/lib/paneEdges.ts`, the fork's CSS and
hooks, and the `AppRoot.*.fence.test.tsx` and `-settingsVimMode.fence.test.tsx`
tests. `tests/unit/modal-keys-wired.test.ts` fails when a sync drops any seam
below.

Every upstream file the branch changes, measured with
`git diff --name-only 42575864a8 HEAD -- apps packages` against
`upstream/main` at `12069eefd7`. The number is the file's commits on
`upstream/main` in the three months to 2026-10-08.

Engine, setting and chat buffer:

- `main.tsx` (10): the `installKeyEngine()` and `installNativeFocus()` calls.
- `routes/_chat.tsx` (11): `<KeyEngineHost />` in `ChatRouteLayout`, and the
  registry block (below).
- `packages/contracts/src/settings.ts` (102): `vimMode` in
  `ClientSettingsSchema` and `ClientSettingsPatch`.
- `packages/contracts/src/settings.test.ts` (59): the default and the stored
  `false`.
- `SettingsPanels.tsx` (98): `VimModeRow` in the Typography section.
- `settingsSearch.ts` (80): the `vim-mode` search entry.
- `apps/web/package.json` (42): the `@mesura/keys` and `@vimee/core`
  dependencies.
- `AssistantSelectionToolbar.tsx` (2): the shared `captureCitation` helper and
  the cite request subscription.
- `MessagesTimeline.tsx` (159): one subscription in `TimelineMinimap` for
  `[u` / `]u`.
- `lib/assistantTextSelection.ts` (1): two exports, `readAssistantText` and
  `TextChunk`.

Composer:

- `ChatComposer.tsx` (139): the Vim adapter registration (with `draftKey`),
  the Vim cite branch, and the registry block
  with `canOpenAttachmentPicker` and `stashCurrentPromptWhenAllowed` lifted
  out of the chord handler.
- `composerDraftStore.ts` (28): one `clearComposerUndoHistory` call in
  `clearComposerContent`.

Command registry — one `useCommandHandlers` block per owner, and the chord
branch bodies lifted into named functions:

- `ChatView.tsx` (282): the block, plus `toggleActiveThreadSettlement`,
  `toggleActiveThreadPin` and `firstQueuedMessage`. The engine pre-empts
  type-to-focus from its own listener, and the chat buffer reads the
  timeline's existing data attributes, so this is the file's only seam.
- `Sidebar.tsx` (163): `adjacentThreadKey` and `openThreadByKey`.
- `CommandPalette.tsx` (65): the block, built from `OVERLAY_MODE_BY_COMMAND`,
  and the `restorePaletteOrigin()` check in `finalFocus`, beside
  `keepFocusInFileManager()`.
- `_chat.pull-requests.tsx` (59): the block, plus `copyPullRequestLink`.
- `LegacySidebar.tsx` (55): `adjacentThread`.
- `routes/_chat.tsx` (11): `startContextualNewThread`, `startNewThread` and
  `togglePreviewPanel`.
- `AppSidebarLayout.tsx` (35), `OpenInPicker.tsx` (12): the block only.

Pane resizing:

- `ui/sidebar.tsx` (23): the rail's width code is split into
  `findSidebarElements`, `acceptSidebarWidth` and `commitSidebarWidth`,
  shared by the drag and the keyboard, plus the rail's `usePaneEdge` call and
  an `onResetWidth` option. The largest seam: it moves upstream lines.
- `ThreadTerminalDrawer.tsx` (29): `resizeDrawerTo`, the `usePaneEdge` call,
  and the separator props on its two handle elements.
- `PreviewPanelShell.tsx` (9): the `usePaneEdge` call and the props handed to
  the handle.
- `RightPanelResizeHandle.tsx` (0): the `separatorProps` prop and the
  handle's focus style.
- `useResizableWidth.ts` (3): `resizeTo` and `reset` returned from the hook.
- `AppSidebarLayout.tsx` (35): `onResetWidth: resetSidebarWidth`.

Round 2 — every upstream file its own commits change (`git log
--first-parent --no-merges --name-only 30f47a5c45..HEAD -- apps packages`),
measured against `upstream/main` at `64972461c0`. The number is the file's
commits on `upstream/main` in the three months to 2026-10-10. A file that
round 1 already changed is listed again for what round 2 added.

Chat and cite:

- `ChatView.tsx` (285): `"rightPanel.toggleMaximized"` and
  `"rightPanel.newTab"` (which opens the panel, then `openPanelLauncher()`)
  in its registry block.
- `chat/ChatComposer.tsx` (142): the Vim cite branch lost the fork's
  `focusEditor` option, so a cite focuses the composer. Lines removed and
  one comment rewritten; nothing added.
- `chat/AssistantSelectionToolbar.tsx` (2): `citeAndFlash` around `onCite`,
  in the cite request subscription and in the Cite button.

Sidebar:

- `Sidebar.tsx` (164): `useViewportThreadKeys(showThreadJumpHints)` and the
  jump hints numbered from it, `useThreadRowArrowKeys()`, `scrollThreadList`
  in the page-key branch of the traversal handler, `readViewportThreadKeys()`
  for the number jump, `data-mesura-thread-key` on the slim and the card row,
  and the rows' `focus-visible` classes. The page-key branch stops the key
  and returns whether or not the list scrolled, and the jump hints'
  memo depends on `viewportThreadKeys`. The guard also pins upstream's row
  `onKeyDown`, which opens a thread on Enter and Space only: an arrow that
  opened a thread would undo `useThreadRowArrowKeys`.

Right panel — tabs, launcher, focus:

- `RightPanelTabs.tsx` (44): the largest round-2 seam in the panel.
  - `useRightPanelTabCycling` and `usePanelSurfaceKeys` in the tab bar.
  - The launcher: `openPanelLauncher` on the `+` in place of upstream's
    drop-down list and its disabled-reason tooltips (`addSurfaceActions`,
    `SurfaceMenuItem`, `DisabledReasonTooltip`, `SURFACE_DISABLED_REASONS`,
    deleted; the guard fails if a merge brings them back), the overlay under
    `launcherOpen` over a `relative` surface content, which takes the same
    props as the empty panel's launcher (the guard compares the two sets), `dismissPanelLauncher`
    on Escape, `data-key-passthrough` on the launcher so the key engine
    leaves its letters alone, and a refocus when an already mounted launcher
    opens again.
  - `runAction`, which every surface row goes through (a letter, Enter on
    the highlight, a click, a browser profile from the Browser row's
    chevron): it closes the launcher, runs the row, then
    `keepFocusInPanelAfterRender(panel)`.
  - The letter handler, registered with `registerLauncherKeyHandler` and as
    a capture-phase `keydown` listener on `window`: it skips a key the page
    already took, answers every row's letter (available rows through
    `runAction`, unavailable ones through `reportUnavailable`, Panel actions
    through `runPanelLauncherAction`), and unregisters both on unmount.
  - The Panel section (`panelLauncherActions`, handed to both launchers) and
    `UnavailableLauncherRow`, which shows a row's reason on the row.
- `preview/PreviewPanel.tsx` (3): `visible={visible && !launcherOpen}`, so
  the desktop browser view does not cover the launcher.
- `DiffPanel.tsx` (43): `data-pane-entry` on the code view's wrapper. One
  attribute; the file moves often, so a sync may meet it in a conflict.
- `diffs/DiffFileTree.tsx` (4): the `usePierreTreePaneEntry` call and the
  wrapper's `ref`, `data-pane-entry` and `onKeyDown`.
- `AgentsPanel.tsx` (7), `pullRequest/ThreadPullRequestsPanel.tsx` (9):
  `data-pane-entry` on the list and on the empty state, which also gains
  `tabIndex={-1}`.
- `pullRequest/PullRequestDetailPanel.tsx` (75),
  `pullRequest/PullRequestCodeTab.tsx` (34): one `data-pane-entry` each.
- `files/FilePreviewPanel.tsx` (41): `data-pane-entry` and
  `ref={previewFocusTargetRef}` on its two previews.
- `files/AttachmentFilePreview.tsx` (5): `data-pane-entry` on the Markdown
  and the image preview.

`Ctrl+Q` and the terminal close confirmation:

- `apps/desktop/src/window/DesktopWindow.ts` (21): `quitShortcutHandler`
  runs only off Linux.
- `apps/desktop/src/window/DesktopApplicationMenu.ts` (7): Linux gets its own
  Quit item with no accelerator in place of `role: "quit"`.
- `packages/contracts/src/keybindings.ts` (26): `rightPanel.nextTab`,
  `rightPanel.previousTab` and `rightPanel.newTab` in
  `STATIC_KEYBINDING_COMMANDS`.
- `packages/shared/src/keybindings.ts` (23): the `ctrl+q`, `ctrl+tab`,
  `ctrl+shift+tab` and `mod+t` defaults, and the
  `ADDED_KEYBINDING_DEFAULTS` ids `2026-10-terminal-close-ctrl-q` and
  `2026-10-right-panel-close-ctrl-q`.
- `packages/contracts/src/ipc.ts` (51): `initialFocus?: "confirm"` in
  `ConfirmDialogOptions`.
- `lib/terminalCloseConfirm.ts` (1), `confirmDialog.ts` (2),
  `ConfirmDialogHost.tsx` (5): the terminal close passes
  `initialFocus: "confirm"`, the store carries it as `focusConfirm` (both
  places that show a confirmation build the state with `confirmingState`),
  and the host hands the Confirm button's ref to the dialog's `initialFocus`.

Upstream tests round 2 extends (not guarded: a sync that drops a case loses
coverage, not a seam):

- `apps/web/src/keybindings.test.ts` (27): two cases, the panel's
  `ctrl+tab` / `ctrl+shift+tab` / `mod+t` resolution, and `ctrl+q`
  resolving to `rightPanel.close` and `terminal.close` with `mod+w` kept as
  the label.
- `apps/desktop/src/window/DesktopWindow.test.ts` (20): a per-platform test
  layer and two cases, `Ctrl+Q` left to the page on Linux and still taken
  by the quit guard on Windows.
- `apps/desktop/src/window/DesktopApplicationMenu.test.ts` (18): the Linux
  Quit item expected without an accelerator.
- `apps/web/src/confirmDialog.test.ts` (2): one case, a confirmation opens
  on Confirm only when the request asks for it.
- `apps/web/src/lib/terminalCloseConfirm.test.ts` (1): the expected options
  gain `initialFocus: "confirm"`.

User documentation (outside `apps` and `packages`, not guarded):

- `docs/user/keybindings.md` (33): the sentence linking `vim-mode.md`, and
  fork paragraphs on the sidebar keys, `Ctrl+Tab` and the launcher in the
  panel, the panel focus, `Ctrl+Q`, and the Linux desktop app's missing quit
  shortcut. Upstream lines edited: the "Desktop quit shortcut" section, the
  macOS-only window close in "Reserved shortcuts", and in "Edit the
  configuration file" the path (`~/.mesura-code/userdata`) and the product
  name; the fork's paragraphs on how new defaults reach the file moved
  there.
- `docs/user/keyboard-focus.md` (1): one sentence on where the palette
  returns focus in Vim mode.

The chat's pane entry is registered from `KeyEngineHost.tsx` through
`registerPaneEntry`, so `paneFocus.ts` and `usePaneNavigation.ts` gain no
seam. The heaviest churn is in `ChatView.tsx`, `Sidebar.tsx` and
`MessagesTimeline.tsx`. `MessagesTimeline.tsx` only adds lines; the other two
also move chord branch bodies into the lifted functions, which is where a sync
conflicts.
