pragma ComponentBehavior: Bound

import Symmetria.FileManager.UI
import Symmetria.FileManager.Models
import QtQuick
import QtQuick.Layouts

// PreviewContent — the single source of file-preview routing, shared by the
// normal preview pane (PreviewPanel) and the fuzzy finder (FuzzyFinderPopup).
//
// Given a FileSystemEntry-shaped `entry`, it picks the right preview by MIME /
// flags and stacks one Loader per type (only one active at a time). It owns NO
// debounce, background, or metadata strip — consumers wrap it with those — so a
// new preview type added here lights up in BOTH consumers automatically.
//
// `entry` is duck-typed: a real FileSystemEntry (from a FileSystemModel) or the
// `entry` of a FileInfo element (path → entry). Both expose the same properties.
Item {
    id: root

    required property var entry  // FileSystemEntry-shaped | null
    property WindowState windowState

    // --- Directory sub-preview outputs (flash navigation in PreviewPanel) ---
    property var _directoryEntries: []
    readonly property var directoryEntries: _previewType === _typeDirectory ? _directoryEntries : []
    readonly property string directoryPath: (_previewType === _typeDirectory && entry) ? entry.path : ""

    // --- Preview type constants ---
    readonly property int _typeNone: 0
    readonly property int _typeDirectory: 1
    readonly property int _typeImage: 2
    readonly property int _typeVideo: 3
    readonly property int _typeText: 4
    readonly property int _typeFallback: 5
    readonly property int _typeArchive: 6
    readonly property int _typeSpreadsheet: 7
    readonly property int _typeAudio: 8
    readonly property int _typeRemoteDir: 9
    readonly property int _typeHtmlRender: 10

    // HTML render toggle (Ctrl+R): an HTML file whose render mode is ON, driven by
    // WindowState.htmlRenderActive. Gated on windowState existing — the finder
    // info pane has no key handler to toggle it, so it always shows source there.
    readonly property bool _htmlRenderActive: !!entry && !entry.isDir
        && !!windowState && windowState.htmlRenderActive
        && FileManagerService.isHtmlFile(entry.mimeType)

    readonly property int _previewType: {
        if (!entry)
            return _typeNone;
        if (entry.isDir) {
            if (entry.isRemoteMount)
                return _typeRemoteDir;
            return _typeDirectory;
        }
        if (entry.isImage)
            return _typeImage;
        if (entry.isVideo)
            return _typeVideo;
        if (FileManagerService.isAudioFile(entry.mimeType))
            return _typeAudio;
        if (FileManagerService.isArchiveFile(entry.mimeType))
            return _typeArchive;
        if (FileManagerService.isSpreadsheetFile(entry.mimeType))
            return _typeSpreadsheet;
        // HTML with render mode ON → WebEngine render instead of source. Checked
        // before the isText catch-all (HTML is isText), so toggling flips between
        // _typeText (source) and _typeHtmlRender (rendered) for the same file.
        if (_htmlRenderActive)
            return _typeHtmlRender;
        // Text last — the catch-all for any non-binary file. `entry.isText` is
        // computed in C++ (MIME inheritance from text/plain + a content sniff for
        // unregistered/extensionless configs), so yaml/toml/csv/ini/etc. preview
        // their contents even when no syntax definition exists for highlighting.
        if (entry.isText)
            return _typeText;
        return _typeFallback;
    }

    // --- Metadata outputs (consumed by PreviewMetadata / File Info panel) ---

    // Media natural dimensions — declarative bindings so they update reactively
    readonly property size _imageNaturalSize: imageLoader.item
        ? imageLoader.item.naturalSize
        : Qt.size(0, 0)
    readonly property size _videoNaturalSize: videoLoader.item
        ? videoLoader.item.naturalSize
        : Qt.size(0, 0)
    // Unified media dimensions — image or video, zero otherwise
    readonly property size mediaNaturalSize: _previewType === _typeImage
        ? _imageNaturalSize
        : _previewType === _typeVideo
            ? _videoNaturalSize
            : Qt.size(0, 0)

    readonly property int textLineCount: textLoader.item?.lineCount ?? 0
    readonly property string textLanguage: textLoader.item?.language ?? ""

    readonly property int archiveFileCount: archiveLoader.item?.fileCount ?? 0
    readonly property int archiveDirCount: archiveLoader.item?.dirCount ?? 0

    readonly property int spreadsheetSheetCount: spreadsheetLoader.item?.sheetCount ?? 0
    readonly property int spreadsheetActiveSheet: spreadsheetLoader.item?.activeSheet ?? 0
    readonly property int spreadsheetTotalRows: spreadsheetLoader.item?.totalRows ?? 0
    readonly property int spreadsheetTotalCols: spreadsheetLoader.item?.totalCols ?? 0

    readonly property string audioDuration: audioLoader.item?.audioDuration ?? ""

    // Moving to a different file returns to cheap source view — render mode is
    // per-file and deliberate (Ctrl+R), so Chromium never spins up on plain j/k.
    // Toggling render does not change `entry`, so this does not fight the toggle.
    onEntryChanged: if (windowState) windowState.resetHtmlRender()

    // --- Loaders: one preview per type, only the matching one active ---

    // Empty / no-selection state
    Loader {
        anchors.centerIn: parent
        active: root._previewType === root._typeNone
        asynchronous: true

        sourceComponent: PreviewStateIndicator {
            iconName: "description"
            message: qsTr("No preview")
        }
    }

    // Directory listing
    Loader {
        anchors.fill: parent
        active: root._previewType === root._typeDirectory
        asynchronous: true

        sourceComponent: Item {
            // Empty folder indicator — only when not loading
            Loader {
                anchors.centerIn: parent
                opacity: directoryView.count === 0 && !directoryView.model.loading ? 1 : 0
                active: directoryView.count === 0 && !directoryView.model.loading

                sourceComponent: PreviewStateIndicator {
                    iconName: "folder_open"
                    message: qsTr("Empty folder")
                }

                Behavior on opacity {
                    Anim {}
                }
            }

            // Loading indicator — visible while directory is being scanned
            Loader {
                anchors.centerIn: parent
                opacity: directoryView.model.loading ? 1 : 0
                active: opacity > 0

                sourceComponent: PreviewLoadingIndicator {}

                Behavior on opacity {
                    Anim {}
                }
            }

            ListView {
                id: directoryView

                anchors.fill: parent
                anchors.margins: FmTheme.padding.sm
                clip: true
                focus: false
                interactive: false
                keyNavigationEnabled: false
                currentIndex: -1
                boundsBehavior: Flickable.StopAtBounds

                model: FileSystemModel {
                    path: root.entry?.path ?? ""
                    showHidden: Config.fileManager.showHidden
                    sortBy: root.windowState ? root.windowState.sortBy : FileSystemModel.Modified
                    sortReverse: root.windowState ? root.windowState.sortReverse : true
                    watchChanges: false
                    onEntriesChanged: root._directoryEntries = entries
                }

                delegate: FileListItem {
                    width: directoryView.width
                    flashActive: root.windowState ? root.windowState.flashActive : false
                    flashQuery: root.windowState ? root.windowState.flashQuery : ""
                    flashLabel: root.windowState?.flashPreviewMatchMap[index]?.label ?? ""
                    flashMatchStart: root.windowState?.flashPreviewMatchMap[index]?.matchStart ?? -1
                }
            }
        }
    }

    // Remote directory — static indicator, no I/O
    Loader {
        anchors.centerIn: parent
        active: root._previewType === root._typeRemoteDir
        asynchronous: true

        sourceComponent: ColumnLayout {
            spacing: FmTheme.spacing.md

            MaterialIcon {
                Layout.alignment: Qt.AlignHCenter
                text: "lan"
                color: FmTheme.palette.outline
                font.pointSize: FmTheme.font.size.xxl * 2
                font.weight: Font.Medium
            }

            StyledText {
                Layout.alignment: Qt.AlignHCenter
                text: qsTr("Remote directory")
                color: FmTheme.palette.outline
                font.pointSize: FmTheme.font.size.xl
                font.weight: Font.Medium
            }

            StyledText {
                Layout.alignment: Qt.AlignHCenter
                text: qsTr("Press Enter to browse")
                color: FmTheme.palette.outlineVariant
                font.pointSize: FmTheme.font.size.sm
            }
        }
    }

    // Image preview
    Loader {
        id: imageLoader

        anchors.fill: parent
        active: root._previewType === root._typeImage
        asynchronous: true

        sourceComponent: ImagePreview {
            entry: root.entry
        }
    }

    // Video preview
    Loader {
        id: videoLoader

        anchors.fill: parent
        active: root._previewType === root._typeVideo
        asynchronous: true

        sourceComponent: VideoPreview {
            entry: root.entry
        }
    }

    // Audio preview (mp3, ogg, flac, wav, etc.)
    Loader {
        id: audioLoader

        anchors.fill: parent
        active: root._previewType === root._typeAudio
        asynchronous: true

        sourceComponent: AudioPreview {
            entry: root.entry
            windowState: root.windowState
        }
    }

    // Text preview (source code, config files, etc.)
    Loader {
        id: textLoader

        anchors.fill: parent
        active: root._previewType === root._typeText
        asynchronous: true

        sourceComponent: TextPreview {
            entry: root.entry
        }
    }

    // HTML render preview (Ctrl+R on an .html file) — real WebEngine render.
    // Isolated in its own component so `import QtWebEngine` and the Chromium view
    // only instantiate when this Loader activates, never on plain text preview.
    Loader {
        id: htmlRenderLoader

        anchors.fill: parent
        active: root._previewType === root._typeHtmlRender
        asynchronous: true

        sourceComponent: HtmlPreview {
            entry: root.entry
        }
    }

    // Archive preview (zip, tar, 7z, rar, deb, iso, etc.)
    Loader {
        id: archiveLoader

        anchors.fill: parent
        active: root._previewType === root._typeArchive
        asynchronous: true

        sourceComponent: ArchivePreview {
            entry: root.entry
        }
    }

    // Spreadsheet preview (.xls, .xlsx)
    Loader {
        id: spreadsheetLoader

        anchors.fill: parent
        active: root._previewType === root._typeSpreadsheet
        asynchronous: true

        sourceComponent: SpreadsheetPreview {
            entry: root.entry
        }
    }

    // Fallback preview (non-image, non-directory, non-video, non-text files)
    Loader {
        anchors.fill: parent
        active: root._previewType === root._typeFallback
        asynchronous: true

        sourceComponent: FallbackPreview {
            entry: root.entry
        }
    }
}
