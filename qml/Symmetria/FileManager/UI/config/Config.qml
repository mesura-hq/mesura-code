pragma Singleton

import QtQuick

QtObject {
    readonly property FileManagerConfig fileManager: FileManagerConfig {}

    function save(): void {
        // No-op — config persistence deferred to later phase
    }
}
