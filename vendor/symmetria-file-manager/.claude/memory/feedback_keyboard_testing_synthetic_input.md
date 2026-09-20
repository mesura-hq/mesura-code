---
name: feedback_keyboard_testing_synthetic_input
description: "QML keyboard/chord features can't be verified via synthetic compositor input — use the real keyboard or QTest"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4e08950a-d890-400a-9fb5-3dcbd6574dce
---

Keyboard-driven features (vim chords, j/k nav, the `g`-chord which-key, the
`ChordHandler.js` logic) cannot be verified by injecting synthetic input from the
compositor.

**Why:** `hyprctl dispatch sendshortcut` targets Hyprland's keybind-dispatch
layer, NOT the focused surface — it never becomes a `wl_keyboard` event the app
receives. Proven for the WebKitGTK webview (j×5 left the cursor unmoved); the same
mechanism means a Qt/QML window won't receive it either. `wtype` DOES create a real
virtual keyboard, but it renegotiates the keymap (NumLock/layout-changed churn), so
keys land under a transient layout.

**How to apply:** to validate a QML keyboard/chord change, rely on (1) the user's
real keyboard, or (2) C++ QTest where the logic can be exercised directly. A
screenshot only confirms static rendering, not key handling. Don't burn time trying
to drive the FM's keyboard from a script. See [[feedback_tauri_testing_workflow]].
