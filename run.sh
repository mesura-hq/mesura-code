#!/usr/bin/env bash
# Dev runner: rebuild + launch the standalone Qt6 host binary.
#
# Useful for iterating on QML / C++ without going through the full
# install path. The binary picks up panel QML from this source tree
# via the SYMMETRIA_FM_PANEL_PATH compile-time define (see
# host/standalone/CMakeLists.txt) — no system reinstall needed for
# QML edits, just rebuild.

set -euo pipefail
cd "$(dirname "$(realpath "$0")")"
cmake -S host/standalone -B host/standalone/build >/dev/null
cmake --build host/standalone/build --parallel "$(nproc)"
exec host/standalone/build/symmetria-fm "$@"
