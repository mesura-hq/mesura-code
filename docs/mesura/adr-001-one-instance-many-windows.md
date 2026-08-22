# ADR-001 — One process, many windows

**Status:** **SUPERSEDED** by `adr-002-one-window-many-projects.md`, on the same
day it was written. Do not plan work from it.

**Why it was superseded, since that is the useful part.** This ADR compared two
candidate architectures against each other and never measured either against the
architecture already running. One window with many projects turned out to be
**flat** — about 890 bytes per additional project — which makes every number
below an argument _against_ windows rather than for them. Read ADR-002 for the
decision and this file only for the measurement method, which stands.

**Scope:** how Mesura Code presents more than one project at once.

## Decision

A project gets its own **window**. Every window belongs to the **same OS
process** — one Electron main process, one GPU process, one bundled server.

**Rejected: one application instance per project.** That design is cheaper to
build and free of merge cost, and it was recommended before this measurement
existed. It is rejected on memory.

## What decides it

Measured 2026-08-21, on the live `t3code` install, with **PSS** rather than RSS —
RSS counts shared pages once per process and overstates a multi-process
application badly, which is the whole quantity in question here.

| Role                                    | PSS          |
| --------------------------------------- | ------------ |
| Main (browser) process                  | 63.6 MB      |
| Bundled server (node)                   | 109.6 MB     |
| GPU process                             | 29.9 MB      |
| Resource monitor                        | 13.2 MB      |
| Network service                         | 6.3 MB       |
| Zygotes                                 | 1.6 MB       |
| **Fixed cost per application instance** | **224.2 MB** |
| **Renderer — the per-window cost**      | **191.3 MB** |

Agent and dev-server subprocesses the app had spawned (`claude`, `codex`,
`next dev`) came to ~272 MB. They are excluded on purpose: that work exists once
per project under either design, so it cannot separate them.

The two designs therefore cost:

```
one instance, N windows   →  224 + 191·N
N instances, one window   →  415·N
```

| Projects | One instance | N instances | Saved          |
| -------- | ------------ | ----------- | -------------- |
| 2        | 606 MB       | 831 MB      | 225 MB         |
| 4        | 989 MB       | 1 662 MB    | 673 MB (40%)   |
| 6        | 1 372 MB     | 2 493 MB    | 1 121 MB (45%) |
| 8        | 1 755 MB     | 3 324 MB    | 1 569 MB (47%) |

**Each project after the first costs 191 MB instead of 415 MB.** The saving
tends to 54% and the single largest term in it is the bundled server, which N
instances would run N times at ~110 MB each.

### Re-running the measurement

Walk the process tree from the main pid and sum `Pss` from
`/proc/<pid>/smaps_rollup`. Two traps, both of which produced a wrong answer on
the first attempt:

- **`ps -e` overrides `--ppid`.** `ps -eo pid --ppid <pid>` returns every process
  on the machine, and the resulting total looks plausible. Use
  `ps --ppid <pid> -o pid --no-headers`.
- **Renderers report `--type=zygote` in their cmdline**, because Chromium forks
  them from the zygote and the cmdline is not rewritten. Classifying by cmdline
  alone therefore finds no renderer at all. Discriminate on mapped libraries: the
  GPU process maps the GL/Vulkan drivers (`radeonsi`, `libEGL`, `libvulkan`) and
  a renderer maps none of them while carrying several anonymous regions above
  64 MB for the V8 heap.

## What this decision forbids

- **Do not solve "a window per project" with `XDG_CONFIG_HOME` + `T3CODE_HOME`
  per project.** It works — Electron scopes the single-instance lock to
  `userData`, so a second instance starts cleanly — and it is the wrong answer
  here.
- **Do not point two instances at one `T3CODE_HOME`.** The server is event
  sourced, so two servers over one SQLite file means two sets of in-memory
  projections, reactors and checkpoint refs. That corrupts silently rather than
  failing, so it is worse than the design it appears to rescue.

## What it costs, accepted knowingly

The obstruction is entirely the Electron shell and the renderer's shared origin
storage. The server is already multi-project — `projection_projects` is keyed by
a UUID with `workspace_root` as its natural key, and every command already
carries a `projectId` — so it backs N windows unchanged.

Five things have to be built, listed in rising cost:

1. **Window bounds are a captured mutable.** `flushMainWindowBounds` is a `let`
   reassigned by whichever window was created last, over one persisted
   `mainWindowBounds` record. A second window silently takes the first's
   geometry.
2. **IPC has no window routing.** The handler discards the event
   (`ipcMain.handle(channel, (_event, raw) => …)`), and window-scoped methods
   guess with `focusedMainOrFirst`.
3. **`PreviewManager` is a single-window singleton** — one `mainWindowRef`, a
   flat tab list, a guard rejecting any webview hosted elsewhere, and a
   `window.once("closed")` that tears down all PiP and recording. 4215 lines.
4. **Two windows share one origin.** Both load `t3code://app`, so localStorage
   and IndexedDB are shared: roughly 25 unscoped keys, most written by zustand
   `persist` stores that rewrite the whole blob, last writer wins. Drafts,
   project order and read state clobber each other. **This is the blocker that
   does not announce itself** — it produces lost state, never an error.
5. **N renderers open N WebSocket sets**, which §2 of `AGENTS.md` cares about.

Blocker 4 has a cheap partial answer: `webPreferences.partition` is already in
the window create-options schema, so a per-window partition isolates storage for
one line. It does not touch 1, 2, 3 or 5.

**Merge cost, priced rather than hidden.** The work lands in the two hottest
files in the desktop app — `window/DesktopWindow.ts` at 24 upstream commits per
quarter and `preview/Manager.ts` at 22. This is the first structural edit the
fork will have made; its whole diff today is 377 inserted lines of renames. That
cost is accepted, not overlooked. See `AGENTS.md`, "Quality decides, merge cost
informs".

## Consequence for dictation

One process with many windows keeps more than one project addressable at once,
so speech-to-text cannot infer its destination from the process. That is the
failure the shell already spent three investigation passes on
(`~/.config/quickshell/symmetria/docs/stt-wrong-agent-delivery.investigation.md`),
and it is why `packages/symmetria-broker-contract` states that `threadId` is the
whole address — "no process id, no window handle, no pane slot".

**This decision therefore makes that contract load-bearing rather than
optional.** Dictation must address a thread, never a process or a window.
