#!/usr/bin/env bash
# Install the Electron file manager as an XDG portal FileChooser backend —
# and DO NOT switch to it.
#
# Only one backend may own `org.freedesktop.impl.portal.FileChooser`, and the
# Qt build owns it today. The operator uses those dialogs every day, so this
# script places files and claims nothing: `portals.conf` is the one thing that
# decides which backend answers, and this never writes it. The line to add is
# printed at the end, for whoever decides to switch.
#
# It runs the SAME `symmetria_portal.py` the Qt backend runs. The two differ in
# two environment variables, set in the systemd unit — see that file.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
units="$HOME/.config/systemd/user"

echo "Installing the Electron portal backend (it will NOT become active):"

# The shared script. Both backends run this exact file from this exact path,
# which is why writing it here is not a collision: the bytes are the same and
# they come from the same source. Only the REGISTRATION differs per backend,
# and this script touches none of the Qt build's.
sudo install -Dm755 "$here/symmetria_portal.py" /usr/lib/symmetria/symmetria_portal.py
echo "  /usr/lib/symmetria/symmetria_portal.py  (shared with the Qt backend)"

sudo install -Dm644 "$here/symmetria-electron.portal" \
  /usr/share/xdg-desktop-portal/portals/symmetria-electron.portal
echo "  /usr/share/xdg-desktop-portal/portals/symmetria-electron.portal"

sudo install -Dm644 "$here/org.freedesktop.impl.portal.desktop.symmetria-electron.service" \
  /usr/share/dbus-1/services/org.freedesktop.impl.portal.desktop.symmetria-electron.service
echo "  /usr/share/dbus-1/services/…symmetria-electron.service"

mkdir -p "$units"
install -Dm644 "$here/xdg-desktop-portal-symmetria-electron.service" \
  "$units/xdg-desktop-portal-symmetria-electron.service"
echo "  $units/xdg-desktop-portal-symmetria-electron.service"

systemctl --user daemon-reload

# The Python dependency the script needs, in the venv the Qt backend already
# uses. Reported rather than created: if the Qt backend is installed this
# already exists, and if it is not, the operator should run its installer once.
venv="$HOME/.local/share/symmetria/portal-venv"
if [ ! -x "$venv/bin/python3" ]; then
  echo
  echo "NOTE: $venv is missing. Run portal/install-portal.sh once to create it;"
  echo "      both backends share that virtual environment and its dbus-fast."
fi

cat <<'NEXT'

Installed, and NOT active. The Qt backend still answers every file dialog.

To switch over, add this to ~/.config/xdg-desktop-portal/portals.conf:

    [preferred]
    org.freedesktop.impl.portal.FileChooser=symmetria-electron

then `systemctl --user restart xdg-desktop-portal`. To switch back, restore
the previous value — the Qt build's is `symmetria`.

Check `systemctl --user status xdg-desktop-portal` afterwards. It activates the
GTK Settings backend synchronously at startup, and if GTK is not already
running that call burns a 75-second D-Bus timeout and systemd may kill the
unit — at which point NO file dialog works anywhere, including the Qt one.
That failure looks like this change broke something and is unrelated to it.
NEXT
