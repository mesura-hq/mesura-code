---
name: project-electron-transition
description: 2026-08-24 direction — port the Qt file manager to Electron inside Mesura Code; research dossier lives in docs/electron-transition/
metadata: 
  node_type: memory
  type: project
  originSessionId: 93ba8dd0-4f8f-4159-b85f-f81992fa0bf0
  modified: 2026-08-25T04:24:40.156Z
---

On 2026-08-24 the user set a new direction for the file manager: **port it from
Qt6/QML to Electron**, first as a standalone resident daemon plus fast windows,
then embedded in **Mesura Code** — replacing that product's file tree and file
explorer and adding git status.

Mesura Code is a **fork of `pingdotgg/t3code`** at
`/home/jc/projects/mesura-code`: a pnpm monorepo on Electron 41.5.0, React
19.2.6, Effect-TS and Tailwind v4. It already contains `apps/desktop/src/symmetria/`,
`apps/web/src/symmetria/` and `packages/symmetria-broker-contract`.

A research dossier sits at `docs/electron-transition/` (15 documents, ~17,000
lines). Read `12-synthesis.md` first; `00-index.md` maps the rest. Reports 13 and
14 **override report 09** on syntax highlighting and on images, because they
benchmarked on this machine rather than citing. It was written in the worktree
`t3code-a2a6aa9b` and may be uncommitted.

**Why:** the direction contradicts what is written in Symmetria IDE's
`docs/tech-stack.md:63` ("Electron rejected. Contradicts *beauty in
functionality*") and its migration plan, which places the file manager at
position 9 of 10, after cutover. Tonight's direction promotes it to first. Unless
that reversal is written into those documents, a future agent will read them and
"correct" the course.

**Decisions are now MADE.** Read `docs/electron-transition/15-decisions.md` — that
file is the authority and beats any report it contradicts. Headlines: the file
manager **keeps its own repository** (Mesura Code consumes published packages);
**one window with tabs**, not many windows; **auto-expansion of the file tree is
removed entirely**; the palette and the icons come from **Mesura Code**; legacy
`.xls` is deferred; documentation gets rewritten, not patched.

`docs/vision.md` states what the tool is for and what it refuses to be.

**Spikes ran on 2026-08-24** — see `18-spike-results.md`. They settled three
things: `fff` frecency stores are shareable **across processes but not within
one** (so Mesura Code needs one index per process); the `sharp` Electron GLib
crash **did not reproduce in 8000 decodes**, so it is a risk to isolate in a
`utilityProcess`, not a blocker; and `fff.grep` beats ripgrep while returning git
status and `isDefinition`, so content search is built on `fff`.

**How to apply:** do not re-run this research — cite the dossier.

Two rules the dossier established that override defaults inside Mesura Code:
fork discipline beats DRY (an edited upstream line is a weekly merge conflict, a
new file is free), and `packages/contracts/src/ipc.ts` must not receive a fourth
Symmetria member — see the warning in that file and issue #16.

Related: [[project_rust_fff_finder]], [[project_framework_evaluation]],
[[project_keybinding_registry]].
