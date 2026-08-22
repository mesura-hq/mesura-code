# ADR-002 — One window, all projects, summoned into a workspace

**Status:** Accepted, 2026-08-21. **Supersedes ADR-001**, which recorded a
decision this one reverses on its central point.

**Scope:** how Mesura Code presents more than one project, and how it sits in a
Hyprland workspace workflow.

## Decision

**One instance, one window, every project inside it.** A project is a selection
within that window, not a window and not a process.

**The window lives in a named special workspace** and is summoned by keybind
onto whatever workspace the user is on. It is not moved between workspaces and
it does not follow the user.

**Mesura owns the project ↔ workspace binding and publishes it.** Summoning the
window from workspace W selects W's bound project.

**What is already true, and what is pending.** One instance with one window and
every project inside is **the architecture that ships today** — this ADR adopts
it deliberately rather than replacing it, which is the whole reason it supersedes
ADR-001. Nothing has to be built to keep it. What is pending is the workspace
half: the summon keybind, the binding, and publishing that binding to the shell.
That work is **deferred on purpose** (2026-08-21) until the tool is in daily use
and the project-switching gesture has been shaped by using it rather than by
predicting it. Dictation comes first.

## What this reverses, and why

ADR-001 decided one process with **many windows**, on a measurement showing that
beat one process per project. That comparison was real and it was also the wrong
question: neither option was measured against the architecture already in use.

Measured 2026-08-21 (method and traps in ADR-001, which stays readable for
them):

| Projects | **One window** | One instance, N windows | N instances |
| -------- | -------------- | ----------------------- | ----------- |
| 4        | **415 MB**     | 989 MB                  | 1 662 MB    |
| 7        | **415 MB**     | 1 563 MB                | 2 909 MB    |
| 10       | **415 MB**     | 2 137 MB                | 4 155 MB    |
| 15       | **415 MB**     | 3 094 MB                | 6 233 MB    |

**The current architecture is flat.** An additional project costs about **890
bytes**, because:

- projections are read with `SELECT` against SQLite and are not held in memory —
  the only cache is prepared statements, keyed by SQL text, not by project;
- the snapshot carries every project and thread as **metadata only**, and message
  bodies are fetched per thread and capped (`THREAD_DETAIL_ACTIVITY_LIMIT = 500`);
- measured on real data: 7 projects = 1 249 bytes, 14 threads = 4 982 bytes.

Independent confirmation: the measured instance **has 7 projects**, and its
application cost came to 415 MB — exactly the model's fixed term. Those 7
projects do not appear in the measurement because they do not weigh anything.

**A window does not amortize.** Of the renderer's 233 MB RSS, **196 MB are
private pages** (170 of them dirty). A second window pays that again; the
shareable ~37 MB is shared with all of Chromium on the machine, not with a
sibling window.

So memory never argued for windows. It argues against them, and the flat option
is the one already running.

## Why a special workspace, and not following the user

The rejected alternative was making the window follow: listen for Hyprland's
`workspace` event and `movetoworkspacesilent` on every switch.

It is rejected for two reasons. The window would vanish from the workspace being
left, reflowing the tiling layout on every switch. And the mental model it
creates — the window chases you — is worse than the one the special workspace
creates, which is _summon it here_.

The special workspace also **already fits the operator's configuration** rather
than asking it to change:

- `special:communications` is an existing **named** special workspace
  (`windowrule = workspace special:communications silent`), so the pattern is in
  use, not hypothetical.
- `Super, S, togglespecialworkspace` is existing muscle memory.
- The workspace-switch binds are already **wrapped to auto-hide special
  workspaces**, so leaving a workspace hides Mesura with no new code.

## The consequence nobody predicts: the shell's bar stops working

The Symmetria Shell bar labels each Hyprland workspace with a project name. That
label is not a Hyprland workspace name — those are plain numbers. It is derived:

```
IDE ──(agent-bridge: agent{project, terminal_pid = host_window_pid})──▶ AgentService._agents
Hyprland ──(toplevels: {pid, workspace{id,name}})─────────────────────▶ Hypr.toplevels
                              join on window PID
                    _workspaceMap[pid] = {id, name}
              agent.project is rendered as that workspace's label
```

`AgentService._rebuildWorkspaceMap()` joins agents to workspaces **by the host
window's PID**. One window means one PID, so every project collapses onto one
workspace label and the operator loses the orientation surface they navigate by.

**This is why the binding must be published, not inferred.** Mesura sends
`{project → workspace}` and the shell renders that instead of joining by PID.
Without this the architecture works and the workflow does not.

It is also the second time the same lesson has landed here: the broker contract
(`packages/symmetria-broker-contract/src/command.ts`) already states that
`threadId` is the whole address — "no process id, no window handle, no pane
slot". The shell does today exactly what that contract forbids, and it works only
because one process happens to be one project.

## What this costs, accepted knowingly

- **Per-project cost is ~0 today and will not stay there.** The plan is to bring
  in the Symmetria File Manager and an editor. Both hold per-project state, so
  the flat line becomes a slope whose gradient is currently **unmeasured**.
- **Eviction has to be built.** Separate processes give it away free: close the
  window and the kernel reclaims everything. One process means idle projects must
  be written out and restored convincingly. That work is the real price of this
  decision, and it is what ADR-001's rejected multi-process option was buying
  with RAM.
- **Crash isolation is weaker, but not as weak as it looks.** State lives in the
  server, a separate process, so a renderer crash reloads rather than losing
  work.

## Relationship to Symmetria IDE

`docs/vision.md` in the `symmetria-ide` repository forbids exactly this
consolidation, and `.claude/memory/project/meta/multi_instance_topology.md`
records it as settled. **Those remain correct for Symmetria IDE and do not govern
this repository.** The memory has been scoped to say so. Do not cite either as a
verdict here.

Their strongest argument — a workspace holds more than the editor, so collapsing
projects orphans the terminal and browser beside them — is answered by the
summon design rather than dismissed: the other windows never move, and Mesura
arrives where they already are.

## Open questions, to be settled by spike rather than argument

1. **Does summoning feel right?** Whether `togglespecialworkspace` from workspace
   W reads as "bring it here". The _feel_ half is untested; the mechanical half
   is **answered — measured 2026-08-21**, Hyprland 0.56.2, 111 events over three
   gestures on the live session:

   - **`hyprctl activeworkspace` keeps returning the workspace UNDERNEATH an open
     special.** Summoning over workspace 5 reports 5; over 6 reports 6. So "which
     workspace did I summon from" is directly answerable.
   - **No race on the plain path**: 30 of 30 `workspace` events had the state
     already updated when the event arrived (query 5.4–11.6 ms).
   - **The toggle direction is readable**: open emits `special:special,eDP-1`,
     close emits `,eDP-1` with an empty first field. `activespecialv2` carries the
     id (`-99,special:special`), so a _named_ special is distinguishable —
     though a named one was **not** tested, only the unnamed one.
   - **⚠ `activewindow` fires 7–10 ms BEFORE `workspace`, without exception.**
     Binding the project switch to `activewindow` — the intuitive choice, since
     "the focused window changed" — reads the OLD workspace and opens the
     previous project. Intermittent, load-dependent, unreproducible by hand. It
     is the dictation bug again: resolving identity from current state inside an
     async pipeline.
   - **Therefore: do not query at toggle time.** Keep the last `workspace`
     payload as state and use the remembered value when `activespecial` opens.
     The event stream is ordered and complete; the `hyprctl` query is
     verification, not the path.

   Driven end to end the same day against a real named special
   (`special:mesura`), summoning from workspaces 3, 8 and 5:

   - **A named special works and is fully identified.** `activespecialv2` carries
     `-98,special:mesura,eDP-1`; the unnamed one is `-99`. Name and id are both
     available, so several specials never get confused.
   - **Summon reports the underlying workspace correctly, every time** — 3, 8 and
     5, each matching where it was summoned from. This is the mechanism the
     design needs and it works.
   - **⚠ Hyprland does NOT dismiss a special when the workspace changes.** A raw
     `hyprctl dispatch workspace 3` with the special open left it open. The
     auto-hide is entirely the operator's own wrapper
     (`~/.config/hypr/scripts/switch_workspace.sh`, which toggles the special off
     before switching). So Mesura inherits "it does not follow me" only for
     switches that go through that script; anything bypassing it leaves the
     window floating over the new workspace.
   - **⚠ The DISMISS path has a real straddling race; the summon path does not.**
     On the wrapper's hide-then-switch, the two events of one toggle disagreed
     with each other: `activespecial` probed the old workspace (8) and
     `activespecialv2`, 0.3 ms later, probed the new one (5). Never resolve a
     workspace on a hide event. Summons are clean because nothing else moves
     with them.

   Latency across the whole run: 6.2–12.4 ms. **What stays untested is the
   _feel_** — that is a use question, not a measurement.

2. **What does a project cost once the File Manager and the editor are inside?**
   Measure with two projects loaded, then extrapolate. This is the number that
   decides whether eviction is urgent or merely eventual.
3. **What does eviction and restore cost**, and can a restored project be made
   indistinguishable from one that never left.
4. **Publishing the binding to the shell** — the replacement for the PID join.
