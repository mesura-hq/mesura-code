---
name: NumberAnimation vs ColorAnimation in QML Behaviors
description: Using Anim (NumberAnimation) on color properties silently produces #000000 — always use CAnim (ColorAnimation) for color/border.color Behaviors
type: feedback
---

**Never use `Anim` (NumberAnimation) in `Behavior on color` or `Behavior on border.color`.** Always use `CAnim` (ColorAnimation) for color properties.

**Why:** `Anim` is a `NumberAnimation` which cannot interpolate color values. When it fires, it produces `#000000` (numeric zero interpreted as black). The property gets stuck at black permanently because subsequent animations from `#000000` → `#000000` are no-ops, so `onColorChanged` never fires again. This is completely silent — no warnings, no errors.

**How to apply:**
- `StyledRect` and `StyledText` already have internal `Behavior on color { CAnim {} }` — do NOT add a redundant `Behavior on color` on instances, as it overrides the correct internal one.
- If you need to animate `border.color` or any other color property, explicitly use `CAnim {}`, not `Anim {}`.
- `Anim` (NumberAnimation) is correct for numeric properties: `width`, `height`, `opacity`, `anchors.margins`, etc.
- The bug manifests as: correct color on first render (Behaviors don't fire during component init), then black on any subsequent change (theme IPC, binding re-evaluation, etc.).

**Diagnostic signature in logs:** `color=#000000 isActive=true expected=#242424` — the binding evaluates correctly but the animated value is wrong.
