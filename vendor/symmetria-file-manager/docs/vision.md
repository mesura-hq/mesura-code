# Vision — Symmetria File Manager

> The beauty in functionality and the functionality of beauty.

This document states what the file manager is for and what it refuses to be. It
is the place to settle arguments about direction. It is not a plan; the plan lives
in `docs/electron-transition/`.

Written 2026-08-24, at the point where the project decided to leave Qt for
Electron.

---

## What it is

**A keyboard-first file manager for one person who lives in the terminal, in
NeoVim, and in an agent harness.** It is a daily-driver tool, used all day, on its
own — not a feature of a larger application.

It is also, deliberately, **a component**. Mesura Code embeds it so that the
ecosystem has exactly one file system: one tree, one preview router, one search,
one set of keybindings. When an editor is brought into Mesura Code later, it will
follow the same shape — an independently useful tool that a larger application
consumes.

That dual nature is the central design constraint. Everything below follows from
it.

---

## Principles

### 1. Standalone first, embedded second

The file manager must be fully useful with Mesura Code closed. Mesura Code is
large; the file manager is not. Requiring the big application to browse a
directory would defeat the point.

**Consequence:** the file manager keeps its own repository and its own release
cycle. The versioning cost between repositories is accepted deliberately, as the
price of an honest boundary.

### 2. The host owns policy, the panel owns behaviour

The Qt version arrived at the right seam and it survives the rewrite: the tree
knows nothing about git. It receives a status provider, an ignored-path set and a
path filter, each of which may be absent. Absent is always safe.

**Consequence:** no capability is duplicated between the file manager and its
host. Mesura Code injects its own git; the standalone injects its own. One tree,
two policies.

### 3. Do not do work the user did not ask for

This is the principle behind removing auto-expansion. Mounting a tree that opens
hundreds of directories to guess what the user wants is expensive, slow on real
repositories, and — the honest objection — **lazy design**. It substitutes bulk
for thought.

The same rule kills a class of features before they are written: no recursive
pre-scanning, no speculative thumbnailing of a whole directory, no indexing a home
directory nobody searched.

**Corollary:** when a bulk operation is genuinely wanted, it is explicit, bounded,
and shows its progress.

### 4. One window

Not many. Tabs carry the navigation.

This is a discipline as much as an optimisation. A tool that makes it easy to
scatter twenty windows encourages scattering twenty windows. Constraining the
surface constrains the mess — and, as a side effect, makes an Electron application
cheaper in memory over a working day than a Qt one that invites sprawl.

### 5. Borrow rather than build, when the borrowed thing is better

The project has a standing bias toward writing its own. That bias is wrong when
something good already exists in the ecosystem:

- The search engine is `fff`, already shared with Mesura Code.
- The icons come from Mesura Code, because they are better than the current ones.
- The palette comes from Mesura Code, minimal and dark, rather than a third grey
  ladder nobody asked for.
- Git status is computed once, in the shape Symmetria IDE already proved.

**What stays ours:** the keyboard model, the preview router, the Miller columns,
and the feel. Those are the reasons this exists instead of a stock file manager.

### 6. Keyboard is the interface, not a shortcut layer

Keybindings are data, not code — one declarative registry feeding the dispatcher,
the help overlay, and eventually the command palette. A binding added once appears
everywhere it should.

The mouse is supported. It is not the design target.

---

## What it refuses to be

- **A file manager for everyone.** No configuration dialogs for preferences that
  could be a sensible default. No plugin system.
- **A second implementation of anything.** If Mesura Code has it and it is good,
  we use it. If it does not, we build it once and both use it.
- **Eager.** See principle 3.
- **A window manager.** See principle 4.

---

## The open design question

Principle 3 removed auto-expansion, and the user still wants a way to understand a
folder structure at a glance. That need is real and currently unanswered.

Candidates, none chosen:

- An explicit, bounded "expand everything under here" action with visible
  progress.
- A flat `tree`-style overview rendered as a **preview**, not as a mounted tree —
  cheap, read-only, and disposable.
- Leaning on the Miller columns, which already show three levels at once.
- Answering "where is X" with fuzzy path search instead of "show me everything".

The right answer probably combines the last two: the columns for structure, the
finder for location, and a rendered overview when someone genuinely wants the
whole shape.

---

## Where the project is going, in order

1. **A standalone Electron file manager** that matches what the Qt version really
   does — which is less than its own documentation claims, and that is a gift.
2. **The previews**, ordered by what actually gets opened.
3. **Search as a shared module**, wrapping `fff`, with content search (grep) — a
   capability the Qt version never had and the engine already provides.
4. **Git status**, built once, behind the injection seam.
5. **The embedded surface in Mesura Code**, spending a strict budget of four edits
   in files the upstream fork maintains.

The endgame is not "the file manager runs inside Mesura Code". It is **one file
system, two front doors** — a small tool that is excellent on its own, and a large
application that does not have to reinvent it.
