#include "shellrunner.hpp"

#include <qdebug.h>

namespace symmetria::filemanager::models {

ShellRunner::ShellRunner(QObject* parent)
    : QObject(parent)
{
    connect(&m_process, &QProcess::started, this, &ShellRunner::onStarted);
    connect(&m_process, &QProcess::finished, this, &ShellRunner::onFinished);
    connect(&m_process, &QProcess::readyReadStandardOutput, this, &ShellRunner::onReadyReadStdout);
    connect(&m_process, &QProcess::readyReadStandardError, this, &ShellRunner::onReadyReadStderr);
    connect(&m_process, &QProcess::errorOccurred, this, &ShellRunner::onErrorOccurred);
}

QStringList ShellRunner::command() const { return m_command; }

void ShellRunner::setCommand(const QStringList& command)
{
    if (m_command == command)
        return;
    m_command = command;
    emit commandChanged();
}

QString ShellRunner::workingDirectory() const { return m_workingDirectory; }

void ShellRunner::setWorkingDirectory(const QString& dir)
{
    if (m_workingDirectory == dir)
        return;
    m_workingDirectory = dir;
    emit workingDirectoryChanged();
}

QVariantMap ShellRunner::environment() const { return m_environment; }

void ShellRunner::setEnvironment(const QVariantMap& environment)
{
    if (m_environment == environment)
        return;
    m_environment = environment;
    emit environmentChanged();
}

bool ShellRunner::running() const { return m_running; }
QString ShellRunner::stdoutText() const { return m_stdoutText; }
QString ShellRunner::stderrText() const { return m_stderrText; }
int ShellRunner::exitCode() const { return m_exitCode; }

void ShellRunner::start()
{
    if (m_running || m_starting) {
        qWarning() << "ShellRunner::start() called while already running or starting, ignoring";
        return;
    }
    if (m_command.isEmpty()) {
        qWarning() << "ShellRunner::start() called with empty command";
        emit errorOccurred(QStringLiteral("command is empty"));
        return;
    }

    m_stdoutText.clear();
    m_stderrText.clear();
    m_stdoutLineBuffer.clear();
    m_stderrLineBuffer.clear();
    // Clear any stale buffered stdin from a previous failed start — without
    // this, a buffered payload from run #1 would leak into run #2.
    m_pendingStdin.clear();
    m_pendingCloseWriteChannel = false;
    m_exitCode = 0;
    emit stdoutTextChanged();
    emit stderrTextChanged();

    if (!m_workingDirectory.isEmpty())
        m_process.setWorkingDirectory(m_workingDirectory);

    if (!m_environment.isEmpty()) {
        QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
        for (auto it = m_environment.constBegin(); it != m_environment.constEnd(); ++it)
            env.insert(it.key(), it.value().toString());
        m_process.setProcessEnvironment(env);
    }

    const QString program = m_command.first();
    const QStringList args = m_command.mid(1);
    m_starting = true;
    m_process.start(program, args);
}

void ShellRunner::terminate()
{
    if (m_running)
        m_process.terminate();
}

void ShellRunner::kill()
{
    if (m_running)
        m_process.kill();
}

void ShellRunner::write(const QString& data)
{
    const QByteArray bytes = data.toUtf8();
    if (!m_running) {
        // Buffer the payload and flush in onStarted(). The race window is
        // start() returning before QProcess::started() fires — common when
        // callers chain start()/write() synchronously, and especially flaky
        // under embedded Qt loops (e.g. PySide6 hosting QML, where the
        // started slot is queued later than in standalone Qt).
        m_pendingStdin.append(bytes);
        return;
    }
    m_process.write(bytes);
}

void ShellRunner::closeWriteChannel()
{
    if (!m_running) {
        // Defer the close until onStarted() flushes the buffered stdin.
        // Buffering the write but not the close would hang any subprocess
        // that reads-until-EOF (e.g. `git check-ignore --stdin`, `cat`).
        m_pendingCloseWriteChannel = true;
        return;
    }
    m_process.closeWriteChannel();
}

void ShellRunner::onStarted()
{
    m_starting = false;
    m_running = true;
    // Flush any stdin buffered by write() calls that fired before this slot.
    // Order matters: write the bytes first, then close the channel — closing
    // first would EOF the subprocess before it sees its input.
    if (!m_pendingStdin.isEmpty()) {
        m_process.write(m_pendingStdin);
        m_pendingStdin.clear();
    }
    if (m_pendingCloseWriteChannel) {
        m_process.closeWriteChannel();
        m_pendingCloseWriteChannel = false;
    }
    emit runningChanged();
    emit started();
}

void ShellRunner::onFinished(int code, QProcess::ExitStatus status)
{
    m_running = false;
    m_exitCode = code;

    // Flush any trailing partial lines (no \n) that the process emitted
    // before exit. Without this, single-line tools without trailing newlines
    // would silently drop their output from the line-buffered consumers.
    if (!m_stdoutLineBuffer.isEmpty()) {
        emit stdoutLine(m_stdoutLineBuffer);
        m_stdoutLineBuffer.clear();
    }
    if (!m_stderrLineBuffer.isEmpty()) {
        emit stderrLine(m_stderrLineBuffer);
        m_stderrLineBuffer.clear();
    }

    emit runningChanged();
    emit exited(code, static_cast<int>(status));
}

void ShellRunner::onReadyReadStdout()
{
    const QByteArray chunk = m_process.readAllStandardOutput();
    if (chunk.isEmpty())
        return;
    const QString s = QString::fromUtf8(chunk);
    m_stdoutText.append(s);
    emit stdoutTextChanged();
    m_stdoutLineBuffer.append(s);
    emitLines(m_stdoutLineBuffer, &ShellRunner::stdoutLine);
}

void ShellRunner::onReadyReadStderr()
{
    const QByteArray chunk = m_process.readAllStandardError();
    if (chunk.isEmpty())
        return;
    const QString s = QString::fromUtf8(chunk);
    m_stderrText.append(s);
    emit stderrTextChanged();
    m_stderrLineBuffer.append(s);
    emitLines(m_stderrLineBuffer, &ShellRunner::stderrLine);
}

void ShellRunner::emitLines(QString& buffer, void (ShellRunner::*signal)(const QString&))
{
    qsizetype nl;
    while ((nl = buffer.indexOf(QChar('\n'))) != -1) {
        const QString line = buffer.left(nl);
        buffer.remove(0, nl + 1);
        emit (this->*signal)(line);
    }
}

void ShellRunner::onErrorOccurred(QProcess::ProcessError error)
{
    // FailedToStart fires before started(), so m_running is still false here —
    // no state correction needed. For errors other than FailedToStart (Crashed,
    // ReadError, WriteError, etc.), we also don't touch m_running: if the process
    // terminates as a result, finished() will clear it; if it keeps running
    // (e.g. a transient WriteError), m_running correctly stays true.
    //
    // FailedToStart specifically means onStarted() will never fire, so any
    // stdin we buffered for the failed run will never be delivered. Clear it
    // so the next start() doesn't accidentally inherit stale bytes (start()
    // already clears these defensively, but doing it here surfaces the intent
    // at the error site).
    if (error == QProcess::FailedToStart) {
        m_starting = false;
        m_pendingStdin.clear();
        m_pendingCloseWriteChannel = false;
    }
    emit errorOccurred(m_process.errorString());
}

} // namespace symmetria::filemanager::models
