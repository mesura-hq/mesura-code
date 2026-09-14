#include "filewatcher.hpp"

#include <qfile.h>
#include <qfileinfo.h>
#include <qurl.h>

namespace symmetria::filemanager::models {

namespace {
// Quickshell.Io.FileView accepts both `file://` URLs and raw paths. We accept
// both for callsite compatibility, normalizing to a raw absolute path
// internally so QFileSystemWatcher and QFile both work.
QString normalizePath(const QString& input)
{
    if (input.startsWith(QStringLiteral("file://"))) {
        const QUrl url(input);
        if (url.isLocalFile())
            return url.toLocalFile();
    }
    return input;
}
} // namespace

FileWatcher::FileWatcher(QObject* parent)
    : QObject(parent)
{
    m_retryTimer.setSingleShot(true);
    m_retryTimer.setInterval(RetryDelayMs);
    connect(&m_retryTimer, &QTimer::timeout, this, &FileWatcher::rearmWatch);

    connect(&m_watcher, &QFileSystemWatcher::fileChanged,
            this, &FileWatcher::onWatcherFileChanged);
    connect(&m_watcher, &QFileSystemWatcher::directoryChanged,
            this, &FileWatcher::onWatcherDirectoryChanged);
}

QString FileWatcher::path() const { return m_path; }

void FileWatcher::setPath(const QString& path)
{
    const QString normalized = normalizePath(path);
    if (m_path == normalized)
        return;

    if (!m_watcher.files().isEmpty())
        m_watcher.removePaths(m_watcher.files());
    if (!m_watcher.directories().isEmpty())
        m_watcher.removePaths(m_watcher.directories());

    m_path = normalized;
    m_loaded = false;
    m_hasEmittedInitialLoad = false;
    m_text.clear();
    m_errorString.clear();

    emit pathChanged();
    emit textChanged();
    emit loadedChanged();
    emit errorStringChanged();

    if (!m_path.isEmpty()) {
        readFile(/*emitChange=*/false);
        if (m_watchChanges)
            rearmWatch();
    }
}

bool FileWatcher::watchChanges() const { return m_watchChanges; }

void FileWatcher::setWatchChanges(bool watch)
{
    if (m_watchChanges == watch)
        return;
    m_watchChanges = watch;
    emit watchChangesChanged();

    if (m_watchChanges && !m_path.isEmpty())
        rearmWatch();
    else if (!m_watchChanges) {
        if (!m_watcher.files().isEmpty())
            m_watcher.removePaths(m_watcher.files());
        if (!m_watcher.directories().isEmpty())
            m_watcher.removePaths(m_watcher.directories());
    }
}

QString FileWatcher::text() const { return m_text; }
bool FileWatcher::loaded() const { return m_loaded; }
QString FileWatcher::errorString() const { return m_errorString; }

void FileWatcher::reload()
{
    if (m_path.isEmpty())
        return;
    readFile(/*emitChange=*/true);
    if (m_watchChanges)
        rearmWatch();
}

void FileWatcher::readFile(bool emitChange)
{
    QFile f(m_path);
    if (!f.exists()) {
        const QString err = QStringLiteral("file not found: %1").arg(m_path);
        if (m_errorString != err) {
            m_errorString = err;
            emit errorStringChanged();
        }
        if (m_loaded) {
            m_loaded = false;
            emit loadedChanged();
        }
        emit loadFailed(err);
        return;
    }

    if (!f.open(QIODevice::ReadOnly)) {
        const QString err = QStringLiteral("failed to open: %1").arg(f.errorString());
        m_errorString = err;
        emit errorStringChanged();
        if (m_loaded) {
            m_loaded = false;
            emit loadedChanged();
        }
        emit loadFailed(err);
        return;
    }

    const QByteArray bytes = f.read(MaxBytes);
    f.close();

    const QString newText = QString::fromUtf8(bytes);
    const bool textActuallyChanged = (newText != m_text);
    m_text = newText;

    if (!m_errorString.isEmpty()) {
        m_errorString.clear();
        emit errorStringChanged();
    }

    if (textActuallyChanged)
        emit textChanged();

    if (!m_loaded) {
        m_loaded = true;
        emit loadedChanged();
    }
    if (!m_hasEmittedInitialLoad) {
        m_hasEmittedInitialLoad = true;
        // initial load — no fileChanged emission
    } else if (emitChange && textActuallyChanged) {
        emit fileChanged();
    } else if (emitChange) {
        // Atomic replace can fire a change signal even when content is byte-identical
        // (e.g. `mv tmp file` where tmp == file). Still surface the event so consumers
        // who depend on inode swaps (e.g. cache invalidation by mtime) can react.
        emit fileChanged();
    }
}

void FileWatcher::rearmWatch()
{
    if (m_path.isEmpty() || !m_watchChanges)
        return;

    // Re-arm by removing then re-adding both the file and its parent directory.
    // Parent dir watch is what catches "rename-into-place" patterns (nvim :w,
    // git checkout, etc.) that drop the file watch silently.
    const QFileInfo info(m_path);
    const QString parentDir = info.absolutePath();

    if (!m_watcher.files().isEmpty())
        m_watcher.removePaths(m_watcher.files());

    bool fileWatchAdded = false;
    if (info.exists()) {
        const QStringList notAdded = m_watcher.addPaths({m_path});
        fileWatchAdded = notAdded.isEmpty();
    }

    // Always (re)watch the parent dir so we get directoryChanged on
    // create-after-delete, even if the file watch failed.
    if (!parentDir.isEmpty()) {
        const QStringList currentDirs = m_watcher.directories();
        if (!currentDirs.contains(parentDir)) {
            m_watcher.addPaths({parentDir});
        }
    }

    if (!fileWatchAdded && !info.exists()) {
        // File didn't exist when we tried to add — schedule a retry. The
        // parent directory watch should also fire once the file appears,
        // but the timer is a belt-and-suspenders fallback for compositors
        // / filesystems where directoryChanged is unreliable.
        m_retryTimer.start();
    }
}

void FileWatcher::onWatcherFileChanged(const QString& changedPath)
{
    if (changedPath != m_path)
        return;
    readFile(/*emitChange=*/true);
    rearmWatch();
}

void FileWatcher::onWatcherDirectoryChanged(const QString& changedPath)
{
    if (m_path.isEmpty())
        return;
    const QFileInfo info(m_path);
    if (info.absolutePath() != changedPath)
        return;
    if (!info.exists()) {
        // File disappeared from the directory. Atomic-replace patterns
        // (nvim :w, mv old new) unlink before renaming the new file in;
        // we expect the second directoryChanged event within milliseconds.
        // We DO NOT clear m_text here — keeping the stale content avoids a
        // single-frame "blank" being read by consumers (e.g. FmTheme bindings)
        // during the unlink/rename gap. Only `loaded` flips to false so
        // consumers that gate on it (`onLoadedChanged: if (loaded) …`) skip
        // the transient state entirely.
        if (m_loaded) {
            m_loaded = false;
            emit loadedChanged();
        }
        return;
    }
    // File came back (or was atomically replaced) — re-read and re-arm.
    readFile(/*emitChange=*/true);
    rearmWatch();
}

} // namespace symmetria::filemanager::models
