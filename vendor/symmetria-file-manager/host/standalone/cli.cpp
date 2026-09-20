// symmetria-fm-cli — minimal IPC sender. Replaces `qs ipc --any-display -c
// symmetria-fm call filemanager <method> <args>` with a tiny Qt6 binary
// that opens a QLocalSocket and writes one JSON line.
//
// Usage:
//   symmetria-fm-cli open <path>
//   symmetria-fm-cli openOverlay <path>
//   symmetria-fm-cli createPicker '<json>'
//
// Exits 0 on success, non-zero on connection / protocol error.

#include <QCoreApplication>
#include <QElapsedTimer>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLocalSocket>
#include <QProcess>
#include <QStringList>
#include <QTextStream>
#include <QThread>
#include <iostream>

namespace {

// Per-attempt connect timeout. Deliberately short: it only ever covers a
// connect that is genuinely in flight. When the socket FILE is absent the
// kernel refuses instantly, so this timeout is not what rides out a daemon
// restart — connectWithRetry's budget is.
constexpr int kConnectAttemptMs = 200;
// Total time we keep retrying before giving up. Must comfortably exceed the
// service's RestartSec plus its ~0.3 s startup.
constexpr int kConnectBudgetMs = 5000;
constexpr int kRetryDelayMs = 50;
// Head start given to systemd's own Restart=always before we ask it to start
// the unit ourselves.
constexpr int kAutostartAfterMs = 250;
// Read timeout. Generous because a connection can land while the freshly
// started daemon is still loading QML: QLocalServer::newConnection only fires
// once the event loop runs, so the request sits queued until then.
constexpr int kReadTimeoutMs = 5000;

QString socketPath()
{
    const QByteArray runtime = qgetenv("XDG_RUNTIME_DIR");
    if (!runtime.isEmpty())
        return QString::fromUtf8(runtime) + QStringLiteral("/symmetria-fm.sock");
    return QStringLiteral("/tmp/symmetria-fm.sock");
}

// Connects to the daemon, riding out the window in which no socket exists.
//
// symmetria-fm exits when its last window closes (main.cpp documents that as a
// deliberate design decision) and systemd's Restart=always brings up a fresh
// instance. Between those two events the daemon has REMOVED the socket file,
// so connectToServer fails in ~10 ms with ServerNotFoundError — a plain
// waitForConnected timeout never helps, because there is no connect in flight
// to wait on. A keybind that runs this CLI therefore did nothing at all,
// silently (compositors discard the stderr of an exec bind), whenever the user
// pressed it right after closing the last window. Retrying is the fix.
//
// The systemctl call covers the other half: a unit that is stopped, failed, or
// otherwise not coming back on its own. It is a no-op when a restart job is
// already queued.
bool connectWithRetry(QLocalSocket& socket, const QString& path)
{
    QElapsedTimer clock;
    clock.start();
    bool autostartRequested = false;

    forever {
        socket.connectToServer(path);
        if (socket.waitForConnected(kConnectAttemptMs))
            return true;
        socket.abort(); // reset the socket state before the next attempt

        if (clock.elapsed() >= kConnectBudgetMs)
            return false;

        if (!autostartRequested && clock.elapsed() >= kAutostartAfterMs) {
            autostartRequested = true;
            QProcess::startDetached(QStringLiteral("systemctl"),
                                    {QStringLiteral("--user"),
                                     QStringLiteral("start"),
                                     QStringLiteral("symmetria-fm.service")});
        }

        QThread::msleep(kRetryDelayMs);
    }
}

void printUsage()
{
    std::cerr << "usage: symmetria-fm-cli <method> [<arg>]\n"
              << "  methods:\n"
              << "    open <path>\n"
              << "    openOverlay <path>\n"
              << "    createPicker '<json>'\n";
}

} // namespace

int main(int argc, char* argv[])
{
    QCoreApplication app(argc, argv);
    const QStringList args = QCoreApplication::arguments();

    if (args.size() < 2) {
        printUsage();
        return 2;
    }

    const QString method = args.at(1);

    QJsonObject argsObj;
    if (method == QStringLiteral("open") || method == QStringLiteral("openOverlay")) {
        argsObj.insert(QStringLiteral("initialPath"),
                       args.size() > 2 ? args.at(2) : QString());
    } else if (method == QStringLiteral("createPicker")) {
        if (args.size() < 3) {
            std::cerr << "createPicker requires a JSON argument\n";
            return 2;
        }
        QJsonParseError err{};
        const QJsonDocument doc = QJsonDocument::fromJson(args.at(2).toUtf8(), &err);
        if (err.error != QJsonParseError::NoError) {
            std::cerr << "invalid JSON: " << err.errorString().toStdString() << "\n";
            return 2;
        }
        argsObj = doc.object();
    } else {
        std::cerr << "unknown method: " << method.toStdString() << "\n";
        printUsage();
        return 2;
    }

    QJsonObject envelope;
    envelope.insert(QStringLiteral("method"), method);
    envelope.insert(QStringLiteral("args"), argsObj);
    const QByteArray line = QJsonDocument(envelope).toJson(QJsonDocument::Compact) + '\n';

    QLocalSocket socket;
    if (!connectWithRetry(socket, socketPath())) {
        std::cerr << "symmetria-fm-cli: cannot connect to symmetria-fm at "
                  << socketPath().toStdString() << " after "
                  << kConnectBudgetMs << " ms: "
                  << socket.errorString().toStdString() << "\n"
                  << "Check: systemctl --user status symmetria-fm\n";
        return 1;
    }

    socket.write(line);
    socket.flush();

    if (!socket.waitForReadyRead(kReadTimeoutMs)) {
        std::cerr << "symmetria-fm-cli: no response from server\n";
        return 1;
    }
    const QByteArray reply = socket.readAll().trimmed();

    QJsonParseError err{};
    const QJsonDocument doc = QJsonDocument::fromJson(reply, &err);
    if (err.error != QJsonParseError::NoError || !doc.isObject()) {
        std::cerr << "symmetria-fm-cli: malformed reply: " << reply.toStdString() << "\n";
        return 1;
    }
    const QJsonObject obj = doc.object();
    if (!obj.value(QStringLiteral("ok")).toBool()) {
        std::cerr << "symmetria-fm-cli: server rejected: "
                  << obj.value(QStringLiteral("error")).toString().toStdString() << "\n";
        return 1;
    }

    return 0;
}
