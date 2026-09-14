pragma ComponentBehavior: Bound

import Symmetria.FileManager.UI

// CLAYMORPHISM card — the content-framing variant of PillSurface, ported from
// the shell's PillCard. Same recipe (matte fill + hairline border + two-shadow
// convex depth + rim highlight), but tuned for FRAMING content rather than
// being a chip:
//   - rounded corners (rounding.lg) instead of a full capsule
//   - softer, WIDER shadows (more "embedded panel" than "raised chip")
//   - a faint bottom inner-shadow (innerShadowAlpha) for the recessed feel
//
// Implemented as a thin PillSurface with overridden defaults so the depth
// recipe lives in exactly ONE place (PillSurface). It inherits PillSurface's
// `default property alias content`, so `PillCard { SomeChild {} }` reparents
// children into the body just like the shell's standalone card did.
//
// Use it for popups / dialogs / any framed surface. For capsule chips (bars,
// tabs) use PillSurface directly.

PillSurface {
    id: root

    radius: FmTheme.rounding.lg

    // ⚠ EVERY SHADOW ALPHA BELOW IS DELIBERATELY 0 — the flat-aesthetic move
    // shared with the Symmetria IDE. Read the neutralization note in
    // PillSurface.qml before changing anything here; historical alphas were
    // dark 0.28, light 0.07, inner 0.03.
    darkShadowOffsetX: 3
    darkShadowOffsetY: 4
    darkShadowBlur: 14
    darkShadowAlpha: 0.0

    lightShadowOffsetX: -3
    lightShadowOffsetY: -3
    lightShadowBlur: 11
    lightShadowAlpha: 0.0

    innerShadowAlpha: 0.0
}
