---
name: QtObject cannot have child QML objects
description: Never declare child objects (Timer, Connections, etc.) inside QtObject — use Qt.createQmlObject() or property Component instead
type: feedback
---

QtObject has no `default property`, so inline child objects like `Timer {}` or `Connections {}` cause "Cannot assign to non-existent default property" at load time.

**Why:** WindowState.qml is a QtObject used per-window (not a Singleton). Adding a Timer child crashed the entire symmetria-fm service on every reboot, since the service reads directly from the git working tree via symlink. This has been a recurring issue.

**How to apply:** When adding child objects to a QtObject-based file:
- Use `property Timer foo: Qt.createQmlObject('import QtQuick; Timer { interval: 2000 }', root, "timerName")` and connect signals in `Component.onCompleted`
- Or use `property Component` + `createObject()` pattern
- Singleton-based files (Theme.qml, Logger.qml, BookmarkService.qml) DO support children — this only affects `QtObject {}` roots
