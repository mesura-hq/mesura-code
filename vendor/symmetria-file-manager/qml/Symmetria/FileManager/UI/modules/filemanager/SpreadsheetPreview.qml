import Symmetria.FileManager.UI
import Symmetria.FileManager.Models
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Item {
    id: root

    required property var entry

    // Exposed for PreviewMetadata
    readonly property int sheetCount: spreadsheetModel.sheetCount
    readonly property int activeSheet: spreadsheetModel.activeSheet
    readonly property int totalRows: spreadsheetModel.totalRows
    readonly property int totalCols: spreadsheetModel.totalCols

    SpreadsheetPreviewModel {
        id: spreadsheetModel
        filePath: root.entry ? root.entry.path : ""
    }

    // Imperative update avoids binding loops — QML re-enters declarative bindings
    // when the C++ model emits multiple NOTIFY signals in the same batch
    property bool _isEmpty: false

    function _updateEmpty() {
        _isEmpty = !spreadsheetModel.loading
            && spreadsheetModel.error === ""
            && spreadsheetModel.totalRows === 0
            && spreadsheetModel.filePath !== "";
    }

    // Each signal triggers re-evaluation of the empty-state condition
    Connections {
        target: spreadsheetModel
        function onLoadingChanged() { root._updateEmpty(); }
        function onErrorChanged() { root._updateEmpty(); }
        function onTotalRowsChanged() { root._updateEmpty(); }
        function onFilePathChanged() { root._updateEmpty(); }
    }

    Component.onCompleted: root._updateEmpty()

    readonly property int _colWidth: 120
    readonly property int _rowHeight: 22

    // Use explicit x/y/width/height to fill parent — this component is loaded as a
    // Loader sourceComponent, so anchors.margins on the root would be silently ignored
    // (QUIRKS.md §1). Explicit geometry bindings are not affected by that quirk.
    ColumnLayout {
        x: 0
        y: 0
        width: parent.width
        height: parent.height
        spacing: 0

        // Sheet tabs (only visible for multi-sheet workbooks)
        Row {
            id: sheetTabBar

            visible: spreadsheetModel.sheetCount > 1
            Layout.fillWidth: true
            Layout.leftMargin: FmTheme.padding.sm
            Layout.topMargin: FmTheme.padding.sm
            spacing: 2

            Repeater {
                model: spreadsheetModel.sheetNames

                delegate: Rectangle {
                    required property int index
                    required property string modelData

                    width: tabLabel.implicitWidth + FmTheme.padding.md * 2
                    height: tabLabel.implicitHeight + FmTheme.padding.sm * 2
                    radius: FmTheme.rounding.sm
                    color: (index === spreadsheetModel.activeSheet
                        ? FmTheme.palette.primaryContainer
                        : FmTheme.palette.surfaceContainer) ?? "transparent"

                    StyledText {
                        id: tabLabel

                        anchors.centerIn: parent
                        text: modelData
                        color: (index === spreadsheetModel.activeSheet
                            ? FmTheme.palette.onPrimaryContainer
                            : FmTheme.palette.onSurfaceVariant) ?? FmTheme.palette.onSurface
                        font.pointSize: FmTheme.font.size.sm
                        font.family: FmTheme.font.family.mono
                        font.weight: index === spreadsheetModel.activeSheet ? Font.DemiBold : Font.Normal
                    }

                    MouseArea {
                        anchors.fill: parent
                        cursorShape: Qt.PointingHandCursor
                        onClicked: spreadsheetModel.activeSheet = index
                    }
                }
            }
        }

        // Table area
        Item {
            Layout.fillWidth: true
            Layout.fillHeight: true

            HorizontalHeaderView {
                id: headerView

                syncView: tableView
                anchors.left: parent.left
                anchors.top: parent.top
                clip: true

                delegate: Rectangle {
                    implicitWidth: root._colWidth
                    implicitHeight: root._rowHeight
                    color: FmTheme.palette.surfaceContainerHigh

                    StyledText {
                        anchors.centerIn: parent
                        text: display ?? ""
                        color: FmTheme.palette.onSurfaceVariant
                        font.pointSize: FmTheme.font.size.sm
                        font.family: FmTheme.font.family.mono
                        font.weight: Font.DemiBold
                    }
                }
            }

            TableView {
                id: tableView

                anchors.top: headerView.bottom
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.bottom: parent.bottom
                anchors.leftMargin: FmTheme.padding.sm
                anchors.rightMargin: FmTheme.padding.sm
                anchors.bottomMargin: FmTheme.padding.sm
                clip: true
                focus: false
                interactive: false
                boundsBehavior: Flickable.StopAtBounds
                alternatingRows: true
                columnSpacing: 1
                rowSpacing: 0

                model: spreadsheetModel

                columnWidthProvider: function(column) { return root._colWidth; }
                rowHeightProvider: function(row) { return root._rowHeight; }

                delegate: Rectangle {
                    implicitWidth: root._colWidth
                    implicitHeight: root._rowHeight
                    color: row % 2 === 0
                        ? FmTheme.palette.surfaceContainerLowest
                        : FmTheme.palette.surfaceContainer

                    StyledText {
                        anchors.fill: parent
                        anchors.leftMargin: 6
                        anchors.rightMargin: 6
                        text: display ?? ""
                        elide: Text.ElideRight
                        verticalAlignment: Text.AlignVCenter
                        color: FmTheme.palette.onSurface
                        font.pointSize: FmTheme.font.size.xs
                        font.family: FmTheme.font.family.mono
                    }
                }

                opacity: spreadsheetModel.totalRows > 0 ? 1 : 0

                Behavior on opacity {
                    Anim {}
                }
            }
        }

        // Truncation indicator
        StyledText {
            visible: spreadsheetModel.truncatedRows || spreadsheetModel.truncatedCols
            Layout.alignment: Qt.AlignHCenter
            Layout.bottomMargin: FmTheme.padding.sm
            text: {
                // rowCount()/columnCount() are method calls and are not tracked by the
                // QML binding engine on their own. They are safe here because this
                // binding already depends on truncatedRows/truncatedCols, which change
                // on the same dataReady signal that also updates the row/column counts.
                // The binding always re-evaluates with correct values.
                let parts = [];
                if (spreadsheetModel.truncatedRows)
                    parts.push(qsTr("Showing %1 of %2 rows").arg(spreadsheetModel.rowCount()).arg(spreadsheetModel.totalRows));
                if (spreadsheetModel.truncatedCols)
                    parts.push(qsTr("%1 of %2 columns").arg(spreadsheetModel.columnCount()).arg(spreadsheetModel.totalCols));
                return parts.join(", ");
            }
            color: FmTheme.palette.outline
            font.pointSize: FmTheme.font.size.sm
            font.family: FmTheme.font.family.mono
        }
    }

    // Loading indicator
    Loader {
        anchors.centerIn: parent
        active: spreadsheetModel.loading
        asynchronous: true

        sourceComponent: PreviewLoadingIndicator {}
    }

    // Error state
    Loader {
        anchors.centerIn: parent
        active: spreadsheetModel.error !== ""
        asynchronous: true

        sourceComponent: PreviewStateIndicator {
            iconName: "block"
            message: qsTr("Cannot preview")
        }
    }

    // Empty spreadsheet indicator
    Loader {
        anchors.centerIn: parent
        active: root._isEmpty
        asynchronous: true

        sourceComponent: PreviewStateIndicator {
            iconName: "grid_off"
            message: qsTr("Empty spreadsheet")
        }
    }
}
