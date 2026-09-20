# 24 — The file picker, as built

The Electron file manager can answer a system file dialog. This is what was
built, what a witness observed, what it costs, and the one thing that is
deliberately not switched on.

## What it does

A caller asks the desktop for a file. The portal creates a FIFO, blocks reading
it, and asks the daemon for a dialog. The daemon opens a second window on the
workspace the caller is on, the user chooses, and the chosen paths come back on
the FIFO. Every way out of the dialog writes to it — confirm, cancel, the
window closing, a `closePicker`, a request turned away, and the dialog
outliving the caller entirely.

Observed, driving a launched daemon under a virtual display: `/etc/xattr.conf`
came back on the pipe; a save dialog returned `/tmp/notes.txt` rather than the
highlighted file; a folder dialog refused a file with Accept greyed out; Escape
sent `__PICKER_CANCELLED__`; and `p` did not paste, which is the first time the
ported suppression has ever been reachable.

## What it costs

Two halves, measured separately because nothing can measure them together from
outside the process.

| Half | p50 | p95 | Instrument |
|---|---|---|---|
| socket write → daemon reply | **9.8 ms** (0.59 frame) | 11.8 ms (0.71 frame) | `app/bench/pickerPath.mjs`, 20 iterations against a real daemon |
| window construction → paint | 4 frames | 7 frames | `app/bench/pickerWindow.mjs`, the earlier spike |

The first half covers the socket round trip, JSON decoding, the FIFO-path
validation, the one-at-a-time check and `new BrowserWindow`. It does NOT cover
paint: no external observer can see a first frame, and instrumenting the product
to report one would measure the probe.

**A fresh dialog therefore costs roughly 5 to 8 frames, 83 to 133 ms.** A warm
one would be about 2.6 frames, 43 ms.

### The fresh-versus-warm decision, closed

**Fresh stays.** The complete number does not change it.

The spike recommended fresh on architecture — a window never reused has no state
to reset, so that defect class cannot be written — while the speed evidence
favoured warm and grew stronger at every correction. It left the decision open
pending this measurement, on the grounds that the socket, the validation and the
FIFO open were all missing from the figure.

They are in it now, and they are **under one frame between them**. The gap
between fresh and warm is the paint, exactly as the spike measured it, and
nothing this phase added moved it. A ~60 ms difference on an action a person
takes deliberately, a few times a day, does not buy the between-uses reset
correctness that a single warm window in the whole application would have to
carry alone.

Two figures to keep in mind if this is ever revisited. `requestToReply` is not
quantised — it is a socket round trip, not a frame clock — so its 0.59 is a real
0.59 and not a rounding of one. The paint half IS quantised, and the earlier
document was wrong twice by reading that quantisation as signal; divide by
16.667 before theorising about it.

## The registration, and why it is switched off

Only one backend may own `org.freedesktop.impl.portal.FileChooser`. The Qt
build owns it and the operator uses those dialogs every day, so this phase
ships the registration and activates nothing.

**One script, two registrations.** `portal/symmetria_portal.py` is 392 lines and
a second copy would drift — the looser of two copies being the one that matters,
since that script creates the FIFO the daemon later opens for writing. The two
backends differ in exactly two values, and both come from the environment:

| Variable | Qt default | Electron |
|---|---|---|
| `SYMMETRIA_PORTAL_FM_CLI` | `symmetria-fm-cli` | `symmetria-fm-electron-cli` |
| `SYMMETRIA_PORTAL_BUS_NAME` | `…desktop.symmetria` | `…desktop.symmetria-electron` |

The defaults are the Qt build's, so its registration behaves exactly as it did
before the script was parameterised.

```bash
./portal/install-portal-electron.sh    # places files; activates nothing
```

To switch over, add to `~/.config/xdg-desktop-portal/portals.conf`:

```ini
[preferred]
org.freedesktop.impl.portal.FileChooser=symmetria-electron
```

then `systemctl --user restart xdg-desktop-portal`. To switch back, the Qt
build's value is `symmetria`.

⚠ **Check `systemctl --user status xdg-desktop-portal` afterwards.** It
activates the GTK Settings backend synchronously at startup, and if GTK is not
already running that call burns a 75-second D-Bus timeout and systemd may kill
the unit — at which point NO file dialog works anywhere, including the Qt one.
That failure looks like this change broke something and is unrelated to it. See
Critical Pitfalls in `CLAUDE.md`.

## Proven against the real bus

The backend was installed, started on its own name, and driven with a real
D-Bus `OpenFile` — with the Qt backend still preferred throughout, so no system
dialog was ever routed to it:

```
CALL:    OpenFile on the Electron backend
backend: Created FIFO: /tmp/symmetria-picker-9eeeff8e…
backend: Launching createPicker: symmetria-fm-electron-cli createPicker {…}
DISMISS: closing the dialog on /tmp/symmetria-picker-9eeeff8e…
backend: Picker cancelled
REPLY:   code=1 results={} after 3.1s
```

Both backends sat on the bus at once, on separate names, each exposing
`OpenFile`, `SaveFile` and `SaveFiles`. That is the whole chain: D-Bus →
parameterised script → the ELECTRON command-line tool → the daemon → a real
window → the FIFO → a D-Bus reply.

⚠ **The first attempt failed, and the reason is worth keeping.** The daemon had
been running since login, from before the picker existed, and answered
`unknown command: createPicker` — so the portal launched the tool, the tool was
refused, and nothing opened while the caller waited out its timeout. The
systemd unit builds on FIRST RUN ONLY; it does not rebuild on start. **After
changing the daemon, `systemctl --user restart symmetria-fm-electron.service`
or the portal talks to yesterday's code**, and the symptom is a dialog that
never appears rather than an error anybody sees.

## What is still not proven

- **The switch itself.** Nothing has verified that `xdg-desktop-portal` selects
  this backend when told to, because telling it means taking the operator's
  working dialogs down and restarting a session service they are using.
- **Typing a replacement filename** into the save field. There is no window
  manager under a bare virtual display, so `xdotool windowactivate` fails and
  there is no dependable route into that text input. Confirming with the
  suggested name works.
- **The 305-second default picker expiry.** Only the
  `SYMMETRIA_FM_PICKER_LIFETIME_MS` override was exercised; the constant itself
  is pinned by a unit test rather than by observation.
