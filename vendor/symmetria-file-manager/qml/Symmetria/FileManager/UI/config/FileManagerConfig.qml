import QtQuick

QtObject {
    property bool showHidden: true
    property string iconMode: "system" // "material" | "system"

    // HTML render preview (Ctrl+R): run page JavaScript when rendering an .html
    // file. OFF by default — a rendered preview should be inert and safe (a local
    // file can't phone home because localContentCanAccessRemoteUrls is also off in
    // HtmlPreview). Flip this on only if you preview JS-built pages and accept
    // that the file's scripts will execute. See HtmlPreview.qml for the sandbox.
    property bool htmlPreviewJavaScript: false

    property Sizes sizes: Sizes {}

    component Sizes: QtObject {
        property int windowWidth: 820
        property int windowHeight: 520
        property int itemHeight: 20
        property real overlayViewportFraction: 0.85 // ratio 0–1: fraction of viewport covered by the overlay
    }
}
