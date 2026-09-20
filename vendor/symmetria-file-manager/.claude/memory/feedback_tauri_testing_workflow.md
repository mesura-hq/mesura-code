---
name: feedback_tauri_testing_workflow
description: "How to run/test the Tauri FM without disturbing the user's desktop, and how to keep the QML FM available"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4e08950a-d890-400a-9fb5-3dcbd6574dce
---

When testing the Tauri FM (`app-tauri/`), launch it onto **Hyprland workspace
7, silently**, so it never steals focus from the user's active workspace.

**Why:** the user uses the QML FM daily and works across other workspaces;
test windows popping onto the active workspace interrupt them. ws7 is the
external-monitor workspace (falls back to laptop when HDMI unplugged); the
`[workspace 7 silent]` exec rule maps the window there without switching view.

**How to apply:**
- `app-tauri/scripts/test-fm.sh` — launch Tauri FM on ws7 silent (dev
  hot-reload default; `--build` / `--stop` variants). Routing is guaranteed by
  a PERSISTENT Hyprland windowrule (`workspace 7 silent` + `no_initial_focus
  true` + `render_unfocused true` for class `symmetria-fm-tauri`, in
  machine-local `~/.config/hypr/workspaces.conf` — see [[project_tauri_pivot]]
  for the 0.55 syntax gotcha), plus a per-launch `[workspace 7 silent]` exec
  prefix as a fallback. `no_initial_focus`+`"focus":false` stop the window
  stealing focus (else it yanks the view to ws7 despite `silent`).
- `app-tauri/scripts/open-qml-fm.sh [path]` — open the daily-driver QML FM
  (runs the installed `symmetria-fm.service`; fully isolated from the branch).
- `app-tauri/scripts/screenshot-ws7.sh` — visual QA; **non-intrusive** and
  position/workspace-independent. Moves ONLY the FM window (by address) to a
  temporary headless monitor's own workspace via silent dispatches, focuses it
  (WebKitGTK paints content only when focused; render_unfocused keeps the
  window warm, not the content), grims its rect, moves it back. Works wherever
  the FM is and whichever workspace you're viewing; your view never changes.
  (Isolating the single window beats moving all of ws7 — ws7 tiles the FM next
  to other windows and can shove it off-canvas.)

**Gotchas learned:**
- **Keyboard behavior can't be driven by synthetic input** — screenshots verify
  STATIC rendering only. `hyprctl dispatch sendshortcut` injects into Hyprland's
  keybind-dispatch layer; it never becomes a `wl_keyboard` event on the surface,
  so the WebKitGTK webview (React `onKeyDown`) never sees it (proven: `j`×5 →
  cursor didn't move). `wtype` *does* make a virtual keyboard but renegotiates
  the keymap (NumLock/layout-changed notifications), so keys land under a
  transient layout. Net: to verify a keyboard feature (chords, the goto menu),
  rely on vitest unit tests + the user's real-keyboard pass; use a screenshot
  only to confirm the app loads cleanly (no white-screen) and static layout.
- `hyprctl dispatch exec` runs from Hyprland's cwd — `cd` into app-tauri
  inside the spawned shell.
- NEVER `pkill -f` a pattern that appears in your own command line (e.g.
  `pkill -f 'tauri dev'` self-kills the shell, exit 144). Match by relative
  binary path (`target/debug/symmetria-fm-tauri`, etc.) or port owner instead.
- The bare debug binary needs a built `dist/` (Tauri embeds the frontend at
  compile time); use `npm run tauri dev` (Vite-served) for reliable runs.
- The QML FM is fully isolated: service loads `/usr/bin/symmetria-fm` + the
  root-owned `/usr/lib/qt6` QML copy — branch/working-tree edits can't break it.

See [[project_tauri_pivot]].
