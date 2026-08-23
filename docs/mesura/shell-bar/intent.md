# Intent — Mesura Code's projects and threads in the Symmetria Shell bar

## The objective

Symmetria Shell's bar is where the user reads the state of the machine at a
glance. Today it shows the agents Symmetria IDE publishes: one pill per project,
the project's name in caps, one chip per agent, a sparkle while an agent works.
Mesura Code publishes nothing, so the moment the user moves from the IDE to
Mesura the bar goes quiet and the machine stops being legible.

This work makes Mesura Code's projects and threads appear in that bar, with the
same visual language, so the user can move off the IDE without losing the
overview that made the desktop worth using.

## What done means

The bottom bar shows one pill per Mesura Code project that has threads. Each
pill carries the project's name and one chip per thread, and a thread that is
working animates the same way an IDE agent does. The bar keeps working when
Mesura is closed, and keeps working when Mesura is the only thing running.

## The constraints

- **The visual language is not ours to invent.** The bar's existing components
  render the result. A Mesura pill and an IDE pill must be indistinguishable in
  typography, spacing and animation, because they are the same components.
- **The wire is the Symmetria broker contract.** `packages/symmetria-broker-contract`
  already describes the projection, the stream framing and the command envelope.
  It is a description with no running part; this work makes it run. Nothing may
  bypass it.
- **The contract is an allowlist and stays one.** The transcript, the activity
  feed, the plans, the checkpoints and project configuration never cross.
- **Nothing under `packages/contracts` may be edited to serve this.** An edit
  inside an upstream file conflicts at every weekly upstream synchronization.
- **The shell must not need the fork's auth.** QuickShell holds no bearer and no
  session, so anything it reads has to be reachable without one.

## What must not break

- Dictation from Symmetria Shell into the Mesura composer, shipped 2026-08-22.
- The Symmetria IDE's own agents in the bar, for as long as the IDE is alive.
- The upstream synchronization: no new edits inside upstream-owned files.
- The contract's existing checksums as a drift detector. They are expected to
  move when the contract changes, and expected to fail the suite until somebody
  regenerates and commits them.

## Explicitly out of scope

- **Mapping a project to a Hyprland workspace.** Many projects will never have
  one. The bar's project grouping needs no workspace at all, so this work does
  not attempt the join and does not leave a hook for it.
- **Any write direction.** No click-to-focus, no `activate`, no `turn.start`,
  no `turn.interrupt`. The stream is read-only in both the publisher and the
  consumer.
- **Moving dictation onto the contract.** The dictation socket keeps its own
  protocol for now.
- **The project logo.** Tracked as issue #12.
- **Removing Symmetria IDE from the shell.** A separate cleanup, later.
- **Surface presence.** `SymmetriaSurfacePresence` exists in the contract and
  the bar has nothing to do with it. It is not published.

## The decisions, and what each rejected

**The wire is the broker contract, and the shell adapts it — not the reverse.**
Rejected: Mesura speaking the existing `agent-bridge.py` protocol, which would
need no shell work at all and would run this week. Refused because that protocol
addresses an agent as `{pid}_{slot}`, and the contract exists in as many words to
replace it: a slot number is reused, and a reused address delivers a command to
the wrong thread. Adopting it would contradict a decision already committed.

**The publisher lives in the Electron main process, not in the server.**
Rejected: publishing from the server, which owns the read model natively and
already emits a thread stream. Refused because the same server also runs over
SSH, inside WSL and in the cloud, and a server on a remote host has no business
writing to a socket on this machine. The main process is the only part that is
always local and always one per machine, and it already owns a Unix socket.

**The main process gets its thread state from the renderer, not from its own
subscription.** Rejected: a second WebSocket client in main, authenticated with
`DesktopLocalEnvironmentAuth.getBearerToken`. Refused as a duplicate
subscription and a second auth path for state the renderer already holds and
already renders. The cost is real and accepted: the publisher only has state
while a renderer is alive. Under ADR-002 there is exactly one window and it is
always open, so the cost does not bite; if the one-window decision is ever
reversed, this decision has to be revisited with it.

**The shell's Mesura service is a sibling of `AgentService`, not a feeder into
it.** Rejected: projecting Mesura's threads into `AgentService.agents` so the
whole existing pipeline carries them. Refused because Symmetria IDE and Mesura
Code are deliberately not meant to coexist for long, and `agent-bridge.py` plus
half of `AgentService.qml` is exactly what gets deleted when the IDE goes. The
seam is `ProjectGroup`'s own two properties, which is the narrowest interface
available and survives that deletion untouched.

**Every Mesura thread renders as Claude in v1, including the ones that are not.**
Rejected: a provider-neutral mark of Mesura's own, and separately, adding
provider identity to the contract now. The contract refuses provider identity by
design — `providerName` and `providerInstanceId` are on the excluded list, and
the liveness projection reports what a session does "without saying anything
about the provider itself" — so nothing on the wire can tell a Codex thread from
a Claude one. A neutral third mark would cost a component and a brand colour that
do not exist. The user wants the distinction and it is deferred, not dropped: the
follow-up adds provider identity to the contract, and the argument it has to
revisit is the exclusion's own stated reason, that a shell needs none of it to
render a row — which this consumer has falsified.

**Each phase runs only the suites of the packages it touches.** Rejected: the
cycle's usual whole-suite step. `AGENTS.md` forbids a bare full run in three
places and issue #3 measures why: load 38, swap exhausted, seventy minutes of
unusable machine. This run is unattended overnight, so a wedged machine would
also end the run. The full suite belongs to CI, which has its own host.

**The projection gains a project record.** Rejected: a `projectName` field on
every thread summary. Refused because the name would repeat on every thread and
two threads could disagree, a project with no active thread would vanish from
the bar, and the logo will need a project-shaped record anyway.

**Issue #2 is closed inside this work.** Rejected: leaving it, on the grounds
that the JSON Schema being laxer than the decoder has never hurt anyone.
Refused because it has never hurt anyone only because there has never been a
non-TypeScript consumer, and this work ships the first one. The field it damages
most, `title`, is the field the bar prints.

**The bar runs unmerged.** Rejected: keeping `Config.agentbar.mergeWorkspaces`
on and finding somewhere in the merged layout for windowless threads. Refused
because the merged layout is organized by workspace and this work has no
workspace. The cost is accepted and understood: the IDE's agents lose their
workspace association in the top bar too, for as long as the IDE is still in use.

## What was deliberately deferred, and to when

- **The workspace mapping**, to after the one-window decision has been lived
  with. ADR-002 records it as deferred.
- **The write direction** (`activate` on click, and eventually dictation), to a
  second delivery once the read path has been used for a while.
- **The project logo**, to issue #12, which records the three things that
  actually block it — the signed asset URL the shell cannot fetch, the marker
  file still named after upstream, and a candidate list that resolves a favicon
  rather than a mark.
- **Removing Symmetria IDE from the shell and from other connected projects**,
  to once Mesura Code is established. Until then both publish and both are
  drawn, which the bar's grouping handles by itself: a project worked in both
  lands in one pill.

## Two facts about the ground this runs on

- **The reasoning trail of the contract package is incomplete.** Its `plan.md`
  and `intent.md` lived in `symmetria-ide-next`, a repository that was deleted
  when the project moved. What survives is the commits, the module docstrings
  and issues #2 and #1. That is why the decisions above are restated here rather
  than referenced.
- **The shell repository has uncommitted work.** `~/.config/quickshell/symmetria`
  is a git repository on branch `dev` carrying two modified files —
  `scripts/stt-inject.sh` and `services/SttJob.qml` — which are the shell half of
  the dictation feature shipped 2026-08-22. The Mesura half was sealed and
  merged; this half never was. It must be committed before any run touches that
  repository.
