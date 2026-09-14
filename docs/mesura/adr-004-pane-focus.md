# ADR-004 — One focused pane decides who gets the keyboard

**Status:** Accepted, 2026-09-14. Built and merged on `t3code/panel-focus-navigation`.
Written as the design for issue #50 (Editor surface: known limitations, and why
the pane model is the next step).

**Scope:** how the web client (and therefore the Linux desktop app, which wraps
it) models keyboard focus across the sidebar, the chat and the right panel, how
`Ctrl+H` / `Ctrl+J` / `Ctrl+K` / `Ctrl+L` move that focus, how a chord is routed
to exactly one surface, and how the focused pane is shown. Mobile is out of
scope: it shares no layout or keybinding code with web and has no keyboard.

## The problem, in one sentence

Today a chord has no addressee. `Ctrl+U` is claimed by the chat timeline
(`ChatView.tsx` capture-phase handler, `when: "!terminalFocus"`) and by Neovim
in the editor at the same time, and the chat wins by mount order even while the
caret is in the editor. Every future surface repeats the collision. Focus has
to decide.

## Decision

**Three panes, one focused, derived from the DOM focus tree, never stored.**

- The panes on the thread route are `sidebar` (thread list), `chat` (timeline,
  composer, and the terminal drawer below them) and `panel` (the right panel:
  editor, diff, terminal, preview, agents). Horizontal order is fixed:
  `sidebar → chat → panel`.
- "Which pane is focused" is not state. It is `document.activeElement` walked up
  to the nearest pane root, the same way `lib/terminalFocus.ts` and
  `lib/previewFocus.ts` already answer "is the terminal focused". One new
  fork-only module, `apps/web/src/lib/paneFocus.ts`, exposes
  `getFocusedPane()`, `isPaneReachable(pane)` and `focusPane(pane)`.
- The pane roots are the hooks upstream already renders: `[data-app-sidebar]`
  for the sidebar, `[data-preview-panel-mode]` for the panel, and the rest of
  `[data-slot="sidebar-inset"]` for the chat. No upstream element gains an
  attribute.
- One sticky `lastFocusedPane` survives a blur to `body` (the editor's Escape
  in normal mode does exactly that today), so a chord typed with nothing
  focused still moves from the pane the developer was last in.
- The keybinding `when` context gains three identifiers, `sidebarFocus`,
  `chatFocus` and `panelFocus`, filled in by `resolveContext` in
  `apps/web/src/keybindings.ts` from `getFocusedPane()`. Every existing caller
  gets them without being edited. An explicit context still overrides them, so
  existing tests keep passing.

**Directional, never wrapping, silent at the edge.** `Ctrl+L` from the panel
does nothing. `Ctrl+H` from the sidebar does nothing. A pane that is closed,
collapsed off-canvas, in sheet mode, or maximised away is skipped as if it were
not there. This is Symmetria IDE's rule verbatim, and the reason is the same:
a wrap-around makes the chord's effect depend on state the developer cannot see.

**The application owns the pane chords, in every pane.** `Ctrl+H` and `Ctrl+L`
are consumed by a window capture-phase listener before the chat, the editor or
the terminal see them. This follows Symmetria IDE's doctrine ("the IDE owns the
keybind layer: the chord has one meaning regardless of focus") and it matches
the developer's own Neovim configuration, where `<C-k>` is `TmuxNavigateUp`,
which is already "go to the pane in that direction". Inside Neovim, split
navigation stays reachable as `<C-w>h` / `<C-w>l`, because a prefix chord is
never captured.

**Everything else stays with the focused pane.** `Ctrl+U` / `Ctrl+D` become
`when: "chatFocus"` for the chat and reach Neovim when the editor is focused.
`Ctrl+P` keeps its status as the one application chord that outranks Neovim
from inside the editor; the pane chords join it only in the sense that they
never reach the editor at all.

## What the focused pane looks like

**Shipped: one mark, two shapes, chosen by whether the pane has a row to
light.** A pane with a header row lights the row — its title goes to full
foreground and a one-pixel hairline appears under it. A pane with no title to
light takes a one-pixel rounded frame drawn 5 px inside its bounds. The chat
column and the right panel take the first shape; the sidebar, whose top row is
a logo and a search box, and the terminal drawer, whose top row is four icons,
take the second.

Why two shapes rather than one. The header treatment was chosen first from the
replica mockups and then dropped, because it depends on every pane having a
header row and two do not. The inset frame that replaced it marks all four the
same way, and the developer, seeing both on the real UI, asked for the header
back. Both readings were right about different panes: the frame is the weaker
mark where a title exists to light, and the header is no mark at all where one
does not. Carrying both costs one extra rule and settles the objection each
raised against the other.

Rejected on the replica, so they are not proposed again: a left-edge bar
(Symmetria's own, read as a second border next to the panel's existing one),
an accent bar (over-signals, as Symmetria recorded), a top bar, surface lift,
corner ticks, an edge glow, and dimming the others. Tried on the real UI and
not pursued: brightened separators (did not render through the injected hooks,
and needs the reader to compare edges), chrome-only fading of unfocused panes
(fragile selectors, invisible on the terminal), and a soft inner glow
(invisible at a usable alpha).

The dot field is rejected outright rather than deferred. A static grid after
React Bits' `DotField`, confined to the header row with no surface tint, was
built to the developer's steer and then withdrawn by them on sight. It is
recorded here because the reason generalises: the mark is a hint about where
the keys are going, and any treatment with a texture of its own competes with
the content for the same attention. An animated version was never on the table
— it would repaint continuously and peg the GPU on a high-refresh display.

- Rendered in `apps/web/src/mesura.css`, keyed on `:focus-within`. The
  browser's own focus tree drives all of it: no React state, no re-render, no
  listener.
- The chat column hands its mark to the terminal drawer whenever focus is
  inside the drawer, because the drawer is rendered inside the column and a
  rule without that clause lights both at once.
- The pane roots are upstream's existing hooks: `[data-app-sidebar]`,
  `[data-chat-column-maximized-away]`, `[data-terminal-owner="drawer"]` and
  `[data-preview-panel-mode]`. The two header rows are `[data-chat-header]`
  and `[data-right-panel-tabbar]`. Each rule names its hook and what happens
  if upstream renames it, per `docs/mesura/styling.md`.
- Neither header carries a bottom border to recolour — both are
  `border-bottom-width: 0` — so the hairline is painted by an `::after` that
  is always present at a fixed size. That is also what keeps the transition
  off the layout path.
- The tint is neutral, not the accent, and it is one token for both themes:
  `color-mix(in srgb, var(--contrast-foreground) 35%, transparent)` for the
  hairlines and 20% for the frames. Symmetria IDE measured the accent
  question and recorded why a full-saturation accent reads as "important" and
  over-signals a hint.
- Only `color`, `background-color` and `border-color` change, over 150 ms.
  Never width, never `display`: a geometry flip costs a layout pass and reads
  as jank during a focus move. This is the one contract Symmetria's
  `FocusBar.qml` documents as load-bearing.
- The whole of the right panel's active tab recedes, icon and pending dot
  included, where the chat header dims only its title. A tab is one atom, and
  an icon at full brightness beside a greyed label reads as a rendering fault.
  The dot recedes to the colour every inactive tab's dot already has, so no
  signal is lost.
- Known edge: the frame sits over the pane's content margin, and the terminal
  drawer's prompt starts within 5 px of its left edge, so the frame's left
  line touches the first character there. The fix belongs to the drawer's
  padding, not to the frame.
- Refinement to try later: `:has(:focus-visible)` instead of `:focus-within`,
  so a pane entered with the mouse shows no mark until a key is pressed.

## Vertical navigation, and the collision it carries

`Ctrl+J` / `Ctrl+K` have vertical neighbours in exactly one column today: the
chat column, where the terminal drawer sits below the timeline. The sidebar and
the panel are single panes vertically.

Symmetria IDE's answer, ported: **a global chord that disables itself is the
forwarding mechanism.** The listener consumes `Ctrl+J` / `Ctrl+K` only when
the focused column has a neighbour in that direction; otherwise it does not call
`preventDefault`, and the event falls through to whatever owns it today.

Two chords already own those keys, and the fallthrough decides what they mean:

- `Ctrl+J` is `terminal.toggle`. With the drawer closed the chord opens it;
  with it open and the chat focused, the chord moves into it. Both read as
  "go down into the terminal". Good.
- `Ctrl+K` is `commandPalette.toggle` outside the terminal. Left there, the
  chord would mean "up to the chat" from the drawer and "palette" from the
  chat: two meanings, which breaks Symmetria's doctrine.

**Decided, 2026-09-14: `Ctrl+K` and `Ctrl+L` are freed for pane navigation.**
The developer chose to keep one meaning per chord. The displaced defaults move
through `RETIRED_KEYBINDING_DEFAULTS` plus `ADDED_KEYBINDING_DEFAULTS`, which
is additive and reaches a config that already materialised the old rows:

| chord         | today                             | after                                         |
| ------------- | --------------------------------- | --------------------------------------------- |
| `mod+k`       | `commandPalette.toggle`           | `pane.focusUp`                                |
| `mod+o`       | `editor.openFavorite` (upstream)  | `commandPalette.toggle`                       |
| `alt+o`       | free                              | `editor.openFavorite`                         |
| `mod+l`       | `preview.focusUrl` (previewFocus) | `pane.focusRight`                             |
| `mod+shift+l` | free                              | `preview.focusUrl` (previewFocus)             |
| `mod+j`       | `terminal.toggle`                 | `pane.focusDown`, falls through to the toggle |

`editor.openFavorite` went to `alt+o` rather than the `mod+shift+o` this
table first named. That key already carries a second `chat.new` default, and
an unconditional rule on it would have shadowed `chat.new` outright under
last-wins. `alt+o` also joins the `alt`+letter family the other pickers use.

`Ctrl+L` also displaces the terminal's hardcoded clear-screen
(`isTerminalClearShortcut`). Symmetria accepted that loss knowingly; `clear`
still works. `Ctrl+K` inside the terminal stops being readline's kill-line for
the same reason.

## Where focus lands when it enters a pane

Symmetria's costliest lesson: focus must land on the element that owns the key
handlers, not on a wrapper. A pane root with `tabIndex=-1` receives focus and
then eats nothing.

`focusPane(pane)` therefore resolves an entry element per pane:

| pane     | entry element                                                                       |
| -------- | ----------------------------------------------------------------------------------- |
| sidebar  | the open thread's row, registered by the route; else the first thread row           |
| chat     | the composer, a `contenteditable`; a `textarea` only on surfaces that still use one |
| panel    | a registered entry when the surface has one, else its first focusable descendant    |
| terminal | xterm's helper textarea, which is what actually receives terminal keys              |

Two things in this table were got wrong first and are recorded because the
mistakes are instructive.

**The sidebar's entry was `[data-sidebar="menu-button"][data-active="true"]`,
and that is not a thread row.** Those are the six icon buttons in the
sidebar's top and bottom bars, every one of them `data-active="false"`, so the
selector matched nothing and `Ctrl+H` landed the keyboard on the collapse
toggle. Which row is the open one is a question `paneFocus.ts` cannot answer
on its own, so the route registers it by the `data-thread-key` the list
already renders. The lesson is the general one: a selector written from the
component's props rather than from the rendered DOM is a guess.

**The chat's entry was described as a textarea.** The composer is a
`contenteditable` div; the textarea is the fallback for surfaces that still
use one.

The registry is a `Map<PaneId, () => boolean>` in `paneFocus.ts`. The boolean
is load-bearing: a registered entry that returns `false` falls through to the
selector list rather than stranding the keyboard, which is what happens when
a virtualised row is not rendered. It is one of two mutable things in the
module; the other is `lastFocusedPane`.

**Not built: a registered entry for the editor.** An earlier draft of this
section said the editor would register Monaco's `editor.focus()`. Nothing
does. `Ctrl+H` and `Ctrl+L` into a panel showing the editor fall through to
the panel's generic focusable list, which lands on whatever comes first.
Worth doing, and cheap when it is: the surface is fork-owned, so the
registration costs no upstream line.

## Focus must never fall into a hole

Every case Symmetria hit is present here:

- **Sidebar collapses while focused** (`Ctrl+B`): focus goes to the chat entry.
- **Panel closes or the thread changes while the panel is focused**: focus goes
  to the chat entry. `ChatView` already refocuses the composer when the
  terminal closes, so the composer is the established fallback.
- **Panel maximised**: the chat is unreachable; `Ctrl+H` from the panel is a
  no-op, and the sidebar stays reachable when open.
- **Editor's Escape in normal mode** blurs to `body`. The sticky
  `lastFocusedPane` keeps `Ctrl+H` / `Ctrl+L` meaningful from there; a later
  change may move that Escape to the chat entry instead, but that is the
  editor's decision, not this one.
- **A pane becomes unreachable while it is the target**: `isPaneReachable`
  is evaluated at chord time, never cached.

What this section got wrong, found by driving the app rather than by
reasoning: it assumed each of those cases announces itself with a blur. Two do
not. Collapsing the sidebar keeps every row mounted, focusable and holding the
keyboard, and only slides the container off-screen — no `focusout` fires at
all, so a guard keyed on blur never runs and the keyboard is left in a pane
nobody can see.

So the guard is keyed on the invariant rather than on either event: after
anything that could change the layout, if the pane holding focus is no longer
reachable, move the keyboard somewhere it can be seen. A `MutationObserver`
over three layout attributes is the second trigger, coalesced to one check per
frame. A pane that merely blurred is still left alone, which is what keeps the
editor's Escape working.

## Sidebar navigation, and what it cost

`j` and `k` walk the thread list once the sidebar is focused, and `Ctrl+D` and
`Ctrl+U` step five, clamped at both ends. It shipped as its own change after
the focus model existed, which is what made it cheap: all four go through the
traversal `Ctrl+Tab` already used, so the sidebar component did not change at
all.

Two things had to be paid for, and both were worth naming here because they
are the price of bare letters rather than of the list.

The first is the search box. `sidebarFocus` alone would make the thread search
unusable for any query holding a `j`, so both letters carry
`!sidebarSearchFocus` — true for any text entry in the sidebar rather than for
one named box, because the sidebar renders two and upstream may add a third.

The second is that a common letter now reads the focus tree on every press.
Measured against the real tree, 1.699 microseconds per read over 200,000
reads, twice per keystroke, against the editor's 16.7 ms insert-mode budget.
Autorepeat is filtered before the read, so holding a key costs nothing.

One defect was found only by driving the app. Opening a thread makes ChatView
focus the composer on every change of the active thread, so `j` worked exactly
once and the next one typed a letter into the draft. The keyboard is put back
rather than the composer stopped from taking it: the mouse path wants that
focus, and the two are indistinguishable at the moment the composer asks.

## What this costs at the next merge, measured

Upstream commits in the last three months per file, from `git log --since="3
months ago" upstream/main -- <path>`:

| file                                    | churn | lines this design adds            |
| --------------------------------------- | ----- | --------------------------------- |
| `packages/contracts/src/keybindings.ts` | 12    | four command ids                  |
| `packages/shared/src/keybindings.ts`    | 10    | four defaults, two retire entries |
| `apps/web/src/routes/_chat.tsx`         | 9     | one hook call                     |
| `apps/web/src/keybindings.ts`           | 6     | three context defaults            |
| `apps/web/src/components/ChatView.tsx`  | 181   | **zero**                          |
| `apps/web/src/components/Sidebar.tsx`   | 93    | **zero**                          |

The two hot files are untouched because the pane roots reuse attributes upstream
already renders and the context is filled in centrally. Everything else is new
fork-only files: `lib/paneFocus.ts`, `lib/usePaneNavigation.ts`, their tests,
the CSS in `mesura.css`, and the docs.

The cheaper alternative, reading `getFocusedPane()` inside each existing keydown
handler, would touch `ChatView.tsx` and `Sidebar.tsx` and be worse: it would
also spread the pane vocabulary across four handlers. The central default is
both the better design and the cheaper one, so the merge cost decides nothing
here.

## Relationship to Symmetria IDE

Ported: derive focus from the real focus tree; directional and silent at the
edge; the application owns the pane chords; a self-disabling global chord is
how a key falls through; a `reachable` gate on every target; move focus before
the focused element goes away; one-pixel left-edge bar, colour-only, neutral
tint, 150 ms.

Not ported: Symmetria's central surface has no indicator at all, because its
side panels are the only things that ever hold focus beside it. Here the chat
is one of three peers, so it gets the same bar. Symmetria also keeps a sticky
sub-pane index for its two sidebar trees; Mesura Code's sidebar is one pane and
needs none.

## What was built, and what was verified

Seven phases on `t3code/panel-focus-navigation`, each its own commit:

1. `paneFocus.ts` — read the focused pane from the DOM focus tree.
2. The three pane `when` identifiers, and `Ctrl+U` / `Ctrl+D` scoped to
   `chatFocus`.
3. `Ctrl+H` / `Ctrl+L`, the capture-phase hook, and the focus-hole guard.
4. `Ctrl+J` / `Ctrl+K` on the chat ↔ drawer axis, with the chord moves.
5. The mark.
6. The sidebar's list chords.
7. This document and the rest of the docs.

Verification, and where each claim comes from:

- Unit tests on `paneFocus.ts` and the `when` evaluation, against a hand-built
  focus tree. This workspace installs no jsdom, so the fixtures are plain
  objects assigned to `globalThis.document`, which is the pattern
  `terminalFocus.test.ts` established.
- Every pane behaviour was driven in the running app by an independent
  witness, not only asserted in tests. Three defects were found that way and
  none of them was reachable from any test written before: focus stranded in a
  collapsed sidebar, `Ctrl+J` answered by the pane command and so never
  reaching the terminal toggle, and the sidebar list walking exactly once.
- The keystroke cost was measured rather than argued: 0.176 microseconds for
  the capture handler's gate over 200,000 calls, and 1.699 microseconds for
  one focus read. `conformance/insertModeLatency.test.ts` was not the
  instrument — it is gated on `MESURA_NVIM_CONFIG_DIR` and it times the server
  round trip, not the client key path.
- `Ctrl+U` and `Ctrl+D` do reach the page, which corrects an assumption made
  while planning. Chromium delivers both, and the sidebar's handler calls
  `preventDefault()`, so `Ctrl+D` pages the thread list rather than opening
  the browser's bookmark dialog. Measured in the running web app: from index 9
  of a fourteen-row list to index 13, a step of five clamped to the last row.
