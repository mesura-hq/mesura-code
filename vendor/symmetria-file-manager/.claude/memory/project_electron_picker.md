---
name: project-electron-picker
description: "2026-09-01 — the Electron FM's portal file picker is COMPLETE: all 5 phases built, proven over real D-Bus, and deliberately not switched on"
metadata: 
  node_type: memory
  type: project
  originSessionId: 93ba8dd0-4f8f-4159-b85f-f81992fa0bf0
  modified: 2026-09-01T19:47:04.903Z
---

**Complete and merged.** Planned with the operator on 2026-09-01 (`sf-plan` →
`sf-solo`) and all five phases delivered the same day on branch
`t3code/map-electron-file-manager`, merged 2026-09-02. The plan and intent are at
`/home/jc/projects/plans/symmetria-fm-picker/` — **not a git repository**, so
they exist on disk only.

**MERGED TO `main` on 2026-09-02**, PR #52 "Port the file manager to Electron,
and give it a working file picker", merge commit `6eb9550` — 42 commits, 240
files. Everything below is on `main` now.

## Where it stopped

| Commit | Phase |
|---|---|
| `9ecd954` | route every bridge push to the window that asked |
| `77d5246` | open a picker window on `createPicker` / `closePicker` |
| `138d59a` | answer the blocked caller on its FIFO |
| `11813fd` | selection logic + the request on the window URL |
| `81cb682` | the chrome, and `PickerState.active` stops being a constant |
| `51cc47d` | **fix:** confirm on Enter instead of opening the file elsewhere |
| `c9596eb` | **fix:** the same hole on Shift+Enter, and marks filtered by kind |
| `2059486` | the portal registration, switched off, and the whole-path measurement |
| `7e663d6` | **CI:** `HeifDecoderTest` had failed on `main` since 14 Aug — Ubuntu splits libheif's codecs into plugin packages and `--no-install-recommends` installed none, so CI had a libheif that could parse an HEIC and not decode the HEVC inside it. Returns empty, exactly as a corrupt file does. Fixed with `libheif-plugin-libde265`; the decoder now logs libheif's own `err.message`, which it had been discarding. |

**The picker WORKS end to end.** A witness drove a real dialog under a virtual
display: `/etc/xattr.conf` came back on the pipe, a save dialog returned
`/tmp/notes.txt` rather than the highlighted file, a folder dialog refused a file
with Accept greyed out, Escape sent the sentinel, and `p` did not paste — the
first time that suppression has ever been reachable.

**All five phases are done.** The portal backend was installed, started on its
own bus name and driven with a real D-Bus `OpenFile` — a real dialog appeared and
`code=1` came back in 3.1 s — with Qt preferred throughout, so no system dialog
was ever routed to it. Both backends sat on the bus at once.

**The Qt build is still the active FileChooser and must stay so until the
operator says otherwise.** `portals.conf` was verified byte-identical afterwards,
`xdg-desktop-portal` was never restarted, and the Electron portal unit is
installed but `disabled` and stopped. To switch: one line in `portals.conf`
(`FileChooser=symmetria-electron`) plus a portal restart; back is `symmetria`.

**Fresh-versus-warm is CLOSED: fresh stays.** Everything the picker path adds
before paint is p50 9.8 ms — 0.59 of a frame — so the gap between the two is the
paint the spike already measured, and ~60 ms on a deliberate action does not buy
the reset burden a single warm window would carry. See
`docs/electron-transition/24-picker.md`.

Still unverified: typing a replacement filename into the save field (no window
manager under xvfb, so no route into the text input) and the 305 s default
expiry (only the `SYMMETRIA_FM_PICKER_LIFETIME_MS` override was exercised).

## Five things a future agent must not re-derive

**The daemon does NOT rebuild on start — the unit builds on FIRST RUN ONLY.**
After changing it, `systemctl --user restart symmetria-fm-electron.service` or
the portal talks to yesterday's code. This cost a failed end-to-end test: the
daemon had been up since login and answered `unknown command: createPicker`,
and the symptom was a dialog that never appeared rather than an error anyone
saw.

**A window can die without Electron raising ANY event, and it is not
detectable.** Instrumented twice: after an X surface is destroyed from outside
the process, neither `close`, nor `webContents` `destroyed`, nor `closed` fires,
and `isDestroyed()` stays **false** — it reports Electron's state, not the
compositor's. A real close button (`WM_DELETE_WINDOW` / `xdg_toplevel.close`)
does raise the event and is verified to work. **The guarantee is the per-picker
expiry** in `createPickerHost`, 305 s — just past the portal's own 300. Do not
replace it with a liveness check; there isn't one.

**`fs.promises.open` on a FIFO with no reader BLOCKS a libuv threadpool thread**,
and there are four. `fifo.ts` opens with `O_NONBLOCK` so the kernel answers
`ENXIO` and waiting becomes a choice. `O_NOFOLLOW` plus an `fstat` FIFO check
after the open are the security half: `/tmp` is world-writable and any local
process may name any path under the picker prefix.

**No key inside a dialog may reach `ops.open()`.** Enter did, and driven for
real it launched a terminal running nvim on `/etc/xattr.conf`; only the virtual
display kept that off the operator's desktop. Shift+Enter (`openCopyingPath`) had
the identical hole and was found by review one commit later. The Qt build does
not SUPPRESS Enter — it RE-ROUTES it through `confirmPickerSelection`, which is
why its suppression list is short. Porting a list is easy; porting the reason the
list is short is not. Check any new binding that spawns, writes or deletes.

**A `createPicker` naming the OPEN picker's own FIFO must write nothing.**
Without that check the busy rejection wrote a cancellation into the very pipe the
user was about to answer — an injection any local process could send.

## What the process caught that tests could not

Five defects came from the witnesses rather than from any suite, and three were
in prose: two comments claiming "the FIFO write timeout bounds this" when no
write is attempted on that path, and one interface promising more than its
adapter delivered. **A wrong comment is worse than none** — the next reader
trusts it and stops looking.

Also worth keeping: a leak with no observable consequence needed production
surface to be testable at all (`Registry.trackedWindows`, `PickerHost.openFifo`).
A guard written without them passed on the bug.

See [[project-electron-single-window]] for the resident daemon this builds on.
