---
name: project_keybinding_registry
description: Normal-mode keybindings are now a data registry (KeyRegistry.js) feeding both dispatch and the ? help popup
metadata: 
  node_type: memory
  type: project
  originSessionId: 28b99fad-3d22-499b-89f4-839b9494e3c6
---

Completed 2026-06-14: migrated the file manager's keyboard handling from scattered
`switch` statements to a **declarative registry** (`handlers/KeyRegistry.js`) that
is the single source of truth for normal-mode bindings. Both the dispatcher and a
new `?`-triggered cheat-sheet (`HelpPopup.qml`) read it — add a binding once, it
works in both views AND self-documents. Full architecture is in CLAUDE.md →
"Keyboard Event Handling"; this memory holds only the non-obvious context.

**Why it was built this way (design decisions not visible in the diff):**
- `KeyRegistry.js` is **not** `pragma library` on purpose — a library has no QML
  scope, so it couldn't see `Qt`/singletons. It's a normal scope-sharing handler
  imported by both views; that's what lets TREE_ONLY runs reach `TreeModel.*` and
  MILLER_ONLY runs reach `NormalModeHandler.*` via each importer's scope.
- Singletons are dependency-injected through `ctx.services` so `dispatch()` is
  hermetically unit-testable — that's the whole reason `KeyRegistryTest` (a
  Qt Quick Test, the project's FIRST QML test) can run with pure stubs and no
  UI-module load. It's the safety net that made the dispatch swap low-risk.
- `FileOpsHandler.js` was DELETED — its picker suppression became the dispatch
  pre-pass and its ops/paste became registry rows.

**Deliberate, negligible behavior changes** (don't "fix" these as regressions):
- modified-Enter (Ctrl/Shift+Enter) in the TREE no longer just "activates" (the
  old tree switch matched Enter mods-agnostically). Bare Enter still activates.
- Miller Ctrl+R *outside* picker-save-mode is no longer swallowed — the old
  Miller switch accepted every `Key_R`; now Ctrl+R only matches when
  `pickerSaveMode` is true (edit-save-name), so otherwise it falls through
  unconsumed. Harmless (nothing upstream binds Ctrl+R).
- Picker Shift+Enter (copy-path-then-confirm) and Ctrl+R-in-save-mode WERE
  preserved as explicit bindings.

**Status / caveats:**
- Verified: full `check-qml.sh` (baseline 63, no regression), all `ctest`
  including `KeyRegistryTest`, plus an offscreen render smoke of HelpPopup. NOT
  yet runtime-tested by real keypresses — synthetic input can't reach the Qt
  surface (see [[feedback_keyboard_testing_synthetic_input]]); the user verifies
  `?` + nav/ops by hand.
- `FuzzyFinderTest` is **flaky** under the full `ctest` run (passes alone /
  on re-run) — pre-existing LMDB/frecency contention, unrelated to this work.
- As of hand-off this was NOT committed (work done under [[feedback_autonomous_restart_consent]]).
