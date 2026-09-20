#include "appiconprovider.hpp"

#include "iconthemeresolver.hpp"

#include <qfile.h>
#include <qfileinfo.h>
#include <qstandardpaths.h>
#include <qtextstream.h>

namespace symmetria::filemanager::models {

AppIconProvider::AppIconProvider(QObject* parent)
    : QObject(parent)
{
}

// XDG application directories in priority order: $XDG_DATA_HOME/applications first,
// then each $XDG_DATA_DIRS/applications. QStandardPaths::ApplicationsLocation
// already expands to exactly this list. Cached once — matches the iconSearchPaths()
// pattern in iconthemeresolver.cpp for consistency.
static const QStringList& applicationDirs()
{
    static const QStringList dirs =
        QStandardPaths::standardLocations(QStandardPaths::ApplicationsLocation);
    return dirs;
}

QString AppIconProvider::locateDesktopFile(const QString& desktopId)
{
    QString id = desktopId;
    if (!id.endsWith(QStringLiteral(".desktop")))
        id += QStringLiteral(".desktop");

    for (const auto& dir : applicationDirs()) {
        const QString direct = dir + QLatin1Char('/') + id;
        if (QFileInfo::exists(direct))
            return direct;

        // XDG spec: a dash in the id may encode a subdirectory (e.g.
        // "org.kde.foo-bar.desktop" can live at "org/kde/foo-bar.desktop"). Rare,
        // but cheap to try as a fallback before moving to the next data dir.
        QString nested = id;
        nested.replace(QLatin1Char('-'), QLatin1Char('/'));
        if (nested != id) {
            const QString nestedPath = dir + QLatin1Char('/') + nested;
            if (QFileInfo::exists(nestedPath))
                return nestedPath;
        }
    }
    return {};
}

QString AppIconProvider::readIconKey(const QString& desktopFilePath)
{
    QFile file(desktopFilePath);
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text))
        return {};

    // The Icon= we want is the one in the main [Desktop Entry] group; ignore Icon=
    // keys in action groups like [Desktop Action new-window].
    QTextStream stream(&file);
    bool inDesktopEntry = false;
    while (!stream.atEnd()) {
        const QString line = stream.readLine().trimmed();
        if (line.isEmpty() || line.startsWith(QLatin1Char('#')))
            continue;
        if (line.startsWith(QLatin1Char('['))) {
            inDesktopEntry = (line == QStringLiteral("[Desktop Entry]"));
            continue;
        }
        if (inDesktopEntry && line.startsWith(QStringLiteral("Icon=")))
            return line.mid(5).trimmed();
    }
    return {};
}

QString AppIconProvider::iconForDesktopId(const QString& desktopId)
{
    if (desktopId.isEmpty())
        return {};

    auto it = m_cache.constFind(desktopId);
    if (it != m_cache.constEnd())
        return it.value();

    QString result;
    const QString desktopFile = locateDesktopFile(desktopId);
    if (!desktopFile.isEmpty()) {
        const QString iconName = readIconKey(desktopFile);
        if (!iconName.isEmpty())
            result = IconThemeResolver::resolveApp(iconName);
    }

    m_cache.insert(desktopId, result);
    return result;
}

} // namespace symmetria::filemanager::models
