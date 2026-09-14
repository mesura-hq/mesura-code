#include "fileinfo.hpp"

#include <qfileinfo.h>
#include <qtconcurrentrun.h>

namespace symmetria::filemanager::models {

FileInfo::FileInfo(QObject* parent) : QObject(parent) {}

FileInfo::~FileInfo() = default;

QString FileInfo::path() const { return m_path; }

void FileInfo::setPath(const QString& path) {
    if (m_path == path)
        return;
    m_path = path;
    emit pathChanged();
    rebuild();
}

FileSystemEntry* FileInfo::entry() const { return m_entry; }
bool FileInfo::ready() const { return m_entry != nullptr; }
bool FileInfo::loading() const { return m_loading; }

// --------------------------------------------------------------------------
// rebuild — derive a FileSystemEntry for m_path off the GUI thread.
//
// Mirrors the async + generation-counter pattern of SyntaxHighlightHelper /
// PreviewImageHelper. The worker produces a plain CachedEntryData (stat/mime
// I/O, safe to run off-thread); the FileSystemEntry QObject is constructed on
// the GUI thread from that value. A stale build (superseded by a newer setPath)
// is dropped via the generation guard and never published.
// --------------------------------------------------------------------------
void FileInfo::rebuild() {
    const int generation = ++m_generation;

    // Empty path clears the entry immediately — no async round-trip.
    if (m_path.isEmpty()) {
        if (m_loading) {
            m_loading = false;
            emit loadingChanged();
        }
        if (m_entry) {
            m_entry->deleteLater();
            m_entry = nullptr;
            emit entryChanged();
        }
        return;
    }

    if (!m_loading) {
        m_loading = true;
        emit loadingChanged();
    }

    const QString path = m_path;
    // Parent-directory fs type is needed for remote-mount detection on dirs; the
    // scan computes this once per directory, here we compute it for the one file.
    const QString parentDir = QFileInfo(path).absolutePath();

    const auto future = QtConcurrent::run([path, parentDir]() {
        const unsigned long parentFsType = filesystemFsType(parentDir);
        return buildCachedEntryData(path, QString(), parentFsType);
    });

    auto* watcher = new QFutureWatcher<CachedEntryData>(this);
    connect(watcher, &QFutureWatcher<CachedEntryData>::finished, this,
        [this, generation, watcher]() {
            watcher->deleteLater();

            // Discard stale results — a newer setPath() has superseded this build.
            if (generation != m_generation)
                return;

            auto data = watcher->result();
            auto* fresh = new FileSystemEntry(std::move(data), this);

            FileSystemEntry* old = m_entry;
            m_entry = fresh;
            if (old)
                old->deleteLater();

            if (m_loading) {
                m_loading = false;
                emit loadingChanged();
            }
            emit entryChanged();
        });
    watcher->setFuture(future);
}

} // namespace symmetria::filemanager::models
