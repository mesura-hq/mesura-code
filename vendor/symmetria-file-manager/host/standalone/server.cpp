#include "server.hpp"

#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QStandardPaths>
#include <QtDebug>

namespace {

constexpr auto kValidFifoPrefix = "/tmp/symmetria-picker-";
constexpr int kMaxFifoPathLength = 128;

QVariantMap toVariantMap(const QJsonObject& obj)
{
    QVariantMap m;
    for (auto it = obj.begin(); it != obj.end(); ++it)
        m.insert(it.key(), it.value().toVariant());
    return m;
}

} // namespace

HostController::HostController(QObject* parent)
    : QObject(parent)
{
    connect(&m_server, &QLocalServer::newConnection, this,
            &HostController::onNewConnection);
}

HostController::~HostController()
{
    // close() clears the server name, so capture the socket path first —
    // removing afterwards with fullServerName() would pass an empty string
    // and log "QFile::remove: Empty or null file name" on every shutdown.
    const QString serverPath = m_server.fullServerName();
    m_server.close();
    if (!serverPath.isEmpty())
        QFile::remove(serverPath);
}

QString HostController::socketPath()
{
    const QByteArray runtime = qgetenv("XDG_RUNTIME_DIR");
    if (!runtime.isEmpty())
        return QString::fromUtf8(runtime) + QStringLiteral("/symmetria-fm.sock");
    // Fallback for environments without XDG_RUNTIME_DIR (CI, minimal setups).
    return QDir::tempPath() + QStringLiteral("/symmetria-fm.sock");
}

bool HostController::startServer()
{
    const QString path = socketPath();
    // Stale socket cleanup — happens when the previous process crashed
    // without graceful shutdown. Safe because we hold the only daemon role
    // (a second instance is rejected after this point by listen()).
    QLocalServer::removeServer(path);
    if (!m_server.listen(path)) {
        qWarning() << "HostController: failed to listen on" << path
                   << ":" << m_server.errorString();
        return false;
    }
    qInfo() << "HostController: listening on" << path;
    return true;
}

void HostController::onNewConnection()
{
    while (auto* client = m_server.nextPendingConnection()) {
        connect(client, &QLocalSocket::readyRead, this, [this, client]() {
            onClientReadyRead(client);
        });
        connect(client, &QLocalSocket::disconnected, client, &QLocalSocket::deleteLater);
    }
}

void HostController::onClientReadyRead(QLocalSocket* client)
{
    while (client->canReadLine()) {
        const QByteArray line = client->readLine().trimmed();
        if (line.isEmpty())
            continue;

        QJsonParseError err{};
        const QJsonDocument doc = QJsonDocument::fromJson(line, &err);
        if (err.error != QJsonParseError::NoError || !doc.isObject()) {
            qWarning() << "HostController: rejecting malformed JSON:" << err.errorString();
            client->write("{\"ok\":false,\"error\":\"invalid_json\"}\n");
            client->flush();
            continue;
        }

        handleCommand(client, doc.object());
    }
}

void HostController::handleCommand(QLocalSocket* client, const QJsonObject& cmd)
{
    const QString method = cmd.value(QStringLiteral("method")).toString();
    const QJsonObject args = cmd.value(QStringLiteral("args")).toObject();

    auto reply = [client](bool ok, const QString& error = {}) {
        QJsonObject obj{{"ok", ok}};
        if (!ok)
            obj.insert(QStringLiteral("error"), error);
        client->write(QJsonDocument(obj).toJson(QJsonDocument::Compact) + '\n');
        client->flush();
    };

    if (method == QStringLiteral("open")) {
        emit openRequested(args.value(QStringLiteral("initialPath")).toString());
        reply(true);
    } else if (method == QStringLiteral("openOverlay")) {
        emit openOverlayRequested(args.value(QStringLiteral("initialPath")).toString());
        reply(true);
    } else if (method == QStringLiteral("createPicker")) {
        // createPicker schema (forwarded as-is to QML via QVariantMap):
        //   fifo (string, required)        — FIFO path validated below
        //   title, multiple, directory, saveMode, suggestedName,
        //   acceptLabel, currentFolder    — picker UX options
        //   parentWindow (string)          — XDG-portal window handle
        //                                    ("wayland:HANDLE" or "x11:XID");
        //                                    consumed in main.qml _spawnPicker
        //                                    to set xdg-foreign transient parent.
        const QString fifoPath = args.value(QStringLiteral("fifo")).toString();
        if (!validateFifoPath(fifoPath)) {
            qWarning() << "HostController: rejected createPicker with invalid fifo path:" << fifoPath;
            reply(false, QStringLiteral("invalid_fifo_path"));
            return;
        }
        emit createPickerRequested(toVariantMap(args));
        reply(true);
    } else if (method == QStringLiteral("closePicker")) {
        // Sent by the portal backend when the requesting app cancels or dies
        // (org.freedesktop.impl.portal.Request.Close). The fifo path names
        // which pending picker to dismiss; main.qml only honours it if it
        // matches the active picker's fifo.
        const QString fifoPath = args.value(QStringLiteral("fifo")).toString();
        if (!validateFifoPath(fifoPath)) {
            qWarning() << "HostController: rejected closePicker with invalid fifo path:" << fifoPath;
            reply(false, QStringLiteral("invalid_fifo_path"));
            return;
        }
        emit closePickerRequested(fifoPath);
        reply(true);
    } else {
        qWarning() << "HostController: unknown method:" << method;
        reply(false, QStringLiteral("unknown_method"));
    }
}

bool HostController::validateFifoPath(const QString& path)
{
    // Mirrors the 4-layer validation that lived in WindowFactory.qml:79-100.
    // Layer 1: prefix
    if (!path.startsWith(QLatin1String(kValidFifoPrefix)))
        return false;
    // Layer 2: traversal
    if (path.contains(QStringLiteral("..")) || path.contains(QChar(0)))
        return false;
    // Layer 3: length
    if (path.length() > kMaxFifoPathLength)
        return false;
    // Layer 4: charset of the suffix (uuid4 hex + dots/dashes/underscores)
    const QString suffix = path.mid(static_cast<int>(qstrlen(kValidFifoPrefix)));
    static const QRegularExpression re(QStringLiteral("^[a-zA-Z0-9._-]+$"));
    return re.match(suffix).hasMatch();
}
