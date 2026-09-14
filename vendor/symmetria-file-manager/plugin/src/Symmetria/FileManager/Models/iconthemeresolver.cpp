#include "iconthemeresolver.hpp"

#include <qdir.h>
#include <qfile.h>
#include <qfileinfo.h>
#include <qicon.h>
#include <qmimedatabase.h>
#include <qstandardpaths.h>
#include <qtextstream.h>
#include <qset.h>
#include <qloggingcategory.h>

Q_LOGGING_CATEGORY(lcIconTheme, "symmetria.filemanager.icontheme", QtWarningMsg)

namespace symmetria::filemanager::models {

// XDG standard search paths for icon themes. Built once and shared across all call sites.
static const QStringList& iconSearchPaths()
{
    static const QStringList paths = []() {
        QStringList result;

        // User-local icons
        const QString dataHome = QStandardPaths::writableLocation(QStandardPaths::GenericDataLocation);
        if (!dataHome.isEmpty())
            result.append(dataHome + QStringLiteral("/icons"));

        // System-wide icon directories
        const auto dataDirs = QStandardPaths::standardLocations(QStandardPaths::GenericDataLocation);
        for (const auto& dir : dataDirs) {
            const QString iconDir = dir + QStringLiteral("/icons");
            if (!result.contains(iconDir))
                result.append(iconDir);
        }

        // Pixmaps fallback
        result.append(QStringLiteral("/usr/share/pixmaps"));

        return result;
    }();
    return paths;
}

QString IconThemeResolver::locateThemeDir(const QString& themeName)
{
    for (const auto& searchPath : iconSearchPaths()) {
        const QString candidate = searchPath + QLatin1Char('/') + themeName;
        if (QDir(candidate).exists())
            return candidate;
    }
    return {};
}

/// Parse an index.theme file and extract MIME/places directories sorted by preference
/// (scalable first, then largest fixed sizes first).
IconThemeResolver::ThemeInfo IconThemeResolver::parseTheme(const QString& themeName)
{
    ThemeInfo info;
    info.basePath = locateThemeDir(themeName);
    if (info.basePath.isEmpty()) {
        qCDebug(lcIconTheme) << "parseTheme: basePath empty for" << themeName;
        return info;
    }

    const QString indexPath = info.basePath + QStringLiteral("/index.theme");
    QFile file(indexPath);
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text)) {
        qCDebug(lcIconTheme) << "parseTheme: cannot open" << indexPath;
        return info;
    }

    // Manual INI parser — QSettings fails on long values and group names with spaces.
    QString currentGroup;
    QString directories;
    QHash<QString, QHash<QString, QString>> sectionData; // section -> key -> value

    QTextStream stream(&file);
    while (!stream.atEnd()) {
        QString line = stream.readLine().trimmed();
        if (line.isEmpty() || line.startsWith(QLatin1Char('#')))
            continue;

        if (line.startsWith(QLatin1Char('[')) && line.endsWith(QLatin1Char(']'))) {
            currentGroup = line.mid(1, line.length() - 2);
            continue;
        }

        const int eq = line.indexOf(QLatin1Char('='));
        if (eq < 0)
            continue;

        const QString key = line.left(eq).trimmed();
        const QString value = line.mid(eq + 1).trimmed();

        if (currentGroup == QStringLiteral("Icon Theme")) {
            if (key == QStringLiteral("Directories"))
                directories = value;
            else if (key == QStringLiteral("Inherits"))
                info.inherits = value.split(QLatin1Char(','), Qt::SkipEmptyParts);
        } else {
            sectionData[currentGroup][key] = value;
        }
    }
    file.close();

    if (directories.isEmpty()) {
        qCDebug(lcIconTheme) << "parseTheme: no Directories in" << indexPath;
        return info;
    }

    // Collect MIME and places directories, categorised by type for sorting.
    struct DirEntry {
        QString path;
        bool scalable;
        int size;
    };
    QList<DirEntry> mimeDirs;
    QList<DirEntry> placesDirs;
    QList<DirEntry> appsDirs;

    const auto dirList = directories.split(QLatin1Char(','), Qt::SkipEmptyParts);
    for (const auto& dir : dirList) {
        const auto& section = sectionData.value(dir);
        const QString context = section.value(QStringLiteral("Context"));
        const QString type = section.value(QStringLiteral("Type"));
        const int size = section.value(QStringLiteral("Size"), QStringLiteral("0")).toInt();

        const bool isMime = context.compare(QStringLiteral("MimeTypes"), Qt::CaseInsensitive) == 0;
        const bool isPlaces = context.compare(QStringLiteral("Places"), Qt::CaseInsensitive) == 0;
        const bool isApps = context.compare(QStringLiteral("Applications"), Qt::CaseInsensitive) == 0;

        if (!isMime && !isPlaces && !isApps)
            continue;

        const bool isScalable = type.compare(QStringLiteral("Scalable"), Qt::CaseInsensitive) == 0;
        DirEntry entry{dir, isScalable, size};

        if (isMime)
            mimeDirs.append(entry);
        else if (isPlaces)
            placesDirs.append(entry);
        else
            appsDirs.append(entry);
    }

    // Sort: scalable first, then by descending size (prefer larger fixed icons).
    auto sortFn = [](const DirEntry& a, const DirEntry& b) {
        if (a.scalable != b.scalable)
            return a.scalable; // scalable before fixed
        return a.size > b.size;
    };
    std::sort(mimeDirs.begin(), mimeDirs.end(), sortFn);
    std::sort(placesDirs.begin(), placesDirs.end(), sortFn);
    std::sort(appsDirs.begin(), appsDirs.end(), sortFn);

    for (const auto& d : mimeDirs)
        info.mimeDirs.append(d.path);
    for (const auto& d : placesDirs)
        info.placesDirs.append(d.path);
    for (const auto& d : appsDirs)
        info.appsDirs.append(d.path);

    qCDebug(lcIconTheme) << "Parsed theme" << themeName
                           << "mimes:" << info.mimeDirs.size() << info.mimeDirs
                           << "places:" << info.placesDirs.size() << info.placesDirs
                           << "apps:" << info.appsDirs.size() << info.appsDirs
                           << "inherits:" << info.inherits;
    return info;
}

void IconThemeResolver::ensureInitialised()
{
    if (s_initialised)
        return;
    s_initialised = true;

    // Determine active theme — verify it actually exists on disk.
    QString themeName = QIcon::themeName();
    qCDebug(lcIconTheme) << "QIcon::themeName():" << themeName;
    qCDebug(lcIconTheme) << "iconSearchPaths():" << iconSearchPaths();
    if (!themeName.isEmpty() && !locateThemeDir(themeName).isEmpty()) {
        s_activeTheme = themeName;
    } else {
        // Fallback: scan for first theme with scalable MIME icons.
        qCDebug(lcIconTheme) << "Theme" << themeName << "not found on disk, scanning for alternatives";
        for (const auto& searchPath : iconSearchPaths()) {
            QDir dir(searchPath);
            if (!dir.exists())
                continue;
            const auto entries = dir.entryList(QDir::Dirs | QDir::NoDotAndDotDot);
            for (const auto& entry : entries) {
                if (QDir(searchPath + QLatin1Char('/') + entry + QStringLiteral("/mimes/scalable")).exists()) {
                    s_activeTheme = entry;
                    qCDebug(lcIconTheme) << "Auto-detected theme:" << s_activeTheme;
                    break;
                }
            }
            if (!s_activeTheme.isEmpty())
                break;
        }
    }

    if (s_activeTheme.isEmpty()) {
        qCDebug(lcIconTheme) << "No icon theme with MIME icons found";
        return;
    }

    qCDebug(lcIconTheme) << "Active icon theme:" << s_activeTheme;
}

QString IconThemeResolver::findInTheme(const ThemeInfo& theme, const QString& iconName, Category cat)
{
    if (theme.basePath.isEmpty())
        return {};

    if (cat == Category::Apps) {
        // Application icons may ship as SVG, PNG, or (rarely) XPM — try each in
        // every apps/ size dir (already preference-sorted: scalable, then largest).
        static const QStringList exts = {
            QStringLiteral(".svg"), QStringLiteral(".png"), QStringLiteral(".xpm")
        };
        for (const auto& dir : theme.appsDirs) {
            for (const auto& ext : exts) {
                const QString path = theme.basePath + QLatin1Char('/') + dir + QLatin1Char('/') + iconName + ext;
                if (QFileInfo::exists(path))
                    return path;
            }
        }
        return {};
    }

    // MimePlaces: determine which directory list to search based on the icon name.
    // "folder*" icons live in places; everything else in mimes. SVG only.
    const bool isPlacesIcon = iconName.startsWith(QStringLiteral("folder"))
                           || iconName == QStringLiteral("user-home")
                           || iconName == QStringLiteral("user-desktop")
                           || iconName == QStringLiteral("user-trash");

    const auto& dirs = isPlacesIcon ? theme.placesDirs : theme.mimeDirs;

    for (const auto& dir : dirs) {
        const QString path = theme.basePath + QLatin1Char('/') + dir + QLatin1Char('/') + iconName + QStringLiteral(".svg");
        if (QFileInfo::exists(path))
            return path;
    }

    // Also try the opposite context as a fallback (some themes put folder icons in mimes).
    const auto& fallbackDirs = isPlacesIcon ? theme.mimeDirs : theme.placesDirs;
    for (const auto& dir : fallbackDirs) {
        const QString path = theme.basePath + QLatin1Char('/') + dir + QLatin1Char('/') + iconName + QStringLiteral(".svg");
        if (QFileInfo::exists(path))
            return path;
    }

    return {};
}

QString IconThemeResolver::findRecursive(const QString& themeName, const QString& iconName,
                                         Category cat, QSet<QString>& visited)
{
    if (visited.contains(themeName))
        return {};
    visited.insert(themeName);

    // Parse and cache theme info if not already done.
    if (!s_themes.contains(themeName))
        s_themes.insert(themeName, parseTheme(themeName));

    const auto& theme = s_themes[themeName];
    const QString result = findInTheme(theme, iconName, cat);
    if (!result.isEmpty())
        return result;

    // Walk the inheritance chain.
    for (const auto& parent : theme.inherits) {
        const QString inherited = findRecursive(parent, iconName, cat, visited);
        if (!inherited.isEmpty())
            return inherited;
    }

    return {};
}

QString IconThemeResolver::resolveForFile(const QFileInfo& fileInfo, const QString& mimeType)
{
    if (fileInfo.isDir())
        return resolve(QStringLiteral("folder"));

    static const QMimeDatabase db;
    const auto mime = db.mimeTypeForName(mimeType);

    QString icon = resolve(mime.iconName());
    if (icon.isEmpty())
        icon = resolve(mime.genericIconName());
    if (icon.isEmpty()) {
        for (const auto& parentName : mime.parentMimeTypes()) {
            icon = resolve(db.mimeTypeForName(parentName).iconName());
            if (!icon.isEmpty())
                break;
        }
    }
    return icon;
}

QString IconThemeResolver::resolve(const QString& iconName)
{
    if (iconName.isEmpty())
        return {};

    ensureInitialised();
    if (s_activeTheme.isEmpty())
        return {};

    // Check cache first.
    auto it = s_cache.constFind(iconName);
    if (it != s_cache.constEnd())
        return it.value();

    // Resolve through the theme inheritance chain.
    QSet<QString> visited;
    const QString result = findRecursive(s_activeTheme, iconName, Category::MimePlaces, visited);

    s_cache.insert(iconName, result);
    qCDebug(lcIconTheme) << "Resolved" << iconName << "->" << (result.isEmpty() ? QStringLiteral("(not found)") : result);
    return result;
}

QString IconThemeResolver::resolveApp(const QString& iconName)
{
    if (iconName.isEmpty())
        return {};

    // An absolute Icon= path is used verbatim (Steam, Flatpak, some bundled apps
    // write a full path rather than a theme name).
    if (iconName.startsWith(QLatin1Char('/')))
        return QFileInfo::exists(iconName) ? iconName : QString();

    auto it = s_appCache.constFind(iconName);
    if (it != s_appCache.constEnd())
        return it.value();

    // The Icon= key should be an extension-less name; some sloppy entries include
    // one (e.g. "foo.png"). Strip a known image extension for theme lookups so we
    // don't search for "foo.png.svg"; the literal form is still tried in pixmaps.
    QString lookupName = iconName;
    for (const auto& ext : {QStringLiteral(".png"), QStringLiteral(".svg"), QStringLiteral(".xpm")}) {
        if (lookupName.endsWith(ext, Qt::CaseInsensitive)) {
            lookupName.chop(ext.size());
            break;
        }
    }

    ensureInitialised();

    QString result;
    if (!s_activeTheme.isEmpty()) {
        QSet<QString> visited;
        result = findRecursive(s_activeTheme, lookupName, Category::Apps, visited);
    }

    // hicolor is the XDG-mandated implicit fallback theme; most application icons
    // are installed there regardless of the user's active theme. Search it
    // explicitly in case the active theme does not declare it via Inherits.
    if (result.isEmpty()) {
        QSet<QString> visited;
        result = findRecursive(QStringLiteral("hicolor"), lookupName, Category::Apps, visited);
    }

    // Legacy flat /usr/share/pixmaps fallback (pre-theme-spec app icons).
    // Use lookupName (extension-stripped) for the extension-appending variants so that
    // a sloppy "Icon=foo.png" entry doesn't produce "foo.png.png" paths. The bare
    // iconName (original, possibly with extension) is tried last to cover files stored
    // without a recognised image extension.
    if (result.isEmpty()) {
        static const QStringList exts = {
            QStringLiteral(".png"), QStringLiteral(".svg"), QStringLiteral(".xpm")
        };
        for (const auto& ext : exts) {
            const QString path = QStringLiteral("/usr/share/pixmaps/") + lookupName + ext;
            if (QFileInfo::exists(path)) {
                result = path;
                break;
            }
        }
        if (result.isEmpty()) {
            const QString path = QStringLiteral("/usr/share/pixmaps/") + iconName;
            if (QFileInfo::exists(path))
                result = path;
        }
    }

    s_appCache.insert(iconName, result);
    qCDebug(lcIconTheme) << "Resolved app icon" << iconName << "->"
                         << (result.isEmpty() ? QStringLiteral("(not found)") : result);
    return result;
}

} // namespace symmetria::filemanager::models
