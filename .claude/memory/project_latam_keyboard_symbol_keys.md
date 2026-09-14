---
name: project_latam_keyboard_symbol_keys
description: "User runs the latam keyboard layout; symbol keys arrive with modifiers, so KeyRegistry symbol bindings must use mods:\"*\""
metadata: 
  node_type: memory
  type: project
  originSessionId: 766282a9-de01-48b5-a881-6e1a93d66d89
---

The user's Hyprland `input:kb_layout` is **`latam` (Spanish Latin-American)**. On
that layout many punctuation glyphs are NOT base-level: `/` = Shift+7, `=` =
Shift+0, `[`/`]` = Shift/AltGr. So a `/` keypress reaches Qt as
`Qt.Key_Slash` **with `Qt.ShiftModifier` set**, not bare.

This is non-derivable from the repo and explains a whole bug class: any
keybinding on a symbol glyph that requires a specific modifier set (`mods: ""`)
will silently do nothing, because the event carries the layout's
glyph-producing modifier. That is exactly what broke `/`-search after the
keybinding-registry migration (the old per-view `switch` matched on
`event.key` alone, ignoring modifiers; the registry added strict mod matching).

**Rule (now enforced in code):** in `KeyRegistry.js`, every symbol-glyph binding
(`/ ? ~ - = [ ] . ,`) uses `mods: "*"` (ignore modifiers). Letters and real
chords keep precise mods — there the modifier IS the user's intent. The header
of `KeyRegistry.js` documents this; `tst_keyregistry.qml` fires the glyphs WITH
Shift to lock it in, validates `mods` is a legal enum value, and `_assertNoCollision`
expands `"*"` to all concrete combos so a `*`-vs-specific shadow fails the test.

**How to apply:** when adding/reviewing any symbol/punctuation keybinding, default
to `mods: "*"`, never `""`. When debugging "a key does nothing," suspect a
layout-modifier mismatch first — check `hyprctl getoption input:kb_layout` and the
compiled keymap (`xkbcli compile-keymap --layout latam`) for the glyph's level.
Synthetic input can't verify this (see [[feedback_keyboard_testing_synthetic_input]]);
rely on the routing test instead. Related: [[project_keybinding_registry]].
