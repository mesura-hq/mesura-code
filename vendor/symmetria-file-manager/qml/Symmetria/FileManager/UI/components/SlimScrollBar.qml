// 6px rounded-thumb scrollbar shared by the file list and tree views.
// Callers own layout-specific concerns: policy, visibility gating,
// re-parenting and anchoring.

import Symmetria.FileManager.UI
import QtQuick
import QtQuick.Controls

ScrollBar {
    width: 6

    contentItem: Rectangle {
        implicitWidth: 6
        radius: width / 2
        color: FmTheme.palette.onSurfaceVariant
        opacity: 0.4
    }
}
