#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# The fuzzy finder links the vendored Rust `fff` engine (submodule). Ensure it's
# present before CMake/Corrosion tries to build it.
git submodule update --init --recursive plugin/third_party/fff
cd plugin
cmake -B build
cmake --build build --parallel $(nproc)
sudo cmake --install build
echo "Plugin installed."
if [[ "${1:-}" == "--restart" ]]; then
    echo "Restarting symmetria-fm..."
    systemctl --user restart symmetria-fm
    sleep 2
    systemctl --user status symmetria-fm --no-pager || true
else
    echo "Note: symmetria-fm was NOT restarted. Close any open picker/FM windows first, then run:"
    echo "  systemctl --user restart symmetria-fm"
fi
