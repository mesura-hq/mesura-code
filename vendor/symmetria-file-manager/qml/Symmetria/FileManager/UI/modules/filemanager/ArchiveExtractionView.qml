pragma ComponentBehavior: Bound

import Symmetria.FileManager.UI
import QtQuick
import QtQuick.Layouts

// Archive-extraction progress view — the context menu's "extracting" viewMode.
// Pure presentation: it renders the icon / status line / progress bar from the
// extraction state the parent (ContextMenuPopup) owns and drives. Key handling
// (Enter/Escape to close once done) stays in the parent's _handleExtractingKeys,
// and focus-on-show is handled by the parent Loader's onLoaded.
ColumnLayout {
    id: root

    required property bool extractionDone
    required property string extractionError
    required property int extractedCount
    required property int extractTotalCount

    spacing: FmTheme.spacing.md

    MaterialIcon {
        Layout.alignment: Qt.AlignHCenter
        text: root.extractionDone ? "check_circle" : "unarchive"
        color: root.extractionDone
            ? FmTheme.palette.primary
            : root.extractionError !== ""
                ? FmTheme.palette.error
                : FmTheme.palette.onSurfaceVariant
        font.pointSize: FmTheme.font.size.xxl
        font.weight: Font.Medium
    }

    StyledText {
        Layout.alignment: Qt.AlignHCenter
        text: {
            if (root.extractionError !== "")
                return root.extractionError;
            if (root.extractionDone)
                return "Extraction complete";
            if (root.extractTotalCount > 0)
                return "Extracting… " + root.extractedCount + " / " + root.extractTotalCount;
            return "Preparing…";
        }
        color: root.extractionError !== "" ? FmTheme.palette.error : FmTheme.palette.onSurface
        font.pointSize: FmTheme.font.size.sm
    }

    // Progress bar
    StyledRect {
        Layout.fillWidth: true
        Layout.preferredHeight: 4
        radius: 2
        color: Qt.alpha(FmTheme.palette.onSurface, 0.06)

        StyledRect {
            height: parent.height
            radius: parent.radius
            color: root.extractionError !== "" ? FmTheme.palette.error : FmTheme.palette.primary
            width: root.extractTotalCount > 0
                ? parent.width * Math.min(root.extractedCount / root.extractTotalCount, 1)
                : 0

            Behavior on width { Anim {} }
        }
    }

    StyledText {
        Layout.alignment: Qt.AlignHCenter
        visible: root.extractionDone || root.extractionError !== ""
        text: "Press Enter or Escape to close"
        color: FmTheme.palette.outline
        font.pointSize: FmTheme.font.size.xs
    }
}
