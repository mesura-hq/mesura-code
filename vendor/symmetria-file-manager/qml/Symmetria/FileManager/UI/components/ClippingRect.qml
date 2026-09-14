// Replaces Quickshell.Widgets.ClippingRectangle with a plain-Qt clip-enabled
// Rectangle. Note: Qt's `clip: true` clips children to the bounding box, not
// to rounded corners — for the StateLayer ripple use case the rectangular
// clip is good enough (the parent's actual rendering masks the rounded edges
// at the pixel level). If pixel-perfect rounded clipping becomes needed, swap
// for a layer-based mask using QtQuick.Effects.OpacityMask.
import QtQuick

Rectangle {
    id: root

    color: "transparent"
    clip: true

    Behavior on color {
        CAnim {}
    }
}
