pragma ComponentBehavior: Bound

import Symmetria.FileManager.UI
import QtQuick
import QtWebEngine

// HtmlPreview — renders an .html/.xhtml file as an actual page via WebEngine,
// the "real browser" counterpart to TextPreview's highlighted source. Reached
// only when the user presses Ctrl+R on an HTML file (WindowState.htmlRenderActive)
// — never on plain navigation — so the heavyweight Chromium view spins up on
// explicit intent, not per j/k.
//
// SANDBOX (why this is safe to auto-render on a keystroke):
//   • javascriptEnabled  — OFF by default (Config.fileManager.htmlPreviewJavaScript).
//     Static pages render fine; JS-built pages render blank unless the user opts in.
//   • localContentCanAccessRemoteUrls: false — the local file CANNOT fetch ANY
//     remote resource (trackers, remote CSS/JS/img, beacons). It cannot phone home.
//   • off-the-record profile + NoCache — zero disk trace (no cookies/cache/history).
//   • LinkClickedNavigation is ignored — this stays a PREVIEW, not a mini-browser.
//
// HOST REQUIREMENT: instantiating a WebEngineView requires the host to have called
// QtWebEngineQuick::initialize() in main() before the QML engine loads (the
// standalone symmetria-fm host does). An embedding host that has NOT initialized
// WebEngine will fail to render here — importing the module is fine, only
// instantiation needs the init. See host/standalone/main.cpp.
Item {
    id: root

    required property var entry  // FileSystemEntry-shaped | null

    // file:// URL for the previewed path. A literal `%` in the name is escaped
    // FIRST (before encodeURI, which does not touch `%` and would otherwise leave
    // a stray `%NN`-looking sequence — so `50%.html` failed to load); encodeURI
    // then handles spaces etc.; `#`/`?` are escaped last so a name containing them
    // isn't parsed as URL fragment/query. Empty string → WebEngine loads blank.
    readonly property url _fileUrl: entry
        ? "file://" + encodeURI(entry.path.replace(/%/g, "%25"))
            .replace(/#/g, "%23").replace(/\?/g, "%3F")
        : ""

    // Load-error flag, flipped by the WebEngineView's onLoadingChanged below.
    property bool _loadFailed: false

    WebEngineView {
        id: webView

        anchors.fill: parent
        url: root._fileUrl
        // Faithful page background: browsers default to white for pages with no
        // background, so match that rather than let the dark FM backdrop bleed
        // through pages that assume white.
        backgroundColor: "white"

        // Never take keyboard focus: the Miller list must keep it so Ctrl+R (exit
        // render) and j/k (which reset render via onEntryChanged) always reach the
        // view's Keys.onPressed and are not swallowed by Chromium. This is a
        // preview, not an interactive browser surface.
        activeFocusOnPress: false

        // Off-the-record, cache-less profile — the preview leaves no trace.
        profile: WebEngineProfile {
            offTheRecord: true
            httpCacheType: WebEngineProfile.NoCache
        }

        // NOTE: WebEngine reads settings.* at page-LOAD time, so flipping the
        // config below re-applies only on the next render (re-navigate / re-toggle),
        // not to an already-loaded page. Fine here — the config is edited rarely.
        settings.javascriptEnabled: Config.fileManager.htmlPreviewJavaScript
        settings.localContentCanAccessRemoteUrls: false  // no phoning home
        // Sibling css/img/js load from disk. A hostile file CAN reference other
        // local files (e.g. file:///~/.ssh/...), but with remote access AND JS
        // both off there is no channel to exfiltrate them — accepted trade-off.
        settings.localContentCanAccessFileUrls: true
        settings.focusOnNavigationEnabled: false  // don't grab focus on load (see activeFocusOnPress)
        settings.javascriptCanOpenWindows: false
        settings.pluginsEnabled: false
        settings.screenCaptureEnabled: false
        settings.errorPageEnabled: false

        // Keep it a preview: allow only the initial local file load; ignore link
        // clicks, form submits, and any hop to another document.
        onNavigationRequested: function(request) {
            if (request.navigationType !== WebEngineNavigationRequest.TypedNavigation)
                request.action = WebEngineNavigationRequest.IgnoreRequest;
        }

        // Drives the error state below (file gone, decode failure, etc.).
        onLoadingChanged: function(loadRequest) {
            if (loadRequest.status === WebEngineView.LoadFailedStatus)
                root._loadFailed = true;
            else if (loadRequest.status === WebEngineView.LoadStartedStatus)
                root._loadFailed = false;
        }
    }

    // Loading indicator — while WebEngine fetches/lays out the page
    Loader {
        anchors.centerIn: parent
        active: webView.loading
        asynchronous: true
        sourceComponent: PreviewLoadingIndicator {}
    }

    // Error state — file gone, decode failure, etc.
    Loader {
        anchors.centerIn: parent
        active: root._loadFailed
        asynchronous: true
        sourceComponent: PreviewStateIndicator {
            iconName: "block"
            message: qsTr("Cannot render")
        }
    }

    // Mode hint — tells the user they're in render mode and how to leave it.
    Rectangle {
        anchors.top: parent.top
        anchors.right: parent.right
        anchors.topMargin: FmTheme.padding.sm
        anchors.rightMargin: FmTheme.padding.sm
        width: hintRow.implicitWidth + FmTheme.padding.md * 2
        height: hintRow.implicitHeight + FmTheme.padding.sm * 2
        radius: FmTheme.rounding.sm
        color: Qt.rgba(0, 0, 0, 0.72)
        visible: !webView.loading && !root._loadFailed

        Row {
            id: hintRow
            anchors.centerIn: parent
            spacing: FmTheme.spacing.sm

            MaterialIcon {
                anchors.verticalCenter: parent.verticalCenter
                text: "html"
                color: "white"
                font.pointSize: FmTheme.font.size.xs
            }
            StyledText {
                anchors.verticalCenter: parent.verticalCenter
                text: qsTr("Rendered · Ctrl+R to exit")
                color: "white"
                font.pointSize: FmTheme.font.size.xs
            }
        }
    }
}
