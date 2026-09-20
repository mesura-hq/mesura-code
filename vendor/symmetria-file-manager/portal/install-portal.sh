#!/bin/bash
# Install the Symmetria XDG Desktop Portal FileChooser backend.
# This replaces the GTK file dialog with the Symmetria file manager
# for all applications that use the portal (browsers, Electron, etc.).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Symmetria Portal FileChooser — Installation ==="
echo ""

# 1. Set up virtualenv for portal dependencies (avoids --break-system-packages)
VENV_DIR="$HOME/.local/share/symmetria/portal-venv"
if [ ! -f "$VENV_DIR/bin/python3" ]; then
    echo "Creating virtualenv at $VENV_DIR..."
    python3 -m venv "$VENV_DIR"
fi
if ! "$VENV_DIR/bin/python3" -c "import dbus_fast" 2>/dev/null; then
    echo "Installing dbus-fast into virtualenv..."
    "$VENV_DIR/bin/pip" install dbus-fast
fi

# 2. Install portal Python backend to a fixed system path (not dev repo path)
#    Service files reference /usr/lib/symmetria/ so the portal works for any user.
echo "Installing portal backend..."
sudo -A mkdir -p /usr/lib/symmetria
sudo -A cp "$SCRIPT_DIR/symmetria_portal.py" /usr/lib/symmetria/symmetria_portal.py
sudo -A chmod 755 /usr/lib/symmetria/symmetria_portal.py

# 3. Install portal definition
echo "Installing portal definition..."
sudo -A cp "$SCRIPT_DIR/symmetria.portal" /usr/share/xdg-desktop-portal/portals/symmetria.portal

# 3b. Verify the .desktop entry is present. It is installed by the HOST build
#     (host/standalone/CMakeLists.txt), not here — it belongs to the binary, and
#     duplicating the copy in two installers would let the two drift. Without it
#     Qt's portal registration fails ("App info not found for ''") and the FM's
#     own portal requests stay anonymous.
if [ ! -f /usr/share/applications/symmetria-fm.desktop ]; then
    echo "WARNING: /usr/share/applications/symmetria-fm.desktop is missing."
    echo "         Run: $SCRIPT_DIR/../install.sh"
fi

# 4. Install D-Bus service file
echo "Installing D-Bus service file..."
sudo -A cp "$SCRIPT_DIR/org.freedesktop.impl.portal.desktop.symmetria.service" \
    /usr/share/dbus-1/services/org.freedesktop.impl.portal.desktop.symmetria.service

# 5. Install systemd user services
echo "Installing systemd user services..."
mkdir -p ~/.config/systemd/user
cp "$SCRIPT_DIR/xdg-desktop-portal-symmetria.service" ~/.config/systemd/user/
cp "$SCRIPT_DIR/../symmetria-fm.service" ~/.config/systemd/user/

# 6. Update portals.conf to route FileChooser to our backend
PORTALS_CONF="$HOME/.config/xdg-desktop-portal/portals.conf"
echo "Updating $PORTALS_CONF..."
mkdir -p "$(dirname "$PORTALS_CONF")"
# Back up existing config before overwriting to preserve custom settings
if [ -f "$PORTALS_CONF" ]; then
    cp "$PORTALS_CONF" "${PORTALS_CONF}.bak"
    echo "Backed up existing portals.conf to ${PORTALS_CONF}.bak"
fi
cat > "$PORTALS_CONF" << 'EOF'
[preferred]
default=hyprland;gtk
org.freedesktop.impl.portal.FileChooser=symmetria
org.freedesktop.impl.portal.Settings=gtk
EOF

# 7. Reload and restart
echo "Reloading systemd and restarting services..."
systemctl --user daemon-reload
systemctl --user enable --now symmetria-fm.service
systemctl --user enable --now xdg-desktop-portal-symmetria.service
systemctl --user restart xdg-desktop-portal

echo ""
echo "=== Installation complete ==="
echo ""
echo "IMPORTANT: Restart your browsers and Electron apps to use the new file picker."
echo "To test: open any file upload dialog in Firefox or Chrome."
echo ""
echo "To uninstall:"
echo "  sudo -A rm /usr/lib/symmetria/symmetria_portal.py"
echo "  sudo -A rm /usr/share/xdg-desktop-portal/portals/symmetria.portal"
echo "  # NOT /usr/share/applications/symmetria-fm.desktop — that belongs to the"
echo "  # symmetria-fm binary, not to this portal backend. Removing it would break"
echo "  # the file manager's own portal registration while it is still installed."
echo "  sudo -A rm /usr/share/dbus-1/services/org.freedesktop.impl.portal.desktop.symmetria.service"
echo "  rm ~/.config/systemd/user/xdg-desktop-portal-symmetria.service"
echo "  rm -rf ~/.local/share/symmetria/portal-venv"
echo "  # Restore portals.conf from backup: cp ~/.config/xdg-desktop-portal/portals.conf.bak ~/.config/xdg-desktop-portal/portals.conf"
