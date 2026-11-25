#!/bin/sh
# Mesura Code @CHANNEL@ launcher, staged by scripts/mesura-channel/stage.ts with the channel substituted.
# A staged ~/Applications/Mesura-Code-<Channel>.next.AppImage becomes the current image at the next
# cold start; the replaced image is kept as .prev for rollback. While the current image is mounted
# (the app runs), the arguments go to the running instance and nothing is swapped.
# Identity comes from the packaged channel, never from XDG_* variables: those leak into every agent
# the app starts (F12).
set -eu
channel="@CHANNEL@"
initial=$(printf '%.1s' "$channel" | tr '[:lower:]' '[:upper:]')
image="$HOME/Applications/Mesura-Code-$initial${channel#?}.AppImage"
next="$HOME/Applications/Mesura-Code-$initial${channel#?}.next.AppImage"
state="$HOME/.local/state/mesura-code-$channel"
mkdir -p "$state"
log="$state/launch.log"
self=$(readlink -f -- "$0")

# stage.ts and the Lab reset hold this lock while they publish a build or rebuild Lab's database.
exec 9>"$state/channel.lock"
if ! flock -w "${MESURA_CHANNEL_LOCK_WAIT_SECONDS:-900}" 9; then
  echo "$(date -u +%FT%TZ) gave up waiting for $state/channel.lock" >>"$log"
  exit 75
fi

running=false
if [ -e "$image" ] && command -v findmnt >/dev/null 2>&1 &&
  findmnt -rn -o SOURCE | grep -Fxq "$(basename "$image")"; then
  running=true
fi

if [ -e "$next" ] && [ "$running" = false ]; then
  if [ -e "$image" ]; then mv -f "$image" "$image.prev"; fi
  mv -f "$next" "$image"
  echo "$(date -u +%FT%TZ) activated the staged build" >>"$log"
fi

# The app becomes this process (exec below). Until the AppImage runtime has exec'd it with APPIMAGE
# set, the Lab reset's process scan cannot see it, so a helper keeps the lock until then (60 s at
# most) or until the process is gone. An APPIMAGE this shell inherited does not count.
launcher_pid=$$
launcher_exe=$(readlink "/proc/$launcher_pid/exe")
(
  waited=0
  while [ -e "/proc/$launcher_pid" ] && [ "$waited" -lt 300 ]; do
    if [ "$(readlink "/proc/$launcher_pid/exe" 2>/dev/null)" != "$launcher_exe" ] &&
      tr '\0' '\n' <"/proc/$launcher_pid/environ" 2>/dev/null | grep -q '^APPIMAGE='; then
      break
    fi
    sleep 0.2
    waited=$((waited + 1))
  done
) </dev/null >/dev/null 2>&1 &

unset ELECTRON_RUN_AS_NODE APPIMAGE APPDIR ARGV0 OWD LD_LIBRARY_PATH
# An inherited home or port override would point this channel at another channel's database.
unset T3CODE_HOME T3CODE_PORT
# The desktop entry the app writes then starts this launcher, so menu starts activate staged builds.
export T3CODE_DESKTOP_LAUNCHER_PATH="$self"
# Arguments can carry one-time pairing tokens; log only their count.
echo "$(date -u +%FT%TZ) start with $# argument(s)" >>"$log"
exec "$image" "$@" >>"$log" 2>&1 9>&-
