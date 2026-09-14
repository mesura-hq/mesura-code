#pragma once

// HostController — exposes IPC commands as Q_INVOKABLE methods + signals so
// QML can spawn windows in response. Mirrors the QuickShell IpcHandler at
// modules/filemanager/WindowFactory.qml without depending on QuickShell.
//
// IPC transport: QLocalServer at $XDG_RUNTIME_DIR/symmetria-fm.sock. Clients
// (the symmetria-fm-cli binary, the XDG portal Python script) send a single
// JSON line: {"method": "open|openOverlay|createPicker", "args": {...}}.
//
// FIFO path validation for createPicker is performed here, server-side,
// before any QML signal fires. The 4-layer rules match what
// WindowFactory.qml:79-100 enforced.

#include <QJsonObject>
#include <QLocalServer>
#include <QLocalSocket>
#include <QObject>
#include <qqmlintegration.h>

class HostController : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_SINGLETON

public:
    explicit HostController(QObject* parent = nullptr);
    ~HostController() override;

    // Start listening on the local socket. Returns false on failure (caller
    // should log and exit; another instance may already be running).
    bool startServer();

    // Path of the local socket — derived from XDG_RUNTIME_DIR.
    [[nodiscard]] static QString socketPath();

signals:
    void openRequested(const QString& initialPath);
    void openOverlayRequested(const QString& initialPath);
    void createPickerRequested(const QVariantMap& options);
    void closePickerRequested(const QString& fifoPath);

private:
    void onNewConnection();
    void onClientReadyRead(QLocalSocket* client);
    void handleCommand(QLocalSocket* client, const QJsonObject& cmd);

    static bool validateFifoPath(const QString& path);

    QLocalServer m_server;
};
