pragma ComponentBehavior: Bound

import Symmetria.FileManager.UI
import QtQuick
import QtQuick.Layouts

// PreviewPanel — the normal-mode preview pane (third Miller column).
//
// A thin wrapper around the shared PreviewContent router: it adds the panel
// chrome (background + bottom metadata strip) and a debounce so the preview only
// rebuilds once the user settles on a file. All preview-type routing lives in
// PreviewContent, shared with the fuzzy finder's File Info panel.
Item {
    id: root

    required property var previewEntry  // FileSystemEntry | null
    property WindowState windowState

    // Flash navigation: directory entries exposed for cross-column search.
    // Sourced from PreviewContent's directory sub-preview.
    readonly property var directoryEntries: previewContent.directoryEntries
    readonly property string directoryPath: previewContent.directoryPath

    // Debounced entry — only updated after the user settles on a file, so fast
    // j/k navigation does not spin up a preview per row.
    property var _committedEntry: null

    onPreviewEntryChanged: {
        if (!previewEntry) {
            // Instant clear — "No preview" should appear without delay
            _previewDebounce.stop();
            _committedEntry = null;
        } else {
            _previewDebounce.restart();
        }
    }

    Timer {
        id: _previewDebounce
        interval: 150
        onTriggered: root._committedEntry = root.previewEntry
    }

    // --- Background ---

    StyledRect {
        anchors.fill: parent
        color: FmTheme.layer(FmTheme.palette.surfaceContainerLow)
    }

    // --- Layout: preview area + metadata strip ---

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        PreviewContent {
            id: previewContent

            Layout.fillWidth: true
            Layout.fillHeight: true

            entry: root._committedEntry
            windowState: root.windowState
        }

        // Metadata strip at the bottom
        PreviewMetadata {
            Layout.fillWidth: true
            entry: root._committedEntry
            imageDimensions: previewContent.mediaNaturalSize
            textLanguage: previewContent.textLanguage
            textLineCount: previewContent.textLineCount
            archiveFileCount: previewContent.archiveFileCount
            archiveDirCount: previewContent.archiveDirCount
            spreadsheetSheetCount: previewContent.spreadsheetSheetCount
            spreadsheetActiveSheet: previewContent.spreadsheetActiveSheet
            spreadsheetTotalRows: previewContent.spreadsheetTotalRows
            spreadsheetTotalCols: previewContent.spreadsheetTotalCols
            audioDuration: previewContent.audioDuration
        }
    }
}
