// symmetria-fm — standalone Qt6 host for the Symmetria File Manager panel.
//
// Replaces the QuickShell-based `qs -c symmetria-fm` daemon. Starts a
// QLocalServer at $XDG_RUNTIME_DIR/symmetria-fm.sock; received commands
// drive QML window creation via signals on HostController.

#include "server.hpp"

#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQmlError>
#include <QtDebug>
#include <QtWebEngineQuick/qtwebenginequickglobal.h>

#ifndef SYMMETRIA_FM_QML_PATH
#error "SYMMETRIA_FM_QML_PATH must be defined by CMake — points at the host main.qml"
#endif

#ifndef SYMMETRIA_FM_PANEL_PATH
#error "SYMMETRIA_FM_PANEL_PATH must be defined by CMake — points at the panel QML root"
#endif

int main(int argc, char* argv[])
{
    // Initialize WebEngine BEFORE QGuiApplication — it sets Qt::AA_ShareOpenGLContexts,
    // which must be applied before the application object is constructed. Powers
    // the HTML render preview (Ctrl+R); the WebEngineView itself is only ever
    // instantiated on demand from QML. This is the canonical Qt6 ordering.
    QtWebEngineQuick::initialize();

    // All four are statics Qt documents as settable before the application
    // object exists, and they are set here ON PURPOSE. Qt's unix platform
    // integration reads desktopFileName() in its constructor: if it is already
    // set it registers with the XDG portal immediately, otherwise it defers the
    // registration onto the event loop and retries. Setting these after
    // construction happens to work through that deferred path, but it makes
    // correctness depend on a Qt implementation detail. Setting them first does
    // not.
    QGuiApplication::setApplicationName(QStringLiteral("symmetria-fm"));
    QGuiApplication::setApplicationDisplayName(QStringLiteral("File Manager"));
    QGuiApplication::setOrganizationName(QStringLiteral("Symmetria"));
    // Must equal the basename of the installed symmetria-fm.desktop, which
    // host/standalone/CMakeLists.txt installs. Qt6 registers every app with
    // org.freedesktop.portal.Registry at startup using this value as the app ID;
    // without it Qt sends an empty id and every launch logs
    //   "Could not register app ID: App info not found for ''".
    // The portal needs a resolvable app ID to attribute requests in the
    // permission store and to parent dialogs against the right window — so this
    // is NOT cosmetic, even though the failure is non-fatal.
    //
    // It also now decides the Wayland app_id: Qt prefers desktopFileName() and
    // only falls back to the executable's basename. Both are "symmetria-fm"
    // today, so nothing changed — but renaming this literal (e.g. to a
    // reverse-DNS id like org.symmetria.FileManager) would silently change the
    // app_id every compositor window rule matches on.
    QGuiApplication::setDesktopFileName(QStringLiteral("symmetria-fm"));

    QGuiApplication app(argc, argv);
    // quitOnLastWindowClosed is deliberately left at its default (true): the
    // daemon exits when the last FM window closes and systemd (Restart=always)
    // brings up a fresh instance. This is a design decision — each session
    // starts clean rather than resuming prior window state. Do NOT "fix" this
    // by setting quitOnLastWindowClosed(false).

    HostController controller;
    if (!controller.startServer()) {
        qCritical("symmetria-fm: failed to start IPC server "
                  "(another instance may already be running)");
        return 1;
    }

    QQmlApplicationEngine engine;

    // Surface QML errors that the engine would otherwise swallow into
    // QtMsgType::QtWarningMsg. Without this connection the engine throws
    // away QML compile / runtime errors silently in release builds.
    QObject::connect(&engine, &QQmlApplicationEngine::warnings, [](const QList<QQmlError>& errors) {
        for (const QQmlError& e : errors)
            fprintf(stderr, "symmetria-fm: QML warning: %s\n", qPrintable(e.toString()));
    });

    // Add the panel QML root as an import path so main.qml can resolve
    // relative imports like `import "../../services"`. Until stage E
    // packages the panel as Symmetria.FileManager.UI, the imports are
    // file-path-relative.
    engine.addImportPath(QStringLiteral(SYMMETRIA_FM_PANEL_PATH));

    // Expose the controller as a context property so QML's Connections can
    // listen for openRequested / createPickerRequested without going through
    // the QML_SINGLETON registration (which only works inside a module).
    engine.rootContext()->setContextProperty(QStringLiteral("hostController"),
                                             &controller);

    engine.load(QUrl::fromLocalFile(QStringLiteral(SYMMETRIA_FM_QML_PATH)));
    if (engine.rootObjects().isEmpty()) {
        qCritical("symmetria-fm: failed to load main.qml");
        return 1;
    }

    qInfo("symmetria-fm: ready");
    return QGuiApplication::exec();
}
