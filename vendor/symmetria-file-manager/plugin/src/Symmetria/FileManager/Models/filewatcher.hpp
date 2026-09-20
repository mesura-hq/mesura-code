#pragma once

// FileWatcher — QML-instantiable wrapper around QFileSystemWatcher with
// auto-read and atomic-replace mitigation.
//
// Replaces Quickshell.Io.FileView for the file manager's hot-reload callsites
// (Theme reading color-scheme.json, BookmarkService reading bookmarks.json).
//
// API shape (mirrors Quickshell.Io.FileView):
//
//   FileWatcher {
//       path: "/path/to/file.json"
//       watchChanges: true              // optional, default true
//       onLoaded: parse(text)
//       onLoadFailed: ...
//       onFileChanged: parse(text)      // fires after re-read on change
//   }
//
// Atomic-replace mitigation (CRITICAL — see plan stage A risk hotspot #3):
//
// QFileSystemWatcher silently drops a watch when the watched path is unlinked
// then renamed-into-place — the typical pattern for nvim's `:w`, git checkout,
// or any tool that writes via "tmp + rename". To survive this, we:
//
//   1. Watch BOTH the file path AND its parent directory.
//   2. On any signal (fileChanged or directoryChanged), re-read the file,
//      then call removePath; addPath unconditionally to re-arm the watch on
//      the new inode.
//   3. If addPath fails (file briefly absent during the rename window),
//      schedule a 100ms QTimer::singleShot retry.
//
// Without this pattern, hot-reload silently breaks on the second `:w`.

#include <qfilesystemwatcher.h>
#include <qobject.h>
#include <qqmlintegration.h>
#include <qstring.h>
#include <qtimer.h>

namespace symmetria::filemanager::models {

class FileWatcher : public QObject {
    Q_OBJECT
    QML_ELEMENT

    Q_PROPERTY(QString path READ path WRITE setPath NOTIFY pathChanged)
    Q_PROPERTY(bool watchChanges READ watchChanges WRITE setWatchChanges NOTIFY watchChangesChanged)
    Q_PROPERTY(QString text READ text NOTIFY textChanged)
    Q_PROPERTY(bool loaded READ loaded NOTIFY loadedChanged)
    Q_PROPERTY(QString errorString READ errorString NOTIFY errorStringChanged)

public:
    explicit FileWatcher(QObject* parent = nullptr);

    [[nodiscard]] QString path() const;
    void setPath(const QString& path);

    [[nodiscard]] bool watchChanges() const;
    void setWatchChanges(bool watch);

    [[nodiscard]] QString text() const;
    [[nodiscard]] bool loaded() const;
    [[nodiscard]] QString errorString() const;

    Q_INVOKABLE void reload();

signals:
    void pathChanged();
    void watchChangesChanged();
    void textChanged();
    void loadedChanged();
    void errorStringChanged();
    void fileChanged();
    void loadFailed(const QString& error);

private:
    static constexpr int RetryDelayMs = 100;
    static constexpr qint64 MaxBytes = 8 * 1024 * 1024; // 8 MiB read cap

    void readFile(bool emitChange);
    void rearmWatch();
    void onWatcherFileChanged(const QString& changedPath);
    void onWatcherDirectoryChanged(const QString& changedPath);

    QString m_path;
    QString m_text;
    QString m_errorString;
    bool m_watchChanges = true;
    bool m_loaded = false;
    bool m_hasEmittedInitialLoad = false;
    QFileSystemWatcher m_watcher;
    QTimer m_retryTimer;
};

} // namespace symmetria::filemanager::models
