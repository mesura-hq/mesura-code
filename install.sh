#!/usr/bin/env bash
# Install Symmetria File Manager — Qt6-native standalone binary + QML modules.
# Idempotent — safe to run multiple times.
#
# What this installs:
#   /usr/lib/qt6/qml/Symmetria/FileManager/Models/  C++ plugin (FileSystemModel,
#                                                   ShellRunner, FileWatcher, …)
#   /usr/lib/qt6/qml/Symmetria/FileManager/UI/      panel QML module
#   /usr/bin/symmetria-fm                           daemon binary
#   /usr/bin/symmetria-fm-cli                       IPC sender CLI
#   /usr/share/icons/hicolor/512x512/apps/          app icon (via cmake --install)
#   /usr/share/applications/                        .desktop entry (via cmake --install)
#   ~/.config/systemd/user/symmetria-fm.service     systemd user unit
#
# After install:
#   systemctl --user enable --now symmetria-fm.service
#   symmetria-fm-cli open ~/Downloads
#
# Or run directly without the daemon:
#   /usr/bin/symmetria-fm

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Symmetria File Manager — Installation ==="
echo "  Project: $PROJECT_DIR"
echo

# 1. Build + install the C++ plugin and panel QML module.
echo "[1/4] Building plugin (C++ + QML module)…"
"$PROJECT_DIR/build-plugin.sh"

# 2. Build + install the standalone host binary and CLI sender.
echo
echo "[2/4] Building standalone host (symmetria-fm + symmetria-fm-cli)…"
cmake -S "$PROJECT_DIR/host/standalone" -B "$PROJECT_DIR/host/standalone/build" >/dev/null
cmake --build "$PROJECT_DIR/host/standalone/build" --parallel "$(nproc)"
sudo cmake --install "$PROJECT_DIR/host/standalone/build"

# 3. Refresh the caches for the assets step 2 just installed, and evict the
#    user-scope copies older versions of this script used to create.
#
#    The .desktop entry and icon are installed by `cmake --install` above, into
#    /usr/share. This script previously copied both into ~/.local/share as well.
#    That is worse than redundant: the user scope takes XDG precedence, so the
#    stale copy wins over the freshly built one and the entry silently stops
#    tracking the repo (this is how an Exec= pointing at the retired QuickShell
#    daemon survived the Qt6 migration). Remove any such leftovers rather than
#    leaving them to shadow the real entry.
echo
echo "[3/4] Refreshing desktop/icon caches…"
rm -f "$HOME/.local/share/applications/symmetria-fm.desktop" \
      "$HOME/.local/share/icons/hicolor/512x512/apps/symmetria-fm.png"
sudo update-desktop-database /usr/share/applications 2>/dev/null || true
sudo gtk-update-icon-cache -f -t /usr/share/icons/hicolor 2>/dev/null || true
echo "  Icon → /usr/share/icons/hicolor/512x512/apps/symmetria-fm.png"
echo "  Desktop entry → /usr/share/applications/symmetria-fm.desktop"

# 4. Install the systemd user unit.
echo
echo "[4/4] Installing systemd user unit…"
mkdir -p "$HOME/.config/systemd/user"
cp "$PROJECT_DIR/symmetria-fm.service" "$HOME/.config/systemd/user/symmetria-fm.service"
systemctl --user daemon-reload
echo "  Unit → ~/.config/systemd/user/symmetria-fm.service"

echo
echo "=== Done ==="
echo
echo "Start the daemon (auto-starts at next login if you enable it):"
echo "  systemctl --user enable --now symmetria-fm.service"
echo
echo "Open a window:"
echo "  symmetria-fm-cli open ~/Downloads"
echo
echo "For the XDG portal integration (file picker for any GTK/Qt app),"
echo "see portal/install-portal.sh."
