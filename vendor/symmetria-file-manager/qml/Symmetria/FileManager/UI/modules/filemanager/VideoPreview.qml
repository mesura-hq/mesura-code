import Symmetria.FileManager.UI
import QtQuick
import QtQuick.Layouts
import QtMultimedia

Item {
    id: root

    required property var entry

    // Exposed for PreviewMetadata — reflects native encoded video dimensions
    readonly property size naturalSize: {
        // Re-evaluate when media status changes so the binding updates once metadata is ready
        const _dep = videoPlayer.mediaStatus;
        const res = videoPlayer.metaData.value(MediaMetaData.Resolution);
        return (res && res.width > 0) ? Qt.size(res.width, res.height) : Qt.size(0, 0);
    }

    MediaPlayer {
        id: videoPlayer
        source: root.entry ? encodeURI("file://" + root.entry.path) : ""
        autoPlay: true
        loops: MediaPlayer.Infinite

        videoOutput: videoOutput
    }

    VideoOutput {
        id: videoOutput

        anchors.fill: parent
        anchors.margins: FmTheme.padding.md
        fillMode: VideoOutput.PreserveAspectFit

        opacity: videoPlayer.hasVideo && videoOutput.sourceRect.width > 0 ? 1 : 0

        Behavior on opacity {
            Anim {}
        }
    }

    // Loading indicator — covers initial media loading, buffering, and stalls
    Loader {
        anchors.centerIn: parent
        active: videoPlayer.mediaStatus === MediaPlayer.LoadingMedia
            || videoPlayer.mediaStatus === MediaPlayer.BufferingMedia
            || videoPlayer.mediaStatus === MediaPlayer.StalledMedia
        asynchronous: true

        sourceComponent: PreviewLoadingIndicator {}
    }

    // Error state
    Loader {
        anchors.centerIn: parent
        active: videoPlayer.error !== MediaPlayer.NoError
        asynchronous: true

        sourceComponent: PreviewStateIndicator {
            iconName: "videocam_off"
            message: qsTr("Cannot preview")
        }
    }
}
