---
name: project-electron-v2-backlog
description: "2026-08-30 — the ten things the operator wants next in the Electron file manager, in their own priority order, with what each one needs from the code"
metadata: 
  node_type: memory
  type: project
  originSessionId: 93ba8dd0-4f8f-4159-b85f-f81992fa0bf0
  modified: 2026-08-30T20:39:29.468Z
---

After trying the built v1 (see [[project-electron-v1-built]]) the operator listed
what to plan next, as **a run of many phases, one fix per phase**, using the same
`sf-plan` → `sf-solo` cycle v1 used. Nothing below is planned yet — this is the
raw list plus what each item needs, captured before a compaction.

## Their priority, in their words

**Very important**

1. **Search (`/`)** — "el search es muy importante". The registry row exists
   (`search.start`) and reports "not built yet". Needs the incremental filter,
   `n`/`N` match cycling, and the Escape-by-focus rule already documented in the
   cascade.
2. **The `g` chords to Downloads, Pictures, Videos and the rest** — "esa feature
   sí que es muy importante, la uso muchísimo". `gd`, `gp`, … in the Qt build.
   `chords.ts` resolves them today and calls `navigateToBookmark`, which the host
   answers "Bookmarks is not built yet". Needs the bookmark store plus the
   default path table.
3. **Bookmarks** — the `gn` / `gx` sub-mode. The cascade and the sub-mode are
   already ported; only the store is missing.
4. **The directory preview must LIST the entries, not count them.** Screenshot
   evidence: the right column reads `16 entries` and nothing else. `PreviewPane`'s
   `directory` branch renders a count; it should render the listing, which is
   what makes Miller columns three columns rather than two.
5. **The mouse does nothing.** Clicking a folder does not enter it. Rows have no
   click handler at all — the whole application is keyboard-only today.
6. **Scrollbars look bad.** Screenshot evidence: Chromium's default scrollbar,
   white, wide, with arrow buttons, over the near-black palette. Mesura Code
   already declares `--app-scrollbar-width`, `--app-scrollbar-thumb` and
   `--app-scrollbar-thumb-hover` — take those.

**Wanted, lower**

7. **Tabs deserve more attention** — "eso sí parece que está hecho de cierta
   manera, así que buen trabajo… es una feature que le quiero dar bastante más
   atención". Built in phase 7; they want it developed further, not repaired.
8. **Tree view** — "muy importante para la validez de cómo lo vamos a traer a
   Mesura Code". The 6 `TREE_ONLY` registry rows are already ported and
   unreachable. This is the phase that proves the embedding story.
9. **Flash jump** — "eso es más secundario, no es tan importante".

**Deliberately deferred**

10. **The fuzzy finder** — "lo vamos a dejar más a futuro porque es más delicado
    y quiero planearlo bien junto con Mesura Code porque quiero que sea
    reutilizable". Do NOT fold it into this run. It is the Rust `fff` engine and
    the operator wants it designed as a shared module with Mesura Code first.

## How they want it planned

One run, many phases, **each phase one of these fixes**, with the system already
in use: `sf-plan` writes it, `sf-solo` builds it, a verifier drives the real
binary per phase, both gates clean per commit.
