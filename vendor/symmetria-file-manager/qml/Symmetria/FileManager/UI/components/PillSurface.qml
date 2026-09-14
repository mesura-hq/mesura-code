pragma ComponentBehavior: Bound

import Symmetria.FileManager.UI
import QtQuick
import QtQuick.Effects

// Matte pill primitive — a fill + hairline border capsule. Use it wherever a
// matte capsule surface is wanted: the path breadcrumb, the status bar, the
// active tab.
//
// ⚠ THE DEPTH IS SWITCHED OFF. This started as a claymorphism primitive ported
// from Symmetria Shell's PillSurface, but the file manager and the Symmetria
// IDE moved to a flat aesthetic together and every shadow alpha below is now 0
// — see the neutralization note on the shadow properties. The shell keeps its
// own clay; this component no longer matches it. Everything the rest of this
// header describes about shadows and rim highlights is HISTORICAL, kept so the
// recipe is legible if the direction is ever reversed.
//
// The recipe (what USED TO make the "claymorphism" look):
//   - Two opposing OUTER shadows — dark SE + light NW — produce a convex,
//     extruded "raised chip" feel. Slightly asymmetric offsets (y > x on the
//     dark shadow) read as an overhead light source.
//   - A hairline 1px border — crisp edge definition that survives a busy /
//     transparent backdrop where the shadows alone would wash out.
//   - A top rim highlight (inner gradient) — the "polished, lit-from-above"
//     warmth that distinguishes clay from a flat matte rect.
//
// The matte FILL + border come from FmTheme.pillMedium, which is already a
// line-for-line port of the shell's mattePill() — so the only thing this
// component adds over the FM's previous inline StyledRect pills is the DEPTH
// (the two shadows + the rim highlight). Defaults match the FM's prior inline
// pills, so existing call sites can swap StyledRect -> PillSurface unchanged.
//
// Two usage patterns (same as the shell):
//   1. Content-inside — children declared inside PillSurface { ... } reparent
//      into the body and paint above the rim highlight:
//        PillSurface { RowLayout { anchors.fill: parent; ... } }
//   2. Background-only — give it no children and let siblings paint on top
//      (PillSurface declared first so it renders behind).
//
// Shadow infra is Qt6-native RectangularShadow (QtQuick.Effects) — no Qt5Compat
// GraphicalEffects, no custom shaders. Available since Qt 6.9 (CI floor).
//
// GOTCHA — shadows render OUTSIDE the pill bounds. The two RectangularShadows
// are offset + blurred, so they paint into the area AROUND pillBody, beyond
// this component's own rect. Two consequences:
//   1. Any ANCESTOR with `clip: true` will cut the soft shadow edges off,
//      leaving a flat, sliced-looking pill. If a shadow looks chopped, search
//      up the parent chain for a clip — do NOT "fix" it by shrinking the blur.
//   2. The host Item (a bar/card) must leave margin around the pill for the
//      shadow to occupy (e.g. StatusBar's anchors.*Margin insets, the bars'
//      implicitHeight padding). A pill anchored flush to a tight parent has
//      nowhere to cast its shadow.
// This is inherent to drop-shadow-style depth, not a bug to engineer around.
//
// To retune the aesthetic for ALL pills at once, edit the property defaults
// here; consumers that override a property (e.g. TabBar driving the shadow
// alphas off the active state) keep working because the public API is stable.

Item {
    id: root

    // --- Fill --------------------------------------------------------------
    property color color: FmTheme.pillMedium.background
    property real radius: FmTheme.rounding.full

    // --- Border ------------------------------------------------------------
    // Flat props (not a `border` group) so consumers can bind/animate them
    // directly, matching the shell's PillSurface API.
    property color borderColor: FmTheme.pillMedium.border
    property real borderWidth: 1

    // Master on/off for the clay DEPTH (both shadows + the rim highlight).
    // The matte fill + border stay regardless. Lets a consumer present a flat
    // matte pill (e.g. an inactive tab) and raise it into full claymorphism on
    // a state change, without re-stating the per-shadow alpha constants.
    property bool elevated: true

    // --- Two-shadow convex depth (claymorphic — NEUTRALIZED) ---------------
    // ⚠ EVERY SHADOW ALPHA BELOW IS DELIBERATELY 0. The File Manager and the
    // Symmetria IDE are moving to a flat aesthetic together; see the IDE's
    // `docs/flat-aesthetic-plan.md`. Do NOT "restore" the historical values —
    // the flatness is the intent, not a regression.
    //
    // The OFFSETS and BLURS keep their historical values on purpose: they are
    // inert while the alphas are 0 (a fully transparent shadow paints nothing
    // regardless of geometry), and keeping them makes the clay look
    // recoverable by editing three numbers here plus three in PillCard if the
    // direction is reversed mid-flight. The plan's last phase deletes the
    // shadow machinery outright, and the geometry goes with it.
    //
    // Historical alphas: dark 0.40, light 0.10, highlight 0.08.
    property real darkShadowOffsetX: 2
    property real darkShadowOffsetY: 3
    property real darkShadowBlur: 12
    property real darkShadowAlpha: 0.0

    property real lightShadowOffsetX: -2
    property real lightShadowOffsetY: -2
    property real lightShadowBlur: 8
    property real lightShadowAlpha: 0.0

    // --- Inner rim highlight (clay-derived — NEUTRALIZED) ------------------
    // The top rim was the single cue that most distinguished clay from a flat
    // matte capsule, so it is the first thing to go. See the note above.
    property real highlightAlpha: 0.0
    property real innerShadowAlpha: 0.0

    // Default slot: children reparent into the body and clip-free overlay the
    // rim highlight (declared after it, so they paint on top).
    default property alias content: contentHolder.data

    // Dark shadow (bottom-right) — declared FIRST so it renders furthest back
    // (paint order is declaration order for items without explicit z).
    //
    // `visible` gates on the TOKEN, not on `elevated`. A zero-alpha
    // RectangularShadow is NOT free: it still runs its blur shader over the
    // offset+blurred area every frame, once per instance, and the flat
    // aesthetic leaves every alpha at 0. Gating on the token skips the pass
    // entirely while the preset is flat. It must stay STATIC (the token never
    // changes at runtime) — binding it to `elevated` instead would make the
    // item pop in and out and cut the eased raise/settle below off mid-fade.
    RectangularShadow {
        anchors.fill: pillBody
        radius: pillBody.radius
        blur: root.darkShadowBlur
        spread: 0
        offset.x: root.darkShadowOffsetX
        offset.y: root.darkShadowOffsetY
        visible: root.darkShadowAlpha > 0
        color: Qt.rgba(0, 0, 0, root.elevated ? root.darkShadowAlpha : 0)

        Behavior on color {
            CAnim {}
        }
    }

    // Light shadow (top-left). Same static token gate — see above.
    RectangularShadow {
        anchors.fill: pillBody
        radius: pillBody.radius
        blur: root.lightShadowBlur
        spread: 0
        offset.x: root.lightShadowOffsetX
        offset.y: root.lightShadowOffsetY
        visible: root.lightShadowAlpha > 0
        color: Qt.rgba(1, 1, 1, root.elevated ? root.lightShadowAlpha : 0)

        Behavior on color {
            CAnim {}
        }
    }

    StyledRect {
        id: pillBody

        anchors.fill: parent
        color: root.color
        radius: root.radius
        border.width: root.borderWidth
        border.color: root.borderColor

        // StyledRect already animates `color` via internal CAnim; add the
        // matching behavior for the border so active-state transitions ease.
        Behavior on border.color {
            CAnim {}
        }

        // Inner rim/contact gradient — top rim highlight by default; bottom
        // band off (innerShadowAlpha: 0). Always instantiated so per-instance
        // alpha changes take effect without a Loader.
        Rectangle {
            anchors.fill: parent
            radius: pillBody.radius
            color: "transparent"
            visible: root.elevated && (root.highlightAlpha > 0 || root.innerShadowAlpha > 0)

            gradient: Gradient {
                GradientStop { position: 0.00; color: Qt.rgba(1, 1, 1, root.highlightAlpha) }
                GradientStop { position: 0.45; color: Qt.rgba(1, 1, 1, 0.00) }
                GradientStop { position: 0.55; color: Qt.rgba(0, 0, 0, 0.00) }
                GradientStop { position: 1.00; color: Qt.rgba(0, 0, 0, root.innerShadowAlpha) }
            }
        }

        // Consumer content slot. anchors.fill so children naturally use
        // anchors.fill / anchors.centerIn against the pill bounds.
        Item {
            id: contentHolder
            anchors.fill: parent
        }
    }
}
