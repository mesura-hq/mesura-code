# Pane focus

Four regions of the web client can hold the keyboard, and exactly one of them
does at any moment. This document describes how the app knows which, how the
four pane chords move between them, and which of the rules here are
load-bearing rather than incidental.

The decision history — what was considered, what was rejected and why — is in
`docs/mesura/adr-004-pane-focus.md`. This document describes what is there
now.

## The four regions

| Pane     | Root attribute                      | Rendered by                |
| -------- | ----------------------------------- | -------------------------- |
| sidebar  | `[data-app-sidebar]`                | `AppSidebarLayout.tsx`     |
| chat     | `[data-chat-column-maximized-away]` | `ChatView.tsx`             |
| panel    | `[data-preview-panel-mode]`         | `PreviewPanelShell.tsx`    |
| terminal | `[data-terminal-owner="drawer"]`    | `ThreadTerminalDrawer.tsx` |

All four attributes are upstream's and were already rendered; no component
gained one for this. If upstream renames any of them, that pane stops being
reachable and nothing else breaks.

`PANE_ORDER` in `apps/web/src/lib/paneFocus.ts` is the horizontal order:
sidebar, chat, panel. The terminal is absent from it deliberately — it is the
chat column's vertical neighbour, never a column of its own, so a horizontal
step from inside it starts at the chat.

## Focus is derived, never stored

`paneFocus.ts` answers three questions and holds no state that could be wrong:

- **Which pane has the keyboard.** `document.activeElement`, then `closest()`
  against each root. `document.activeElement` is already the truth about where
  a keystroke will be delivered, so a stored copy could only ever disagree
  with it. `terminalFocus.ts` and `previewFocus.ts` answer the same question
  for one surface each and established the pattern.
- **Whether a pane can be reached.** A pane that is rendered but collapsed,
  maximized away, or showing as a sheet cannot hold the keyboard, and focusing
  it would drop the keyboard with no way back except the mouse.
- **How to enter a pane.** The element that owns the pane's key handling.
  Focusing a wrapper instead would satisfy `:focus-within` and then swallow
  every keystroke, which looks identical to the feature not working.

The one piece of state is `lastFocusedPane`, and it exists because blurring to
`<body>` is ordinary — leaving Neovim's normal mode does it — and a chord
typed in that state still has to mean something. It is never persisted: a pane
is a view position, not an identity.

The roots are walked most-contained first, because the drawer is rendered
inside the chat column. A walk that tested the chat first would report `chat`
for a focused terminal and send its keys to the wrong place.

## The chords, and how they are routed

`usePaneNavigation.ts` claims `keydown` on the window **in the capture phase**
and consumes the horizontal chords before any pane sees them. That is the
whole arbitration: the chord has one meaning wherever it is typed, including
inside the embedded Neovim editor and inside a terminal. `stopImmediatePropagation`
is what makes listener registration order irrelevant, which matters because
several components attach their own window handlers and their order depends on
mount order.

Neovim's own window commands stay reachable as `<C-w>h` and `<C-w>l`, because
a prefix chord is never captured here.

Movement is directional, never wrapping, and silent at the edge. `Ctrl+L` from
the rightmost pane does nothing rather than jumping to the leftmost: a chord
whose effect depends on invisible state is worse than one that does nothing.
A closed or collapsed pane is stepped over, not stopped at.

### The vertical chords disable themselves, and that is the mechanism

`Ctrl+J` and `Ctrl+K` each share a key with something else, `mod+j` with
`terminal.toggle` by design. The pane handler consumes one of them **only when
there is a neighbour to move into**, and declining leaves the event untouched
so the other owner runs. That is how `Ctrl+J` opens the drawer when none is
open and enters it when one is.

The vertical path deliberately does not resolve against the whole keybinding
table. `mod+j` answers `terminal.toggle` under last-wins, so asking would
always decline and the chord would never work at all. It matches the pane
binding itself instead. The horizontal path is the opposite case and does
resolve the whole table, because the application owns those chords in every
pane and another binding on the same chord may outrank the pane one.

## The keyboard is never left in a pane nobody can see

Two different things break that invariant and they look nothing alike:

- **The pane unmounts.** Closing the right panel removes its subtree, focus
  falls to the document body, and a `focusout` fires.
- **The pane stays but goes away.** Collapsing the sidebar keeps every row
  mounted, focusable and in the tab order, and slides the container
  off-screen. No blur happens and no `focusout` fires at all.

So the guard is keyed on the invariant rather than on either event: after
anything that could change the layout, if the pane holding focus is no longer
reachable, the keyboard moves somewhere it can be seen. A `MutationObserver`
watching three layout attributes is the second trigger, coalesced to one check
per frame.

**A pane that merely blurred is left alone.** Leaving Neovim's normal mode
blurs the editor to the body on purpose, and a rescue there would yank the
keyboard out of the pane the developer is working in.

## The sidebar's list chords

`j` and `k` walk the thread list, `Ctrl+D` and `Ctrl+U` step five. They are the
only bare letters the app binds, which costs two things.

They carry `!sidebarSearchFocus` so they type rather than jump in the
sidebar's text entries. That context key is true for any `input`, `textarea`
or contenteditable inside the sidebar, not for one named box: the sidebar
renders a thread search and a project filter, and a rule keyed to either would
silently stop guarding the other.

And a common letter now reaches a `when` clause, so it reads the focus tree:
1.699 microseconds per read measured against the real tree, twice per
keystroke. Autorepeat is filtered first, so holding a key costs nothing.

A list chord also leaves the keyboard in the list. Opening a thread makes
`ChatView` focus the composer on every change of the active thread, which is
right when you clicked the row and wrong when you walked to it. The claim in
`usePaneNavigation.ts` puts the keyboard back rather than stopping the
composer taking it, because the mouse path wants that focus and the two are
indistinguishable at the moment the composer asks.

## The mark

The pane holding the keyboard is marked in one of two shapes, chosen by
whether it has a header row to light. The chat column and the right panel
light their header — the title goes to full foreground and a hairline appears
under the row. The sidebar and the terminal drawer take a rounded frame inset
inside the pane.

It is CSS alone, in `apps/web/src/mesura.css`, keyed on `:focus-within`, and
every rule changes colour only. Nothing about the mark reaches React and
nothing about it reaches the layout path.

## Traps

Each of these was got wrong once, in the direction named.

- **The drawer is inside the chat column.** Any rule about the chat that does
  not exclude a focused drawer will fire for both. This applies to the focus
  read, to the mark, and to anything added later.
- **`data-app-sidebar` is not where `data-state` is.** The attribute sits on
  the inner container; the collapsed state is on its `[data-slot="sidebar"]`
  parent, and the container keeps its full width when collapsed. Neither the
  container's own dataset nor its width can answer whether the sidebar is
  reachable.
- **A thread row is not a `[data-sidebar="menu-button"]`.** Those are the six
  icon buttons in the sidebar's top and bottom bars, all of them
  `data-active="false"`. A thread row is a `role="button"` inside an
  `<li data-thread-item data-thread-key>`, and the route registers the open
  thread's row as the way in.
- **Never ask `findEffectiveShortcutForCommand` about a `pane.*` command.** It
  reports the binding that wins ignoring context, and the pane chords are
  arbitrated by the capture handler rather than by that resolution.
- **`Ctrl+U` and `Ctrl+D` do reach the page.** Chromium delivers both, and the
  handlers call `preventDefault()`, so `Ctrl+D` does not open the browser's
  bookmark dialog. An earlier assumption that browsers swallow them was wrong.
- **The insert-mode conformance test is not the latency instrument.** It is
  gated on `MESURA_NVIM_CONFIG_DIR` and it times the server round trip. Client
  key-path cost has to be measured on the client.
