#pragma once

#include <qfileinfo.h>
#include <qhash.h>
#include <qset.h>
#include <qstring.h>
#include <qstringlist.h>

namespace symmetria::filemanager::models {

/// Resolves XDG icon names to file paths from the active system icon theme.
/// Results are cached statically — each icon name is resolved at most once.
class IconThemeResolver {
public:
    /// Returns the absolute path to an SVG icon for a MIME/places icon name
    /// (file-type and folder icons), or empty if not found in any theme in the
    /// inheritance chain. Searches only `mimes/` and `places/` context dirs, SVG only.
    static QString resolve(const QString& iconName);

    /// Returns the absolute path to an application icon (the value of a .desktop
    /// `Icon=` key). Searches the active theme's `apps/` context dirs and its
    /// inheritance chain trying `.svg`/`.png`/`.xpm`, then `hicolor` (the XDG
    /// implicit fallback theme where most app icons live), then the legacy flat
    /// `/usr/share/pixmaps`. Absolute `Icon=` paths are returned verbatim if they
    /// exist. Empty if nothing matches.
    static QString resolveApp(const QString& iconName);

    /// Resolves a file's themed icon path from its `QFileInfo` plus its
    /// pre-computed MIME type *name* (e.g. "text/x-python"). Directories resolve
    /// to the "folder" icon; files try the MIME icon, then the generic icon,
    /// then each parent MIME's icon in turn. Returns "" if nothing matches.
    ///
    /// Single source of truth for file → icon-path derivation, shared by
    /// `FileSystemEntry` (reuses its already-computed MIME) and `FuzzyFinder`
    /// (looks the MIME up on demand). Main-thread only — wraps `resolve()`,
    /// whose static caches are unsynchronized.
    static QString resolveForFile(const QFileInfo& fileInfo, const QString& mimeType);

private:
    // Which icon-theme context dirs (and file extensions) a lookup searches.
    enum class Category { MimePlaces, Apps };

    struct ThemeInfo {
        QString basePath;
        QStringList mimeDirs;   // e.g. {"mimes/scalable", "mimes/22", "mimes/16"}
        QStringList placesDirs; // e.g. {"places/scalable", "places/22", "places/16"}
        QStringList appsDirs;   // e.g. {"apps/scalable", "apps/48", "apps/22"}
        QStringList inherits;
    };

    static void ensureInitialised();
    static ThemeInfo parseTheme(const QString& themeName);
    static QString findInTheme(const ThemeInfo& theme, const QString& iconName, Category cat);
    static QString findRecursive(const QString& themeName, const QString& iconName,
                                 Category cat, QSet<QString>& visited);
    static QString locateThemeDir(const QString& themeName);

    static inline QHash<QString, QString> s_cache;     // MIME/places resolutions
    static inline QHash<QString, QString> s_appCache;  // application-icon resolutions
    static inline QHash<QString, ThemeInfo> s_themes;
    static inline QString s_activeTheme;
    static inline bool s_initialised = false;
};

} // namespace symmetria::filemanager::models
