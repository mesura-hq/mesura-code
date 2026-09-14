# 22 — The desktop integration: entry, unit, and the workspace it lives on

What the resident daemon needs from the desktop, and the exact lines to add. The
entry, the unit and the install script live in this repository; the Hyprland
fragment lives in the operator's dotfiles and is reproduced below so this
document remains readable on its own.

## The identifier contract

Three strings must be `symmetria-fm-electron`, and they fail differently:

| Corner | Where | What breaks when it drifts |
|---|---|---|
| the entry's basename | `symmetria-fm-electron.desktop` | the portal's app-info lookup, silently |
| `desktopName` | `app/package.json` | Chromium's Wayland `app_id`, so the window rule stops matching |
| `StartupWMClass` | inside the entry | nothing here — a launcher and XWayland hint only |

**Only the first two are load-bearing.** Electron 41 has no
`app.setDesktopName()`; it reads the name from `desktopName`, hands it to
Chromium, and Chromium sets `xdg_toplevel.set_app_id` from it. That is what a
compositor rule matches. `StartupWMClass` drives nothing — editing it to fix a
window rule will do nothing at all — and is kept in step only so the three never
disagree. `app/test/desktopEntry.test.ts` asserts all three.

Deliberately **not** `symmetria-fm`, which is the Qt build's. The two run side by
side until parity and the operator uses the Qt one daily.

## The Hyprland fragment

**Already applied**, in `~/.dotfiles/.config/hypr/`, following the pattern the
browser and the editor use. Reproduced here as the record of what was added and
why; Hyprland picks up config changes on its own, so no reload was needed.

```conf
# ── workspaces.conf, beside name:browser and name:agents ──
workspace = name:files

# ── windowrules.conf, beside the zen and mesura-code rules ──
# `silent` is not optional. The operator's own comments on the Zen and Mesura
# Code rules say why: without it every relaunch yanks them off whatever
# workspace they were working on, and this daemon relaunches on every rebuild.
#
# The title exclusion is what keeps a SAVE DIALOG off this workspace. Chromium
# sets the Wayland app id once per PROCESS, from the desktop name, so a dialog
# cannot have an id of its own — the title is the only discriminator there is.
# Without this, every "attach a file" dialog would be dragged here instead of
# appearing over the application that asked for it. The precedent is the Zen
# rule, which excludes Picture-in-Picture in exactly this way for exactly this
# reason: one class, two kinds of toplevel.
#
# ⚠ THIS MAKES THE PICKER'S WINDOW TITLE A CONTRACT. The picker does not exist
# yet; when it is built its title must start with "Choose a file", or it will
# land on the wrong workspace. Whoever changes a window title for cosmetic
# reasons is the person this breaks.
windowrule = workspace name:files silent, match:class ^(symmetria-fm-electron)$, match:title negative:^(Choose a file.*)$

# ── keybindings.conf, beside the Super+B and Super+A group ──
#
# The previous bind on this chord — which LAUNCHED the application directly —
# was REPLACED, not added beside. Hyprland fires every bind matching a chord, so
# leaving both would have meant one press switching workspace AND trying to
# launch a second copy, which the socket would then refuse. Review caught it
# against the live config before it was applied.
#
# Super+E stays with the Qt build, which is still the daily driver. The Electron
# one keeps the secondary binding until the operator moves it deliberately.
bind = Super+Shift, E,       exec, $hyprScripts/switch_workspace.sh name:files
bind = Super+Shift+Ctrl, E,  movetoworkspace,       name:files
```

The launcher that old bind pointed at is now `bin/symmetria-fm-electron` in this
repository, linked onto the PATH by the install script. Nothing needs to launch
it by hand: the systemd unit starts it at login, and after that the workspace is
where you go.

**Nothing raises the window.** That is the point of a named workspace rather than
a scratchpad: the operator switches to where the window lives, using their own
key and their own `switch_workspace.sh`. The application never calls `show()` or
`focus()`, so Wayland's activation-token problem — which the research calls the
hardest problem in this design — is deleted rather than solved.

A scratchpad was considered and rejected, and not by us: `workspaces.conf`
records that the app-owned workspaces "used to be special workspaces (overlays
toggled on top of the current one) and became normal workspaces so their windows
stay visible and countable in the bar."

## Applying it

```bash
./install-desktop-integration.sh    # links the entry, the unit and the CLI; enables the unit
```

The script starts nothing and touches no compositor. The compositor fragment is
already in the dotfiles, so all that remains is to start the daemon — which
happens by itself at the next login, or immediately with
`systemctl --user start symmetria-fm-electron.service`.

## Two things the unit learned the hard way

Both were found the first time it was started for real, and both are in the unit
file with their reasoning.

**Chromium moves its browser process out of the service cgroup.** On a systemd
user session it relocates into a transient scope of its own,
`app-symmetria-fm-electron-<pid>.scope`, so it survives cleanup of whatever
launched it. Right for a desktop launch, wrong for a service: the service cgroup
then holds only the Node wrapper and the zygotes, so `systemctl --user stop`
reaches everything except the process that owns the socket. `ExecStopPost` stops
that scope by glob.

**`Restart=always` plus a correct liveness check is an infinite loop.** With an
orphan holding the socket, every start refused — correctly — and was restarted
two seconds later, six times in twenty seconds, each one paying a full Electron
boot. `RestartPreventExitStatus` says a deliberate refusal is not a crash. The
check was never the broken half.

**That fix was itself wrong the first time, and worse than the bug.** It named
exit `1`, which Node also uses for an uncaught exception and the launcher for a
failed build — so it told systemd to give up after a real crash, which is the
one thing `Restart=always` exists to prevent. The refusal now exits **69**
(`EX_UNAVAILABLE`) and a missing application directory exits **78**
(`EX_CONFIG`); those two are exempt and everything else still restarts.

## Rebuilding before a restart

`CLAUDE.md` carries the rule — rebuild, restart, then report. This is why the
two halves of it are not optional, and it is the long form of what `24-picker.md`
records from the day the daemon answered `unknown command: createPicker`.

**The unit never builds.** `bin/symmetria-fm-electron` runs `pnpm build` only
when the bundle is absent; the comment above that `if` says why. So every run
after the first leaves the build to the caller, and a restart on its own reloads
exactly the code that was already running.

**A test run leaves a DEVELOPMENT bundle behind.** `app/test/build.setup.ts`
spawns the same `pnpm run build`, but it passes `{...process.env}` and pins
nothing, so it inherits vitest's `NODE_ENV=test`. `app/vite.config.ts` has no
mode handling, so that variable alone decides the renderer build: vite skips
minification and keeps React's development build. Measured 2026-09-04 at
743.84 kB against 495.45 kB, and `NODE_ENV=test pnpm build` reproduces the
larger one exactly — same script both times, so do not go looking for a second
build command. Restarting straight after `pnpm -r test` therefore serves that
bundle to the operator's real window.

That second one is a defect in the harness, not a fact of the tools. Setting
`env.NODE_ENV = "production"` in `build.setup.ts`, beside the existing
`delete env.ELECTRON_RUN_AS_NODE`, would remove it and would also make the smoke
test assert against the bundle that actually ships. It is left undone
deliberately: it changes what every test run exercises — minified code and
production React — which can hide a development-only warning or surface a
difference no test currently covers. Worth doing with a measurement, not as a
drive-by.

## Verifying

```bash
systemctl --user status symmetria-fm-electron.service
systemctl --user show-environment | grep WAYLAND_DISPLAY   # must be set, or the daemon cannot paint
hyprctl clients -j | jq -r '.[] | select(.class=="symmetria-fm-electron") | .workspace.name'

# After a stop, nothing should be left holding the socket. This is the ONLY
# check that catches the ExecStopPost glob silently going stale: the line is
# `-` prefixed, so if Chromium ever renames its transient scope the cleanup
# stops matching and keeps reporting success.
systemctl --user stop symmetria-fm-electron.service && sleep 3
ss -lxp | grep symmetria-fm-electron   # want NO output
```

An empty `WAYLAND_DISPLAY` in the user manager is the failure that looks like a
broken application: the unit starts, cannot reach the compositor, and either
restarts on a loop or serves windows nobody can see. It DOES keep restarting —
that failure exits 1, and only 69 and 78 are exempt from `Restart=always`. The
journal is where you will see it; `systemctl --user status` will show a
climbing restart counter.
