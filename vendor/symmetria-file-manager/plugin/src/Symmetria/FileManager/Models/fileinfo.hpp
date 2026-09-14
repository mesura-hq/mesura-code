#pragma once

// FileInfo — turns a filesystem PATH into a fully-derived FileSystemEntry,
// asynchronously.
//
// This is the QML bridge for consumers that have only a path (the fuzzy finder,
// and the future Symmetria-IDE) and need to drive the shared PreviewContent
// component, which expects a FileSystemEntry-shaped object. FileSystemEntry is
// QML_UNCREATABLE — only a FileSystemModel mints one — so QML cannot build one
// for an arbitrary path, and QML has no QMimeDatabase/QImageReader access to
// derive mimeType/isImage/isVideo itself. FileInfo fills that gap: it runs the
// SAME buildCachedEntryData() the directory scan uses (off the GUI thread for
// SSHFS/FUSE safety) and exposes the resulting entry.
//
// Lifetime: the entry is rebuilt whenever `path` changes; an in-flight build is
// discarded by a generation counter if a newer setPath() supersedes it. The
// FileSystemEntry (a QObject) is constructed only on the GUI thread; the worker
// produces a plain CachedEntryData value.

#include <qfuturewatcher.h>
#include <qobject.h>
#include <qqmlintegration.h>

#include "filesystemmodel.hpp"

namespace symmetria::filemanager::models {

class FileInfo : public QObject {
    Q_OBJECT
    QML_ELEMENT

    // Input
    Q_PROPERTY(QString path READ path WRITE setPath NOTIFY pathChanged)

    // Output — the derived entry (nullptr until ready / when path is empty)
    Q_PROPERTY(symmetria::filemanager::models::FileSystemEntry* entry READ entry NOTIFY entryChanged)
    Q_PROPERTY(bool ready READ ready NOTIFY entryChanged)
    Q_PROPERTY(bool loading READ loading NOTIFY loadingChanged)

public:
    explicit FileInfo(QObject* parent = nullptr);
    ~FileInfo() override;

    [[nodiscard]] QString path() const;
    void setPath(const QString& path);

    [[nodiscard]] FileSystemEntry* entry() const;
    [[nodiscard]] bool ready() const;
    [[nodiscard]] bool loading() const;

signals:
    void pathChanged();
    void entryChanged();
    void loadingChanged();

private:
    void rebuild();

    QString m_path;
    FileSystemEntry* m_entry = nullptr;
    bool m_loading = false;
    int m_generation = 0;
};

} // namespace symmetria::filemanager::models
