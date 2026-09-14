#pragma once

// AppIconProvider — QML singleton that maps a .desktop id to a themed
// application-icon file path.
//
// The "Open With" menu (ContextMenuPopup.qml) discovers applications as .desktop
// ids via `gio mime`, but has no way to render their real icons: QML cannot read
// a .desktop file's Icon= key, nor resolve an XDG icon name to a path. This
// provider fills that gap — it locates the .desktop across the XDG application
// dirs, reads its Icon= key, and resolves it through IconThemeResolver::resolveApp
// (active theme apps/ dirs + hicolor + pixmaps). Results are cached per id, so a
// list of a handful of apps resolves once and re-renders for free.
//
// This is intentionally separate from IconThemeResolver: that class resolves an
// icon NAME to a path; this one owns the .desktop-entry concern (file location +
// Icon= parsing) and the QML bridge.

#include <qhash.h>
#include <qobject.h>
#include <qqmlintegration.h>
#include <qstring.h>

namespace symmetria::filemanager::models {

class AppIconProvider : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_SINGLETON

public:
    explicit AppIconProvider(QObject* parent = nullptr);

    /// Absolute image path for the application's icon, or "" if it cannot be
    /// resolved. `desktopId` is a .desktop file id with or without the trailing
    /// ".desktop" (e.g. "firefox.desktop", "dev.zed.Zed"). Cached per id.
    Q_INVOKABLE QString iconForDesktopId(const QString& desktopId);

private:
    [[nodiscard]] static QString locateDesktopFile(const QString& desktopId);
    [[nodiscard]] static QString readIconKey(const QString& desktopFilePath);

    QHash<QString, QString> m_cache;
};

} // namespace symmetria::filemanager::models
