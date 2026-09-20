---
name: project_first_window_workspace_bug
description: "Fixed — FM's first window after login opened on Hyprland workspace 1; cause was a stale HL_INITIAL_WORKSPACE_TOKEN inherited by the daemon"
metadata: 
  node_type: memory
  type: project
  originSessionId: 3008e5e2-bb7d-4b8c-8bf4-d36c0b09fb3f
---

**Symptom (FIXED 2026-06-13):** The *first* file-manager window after login always
opened on Hyprland **workspace 1** regardless of the active workspace; every
subsequent window opened correctly.

**Root cause:** `symmetria-fm` is a long-lived daemon started by systemd at login.
It inherited Hyprland's session-minted `HL_INITIAL_WORKSPACE_TOKEN` (encoding the
login workspace = 1). Hyprland reads that token from the client's
`/proc/<pid>/environ` and, with `misc:initial_workspace_tracking=1` (its *default*,
not set in the user's hypr config), routes the process's FIRST mapped window to the
token's recorded workspace. The token is single-shot (value 1) — consumed by the
first window or expiring after 2 min — hence "only the first time". This is the
behaviour of Hyprland issue #5919; maintainer's blunt fix is to disable the feature
globally (`misc:initial_workspace_tracking = 0`).

**Why the obvious in-process fix fails:** an `unsetenv()`/`qunsetenv()` in
`main.cpp` would NOT work — Hyprland reads `/proc/<pid>/environ`, the exec-time
environment block, which `unsetenv` does not rewrite. The token must be removed
*before* exec.

**Fix applied (targeted, not the global disable):** added
`UnsetEnvironment=HL_INITIAL_WORKSPACE_TOKEN` to the `[Service]` section of
`symmetria-fm.service`. Full rationale is in the comment in that file.

**Gotcha — TWO copies of the unit:** the repo's `symmetria-fm.service` and
`~/.dotfiles/.config/systemd/user/symmetria-fm.service` are independent
byte-identical files (NOT symlinked to each other). The dotfiles copy is the one
symlinked into `~/.config/systemd/user/` and is what systemd actually loads. Edit
BOTH or they drift. Takes effect on the next daemon start (next login), so no
disruptive restart was needed. Related: [[feedback_restart_service]].
