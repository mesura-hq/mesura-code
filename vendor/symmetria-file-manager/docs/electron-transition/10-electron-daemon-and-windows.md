# 10 — The resident daemon and instant windows in Electron

Status: **research and design**. No code changed in either repository. Every
number marked *measured* was read from `/proc` and `hyprctl` on this machine on
2026-08-24; every number marked *published* carries a source URL.

The question this document answers: **can an Electron process behave like
`symmetria-fm.service` — resident, headless at idle, and able to put a window on
screen fast enough that the user reads it as instant?**

The short answer: **yes, but only by never paying an Electron cold start on the
user's critical path.** Electron cannot cold-start a window in the time the Qt
daemon takes to create one. It can get within the "feels instant" band if the
process is already resident *and* a renderer is already warm. Everything below
is the engineering needed to hold that property.

---

## 0. The thing being matched

Read the Qt host before reading the rest. The relevant facts:

| Fact | Source file |
|---|---|
| One process, `QGuiApplication` + `QQmlApplicationEngine`, **zero windows at startup** | `host/standalone/main.cpp` |
| `QLocalServer` at `$XDG_RUNTIME_DIR/symmetria-fm.sock`, newline-delimited JSON | `host/standalone/server.cpp` |
| Command set: `open`, `openOverlay`, `createPicker`, `closePicker` | `host/standalone/server.cpp:114-154` |
| Envelope in: `{"method":…,"args":{…}}` — envelope out: `{"ok":true}` or `{"ok":false,"error":"…"}` | `host/standalone/cli.cpp:78-113` |
| A window is `Component.createObject()` on an already-loaded `Component` | `host/standalone/main.qml:105-150` |
| The daemon **quits** when the last window closes; systemd `Restart=always` brings it back | `host/standalone/main.cpp:60-64`, `symmetria-fm.service` |
| `UnsetEnvironment=HL_INITIAL_WORKSPACE_TOKEN` before exec | `symmetria-fm.service:16` |
| The picker is a **singleton** — a second `createPicker` is rejected, not queued | `host/standalone/main.qml:118-135` |

That last row is the single most useful fact in this document. It licenses a
window-reuse strategy for the picker that would be wrong for browse windows.

**Measured resident cost of the Qt daemon** (PID 1878305, one FM window open,
`/proc/PID/smaps_rollup`):

```
Rss             250 044 kB   (244 MiB)
Pss             115 346 kB   (113 MiB)
Private_Dirty    84 720 kB
Shared_Clean    164 244 kB
```

`Pss` is the honest figure for "what this process costs the machine", because it
divides shared pages (Qt libraries, the QML cache) by the number of processes
mapping them. The zero-window figure is lower and was not measured, because
measuring it would have required restarting the running service.

---

## 1. Cold start budget

### 1.1 What is actually being paid

An Electron cold start is four costs in series. Only the fourth has an analogue
in the Qt daemon's per-window path.

| # | Phase | What happens | Anchor |
|---|---|---|---|
| 1 | `exec` + dynamic link | The kernel maps a 207 MB `electron` binary; `ld.so` applies relocations | Chromium's own measurement: relocations cost **~56 ms/GHz per process** and are **76.9 % of startup time** |
| 2 | Chromium browser init | Field trials, ICU (`icudtl.dat`, 11 MB), resource paks (`resources.pak`, 7 MB), Ozone/Wayland connection, GPU process, network service | no published single number |
| 3 | Node + V8 in main | V8 context from `v8_context_snapshot.bin` (715 kB), then parse and run the app's main bundle | measured floor below |
| 4 | Window → first paint | `new BrowserWindow` → renderer fork from the zygote → preload → HTML/CSS/JS → `ready-to-show` | app-dependent |

**Measured on this machine** (`/usr/bin/node`, v26.7.0 — the same major line
Electron 41 ships, Node 24.15.0):

```
node -e ""     0.02 – 0.04 s      maxrss ≈ 45 MB
```

That ~20–40 ms is the *floor* for phase 3 with an empty script. Mesura Code's
`dist-electron/main.cjs` is a single packed CJS bundle whose ~50 top-level
`require`s all run before anything else, and it inlines every `@t3tools/*` and
`@symmetria/*` workspace source (`vite.config.ts` `alwaysBundle`). Phase 3 for
that app is therefore hundreds of milliseconds, not tens.

**Measured Electron artefact sizes**
(`/home/jc/projects/mesura-code/node_modules/.pnpm/electron@41.5.0/node_modules/electron/dist`):

```
electron                  207 MB
icudtl.dat                 11 MB
resources.pak             7.0 MB
v8_context_snapshot.bin   715 kB
snapshot_blob.bin         341 kB
```

Phase 1 on a **cold page cache** must fault in a large fraction of that 207 MB
from disk. On the first launch after boot this dominates everything else. On a
warm cache it is close to free, which is why "restart the app and time it" gives
optimistic numbers and why the once-per-login cost is the one that matters.

### 1.2 Published end-to-end numbers, and why none of them is the answer

- Inkdrop (Electron 8, macOS): **4 s → 3 s** time-to-interactive after bundling
  plus a V8 snapshot.
- Atom: V8 snapshots gave **~500 ms**, described elsewhere as **~50 %** of
  startup.
- A consulting case: **~10 s → ~3 s** through route-based code splitting.

Every one of these measures *an application*, not the framework floor. They are
useful for one conclusion only: **the app's own JavaScript, not Chromium, is
usually the largest term.** That is good news, because it is the term we control.

There is no authoritative published measurement of "Electron hello world, Linux,
process spawn to first pixel". Treat the following as an engineering estimate to
be replaced by the spike in §3.6:

- warm page cache, modern desktop Linux, trivial renderer: **250–600 ms**
- warm page cache, a real React file-manager renderer: **1–3 s**
- cold page cache, first launch after boot: **add 0.5–2 s**

### 1.3 The Qt comparison, honestly

The Qt daemon's per-window cost is not a cold start at all. `QGuiApplication`,
the QML engine, the type registrations, and the compiled QML cache for
`FileManager.qml` are **already resident**. `_spawnFileManager` is
`Component.createObject()` on a `Component` that was compiled when the daemon
loaded `main.qml`. That is object construction plus scene-graph build plus one
compositor frame.

At the measured display (`eDP-1`, 2560×1600, **scale 1.6**, **165 Hz**) one frame
is **6.06 ms**. A plausible Qt window-spawn cost is **10–30 ms** to first pixel,
with the directory listing arriving asynchronously after.

**The gap, stated without softening:**

| Path | To first pixel |
|---|---|
| Qt daemon, `createObject` | ~10–30 ms |
| Electron, cold start per window | ~250 ms – 3 s |
| Electron, resident + warm renderer (this document's target) | **~40–120 ms** |

Electron loses by roughly **two orders of magnitude** if a window costs a
process launch, and by roughly **3–5×** at best when the process is resident and
a renderer is already painted. The design job is to make the second row
impossible to reach and the third row the only path a user ever takes.

---

## 2. The resident-daemon pattern in Electron

### 2.1 Staying alive with zero windows — the `window-all-closed` trap

Electron's documented default: *"If you do not subscribe to this event and all
windows are closed, the default behavior is to quit the app; however, if you
subscribe, you control whether the app quits or not."*

So a resident daemon needs exactly one line:

```ts
app.on("window-all-closed", () => { /* stay resident */ });
```

**This inverts a deliberate decision in the Qt host.** `main.cpp:60-64` leaves
`quitOnLastWindowClosed` at its default `true` on purpose, so each session starts
clean and systemd respawns the daemon. That decision is cheap in Qt, where a
respawn costs a `QGuiApplication` construction. It is **not** cheap in Electron:
a respawn costs a full cold start and throws away every warm renderer. The
Electron design must keep the process alive and reset state in-process instead.

Mesura Code today does the opposite of what a daemon needs. Its handler
(`apps/desktop/src/app/DesktopLifecycle.ts:234`) quits on every non-darwin
platform:

```ts
if (environment.platform !== "darwin" && !(yield* Ref.get(state.quitting))) {
  yield* app.quit;
}
```

A daemon build must branch on a "resident mode" flag here rather than delete the
line, because the goal-two embedding (the file manager inside Mesura Code) still
wants ordinary quit-on-last-window behaviour.

### 2.2 Single-instance ownership

Two mechanisms are available and they should both be used, for different jobs.

**The socket bind is the authority.** This mirrors the Qt design: whoever
successfully `listen()`s on `$XDG_RUNTIME_DIR/symmetria-fm.sock` is the daemon.
It works identically for a C++, Qt, Node, or Rust host, and it is the thing the
existing `symmetria-fm-cli` probes.

One improvement over the current Qt code is worth taking while porting.
`server.cpp:61` calls `QLocalServer::removeServer(path)` **unconditionally**
before listening, so a second daemon started by accident silently steals the
socket from a live one. The safe sequence is:

1. `connect()` to the path. If it succeeds, a daemon is alive → exit non-zero.
2. If it fails with `ECONNREFUSED` or `ENOENT`, the socket is stale → `unlink`,
   then `bind` and `listen`.
3. `chmod 0600` the socket, in a `0700` directory.

Mesura Code already ships that exact hardening in
`apps/desktop/src/symmetria/socketFiles.ts` (`SOCKET_MODE = 0o600`,
`DIRECTORY_MODE = 0o700`, `prepareSocketPath`, `restrictSocketPath`,
`defaultRuntimeDir`) with a written rationale about symlink pre-placement in a
world-writable `tmpdir`. Reuse it; do not write a second one.

**`app.requestSingleInstanceLock()` is the secondary guard.** It stops a stray
double-launch from ever reaching the socket race. Two cautions specific to
Mesura Code:

- The lock is currently taken **implicitly** by the Clerk SDK bridge
  (`apps/desktop/src/app/DesktopClerk.ts:90-147`), never by the app's own code.
  That is why `setPath("userData")` must precede it — the lock is scoped to the
  userData directory and creates it. Any daemon work that touches instance
  semantics has to respect that ordering, which is documented in three files.
- The lock's IPC carried **CVE-2026-34776**, an out-of-bounds heap read in the
  `second-instance` path on macOS and Linux, exploitable by a process running as
  the same user. Patched in **38.8.6, 39.8.1, 40.8.1, 41.0.0**. The pinned
  `electron@41.5.0` is on the safe side of that, but it is a standing reason not
  to make `second-instance` the *primary* transport.

### 2.3 Autostart: systemd user unit versus XDG autostart

| | systemd user unit | XDG autostart entry |
|---|---|---|
| Restart on crash | `Restart=always`, `RestartSec=2` | none |
| Logs | `journalctl --user -u symmetria-fm` | wherever stdout goes |
| Ordering | `After=graphical-session.target` | DE-dependent, unordered |
| **Can strip an env var before `exec`** | **yes — `UnsetEnvironment=`** | **no** |
| Electron built-in support | none needed | `app.setLoginItemSettings` is **macOS and Windows only** |

The decision is already made by a project-specific bug. `symmetria-fm.service`
carries `UnsetEnvironment=HL_INITIAL_WORKSPACE_TOKEN` with a comment explaining
that Hyprland reads that token from `/proc/<pid>/environ`, so an in-process
`unsetenv()` is too late and the daemon's first window lands on the wrong
workspace. **An XDG autostart entry cannot do this.** Use a systemd user unit,
and carry the `UnsetEnvironment=` line across verbatim.

`app.setLoginItemSettings` is not a third option: the Electron `app` docs list it
as macOS and Windows only, and the Linux work that exists targets the Flatpak
background portal, not a plain systemd session.

**One non-obvious consequence of pre-warming.** Today's unit is
`WantedBy=default.target` with no ordering, and that is safe *because the daemon
opens no window at startup* — it does not need `WAYLAND_DISPLAY` until the first
`open` arrives. The moment the Electron daemon pre-warms a hidden `BrowserWindow`
at boot, it needs the Wayland socket immediately. The unit then requires:

```ini
[Unit]
After=graphical-session.target
PartOf=graphical-session.target

[Install]
WantedBy=graphical-session.target
```

and the session must have run `systemctl --user import-environment WAYLAND_DISPLAY XDG_CURRENT_DESKTOP`
(or Hyprland's `exec-once` equivalent). Missing this produces a daemon that
starts, fails to connect to Wayland, and either dies in a restart loop or serves
windows that never appear.

### 2.4 The CLI → daemon transport, three ways

The contract to preserve is in `cli.cpp` and `server.cpp`: one JSON line in, one
JSON line out, `{"ok":false,"error":"invalid_fifo_path"}` on rejection, exit code
1 on any failure. The Python portal depends on the exit code
(`symmetria_portal.py` `launch_fm_ipc`).

#### (a) The built-in `second-instance` mechanism

```
symmetria-fm --open ~/Downloads
  → a whole new Electron process starts
  → app.requestSingleInstanceLock() returns false
  → the resident process receives ('second-instance', argv, cwd, additionalData)
  → the new process quits
```

- **Latency: disqualifying.** Delivering one message costs a *complete Electron
  cold start* in the sender — the 250 ms–3 s of §1 plus 200+ MB of transient
  RSS — before the resident process learns anything. Every system file dialog in
  the session would pay it.
- **Robustness: there is no reply channel.** `first-instance-ack` plus an
  `ackCallback` on `second-instance` was added in PR #31460 and then **reverted**
  before Electron 19 because its named-pipe implementation was not
  session-specific and deadlocked across apps. So the first instance cannot
  answer `{"ok":false,"error":"invalid_fifo_path"}`. That alone breaks
  `createPicker`.
- **Security:** this is the code path CVE-2026-34776 lived in.
- **Contract match: poor.** Wrong latency, no reply, and the CLI would have to
  become an Electron binary.

**Score: latency 1/5, robustness 2/5, contract match 1/5.**

#### (b) A Unix domain socket the main process listens on

```ts
import net from "node:net";
const server = net.createServer((c) => { /* newline JSON in, newline JSON out */ });
server.listen(socketPath);
```

- **Latency: sub-millisecond.** `connect` + `write` + `read` on an `AF_UNIX`
  stream socket on the same machine. The measurable cost moves entirely into the
  window-spawn path, which is where it belongs.
- **Robustness: high, and already proven in the destination repo.** Mesura Code
  runs two of these today (`symmetria/SttSocket.ts`, `symmetria/threadStream.ts`)
  with the permission and stale-path hardening in `socketFiles.ts` and
  `unixSocket.ts`. Failure modes are known: stale socket after a crash (handled
  by the connect-probe sequence in §2.2), and `EMFILE` under connection storms
  (bound by closing on reply, as the Qt server does).
- **Contract match: exact.** Same path, same envelope, same replies. **The
  existing C++ `symmetria-fm-cli` binary keeps working unmodified**, and so does
  `symmetria_portal.py`. That is the strongest argument in this document: the
  transport swap can be verified by pointing the *unchanged* Python portal at an
  Electron daemon on an alternate socket path.

**Score: latency 5/5, robustness 5/5, contract match 5/5.**

#### (c) D-Bus

- **Latency: good but not free.** Every call goes through `dbus-daemon`, so it is
  two hops rather than one — low single-digit milliseconds on a session bus.
  Irrelevant against a 40–120 ms window budget.
- **Robustness: a new dependency with a maintenance shape.** There is no C
  binding in the Node ecosystem worth shipping; the realistic choice is a
  pure-JS stack. `dbus-next` is **0.10.2, last published five years ago**.
  `@homebridge/dbus-native` is **0.7.1, published within the last two weeks** as
  of 2026-08-24 and is the maintained option. Electron also needs a live session
  bus, which Mesura Code already repairs — `DesktopShellEnvironment.ts:508-513`
  derives `unix:path=${XDG_RUNTIME_DIR}/bus` and overwrites a stale
  `DBUS_SESSION_BUS_ADDRESS` inherited from the login shell.
- **Contract match: poor for the CLI, excellent for the portal.** Moving
  `symmetria-fm-cli` to D-Bus breaks a working binary for no gain. But exporting
  `org.freedesktop.impl.portal.FileChooser` **from the Electron process** would
  delete the Python backend, the venv, the FIFO, and the 300 s timeout. See §6.

**Score: latency 4/5, robustness 3/5, contract match 2/5 for the CLI hop,
5/5 for the portal hop.**

#### Verdict

**Use (b) for the CLI hop.** Keep the socket path, the envelope, and the exit
codes byte-identical so the existing CLI and portal are the regression test.
Keep `app.requestSingleInstanceLock()` as a cheap secondary guard, never as the
transport. Revisit (c) later, additively, and only for the portal.

---

## 3. Making a window appear instantly

### 3.1 The techniques, ranked

Ranked by saving-per-unit-of-complexity for *this* application.

#### Rank 1 — Reuse one window and swap its contents

**Saving: the largest available, ~everything except `show()` and one frame
(6–20 ms).** No process spawn, no page load, no pool memory.

**Complexity: low for the picker, wrong for browse windows.** The picker is
already a singleton by construction: `main.qml:118-135` rejects a second
`createPicker` while one is open, writes the cancel sentinel to the new
request's FIFO, and raises the existing picker. So exactly one picker window can
exist, ever. Keep **one hidden picker window alive for the lifetime of the
daemon** and reuse it for every dialog.

Browse windows are genuinely multi-window — `open` is expected to give the user
a new window each time — so reuse there would be a behaviour change, not an
optimisation.

**Failure modes:** state carried across uses (see §3.2), and a window that has
been `hide()`n on Wayland loses its surface, so `show()` still pays one map plus
one configure round trip.

#### Rank 2 — A pre-warmed hidden `BrowserWindow` pool

**Saving: the page load and the renderer fork, i.e. most of phases 2–4.**
Target residual: `show()` + focus + one frame.

**This works because of a documented Electron behaviour that reads like a
footnote:** *"Using the ready-to-show event implies that the renderer will be
considered 'visible' and paint even though show is false."* A `show: false`
window therefore **does** run its renderer and **does** paint. The inverse switch
exists too: *"The ready-to-show event will never fire if you use
`paintWhenInitiallyHidden: false`."* So leave `paintWhenInitiallyHidden` at its
default.

**Complexity: high — reset discipline is the whole cost.** See §3.2.

**Failure modes:**
1. **Memory.** One warm window is one renderer process. Measured on this machine
   (§4.3): a light renderer costs **~48 MB PSS**, a heavy React renderer
   **~235 MB PSS**. A pool of four is not a pool, it is a leak with a schedule.
2. **CPU while hidden.** Chromium throttles hidden renderers — timers coalesce
   and `requestAnimationFrame` stops. Mesura Code documents exactly this at
   `DesktopWindow.ts` and sets `backgroundThrottling: false` so the hidden boot
   window can reach first paint. The trap is leaving it false: an unthrottled
   hidden window burns battery forever. The correct sequence is
   `backgroundThrottling: false` while warming, then
   `webContents.setBackgroundThrottling(true)` once painted — which is precisely
   what Mesura already does at reveal, applied one step earlier.
3. **Staleness.** A window warmed at login and shown at 18:00 holds a six-hour-old
   render. Re-warm on theme change, on `color-scheme.json` change, and after any
   app update.

#### Rank 3 — `backgroundColor`

**Saving: none in time; it removes the white flash.** Electron's own guidance:
*"Even for apps that use ready-to-show event, it is still recommended to set
backgroundColor to make the app feel more native."* Set it to the opaque form of
`FmTheme.windowBackdrop`. Cost: one property. There is a known Electron issue
(#45774) about a white flash on `show()` when animation effects are disabled —
`backgroundColor` is the mitigation.

#### Rank 4 — `show: false` + `ready-to-show`

**Saving: none. It is a correctness mechanism, not a speed one** — it makes the
window appear *later* but without a flash. In a warm-pool design it is subsumed:
the pooled window is already past `ready-to-show` before the user asks for
anything.

Worth copying from Mesura Code: on Linux it races `ready-to-show` against
`did-finish-load` first-wins (`DesktopWindow.ts:740-756`), because
`ready-to-show` is not reliably emitted on every Linux/compositor combination.
That defensive pattern belongs in the warm-pool warm-up too, with a hard timeout
that shows the window anyway.

#### Rank 5 — Code caching (`module.enableCompileCache()` / `NODE_COMPILE_CACHE`)

**Saving: a slice of phase 3, once per login.** Electron 41.5.0 ships Node
24.15.0, which has the compile-cache API. Complexity is one line. **Unverified:**
whether Electron's main process honours it, and whether it survives ASAR. Treat
as a five-minute spike, not a fact.

#### Rank 6 — V8 snapshots (`electron/mksnapshot` + `electron-link`)

**Saving: published at ~500 ms / ~50 % of startup for Atom.** That is real, and
it is also **entirely on the once-per-login path.** For a resident daemon it buys
the user nothing after the first launch of the session.

**Complexity: high and brittle.** `electron-link` rewrites the require graph to
defer every "forbidden" require, then `mksnapshot` serialises the heap; the
snapshot must be regenerated for every Electron version bump, and anything
touching `process`, `fs`, or native modules at module scope breaks it.

**Verdict: do not do this first.** Revisit only if login-time daemon start
becomes a complaint.

#### Rank 7 — Chromium's own spare renderer

Chromium already keeps one pre-initialised renderer warm. It is controllable with
`--disable-features=SpareRendererForSitePerProcess`. This interacts with our pool
in the wrong direction: **our pool and Chromium's spare are redundant**, and
running both means two idle renderers. If we ship a pool, disable the spare and
measure; if the pool is dropped, keep the spare.

### 3.2 What must be reset between uses of a pooled window

This is the part that sinks naive pool implementations. A reused window is a
reused *renderer*, so nothing resets itself.

| Layer | What leaks | Reset |
|---|---|---|
| App state | current directory, selection set, tab collection, chord prefix, search query, sort mode, scroll offset | a single `resetSession(nextInitialPath)` entry point in the renderer; never partial resets |
| DOM | virtual-list scroll anchor, focus ring, open popovers, `:hover` state, CSS transitions mid-flight | unmount the whole panel subtree and remount, rather than resetting props |
| Timers | debounce timers (the preview path debounces 150 ms), watchers, `setInterval` | tie every timer to the panel subtree's lifetime |
| Focus | `document.activeElement` survives hide/show; keyboard-first UI depends on it | explicit `focus()` on the key-handling element in the same task as `show()` |
| Web platform | in-memory caches, `IndexedDB` handles, object URLs for previews | `URL.revokeObjectURL` on unmount; keep `IndexedDB` deliberately shared |
| Window | title, bounds, maximized state, always-on-top, `backgroundThrottling` | set explicitly on every hand-out |
| Chromium | the back-forward list grows if you `loadURL` per use | **never `loadURL` on a pooled window** — see §3.3 |

The design rule that keeps this tractable: **a pooled window is handed out
exactly once, then destroyed on close and replaced by a freshly warmed one.**
Reset only has to be correct for the *picker* singleton, which is reused
indefinitely. Browse windows get a fresh pool member, so the reset surface
shrinks to "the pool member was warmed with a placeholder path and must be
retargeted before showing".

### 3.3 Process reuse and site isolation when navigating a warm renderer

Two facts decide the navigation strategy.

**Fact one: every `BrowserWindow` gets its own renderer process, even
same-origin.** Electron issue #49960 is an open request to allow reuse and states
that today *"when multiple WebContents instances load pages from the same domain,
each one creates a separate SiteInstance and renderer process"*, with *"no
reliable way … to achieve process reuse for same-origin cases in Electron's
public API"*. A pool of N is N renderer processes. There is no way around this;
plan the memory for it.

**Fact two: a cross-origin navigation swaps the renderer process.** That is
standard Chromium site isolation. If a warm renderer sitting on
`t3code://app/filemanager` is navigated to `file:///home/jc/...`, Chromium
discards the warm process and forks a new one — the pre-warming is thrown away
at exactly the moment it was supposed to pay off.

**Therefore:**
- Serve the whole file manager from **one custom-scheme origin**. Mesura Code
  already registers `t3code://app` with
  `{ standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }`
  synchronously before `ready` (`ElectronProtocol.ts:111`,
  `registerDesktopSchemePrivilegesSync`). Reuse it.
- **Never call `webContents.loadURL()` on a pooled window.** Retarget it by
  sending an IPC message and letting the renderer change route in-page. This
  keeps the process, keeps the JIT-warmed code, and keeps the back-forward list
  empty.
- Previews of arbitrary files must not navigate the top-level frame. Stream file
  bytes over IPC or the custom protocol; if an isolated frame is genuinely needed
  (HTML render preview, the `Ctrl+R` path), use a `<webview>` or a child
  `BrowserWindow`, exactly as Mesura Code already isolates preview guests into
  `PREVIEW_PARTITION_PREFIX` partitions.

### 3.4 The recommended design

```
Resident main process (no window at idle)
│
├── picker window   — created once at daemon start, hidden, NEVER destroyed
│                     reused for every createPicker; reset via resetSession()
│
└── browse pool     — exactly ONE hidden, pre-navigated, already-painted window
                      handed out on `open`, then owned by the user
                      replaced asynchronously ~500 ms after each hand-out
```

Hand-out sequence for `open`:

1. `t0` — the CLI writes `{"method":"open","args":{"initialPath":"…","t0Ns":…}}`.
2. Main validates, answers `{"ok":true}` **immediately** — do not make the CLI
   wait for pixels; the current Qt server also replies before the window exists.
3. Main takes the pooled window, sets `title`, applies bounds, calls
   `webContents.send("fm:retarget", { initialPath })`.
4. The renderer swaps route, paints a **skeleton** (chrome + column frames +
   spinner) synchronously, and posts `fm:painted`.
5. Main calls `win.show()` then `win.focus()`, and
   `webContents.setBackgroundThrottling(true)`.
6. Main forks a replacement pool member on a `setTimeout(…, 500)` so the fork
   does not contend with the frame the user is waiting for.
7. The renderer's directory scan resolves and replaces the skeleton.

Step 4 is what makes the budget achievable. **Do not wait for the directory
listing before showing the window** — the Qt path does not either; `FileList`
renders empty and fills in. Waiting for I/O inside the show path converts a
predictable 60 ms into an unpredictable 60–400 ms.

Hand-out sequence for `createPicker` is the same minus step 6, plus the FIFO
plumbing of §6, plus the busy-rejection branch that already exists in
`main.qml:118-135`.

### 3.5 The target

| Milestone | Target p50 | Target p95 |
|---|---|---|
| CLI write → main receives the line | < 2 ms | < 5 ms |
| → renderer reports skeleton painted | < 35 ms | < 70 ms |
| → window mapped and first frame on screen | **< 60 ms** | **< 120 ms** |
| → directory listing painted (warm page cache, < 500 entries) | < 120 ms | < 250 ms |

The 60 ms p50 is chosen deliberately: it is under the ~100 ms threshold at which
a UI response reads as instantaneous, and it is achievable because it contains no
process spawn and no page load. It is **still 2–6× the Qt daemon's cost**, and
the design should not pretend otherwise.

### 3.6 How to measure it

Four timestamps, joined by an id carried in the JSON envelope.

- **`t0`** — the CLI reads `CLOCK_MONOTONIC` before `write()` and puts `t0Ns` in
  `args`. The existing C++ CLI would need three lines; a throwaway shell client
  can use `date +%s%N` for the spike.
- **`t1`** — main process, `process.hrtime.bigint()` in the socket `data`
  handler. `t1 - t0` is transport.
- **`t2`** — renderer, a `PerformanceObserver` on `paint` entries reporting
  `first-contentful-paint` after the retarget message, sent back over IPC.
- **`t3`** — compositor-visible frame. There is no in-process API for this.
  Two workable proxies:
  - run the daemon with `WAYLAND_DEBUG=client` and timestamp the
    `wl_surface.commit` that follows the `xdg_surface.configure` for the shown
    toplevel;
  - or, in a scripted harness on a scratch output, record with `wf-recorder` at a
    known frame rate and count frames between a marker and the window appearing.

Reuse what already exists rather than inventing telemetry. Mesura Code has an
Effect tracer writing NDJSON to `${logDir}/desktop.trace.ndjson`
(`DesktopObservability.ts`), with spans already named
`desktop.electron.whenReady`, `desktop.window.createWindow`,
`desktop.window.createMain`. Add `symmetria.fm.retarget` and
`symmetria.fm.show` spans and the phase breakdown falls out of the existing
sink. Also copy VS Code's discipline of naming every startup moment with
`performance.mark` — its published mark inventory is the model.

**Gate it.** A headless run (`--ozone-platform=headless`) measuring `t0 → t2`
over ≥ 100 iterations, asserting p95, belongs in CI. `t3` cannot be gated in CI
and must be re-measured by hand on Hyprland after any Electron bump.

---

## 4. Multiple windows sharing state

### 4.1 The four things being shared

| Subsystem | Why sharing matters |
|---|---|
| Filesystem cache (directory listings, `stat` results) | two windows on `~/Downloads` must not scan it twice |
| Watcher registry (`inotify`) | the kernel budget is finite and per-user |
| Thumbnail / preview cache | decoding a HEIC twice is pure waste |
| Fuzzy index (`fff` + frecency LMDB) | **cannot** be opened twice in one process |

The last row is not a preference. `CLAUDE.md` records that LMDB/heed refuses to
open the same frecency environment twice in a process, which is why
`fuzzyfinder.cpp` holds a process-wide `FffEngine` singleton. Any Electron design
that puts the index in more than one process must give each a distinct
`SYMMETRIA_FM_FRECENCY_DIR`, which defeats the point of frecency.

The `inotify` budget has the same shape. The C++ `FileSystemModel` already caps
per-file watches at `kMaxFileWatches` and restricts them to non-recursive scans,
explicitly to protect that budget. N windows × M directories multiplies the watch
count unless the registry is deduplicated **above** the window layer.

### 4.2 The three architectures

#### (a) All state in the main process, pushed to renderers

- Renderers are pure views. Every read goes over IPC; every change arrives as a
  delta on `webContents.send`.
- **Sharing: perfect.** One watcher per path, one cache entry per path, one
  `fff` engine, regardless of window count.
- **Risk: main-process blocking.** The main process also owns the event loop that
  services the socket, the window lifecycle, and every renderer's IPC. A
  synchronous native call there freezes *every* window at once. This is the
  single most common Electron performance failure.
- **Cost:** IPC serialisation on every listing. A 5 000-entry directory as JSON
  is a few MB per window; use `postMessage` with transferable `ArrayBuffer`s or a
  columnar encoding rather than an array of objects.

#### (b) `SharedWorker`-style patterns

- A `SharedWorker` is shared across same-origin renderers in one session — which
  is exactly our topology, since §3.3 puts every window on one custom-scheme
  origin.
- **But it runs in a renderer-type process** with no Node integration and no
  native modules, and under `sandbox: true` it has no `fs`. It cannot own a
  watcher, cannot call `fff`, cannot decode a HEIC with `libheif`.
- Its lifetime is tied to its clients: with zero windows open there is no
  `SharedWorker`, so nothing survives the idle state a daemon spends most of its
  time in.
- **Verdict: wrong tool for filesystem state.** Legitimate for pure computation
  shared across windows — fuzzy-match scoring of an already-loaded list, sort
  comparators, virtual-list layout maths.

#### (c) A `utility_process` per subsystem

`utilityProcess.fork` gives *"the equivalent of `child_process.fork` … but
instead uses Services API from Chromium"*: a real Node environment, native module
support, **no DOM**, communicating over `MessagePortMain` / `parentPort`.

- **Sharing: good, with one owner per subsystem.** The `fff` engine lives in
  exactly one utility process, satisfying the LMDB constraint by construction.
- **Blocking: solved.** A slow native call blocks that utility process, not the
  main event loop and not any window.
- **Direct renderer channel:** a `MessageChannelMain` port can be transferred
  from a utility process to a renderer via `webContents.postMessage`, so
  thumbnail bytes need not be relayed through main.
- **Cost:** one more process (~40–80 MB, see §4.3) per subsystem, and a
  serialisation boundary.

Mesura Code uses **zero** utility processes today — out-of-process work goes
through `ChildProcessSpawner` (the backend server, `wsl.exe`, `xdg-mime`). So
this is new ground in that repo, not an existing pattern to copy.

#### Recommended split

```
main process          socket server, window lifecycle, watcher REGISTRY,
                      directory cache authority, delta fan-out
                      — no synchronous native calls, ever

utility #1 "index"    fff engine + frecency LMDB (single owner by necessity)

utility #2 "media"    image/HEIC/archive/spreadsheet decode; owns the thumbnail
                      cache on disk; hands bytes to renderers over a transferred
                      MessagePort

renderers             views only; no fs, sandbox: true, contextIsolation: true
```

Put the *registry* in main and the *work* in utilities. Main stays a router.

### 4.3 Memory cost per extra window on Linux — measured

All figures read from `/proc/PID/smaps_rollup` on this machine, 2026-08-24.
`Pss` divides shared pages by the number of processes mapping them, so the `Pss`
column is the marginal cost; `Rss` overstates it badly for Chromium.

**Mesura Code, AppImage build, one window open** (`/tmp/.mount_Mesuramttn4d/`):

| PID | Role | Rss (kB) | Pss (kB) |
|---|---|---|---|
| 1897083 | browser (main) | 251 436 | 139 956 |
| 1897096 | zygote host | 55 396 | 11 536 |
| 1897097 | zygote | 54 616 | 9 597 |
| 1897099 | zygote | 14 152 | 4 179 |
| 1897210 | forked child (GPU) | 183 184 | 74 250 |
| 1897835 | forked child (renderer) | 172 584 | 113 255 |
| 1897485 | Node backend sidecar (Mesura-specific) | 187 384 | 123 467 |
| 1897544 | resource monitor | 7 980 | 5 925 |
| | **total** | | **482 165** |

**T3 Code, AUR build, one window open** (`/opt/t3code-bin/`):

| PID | Role | Rss (kB) | Pss (kB) |
|---|---|---|---|
| 1671124 | browser (main) | 244 268 | 137 792 |
| 1671129 / 1671130 | zygotes | 45 056 / 46 620 | 6 305 / 7 098 |
| 1671551 | forked child (light) | 148 832 | **48 589** |
| 1672509 | forked child (heavy renderer) | 282 076 | **234 841** |
| 1671569 | network service utility | 71 088 | not sampled |

**Read from this:**

- **Electron shell with one window: ~350–400 MiB PSS.** (Mesura total minus its
  Node sidecar and resource monitor: 482 165 − 123 467 − 5 925 = **352 773 kB**.)
- **The marginal cost of one extra window is one renderer: 48 MB PSS at the light
  end, 235 MB PSS for a heavy React tree.** Both numbers are from real running
  apps on this box, not estimates. A file-manager renderer with a virtualised
  list should sit near the low end; a renderer with a WebGL preview or a large
  virtual DOM will not.
- The zygotes are cheap in PSS (4–12 MB) because they exist precisely to be
  shared — see §1.1's relocation-amortisation citation.

**Budget rule for the pool:** at 48–235 MB per warm window, **the pool size is 1
plus the picker singleton.** Two warm windows is a defensible experiment; four is
not.

---

## 5. Wayland and Hyprland specifics

Environment this section was checked against:
`Hyprland 0.56.2`, `eDP-1` 2560×1600 at **scale 1.6**, 165 Hz.

### 5.1 Ozone flags at this Electron version

**Electron 41 needs no flags for native Wayland.** Wayland is supported out of
the box from **Electron 38.2**, and `ELECTRON_OZONE_PLATFORM_HINT` was **removed
in Electron 38** and now does nothing.

Confirmed by measurement on this machine:

- `mesura-code` (Electron 41, AppImage) runs with **no ozone flags at all** in
  its command line, and `hyprctl clients` reports
  `class='mesura-code' … xwayland=False`. Native Wayland, zero configuration.
- `t3code` (the AUR build of the same app) passes
  `--no-sandbox --enable-features=UseOzonePlatform --ozone-platform=wayland --ozone-platform-hint=wayland`.
  Those are **legacy and redundant on 41**; they are harmless, but the
  `--no-sandbox` in the same line is a real security regression that a packaging
  review should question.
- Older advice to add `--enable-features=WaylandWindowDecorations` is also
  obsolete: Electron 41 ships full client-side decorations.

**Action: ship no ozone flags.** Any flag that appears must justify itself
against a measured failure.

### 5.2 The app-id contract, translated

`CLAUDE.md` records the Qt contract as three-way:
`setDesktopFileName()` == the installed `.desktop` basename == that file's
`StartupWMClass`, with only the first two load-bearing.

In Electron the mechanism is different and the version boundary matters.

| Qt | Electron |
|---|---|
| `QGuiApplication::setDesktopFileName("symmetria-fm")` before the app object | `app.setDesktopName("symmetria-fm.desktop")` **before `ready`** (Linux only) |
| Falls back to the executable basename | Falls back to a normalised `productName` / `app.name`, then to the executable name |
| Qt registers with `org.freedesktop.portal.Registry` using it | Chromium sets `xdg_toplevel.set_app_id` from it |

**The version boundary.** Electron PR #51424 (merged 2026-05-04, backported to
the 41 line as #51480 and to 42 as #51479) changed Linux identity derivation so
that **both X11 `WM_CLASS` and Wayland `app_id` come from the same XDG app ID**,
normalised from `productName` when `desktopName` is absent. The consequence
stated in that discussion: the older `--class` switch fed `WM_CLASS` only, and
**never** fed the Wayland `app_id`; after 41.6.1 it no longer feeds `WM_CLASS`
either.

**This lands squarely on Mesura Code.** It pins `electron@41.5.0` — *before* the
backport — and `apps/desktop/src/app/DesktopPreReadyPlatform.ts:58-63` appends
exactly that switch:

```ts
Electron.app.commandLine.appendSwitch("class", linux.linuxWmClass);
```

What actually makes the Hyprland class correct today is the *other* call,
`app.setDesktopName(environment.linuxDesktopEntryName)` in
`DesktopAppIdentity.configure` (`DesktopAppIdentity.ts:120-147`), which runs
before `whenReady`. The measured `class='mesura-code'` is that call's doing. The
`--class` switch is already vestigial on Wayland and becomes vestigial
everywhere at 41.6.1.

**The contract for an Electron file-manager daemon is four-way:**

1. `app.setDesktopName("symmetria-fm.desktop")`, called synchronously before
   `ready`;
2. `desktopName` in the app's `package.json`, as the belt to that braces;
3. the installed `.desktop` basename, `symmetria-fm.desktop`, in
   `/usr/share/applications` — **not** `~/.local/share/applications`, which takes
   XDG precedence and goes stale, exactly as `CLAUDE.md` already warns;
4. electron-builder's `linux.desktop.entry.StartupWMClass` **and**
   `linux.executableName`.

Row 4 is where Mesura Code already has a live defect worth learning from: the
builder config and the runtime both use `mesura-code`, while
`packaging/aur/t3code-bin/PKGBUILD` writes `StartupWMClass=t3code`,
`Icon=t3code`, `Exec=t3code`. Three independent `.desktop` generators — the
builder, the runtime `DesktopLinuxUrlHandler`, and the PKGBUILD — with divergent
identities. Any file-manager packaging must have **one** generator.

**Verification command**, mirroring the `journalctl … | grep "app ID"` check the
Qt side documents:

```bash
hyprctl clients -j | jq -r '.[] | select(.class=="symmetria-fm") | {class, initialClass, xwayland}'
```

`xwayland: false` and `class == initialClass == "symmetria-fm"` is the pass
condition.

### 5.3 Window decorations

Electron 41 is the first version with full CSD on Wayland, including frameless
windows. Relevant knobs:

- `frame: false` — the file manager draws its own chrome, as the QML panel does.
- `hasShadow: false` — **required** for a truly bare frameless window on Wayland;
  otherwise Electron 41 gives frameless windows GTK drop shadows and extended
  resize boundaries.
- `roundedCorners` — now supported on Linux and **defaults to `true`**. The
  current design paints its own `rounding.lg` corners on the Miller columns, so
  compositor-level rounding on top would double them. Set it explicitly.
- `titleBarStyle: "hidden"` on Linux, with `titleBarOverlay` **withheld** — this
  is Mesura Code's existing Hyprland-motivated choice, documented in
  `DesktopWindow.ts` `getWindowTitleBarOptions`: withholding the overlay makes
  `navigator.windowControlsOverlay` report invisible so the web side drops its
  window-controls layout. Copy it.

### 5.4 Focus and activation — the hardest problem

**The requirement:** the picker window must take keyboard focus, because the user
is mid-dialog in another application and expects to type immediately. The Qt path
approximates this with `Qt.Dialog | Qt.WindowStaysOnTopHint` plus
`requestActivate()` (`main.qml:84-88`), and `CLAUDE.md` records that a Hyprland
`windowrule` is the documented fallback if Hyprland still swallows the keys.

**The Wayland rule:** a client cannot focus itself. It can only be activated with
a token obtained by *the requesting client* through `xdg_activation_v1` and
handed over out of band — canonically in the `XDG_ACTIVATION_TOKEN` environment
variable of a newly launched process.

**What Electron implements:** PRs #43480 and #43481 (with backports #43546–43548,
#43577, #43579) make Electron read `XDG_ACTIVATION_TOKEN` from its environment
and use it to activate the window — *"both for the first instance of an electron
app as well a subsequent instance that uses `app.requestSingleInstanceLock()`"*.
PR #50568 extends the same idea to notification clicks.

**Why that does not solve our case.** Both supported paths deliver the token in
the environment of a **freshly launched Electron process**. Our daemon is not
freshly launched — it has been resident since login, and its environment block is
whatever systemd gave it. There is no public Electron API to hand a token to a
specific existing `BrowserWindow`. This is the single largest Wayland risk in the
design.

**Mitigations, in order of preference:**

1. **Carry the token through the existing envelope.** The CLI already runs as a
   child of the activating application. Have `symmetria-fm-cli` copy its own
   `XDG_ACTIVATION_TOKEN` into `args`, and have the daemon set it in
   `process.env` immediately before `win.show()`. **Unverified** — this depends on
   Electron re-reading the variable at show time rather than only at launch, which
   the PRs do not promise. Spike it first (§9, risk 1).
2. **Use the portal's `parent_window` handle.** `server.cpp:121-128` already
   forwards a `parentWindow` string of the form `wayland:HANDLE`, and
   `main.qml:140-141` already logs it for the xdg-foreign import plan. A window
   set transient-for its parent is the compositor-blessed way to be raised and
   focused. Electron has no `setParentWindow` equivalent that consumes an
   xdg-foreign handle, so this needs either an upstream contribution or a native
   addon.
3. **A Hyprland window rule.** `windowrule = float, match:class ^(symmetria-fm)$`
   plus a focus rule. `CLAUDE.md` states none is shipped today and that the class
   it matches is the app-id contract — **so a rule and an app-id change must ship
   together.** Note the syntax in this config is the current
   `windowrule = <action>, match:<selector>` form, verified against
   `~/.config/hypr/windowrules.conf`.
4. **`alwaysOnTop: true` + `show()` + `focus()`**, accepting that
   *"`win.focus()` behavior varies by compositor"* per Electron's own Wayland
   write-up.

**Corollary for the browse window:** `open` is invoked from a keybinding, so the
launching context can hand a token the ordinary way. The picker is the case that
needs the work.

### 5.5 Transparency and blur

The design keeps the Miller panes **opaque** and lets `FmTheme.windowBackdrop`
(pure black at 0.6 alpha) show through only the chrome gaps. That is fortunate,
because Chromium's transparency story on Wayland is the weak part.

- Hyprland issue #1332 reports blur failing on semi-transparent Electron windows,
  with an `opacity 0.99` workaround. The mechanism is Chromium's opaque-region
  reporting: Hyprland blurs only where the surface declares itself non-opaque.
- `transparent: true` on Electron also disables some Chromium fast paths and
  interacts badly with `roundedCorners`.
- This machine's Hyprland config already blurs by rule
  (`layerrule = blur on, match:namespace symmetria-.*` and friends in
  `~/.config/hypr/windowrules.conf`), but those are **layer** rules for the
  QuickShell shell surfaces, not window rules. A normal `xdg_toplevel` from
  Electron needs a `windowrule`, not a `layerrule`.

**Plan:** ship `transparent: true` + `backgroundColor: "#00000000"` +
`frame: false`, then verify blur visually against the Qt build side by side. If
Chromium's opaque region defeats the blur, the fallback is to drop to an opaque
`backgroundColor` matching `FmTheme.windowBackdrop` composited over a solid
colour — visually close, and it loses only the wallpaper darkening that
`CLAUDE.md` matches to Ghostty's `background-opacity = 0.6`.

### 5.6 Per-monitor scaling

**This is a concrete problem at this Electron version on this machine.**

- The display runs at **scale 1.6** — a fractional scale.
- Chromium's Wayland fractional-scaling support arrived behind the
  `WaylandFractionalScaleV1` feature and is reported as landing around
  **Chromium 148**.
- **Electron 41.5.0 is Chromium 146.0.7680.216.** Electron 42.0.0 is the first
  release on Chromium 148.

So on the pinned version Chromium renders at an integer scale and the compositor
downscales — the classic "Electron apps look blurry on Wayland" symptom, on a
1.6-scale panel where it is most visible. There is also a reported caveat that
*"flags given on the command line are sometimes thrown away by Electron's
internal initialization code"*, so enabling the feature by flag may silently not
take.

**Options:** bump to Electron ≥ 42 for the file-manager daemon; or accept
downscaled text; or set `--force-device-scale-factor=2` and lay out for it, which
trades blur for wasted pixels. This deserves a side-by-side screenshot comparison
against the Qt build before any UI work starts, because it changes how much
pixel-level polish is worth doing.

### 5.7 IME

Native Wayland input methods are **off by default** in Chromium. Enabling them:

```
--enable-wayland-ime --wayland-text-input-version=3
```

`text-input-v3` has known compositor-specific behaviour differences, which is why
the version is selectable.

Relevance here: the user runs the **latam** keyboard layout. The recorded
keybinding issue (`mods:"*"` for symbol glyphs) is about modifier reporting, not
IME, and that is a renderer-side concern that translates directly to
`KeyboardEvent.key` / `.code` handling. But **dead keys** — the latam layout's
acute accent — go through the IME path in a rename or search field. Test a rename
containing `á` before deciding whether the flags are needed.

### 5.8 The Wayland checklist

```
[ ] no ozone flags (Electron ≥ 38.2 is native by default)
[ ] app.setDesktopName("symmetria-fm.desktop") before ready
[ ] desktopName in package.json
[ ] .desktop installed to /usr/share/applications, not ~/.local/share
[ ] exactly ONE .desktop generator
[ ] electron-builder linux.executableName == StartupWMClass == app id stem
[ ] verify: hyprctl clients -j → class == "symmetria-fm", xwayland == false
[ ] frame:false + hasShadow:false + roundedCorners:false
[ ] titleBarStyle "hidden", titleBarOverlay withheld
[ ] backgroundColor set (flash) even with ready-to-show
[ ] picker activation: token path spiked, Hyprland rule ready as fallback
[ ] blur verified side-by-side against the Qt build
[ ] fractional scale 1.6 verified; Electron >= 42 if blurry
[ ] --enable-wayland-ime evaluated with a latam dead-key rename
[ ] systemd unit: After/PartOf graphical-session.target IF pre-warming at boot
[ ] systemd unit: UnsetEnvironment=HL_INITIAL_WORKSPACE_TOKEN carried over
```

---

## 6. The picker and portal path

### 6.1 What survives unchanged

Everything, if the socket contract is preserved. `portal/symmetria_portal.py`
does exactly four things that touch the file manager:

1. `create_fifo()` — `os.mkfifo(path, mode=0o600)` under `/tmp/symmetria-picker-<uuid4>`;
2. `launch_fm_ipc("createPicker", json)` — spawns `symmetria-fm-cli`;
3. `read_fifo(path, 300)` — blocking read with a `S_ISFIFO` re-check on the open
   fd to defeat symlink substitution;
4. `launch_fm_ipc("closePicker", …)` from `PortalRequest.close`.

None of that knows or cares what language the daemon is written in. **Keep
Python. Keep the FIFO. Keep the CLI.** The Electron daemon has to implement
`createPicker` and `closePicker` on the same socket with the same four-layer FIFO
path validation (`server.cpp:156-172`: prefix, traversal, length ≤ 128, charset
`^[a-zA-Z0-9._-]+$`) and the same `invalid_fifo_path` rejection.

### 6.2 What gets simpler

The Qt host writes the FIFO by **spawning `python3 -c`** — three separate
`ShellRunner` instances (`_fifoWriteProcess`, `_fifoCancelProcess`,
`_fifoRejectProcess`), each with a 5 s timeout timer, each with a
`FailedToStart`-emits-no-`exited` guard, plus a serialising reject queue with a
`_rejectBusy` latch. That is roughly 140 lines of `main.qml` existing purely
because QML cannot open a FIFO.

**Node can open a FIFO directly.** That deletes all of it:

```ts
const fd = await fsp.open(fifoPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
```

The `O_NONBLOCK` is load-bearing: opening a FIFO for writing **blocks until a
reader attaches**, and the daemon must never block. Open non-blocking, wrap the
fd in a stream, write, close — and keep an equivalent of the 5 s timeout, because
a portal client that died between `mkfifo` and `read` leaves no reader at all
(`O_WRONLY|O_NONBLOCK` on a readerless FIFO fails with `ENXIO`, which is the
signal to give up rather than hang).

The reject queue also collapses: with real async file handles, two concurrent
rejections no longer contend for one `ShellRunner`'s `fifoPath` property, which
is the entire reason `_drainRejects` and `_settleReject` exist.

### 6.3 Could the portal talk D-Bus directly to Electron?

Yes, and it is attractive — but as a second phase.

**The shape:** the Electron daemon owns the bus name
`org.freedesktop.impl.portal.desktop.symmetria` and exports
`org.freedesktop.impl.portal.FileChooser` (`OpenFile`, `SaveFile`, `SaveFiles`)
using `@homebridge/dbus-native` (0.7.1, actively maintained;
`dbus-next` is five years stale).

**What disappears:** `symmetria_portal.py`, the `portal-venv` with `dbus-fast`,
the FIFO, `create_fifo`/`read_fifo`, the 300 s timeout, the cancellation
sentinel, and the `closePicker` method — `Request.Close` becomes a direct D-Bus
method call on an object we export.

**What it costs:**

- A pure-JavaScript D-Bus stack in the hot path of **every system file dialog on
  the machine**. A parser bug there is a desktop-wide outage, not an app bug.
- The daemon must be running before any application opens a dialog. Today's
  `.service` file makes the *Python* backend D-Bus-activatable; making the
  Electron daemon activatable instead means the first file dialog of the session
  pays a full Electron cold start of 1–3 s. Keep systemd start and let the D-Bus
  name be claimed by an already-running process.
- Losing the isolation the current split provides: today, if the file manager is
  down, the Python backend still answers with a cancel and the requesting
  application recovers. A single-process design has no such fallback.

**Recommendation: phase 1 keeps Python and the FIFO** — it is zero-risk and makes
the unchanged portal the regression test for the whole transport swap. **Phase 2
evaluates the D-Bus collapse** on its own merits, once the Electron daemon has
proved stable for weeks.

---

## 7. Memory and battery honesty

### 7.1 The number

| | measured PSS | measured RSS |
|---|---|---|
| Qt daemon, one window (PID 1878305) | **113 MiB** | 244 MiB |
| Electron shell, one window (Mesura, minus its Node sidecar) | **~345 MiB** | ~700 MiB across 6 processes |
| Electron, idle, zero windows (estimated: browser + GPU + network) | **~230 MiB** | — |
| Marginal cost of each extra window | **48–235 MiB** | 149–282 MiB |

**Expect roughly 3× the resident memory of the Qt daemon, and up to 4× once a
warm pool member and a picker singleton are held.** That is the honest number and
it should be stated to the user before, not after, the port.

Two caveats in both directions:

- The Qt figure was measured **with a window open**; its zero-window figure is
  lower and unmeasured.
- The Electron renderer figures come from apps with large React trees. A
  virtualised file list should land near the 48 MB end, not the 235 MB end — but
  that is a hypothesis until the spike measures it.

### 7.2 Battery

At idle with zero windows, an Electron main process runs no timers and costs
essentially no CPU. **The cost of residency is memory, not power.** The battery
risks are all self-inflicted:

1. **A pooled window with `backgroundThrottling: false` left on.** Hidden
   renderers normally have `rAF` stopped and timers coalesced; disabling
   throttling to reach first paint and then forgetting to re-enable it means a
   permanently animating invisible window. Re-enable with
   `webContents.setBackgroundThrottling(true)` the instant the warm-up paint
   lands.
2. **Chromium's own spare renderer stacked on top of ours.** Disable it with
   `--disable-features=SpareRendererForSitePerProcess` if the pool ships.
3. **File watchers left armed on directories nobody is looking at.** The registry
   in main must drop a watch when the last interested window closes — the same
   discipline `FileSystemModel::syncFileWatches` already applies in C++.
4. **The GPU process.** It stays alive for the resident daemon. On a laptop this
   keeps the render node open. Consider whether the idle daemon can run without
   a GPU process until the first window (untested; likely not worth the
   complexity).

### 7.3 Mitigations, in order of cost

1. **Pool size 1**, plus the picker singleton. Free.
2. **Re-throttle after warm-up.** One line.
3. **Disable Chromium's spare renderer.** One flag.
4. **Idle discard.** After N minutes with no visible FM window, destroy the pool
   member and keep only main + picker. Re-warm lazily on the next `open`, paying
   ~200 ms once instead of ~50 MB always. A 10-minute timer is a reasonable
   first guess.
5. **`utilityProcess` that can be killed.** The media decoder does not need to
   exist between previews; spawn on demand, kill after 60 s idle.
6. **Full idle mode.** Close every window and keep only the main process — which
   is exactly what the `window-all-closed` no-op handler already gives, at
   ~140 MiB PSS.

---

## 8. The recommended architecture

### 8.1 Diagram

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │  systemd --user : symmetria-fm.service                               │
 │  ExecStart=/usr/bin/symmetria-fm            (the Electron daemon)    │
 │  UnsetEnvironment=HL_INITIAL_WORKSPACE_TOKEN                         │
 │  After/PartOf=graphical-session.target   [only if pre-warming early] │
 │  Restart=always  RestartSec=2                                        │
 └──────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │  MAIN PROCESS  (resident, ~140 MiB PSS idle)                         │
 │                                                                      │
 │   net.createServer  →  $XDG_RUNTIME_DIR/symmetria-fm.sock  (0600)    │
 │       envelope in : {"method":…, "args":{…}}                         │
 │       envelope out: {"ok":true} | {"ok":false,"error":"…"}           │
 │       methods     : open | openOverlay | createPicker | closePicker  │
 │                                                                      │
 │   app.on("window-all-closed", () => {})       ← stay resident        │
 │   app.requestSingleInstanceLock()             ← secondary guard      │
 │   app.setDesktopName("symmetria-fm.desktop")  ← before ready         │
 │   protocol t3code://app  standard+secure      ← ONE origin, always   │
 │                                                                      │
 │   owns: watcher REGISTRY · directory cache · window lifecycle        │
 │   never: synchronous native calls                                    │
 └──────────────────────────────────────────────────────────────────────┘
      │                    │                     │                │
      │ MessagePortMain    │ MessagePortMain     │ IPC            │ IPC
      ▼                    ▼                     ▼                ▼
 ┌──────────┐        ┌──────────┐        ┌───────────────┐  ┌──────────────┐
 │ utility  │        │ utility  │        │ PICKER window │  │ BROWSE pool  │
 │ "index"  │        │ "media"  │        │ hidden        │  │ size = 1     │
 │          │        │          │        │ created once  │  │ hidden       │
 │ fff +    │        │ image /  │        │ NEVER         │  │ pre-painted  │
 │ frecency │        │ heif /   │        │ destroyed     │  │ handed out   │
 │ LMDB     │        │ archive  │        │ reset per use │  │ then replaced│
 │ (single  │        │ decode   │        │               │  │              │
 │  owner   │        │ + thumb  │        │ ~48–235 MiB   │  │ ~48–235 MiB  │
 │  by LMDB)│        │ cache    │        └───────────────┘  └──────────────┘
 └──────────┘        └──────────┘                │                 │
                                                 ▼                 ▼
                                        user-visible windows (fresh renderer each)

 external:
   symmetria-fm-cli (unchanged C++)  ──write one JSON line──▶ socket
   symmetria_portal.py (unchanged)   ──spawns the CLI, reads the FIFO──▶
```

### 8.2 Process inventory

| Process | Count | Lifetime | Measured / estimated PSS |
|---|---|---|---|
| main (browser) | 1 | login → logout | ~140 MiB (measured) |
| GPU | 1 | with main | ~74 MiB (measured) |
| network service (utility) | 1 | with main | ~40–80 MiB (estimated) |
| zygotes | 2–3 | with main | ~4–12 MiB each (measured) |
| picker window renderer | 1 | login → logout | 48–235 MiB (measured range) |
| browse pool renderer | 1 | replenished per hand-out | 48–235 MiB |
| visible browse renderers | 0..N | user-controlled | 48–235 MiB each |
| `utility "index"` (`fff` + LMDB) | 1 | on demand, long-lived | est. 40–90 MiB |
| `utility "media"` (decode) | 0–1 | spawned per burst, idle-killed | est. 40–120 MiB |

**Idle floor: ~260–330 MiB PSS.** **Typical, one window open: ~400–500 MiB PSS.**
Against a Qt daemon at 113 MiB with one window.

### 8.3 Transport

**Unix domain socket, `$XDG_RUNTIME_DIR/symmetria-fm.sock`, mode 0600, newline
JSON, identical envelope and identical error strings.** The unchanged
`symmetria-fm-cli` and the unchanged `symmetria_portal.py` are the acceptance
test. `second-instance` is never the transport. D-Bus is a phase-2 addition for
the portal only.

### 8.4 Window-spawn strategy

**One warm hidden window in the pool, one warm hidden picker singleton, retarget
by IPC, never by `loadURL`, paint a skeleton before showing.**

Target: **p50 < 60 ms, p95 < 120 ms** from CLI write to first frame; listing
painted by 120 ms p50. Measured by the four-timestamp harness of §3.6, gated in
CI at `t0 → t2` and re-checked by hand on Hyprland for `t3`.

---

## 9. Risks, mitigations, and the spike that kills each one early

Each spike is small, runs against a **scratch socket path** and a **scratch
`.desktop` id**, and never touches the live `symmetria-fm.sock`.

### Risk 1 — The picker cannot take keyboard focus on Wayland

**Why it could sink the project:** the portal path is the file manager's most
externally visible job. A picker that appears but does not accept keystrokes is
worse than no picker. Electron's `XDG_ACTIVATION_TOKEN` support targets
freshly launched processes, which a resident daemon is not (§5.4).

**Mitigation:** the four-step ladder in §5.4 — token forwarded through the
envelope, then xdg-foreign parenting, then a Hyprland `windowrule` shipped
together with the app-id, then `alwaysOnTop` + `focus()`.

**Spike (≈ 40 lines, half a day).** An Electron script that listens on
`/run/user/1000/fm-spike.sock`, and on message creates a window with
`alwaysOnTop: true`, sets `process.env.XDG_ACTIVATION_TOKEN` from the message,
calls `show()` then `focus()`, and 200 ms later logs `win.isFocused()` alongside
`hyprctl activewindow -j`. Drive it from a shell one-liner launched from a
terminal, and separately from a `zenity`-style child so a *real* activation token
exists. **Run this before any UI work.** It is the cheapest possible answer to
the most expensive possible question. Note it opens a window, so it must be run
deliberately by the operator, not by an agent.

### Risk 2 — The warm-window budget is not reachable

**Why it could sink the project:** the entire justification for the port assumes
"feels instant". If the honest p95 is 400 ms, the Qt daemon should stay.

**Mitigation:** the skeleton-first show of §3.4; if that is not enough, reduce to
one reused window per view instead of a pool.

**Spike (one day).** Build the harness of §3.6 against a **stub** renderer that
renders a static skeleton and nothing else. Measure `t0 → t2` over 200
iterations. If the stub cannot reach p95 < 120 ms, no real renderer will, and the
target must be renegotiated before any feature work.

### Risk 3 — Fractional scaling makes the app look worse than the Qt build

**Why it could sink the project:** this display runs at scale 1.6, and Electron
41.5.0 is Chromium 146, which predates `WaylandFractionalScaleV1` (~Chromium
148 / Electron 42). Blurry text next to crisp Qt text is a rejection on sight.

**Mitigation:** run the file-manager daemon on Electron ≥ 42, decoupled from
whatever Mesura Code pins; failing that, `--force-device-scale-factor=2`.

**Spike (one hour).** Open the already-installed Mesura Code AppImage (Electron
41) and take a `grim` capture of a text-heavy panel. Do the same for the running
`symmetria-fm` window. Compare at 1:1. **This requires no new code at all** —
both applications are already running on this machine.

### Risk 4 — Memory lands at the top of the measured range

**Why it could sink the project:** at 235 MB per renderer, a daemon with a pool,
a picker, and two open windows costs over 1 GiB.

**Mitigation:** pool size 1, idle discard, `utilityProcess` for the heavy
subsystems, and a virtualised list that keeps the DOM small.

**Spike (half a day).** Script open/close of 1, 2, 4 windows against the stub
renderer from spike 2, sampling `app.getAppMetrics()` and
`/proc/*/smaps_rollup` after each step. Produce a per-window marginal PSS number
for *our* renderer, not someone else's.

### Risk 5 — The `fff` engine does not port cleanly

**Why it could sink the project:** the fuzzy finder is a headline feature with a
measured 11–20× advantage over the previous implementation, and its LMDB
frecency store refuses to open twice in one process.

**Mitigation:** exactly one `utilityProcess` owns it (§4.2c); `napi-rs` over the
existing `fff-c` C ABI; `SYMMETRIA_FM_FRECENCY_DIR` isolates test runs.

**Spike (two days).** Build a minimal `napi-rs` addon over `fff_search_mixed`,
load it in a `utilityProcess`, and assert that (a) it loads against Electron's
Node ABI without a rebuild dance, (b) two concurrent finder sessions in that one
process do not trip the LMDB "environment already open" error, and (c)
per-keystroke latency matches the C++ measurement.

### Risk 6 — A portal regression breaks every file dialog on the machine

**Why it could sink the project:** `CLAUDE.md` already documents a case where an
unrelated portal failure made *every* dialog in the session hang for 75 s and
looked like this project's bug. A half-working Electron backend would be
indistinguishable.

**Mitigation:** never point the live portal at the Electron daemon during
development. Run the Electron daemon on an **alternate socket path** and drive it
with a **copy** of `symmetria_portal.py` registered under an alternate D-Bus
name, switching `~/.config/xdg-desktop-portal/portals.conf` only for a scheduled
test window.

**Spike (half a day).** Point a copied portal script at the alternate socket and
run `OpenFile`, `SaveFile`, `SaveFiles`, plus `Request.Close`, plus the
busy-rejection path (two dialogs at once), plus the 300 s timeout path (kill the
daemon mid-dialog). All six must produce the same outcomes as the Qt build.

### Risk 7 — Daemon lifecycle bugs: stale socket, double daemon, silent quit

**Why it could sink the project:** a daemon that quits on the last window (the
`window-all-closed` default) turns every subsequent `open` into a cold start and
silently destroys the whole design's premise. A stolen socket splits the world in
two.

**Mitigation:** the no-op `window-all-closed` handler behind a resident-mode
flag; the connect-probe-then-bind sequence of §2.2 replacing the Qt code's
unconditional `removeServer`.

**Spike (two hours, unit-testable, no GUI).** Node tests over the socket module
alone: bind twice → second must fail; kill -9 the first then rebind → must
succeed; `chmod` and directory-mode assertions; malformed JSON → the exact
`{"ok":false,"error":"invalid_json"}` byte string; every FIFO path that
`validateFifoPath` rejects must be rejected identically.

### Risk 8 — Electron version drift changes the app-id under us

**Why it could sink the project:** the Linux identity derivation changed in
PR #51424, backported to the 41 line as #51480. Mesura Code pins 41.5.0 and still
appends `--class`, which is on the wrong side of that change. A silent app-id
change breaks every compositor rule, the portal registration, and the icon.

**Mitigation:** pin the app id in **one** place, assert it at startup, and make
the assertion a test.

**Spike (one hour, no GUI).** A script that starts the daemon headless
(`--ozone-platform=headless`), reads back what Electron computed for the XDG app
id, and fails if it is not `symmetria-fm`. Run it on 41.5.0 and on ≥ 41.6.1 and
diff. Wire it into CI so an Electron bump cannot change the id quietly.

---

## Sources

https://www.electronjs.org/docs/latest/api/app

https://www.electronjs.org/docs/latest/api/browser-window

https://www.electronjs.org/docs/latest/api/utility-process

https://www.electronjs.org/docs/latest/api/web-contents

https://www.electronjs.org/docs/latest/tutorial/performance

https://www.electronjs.org/docs/latest/tutorial/process-model

https://www.electronjs.org/blog/tech-talk-wayland

https://www.electronjs.org/blog/electron-41-0

https://releases.electronjs.org/releases.json

https://github.com/electron/electron/security/advisories/GHSA-3c8v-cfp5-9885

https://advisories.gitlab.com/pkg/npm/electron/CVE-2026-34776/

https://github.com/electron/electron/pull/51424

https://github.com/electron/electron/pull/51480

https://github.com/electron/electron/pull/51479

https://github.com/electron/electron/issues/48391

https://github.com/electron/electron/issues/49960

https://github.com/electron/electron/issues/20268

https://github.com/electron/electron/issues/45774

https://github.com/electron/electron/issues/30912

https://github.com/electron/electron/pull/43480

https://github.com/electron/electron/pull/43481

https://github.com/electron/electron/pull/50568

https://github.com/electron/electron/pull/31460

https://github.com/electron/electron/pull/34312

https://github.com/electron/electron/pull/39792

https://github.com/electron/electron/issues/48001

https://github.com/electron/electron/issues/33662

https://github.com/electron/electron/pull/42727

https://chromium.googlesource.com/chromium/src/+/HEAD/docs/linux/zygote.md

https://www.phoronix.com/news/Chrome-fractional-scale-v1

https://github.com/hyprwm/Hyprland/discussions/11627

https://github.com/hyprwm/Hyprland/issues/1332

https://fcitx-im.org/wiki/Using_Fcitx_5_on_Wayland

https://www.devas.life/how-to-make-your-electron-app-launch-1000ms-faster/

https://palette.dev/blog/improving-performance-of-electron-apps

https://github.com/electron/mksnapshot/blob/main/README.md

https://github.com/atom/electron-link

https://github.com/microsoft/vscode/wiki/Inventory-of-performance-marks

https://www.npmjs.com/package/@homebridge/dbus-native

https://www.npmjs.com/package/dbus-next

https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.impl.portal.FileChooser.html

https://flatpak.github.io/xdg-desktop-portal/docs/writing-a-new-backend.html

https://wayland.app/protocols/xdg-activation-v1
