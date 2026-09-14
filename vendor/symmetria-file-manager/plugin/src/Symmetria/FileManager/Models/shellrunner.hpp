#pragma once

// ShellRunner — QML-instantiable wrapper around QProcess.
//
// Replaces Quickshell.Io.Process for the file manager's shell-out callsites
// (xdg-open, gio trash, cp, mv, mkdir, etc.). The API intentionally mirrors
// Quickshell.Io.Process so QML callsites change only their import + type
// name, not their behavior.
//
// API shape:
//
//   ShellRunner {
//       command: ["xdg-open", path]
//       workingDirectory: ""              // optional
//       environment: ({"FOO": "bar"})     // optional, merges over inherited env
//       onStarted: ...
//       onExited: (code, status) => ...
//       // stdoutText / stderrText accumulate over the run
//   }
//   runner.start()
//
// Notes:
//   - Property names are stdoutText / stderrText (not stdout / stderr) to
//     avoid clashing with the legacy C macros and to keep QML access clean.
//   - start() is a no-op if already running (logs a warning). Callsites that
//     want to re-run after a previous exit can simply call start() again.
//   - environment merges *over* the inherited process environment — passing
//     {"FOO": "bar"} sets FOO=bar without clearing PATH/HOME/etc. This
//     matches the QuickShell behavior the existing callsites assume.

#include <qobject.h>
#include <qprocess.h>
#include <qqmlintegration.h>
#include <qstringlist.h>
#include <qvariant.h>

namespace symmetria::filemanager::models {

class ShellRunner : public QObject {
    Q_OBJECT
    QML_ELEMENT

    Q_PROPERTY(QStringList command READ command WRITE setCommand NOTIFY commandChanged)
    Q_PROPERTY(QString workingDirectory READ workingDirectory WRITE setWorkingDirectory NOTIFY workingDirectoryChanged)
    Q_PROPERTY(QVariantMap environment READ environment WRITE setEnvironment NOTIFY environmentChanged)
    Q_PROPERTY(bool running READ running NOTIFY runningChanged)
    Q_PROPERTY(QString stdoutText READ stdoutText NOTIFY stdoutTextChanged)
    Q_PROPERTY(QString stderrText READ stderrText NOTIFY stderrTextChanged)
    Q_PROPERTY(int exitCode READ exitCode NOTIFY exited)

public:
    // Mirrors QProcess::ExitStatus so QML callsites can compare against
    // ShellRunner.NormalExit / ShellRunner.CrashExit, matching the
    // Quickshell.Io.Process.NormalExit pattern existing callsites use.
    enum ExitStatus {
        NormalExit = 0,
        CrashExit = 1,
    };
    Q_ENUM(ExitStatus)

    explicit ShellRunner(QObject* parent = nullptr);

    [[nodiscard]] QStringList command() const;
    void setCommand(const QStringList& command);

    [[nodiscard]] QString workingDirectory() const;
    void setWorkingDirectory(const QString& dir);

    [[nodiscard]] QVariantMap environment() const;
    void setEnvironment(const QVariantMap& environment);

    [[nodiscard]] bool running() const;
    [[nodiscard]] QString stdoutText() const;
    [[nodiscard]] QString stderrText() const;
    [[nodiscard]] int exitCode() const;

    Q_INVOKABLE void start();
    Q_INVOKABLE void terminate();
    Q_INVOKABLE void kill();
    Q_INVOKABLE void write(const QString& data);
    Q_INVOKABLE void closeWriteChannel();

signals:
    void commandChanged();
    void workingDirectoryChanged();
    void environmentChanged();
    void runningChanged();
    void stdoutTextChanged();
    void stderrTextChanged();
    void started();
    void exited(int exitCode, int exitStatus);
    void errorOccurred(const QString& error);
    // Line-buffered signals — emitted once per complete '\n'-terminated line.
    // Partial trailing lines are flushed only when the process exits.
    void stdoutLine(const QString& line);
    void stderrLine(const QString& line);

private:
    void onStarted();
    void onFinished(int code, QProcess::ExitStatus status);
    void onReadyReadStdout();
    void onReadyReadStderr();
    void onErrorOccurred(QProcess::ProcessError error);

    void emitLines(QString& buffer, void (ShellRunner::*signal)(const QString&));

    QStringList m_command;
    QString m_workingDirectory;
    QVariantMap m_environment;
    QString m_stdoutText;
    QString m_stderrText;
    QString m_stdoutLineBuffer;  // partial trailing line (no \n yet)
    QString m_stderrLineBuffer;
    // write() and closeWriteChannel() may fire from QML before QProcess
    // emits started() — common pattern when callers do start()+write() back
    // to back. We buffer here and flush in onStarted() instead of dropping.
    // Critical for embedded Qt loops (e.g. PySide6 hosting QML) where the
    // started() slot fires later than in a standalone Qt application.
    QByteArray m_pendingStdin;
    bool m_pendingCloseWriteChannel = false;
    int m_exitCode = 0;
    bool m_running = false;
    // True between m_process.start() and the QProcess::started() slot landing.
    // Guards start() from being called a second time during the brief window
    // where m_running is still false but a process is already being launched.
    bool m_starting = false;
    QProcess m_process;
};

} // namespace symmetria::filemanager::models
