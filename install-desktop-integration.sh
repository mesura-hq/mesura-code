#!/usr/bin/env bash
#
# Put the Electron file manager's desktop integration in place.
#
# ONE REAL FILE, NO COPIES. The desktop entry, the unit and the command-line
# tool are canonical in this repository — they name a binary this repository
# builds, so they version with it — and this script symlinks them into the
# places XDG and systemd read. Nothing is duplicated into the dotfiles.
#
# That is a deliberate answer to a recorded defect: the Qt build's unit exists
# in TWO unsynced copies, one here and one in ~/.dotfiles, and they drifted. A
# symlink cannot drift.
#
# WHAT THIS SCRIPT DOES NOT DO, and each omission is deliberate:
#   * It does not START the service. The Hyprland rules are written but not
#     applied until the operator reloads, so a daemon started now would map its
#     window onto whatever workspace they are working on. It starts at their
#     next login, by which time the compositor knows where to put it.
#   * It does not touch the compositor. No `hyprctl reload`, no dispatch.
#   * It does not touch the Qt build, its unit, its socket or its keybinding.
#
# The user location is correct here, and that is worth stating because the Qt
# build does the opposite. CLAUDE.md records that the Qt desktop entry must go
# to /usr, because a ~/.local/share copy takes XDG precedence and goes stale.
# That reasoning is about a PACKAGED application with a system install. This one
# is built from a working tree and has no system install, so /usr would be the
# stale copy and the user location is the only honest home for it.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

applications="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
bindir="$HOME/.local/bin"

mkdir -p "$applications" "$units" "$bindir"

link() {
  # `-n` so a re-run replaces the link rather than creating one INSIDE the
  # directory the old link points at, which is what `ln -sf` does to an
  # existing symlink-to-a-directory and is a genuinely confusing failure.
  ln -sfn "$1" "$2"
  printf '  %s -> %s\n' "$2" "$1"
}

echo "Linking:"
link "$repo/symmetria-fm-electron.desktop" "$applications/symmetria-fm-electron.desktop"
link "$repo/symmetria-fm-electron.service" "$units/symmetria-fm-electron.service"
link "$repo/app/bin/symmetria-fm-electron-cli.mjs" "$bindir/symmetria-fm-electron-cli"
link "$repo/bin/symmetria-fm-electron" "$bindir/symmetria-fm-electron"

# Refresh the desktop database so the MimeType association is seen. Harmless
# where the tool is absent, which is why the failure is swallowed.
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$applications" 2>/dev/null || true
fi

echo
# The unit carries Restart=always, so enabling it against a missing binary
# would restart-loop forever at the next login with nothing pointing at the
# cause. Review found the ExecStart target used to live outside this
# repository entirely; it is linked above now, and this refuses to proceed if
# that ever stops being true.
if [ ! -x "$bindir/symmetria-fm-electron" ]; then
  echo "ERROR: $bindir/symmetria-fm-electron is missing or not executable." >&2
  echo "The unit would restart-loop. Not enabling it." >&2
  exit 1
fi

# The desktop entry runs the tool BY NAME, so the launcher directory has to be
# on the PATH a launcher hands it. A warning rather than an error: a portal or
# an application menu usually has a fuller PATH than this shell.
case ":$PATH:" in
  *":$bindir:"*) ;;
  *) echo "NOTE: $bindir is not on this shell's PATH; the .desktop entry needs it on the session PATH." >&2 ;;
esac

echo "Registering the unit (this starts nothing):"
# Both of these are non-disruptive. `daemon-reload` re-reads unit files and
# restarts no running service; `enable` writes a wants-symlink and starts
# nothing. The daemon comes up at the next login.
systemctl --user daemon-reload
systemctl --user enable symmetria-fm-electron.service

cat <<'NEXT'

Done. Two things are left, and they are yours because they change the session:

  1. Add the Hyprland fragment from
     docs/electron-transition/22-desktop-integration.md
     to ~/.dotfiles/.config/hypr/, then reload the compositor.

  2. Log out and back in, or start the daemon by hand once the compositor
     knows where to put its window:
         systemctl --user start symmetria-fm-electron.service

  Check afterwards with:
         systemctl --user status symmetria-fm-electron.service
         systemctl --user show-environment | grep WAYLAND_DISPLAY
NEXT
