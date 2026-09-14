// AppIconProviderTest — unit tests for AppIconProvider (.desktop id -> app icon
// path). Covers the deterministic branches: .desktop location across XDG dirs,
// Icon= parsing, the absolute-path icon case, and graceful misses.
//
// Themed-name resolution (Icon=firefox -> /usr/share/icons/.../firefox.svg) is
// deliberately NOT tested: it depends on the live system icon theme and
// IconThemeResolver's process-wide static caches, which cannot be isolated
// deterministically. The same reason the suite does not test IconThemeResolver
// against the live theme. Here we redirect XDG dirs to a temp tree via
// QStandardPaths test mode and exercise everything up to (and including) the
// absolute-path branch of resolveApp.

#include "appiconprovider.hpp"

#include <QDir>
#include <QFile>
#include <QStandardPaths>
#include <QTemporaryDir>
#include <QTest>

using namespace symmetria::filemanager::models;

class AppIconProviderTest : public QObject {
    Q_OBJECT

private:
    QString m_appsDir; // writable XDG applications dir under test-mode redirection

    // Write a .desktop file into the redirected applications dir. `iconLine` is the
    // full "Icon=..." line (or empty to omit the key entirely).
    QString writeDesktop(const QString& fileName, const QString& iconLine)
    {
        const QString path = m_appsDir + QLatin1Char('/') + fileName;
        QFile f(path);
        if (!f.open(QIODevice::WriteOnly | QIODevice::Text))
            return {};
        QString contents = QStringLiteral("[Desktop Entry]\nType=Application\nName=Test\n");
        if (!iconLine.isEmpty())
            contents += iconLine + QLatin1Char('\n');
        f.write(contents.toUtf8());
        return path;
    }

private slots:
    void initTestCase()
    {
        // Redirect GenericDataLocation (and hence ApplicationsLocation) to a temp tree.
        QStandardPaths::setTestModeEnabled(true);
        m_appsDir = QStandardPaths::writableLocation(QStandardPaths::ApplicationsLocation);
        QVERIFY(!m_appsDir.isEmpty());
        QVERIFY(QDir().mkpath(m_appsDir));
    }

    void absoluteIconPathReturnedVerbatim()
    {
        // A .desktop whose Icon= is an absolute path to an existing file resolves
        // straight to that path — no theme lookup involved.
        QTemporaryDir iconDir;
        QVERIFY(iconDir.isValid());
        const QString iconPath = iconDir.path() + QStringLiteral("/myapp.png");
        QFile icon(iconPath);
        QVERIFY(icon.open(QIODevice::WriteOnly));
        icon.write("not-a-real-png-but-exists");
        icon.close();

        QVERIFY(!writeDesktop(QStringLiteral("abs-icon.desktop"),
                              QStringLiteral("Icon=") + iconPath)
                     .isEmpty());

        AppIconProvider provider;
        QCOMPARE(provider.iconForDesktopId(QStringLiteral("abs-icon.desktop")), iconPath);
    }

    void absoluteIconPathMissingReturnsEmpty()
    {
        // Absolute Icon= that does not exist on disk yields empty (not the dead path).
        QVERIFY(!writeDesktop(QStringLiteral("abs-missing.desktop"),
                              QStringLiteral("Icon=/nonexistent/dir/ghost.png"))
                     .isEmpty());

        AppIconProvider provider;
        QCOMPARE(provider.iconForDesktopId(QStringLiteral("abs-missing.desktop")), QString());
    }

    void desktopIdWithoutExtensionResolves()
    {
        // Callers may pass the id without the ".desktop" suffix; it is appended.
        QTemporaryDir iconDir;
        QVERIFY(iconDir.isValid());
        const QString iconPath = iconDir.path() + QStringLiteral("/noext.svg");
        QFile icon(iconPath);
        QVERIFY(icon.open(QIODevice::WriteOnly));
        icon.write("<svg/>");
        icon.close();

        QVERIFY(!writeDesktop(QStringLiteral("noext.desktop"),
                              QStringLiteral("Icon=") + iconPath)
                     .isEmpty());

        AppIconProvider provider;
        QCOMPARE(provider.iconForDesktopId(QStringLiteral("noext")), iconPath);
    }

    void missingDesktopReturnsEmpty()
    {
        AppIconProvider provider;
        QCOMPARE(provider.iconForDesktopId(QStringLiteral("does-not-exist.desktop")), QString());
    }

    void desktopWithoutIconKeyReturnsEmpty()
    {
        QVERIFY(!writeDesktop(QStringLiteral("no-icon.desktop"), QString()).isEmpty());

        AppIconProvider provider;
        QCOMPARE(provider.iconForDesktopId(QStringLiteral("no-icon.desktop")), QString());
    }

    void emptyDesktopIdReturnsEmpty()
    {
        AppIconProvider provider;
        QCOMPARE(provider.iconForDesktopId(QString()), QString());
    }

    void iconKeyInActionGroupIsIgnored()
    {
        // Only the [Desktop Entry] group's Icon= counts — a later [Desktop Action ...]
        // Icon= must not be picked up. Here the main group has no icon, so the result
        // is empty even though an action group declares one.
        const QString path = m_appsDir + QStringLiteral("/action-only.desktop");
        QFile f(path);
        QVERIFY(f.open(QIODevice::WriteOnly | QIODevice::Text));
        f.write(
            "[Desktop Entry]\n"
            "Type=Application\n"
            "Name=Test\n"
            "\n"
            "[Desktop Action new-window]\n"
            "Icon=/tmp/should-be-ignored.png\n");
        f.close();

        AppIconProvider provider;
        QCOMPARE(provider.iconForDesktopId(QStringLiteral("action-only.desktop")), QString());
    }
};

QTEST_GUILESS_MAIN(AppIconProviderTest)
#include "AppIconProviderTest.moc"
