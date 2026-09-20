#include "filesystemmodel.hpp"
#include "iconthemeresolver.hpp"

#include <qdiriterator.h>
#include <qfile.h>
#include <qfuturewatcher.h>
#include <qtconcurrentrun.h>
#include <sys/vfs.h>

#ifndef FUSE_SUPER_MAGIC
#define FUSE_SUPER_MAGIC 0x65735546
#endif
#ifndef NFS_SUPER_MAGIC
#define NFS_SUPER_MAGIC 0x6969
#endif
#ifndef SMB_SUPER_MAGIC
#define SMB_SUPER_MAGIC 0x517B
#endif
#ifndef CIFS_SUPER_MAGIC
#define CIFS_SUPER_MAGIC 0xFF534D42
#endif

namespace symmetria::filemanager::models {

// Forward declaration — defined after the accessors to keep related code together.
static QString buildPermissions(const QFileInfo& info);

// Detect FUSE/NFS/CIFS mount points by comparing the filesystem type of a
// directory entry against its parent.  A directory is a remote mount point when
// its own statfs returns a network/FUSE magic number AND that differs from the
// parent directory's filesystem (so we don't flag every subdirectory inside the
// mount — only the mount root).
static bool isRemoteFsType(unsigned long type) {
    return type == FUSE_SUPER_MAGIC
        || type == NFS_SUPER_MAGIC
        || type == SMB_SUPER_MAGIC
        || type == CIFS_SUPER_MAGIC;
}

static bool detectRemoteMount(const QString& path, unsigned long parentFsType) {
    struct statfs sfs;
    if (::statfs(path.toUtf8().constData(), &sfs) != 0)
        return false;
    const auto fsType = static_cast<unsigned long>(sfs.f_type);
    // Only flag the mount root: the entry's fs type differs from its parent's
    return isRemoteFsType(fsType) && fsType != parentFsType;
}

unsigned long filesystemFsType(const QString& path) {
    struct statfs sfs;
    // 0 is a safe sentinel for "statfs failed" — it matches no remote magic, so
    // a dir whose own f_type is 0 is never mistakenly flagged as a remote mount.
    if (::statfs(path.toUtf8().constData(), &sfs) != 0)
        return 0;
    return static_cast<unsigned long>(sfs.f_type);
}

// Reads the first 4 KiB and treats the file as text when it contains no NUL
// byte. Only reached when the MIME database returns application/octet-stream —
// in practice this requires content that Qt's magic detection cannot identify as
// text (i.e., non-ASCII binary with no known magic signature). Direct unit-test
// isolation is impractical because libmagic classifies readable ASCII as
// text/plain first, bypassing this sniff entirely.
// Empty or unreadable files are NOT treated as text — the metadata fallback card
// is more useful for a 0-byte unknown.
static bool looksLikeText(const QString& path) {
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly))
        return false;
    const QByteArray head = f.read(4096);
    if (head.isEmpty())
        return false;
    return !head.contains('\0');
}

// True when a file's contents are plausibly text. Registered text formats are
// detected structurally via MIME inheritance from text/plain (application/yaml →
// text/plain, application/toml, text/csv, application/json, application/xml, …) —
// no hand-maintained type list to drift as freedesktop renames types. Types the
// database can't place (application/octet-stream or invalid) fall back to a
// content sniff so extensionless configs still preview.
static bool isTextLike(const QMimeType& mime, const QString& path) {
    if (mime.inherits(QStringLiteral("text/plain")))
        return true;
    if (!mime.isValid() || mime.name() == QStringLiteral("application/octet-stream"))
        return looksLikeText(path);
    return false;
}

// Formats Qt cannot sniff/decode natively but which PreviewImageHelper renders
// via a custom decoder into a cache PNG (icns, RPGMV, and HEIF/HEIC — Arch's
// qt6-imageformats has no libheif plugin). These must be treated as images even
// though QImageReader::canRead() returns false, so they route to the image
// preview instead of the fallback. Keep this in sync with
// PreviewImageHelper::needsCachedDecode / ::isHeifFormat.
static bool isCustomDecodedImage(const QString& path) {
    return path.endsWith(QStringLiteral(".rpgmvp"), Qt::CaseInsensitive)
        || path.endsWith(QStringLiteral(".png_"), Qt::CaseInsensitive)
        || path.endsWith(QStringLiteral(".icns"), Qt::CaseInsensitive)
        || path.endsWith(QStringLiteral(".heic"), Qt::CaseInsensitive)
        || path.endsWith(QStringLiteral(".heif"), Qt::CaseInsensitive);
}

CachedEntryData buildCachedEntryData(
    const QString& path, const QString& relativePath, unsigned long parentFsType) {
    CachedEntryData data;
    data.path = path;
    data.relativePath = relativePath;
    data.fileInfo = QFileInfo(path);
    data.permissions = buildPermissions(data.fileInfo);
    data.owner = data.fileInfo.owner();
    data.isRemoteMount = data.fileInfo.isDir() && detectRemoteMount(path, parentFsType);

    // Pre-compute MIME type and image detection here (background thread) so the
    // FileSystemEntry accessors become trivial field reads with no I/O.
    // QMimeDatabase is thread-safe; QImageReader::canRead() is stack-local.
    if (!data.fileInfo.isDir()) {
        static const QMimeDatabase mimeDb;
        const QMimeType mime = mimeDb.mimeTypeForFile(path);
        data.mimeType = mime.name();
        data.isVideo = data.mimeType.startsWith(QStringLiteral("video/"));
        data.isText = isTextLike(mime, path);

        if (isCustomDecodedImage(path)) {
            data.isImage = true;
        } else {
            QImageReader reader(path);
            data.isImage = reader.canRead();
        }
    }

    return data;
}

FileSystemEntry::FileSystemEntry(const QString& path, const QString& relativePath, QObject* parent)
    : QObject(parent)
    , m_fileInfo(path)
    , m_path(path)
    , m_relativePath(relativePath)
    , m_isImage([this]() {
        if (m_fileInfo.isDir()) return false;
        if (isCustomDecodedImage(m_path))
            return true;
        return QImageReader(m_path).canRead();
      }())
    , m_mimeType([this]() -> QString {
        if (m_fileInfo.isDir()) return {};
        static const QMimeDatabase db;
        return db.mimeTypeForFile(m_path).name();
      }())
    , m_isVideo(m_mimeType.startsWith(QStringLiteral("video/")))
    // NOTE: mimeTypeForFile is called again here (m_mimeType above stores only the
    // name string, not the QMimeType object the init-list can reuse). Since this ctor
    // is dead code (production always goes through buildCachedEntryData → CachedData&&),
    // the redundant lookup is accepted rather than adding a helper struct for one ctor.
    , m_isText([this]() {
        if (m_fileInfo.isDir()) return false;
        static const QMimeDatabase db;
        return isTextLike(db.mimeTypeForFile(m_path), m_path);
      }())
    , m_iconPath(IconThemeResolver::resolveForFile(m_fileInfo, m_mimeType))
    , m_permissions(buildPermissions(m_fileInfo))
    , m_owner(m_fileInfo.owner())
    , m_isRemoteMount(false) {}

FileSystemEntry::FileSystemEntry(CachedEntryData&& data, QObject* parent)
    : QObject(parent)
    , m_fileInfo(std::move(data.fileInfo))
    , m_path(std::move(data.path))
    , m_relativePath(std::move(data.relativePath))
    , m_isImage(data.isImage)
    , m_mimeType(std::move(data.mimeType))
    , m_isVideo(data.isVideo)
    , m_isText(data.isText)
    , m_iconPath(IconThemeResolver::resolveForFile(m_fileInfo, m_mimeType))
    , m_permissions(std::move(data.permissions))
    , m_owner(std::move(data.owner))
    , m_isRemoteMount(data.isRemoteMount) {}

QString FileSystemEntry::path() const {
    return m_path;
};

QString FileSystemEntry::relativePath() const {
    return m_relativePath;
};

QString FileSystemEntry::name() const {
    return m_fileInfo.fileName();
};

QString FileSystemEntry::baseName() const {
    return m_fileInfo.baseName();
};

QString FileSystemEntry::parentDir() const {
    return m_fileInfo.absolutePath();
};

QString FileSystemEntry::suffix() const {
    return m_fileInfo.completeSuffix();
};

qint64 FileSystemEntry::size() const {
    return m_fileInfo.size();
};

bool FileSystemEntry::isDir() const {
    return m_fileInfo.isDir();
};

bool FileSystemEntry::isImage() const { return m_isImage; }
bool FileSystemEntry::isVideo() const { return m_isVideo; }
bool FileSystemEntry::isText() const { return m_isText; }

QDateTime FileSystemEntry::modifiedDate() const {
    return m_fileInfo.lastModified();
}

// Static helper — keeps the constructor initialiser list clean and ensures
// m_permissions is built exactly once per entry lifetime.
static QString buildPermissions(const QFileInfo& info) {
    const auto p = info.permissions();
    QString s;
    s.reserve(10);
    // isSymLink() must be checked before isDir() because a symlink to a directory
    // satisfies both; the first character should reflect the entry type, not the target.
    s += info.isSymLink() ? 'l' : (info.isDir() ? 'd' : '-');
    s += (p & QFileDevice::ReadOwner)  ? 'r' : '-';
    s += (p & QFileDevice::WriteOwner) ? 'w' : '-';
    s += (p & QFileDevice::ExeOwner)   ? 'x' : '-';
    s += (p & QFileDevice::ReadGroup)  ? 'r' : '-';
    s += (p & QFileDevice::WriteGroup) ? 'w' : '-';
    s += (p & QFileDevice::ExeGroup)   ? 'x' : '-';
    s += (p & QFileDevice::ReadOther)  ? 'r' : '-';
    s += (p & QFileDevice::WriteOther) ? 'w' : '-';
    s += (p & QFileDevice::ExeOther)   ? 'x' : '-';
    return s;
}

QString FileSystemEntry::permissions() const {
    return m_permissions;
}

bool FileSystemEntry::isSymlink() const {
    // Safe as CONSTANT: FileSystemEntry is always destroyed and recreated via
    // applyChanges() on any filesystem add/remove event, so stale values cannot
    // accumulate across entry lifetimes.
    return m_fileInfo.isSymLink();
}

QString FileSystemEntry::symlinkTarget() const {
    return m_fileInfo.symLinkTarget();
}

bool FileSystemEntry::isExecutable() const {
    return m_fileInfo.isExecutable();
}

QString FileSystemEntry::owner() const {
    // m_owner is pre-computed in the constructor; owner() is a blocking syscall
    // (getpwuid) on Linux and must not be called on the UI thread at render time.
    return m_owner;
}

bool FileSystemEntry::isRemoteMount() const {
    return m_isRemoteMount;
}

QString FileSystemEntry::mimeType() const { return m_mimeType; }
QString FileSystemEntry::iconPath() const { return m_iconPath; }

void FileSystemEntry::updateRelativePath(const QDir& dir) {
    const auto relPath = dir.relativeFilePath(m_path);
    if (m_relativePath != relPath) {
        m_relativePath = relPath;
        emit relativePathChanged();
    }
}

FileSystemModel::FileSystemModel(QObject* parent)
    : QAbstractListModel(parent)
    , m_recursive(false)
    , m_watchChanges(true)
    , m_showHidden(false)
    , m_sortReverse(false)
    , m_sortBy(Natural)
    , m_filter(NoFilter) {
    connect(&m_watcher, &QFileSystemWatcher::directoryChanged, this, &FileSystemModel::watchDirIfRecursive);
    connect(&m_watcher, &QFileSystemWatcher::directoryChanged, this, &FileSystemModel::updateEntriesForDir);
    connect(&m_watcher, &QFileSystemWatcher::fileChanged, this, &FileSystemModel::onFileChanged);

    // Single-shot, restarted on demand by onFileChanged(). 250ms keeps a busy
    // download to ~4 rescans/sec while still surfacing the final size promptly
    // once writes stop.
    m_fileChangedDebounce.setSingleShot(true);
    m_fileChangedDebounce.setInterval(250);
    connect(&m_fileChangedDebounce, &QTimer::timeout, this, [this]() {
        // Guard on m_watchChanges too: a fileChanged that landed just before
        // watching was disabled must not drive a rescan after the fact.
        if (m_watchChanges && !m_path.isEmpty()) {
            updateEntriesForDir(m_path);
        }
    });
}

int FileSystemModel::rowCount(const QModelIndex& parent) const {
    if (parent != QModelIndex()) {
        return 0;
    }
    return static_cast<int>(m_entries.size());
}

QVariant FileSystemModel::data(const QModelIndex& index, int role) const {
    if (role != Qt::UserRole || !index.isValid() || index.row() >= static_cast<int>(m_entries.size())) {
        return QVariant();
    }
    return QVariant::fromValue(m_entries.at(index.row()));
}

QHash<int, QByteArray> FileSystemModel::roleNames() const {
    return { { Qt::UserRole, "modelData" } };
}

QString FileSystemModel::path() const {
    return m_path;
}

void FileSystemModel::setPath(const QString& path) {
    if (m_path == path) {
        return;
    }

    m_path = path;
    emit pathChanged();

    m_dir.setPath(m_path);

    for (const auto& entry : std::as_const(m_entries)) {
        entry->updateRelativePath(m_dir);
    }

    update();
}

bool FileSystemModel::recursive() const {
    return m_recursive;
}

void FileSystemModel::setRecursive(bool recursive) {
    if (m_recursive == recursive) {
        return;
    }

    m_recursive = recursive;
    emit recursiveChanged();

    update();
}

bool FileSystemModel::watchChanges() const {
    return m_watchChanges;
}

void FileSystemModel::setWatchChanges(bool watchChanges) {
    if (m_watchChanges == watchChanges) {
        return;
    }

    m_watchChanges = watchChanges;
    emit watchChangesChanged();

    update();
}

bool FileSystemModel::showHidden() const {
    return m_showHidden;
}

void FileSystemModel::setShowHidden(bool showHidden) {
    if (m_showHidden == showHidden) {
        return;
    }

    m_showHidden = showHidden;
    emit showHiddenChanged();

    update();
}

bool FileSystemModel::sortReverse() const {
    return m_sortReverse;
}

void FileSystemModel::setSortReverse(bool sortReverse) {
    if (m_sortReverse == sortReverse) {
        return;
    }

    m_sortReverse = sortReverse;
    emit sortReverseChanged();

    resort();
}

FileSystemModel::SortBy FileSystemModel::sortBy() const {
    return m_sortBy;
}

void FileSystemModel::setSortBy(SortBy sortBy) {
    if (m_sortBy == sortBy) {
        return;
    }

    m_sortBy = sortBy;
    emit sortByChanged();

    resort();
}

FileSystemModel::Filter FileSystemModel::filter() const {
    return m_filter;
}

void FileSystemModel::setFilter(Filter filter) {
    if (m_filter == filter) {
        return;
    }

    m_filter = filter;
    emit filterChanged();

    update();
}

QStringList FileSystemModel::nameFilters() const {
    return m_nameFilters;
}

void FileSystemModel::setNameFilters(const QStringList& nameFilters) {
    if (m_nameFilters == nameFilters) {
        return;
    }

    m_nameFilters = nameFilters;
    emit nameFiltersChanged();

    update();
}

QQmlListProperty<FileSystemEntry> FileSystemModel::entries() {
    return QQmlListProperty<FileSystemEntry>(this, &m_entries);
}

bool FileSystemModel::loading() const {
    return m_loading;
}

void FileSystemModel::watchDirIfRecursive(const QString& path) {
    if (m_recursive && m_watchChanges) {
        const auto currentDir = m_dir;
        const bool showHidden = m_showHidden;
        const auto future = QtConcurrent::run([showHidden, path]() {
            QDir::Filters filters = QDir::Dirs | QDir::NoDotAndDotDot;
            if (showHidden) {
                filters |= QDir::Hidden;
            }

            QDirIterator iter(path, filters, QDirIterator::Subdirectories);
            QStringList dirs;
            while (iter.hasNext()) {
                dirs << iter.next();
            }
            return dirs;
        });
        const auto watcher = new QFutureWatcher<QStringList>(this);
        connect(watcher, &QFutureWatcher<QStringList>::finished, this, [currentDir, showHidden, watcher, this]() {
            const auto paths = watcher->result();
            if (currentDir == m_dir && showHidden == m_showHidden && !paths.isEmpty()) {
                // Ignore if dir or showHidden has changed
                m_watcher.addPaths(paths);
            }
            watcher->deleteLater();
        });
        watcher->setFuture(future);
    }
}

void FileSystemModel::resort() {
    if (m_entries.isEmpty()) {
        return;
    }

    beginResetModel();
    std::sort(m_entries.begin(), m_entries.end(), [this](const FileSystemEntry* a, const FileSystemEntry* b) {
        return compareEntries(a, b);
    });
    endResetModel();

    emit entriesChanged();
}

void FileSystemModel::update() {
    updateWatcher();
    updateEntries();
}

void FileSystemModel::updateWatcher() {
    // Drop BOTH directory and per-file watches. The old code removed only
    // directories(), so per-file watches added by syncFileWatches() would leak
    // across navigation. File watches for the new directory are (re-)armed by the
    // subsequent scan via applyChanges() → syncFileWatches().
    const QStringList watched = m_watcher.directories() + m_watcher.files();
    if (!watched.isEmpty()) {
        m_watcher.removePaths(watched);
    }

    // Discard any debounce pending from the previous directory/state — updateWatcher()
    // runs on every state change (setPath/setRecursive/setWatchChanges/…), so a stale
    // fileChanged from before the change must not trigger a rescan afterwards.
    m_fileChangedDebounce.stop();

    if (!m_watchChanges || m_path.isEmpty()) {
        return;
    }

    m_watcher.addPath(m_path);
    watchDirIfRecursive(m_path);
}

void FileSystemModel::onFileChanged(const QString& /*path*/) {
    // A growing file emits one fileChanged per write. Start the debounce only if
    // it isn't already pending so a continuous download settles into ~one rescan
    // per interval; the trailing write after the timer fires schedules a final
    // rescan that captures the settled size.
    if (!m_fileChangedDebounce.isActive()) {
        m_fileChangedDebounce.start();
    }
}

void FileSystemModel::syncFileWatches() {
    // Per-file watches are scoped to the flat current directory: in recursive
    // mode the file count is unbounded and the directory watch already covers the
    // subtree. When watching is off / no path / recursive, ensure no file watches
    // linger (they would otherwise leak across a mode switch).
    const QStringList watchedFiles = m_watcher.files();
    if (!m_watchChanges || m_recursive || m_path.isEmpty()) {
        if (!watchedFiles.isEmpty()) {
            m_watcher.removePaths(watchedFiles);
        }
        return;
    }

    QStringList desired;
    desired.reserve(static_cast<int>(m_entries.size()));
    for (const auto& entry : std::as_const(m_entries)) {
        // Directories are handled by the directory watch; only regular files can
        // grow in place without emitting a directoryChanged signal.
        if (!entry->isDir()) {
            desired << entry->path();
        }
    }

    if (desired.size() > kMaxFileWatches) {
        // Fall back to directory-only watching (add/remove still tracked; only
        // in-place content refresh is lost). Warn once per model — not silently.
        if (!watchedFiles.isEmpty()) {
            m_watcher.removePaths(watchedFiles);
        }
        if (!m_fileWatchCapWarned) {
            m_fileWatchCapWarned = true;
            qWarning("FileSystemModel: %lld files exceeds per-file watch cap (%d); "
                     "in-place content refresh disabled for '%s'",
                     static_cast<long long>(desired.size()), kMaxFileWatches,
                     qUtf8Printable(m_path));
        }
        return;
    }

    const QSet<QString> desiredSet(desired.cbegin(), desired.cend());
    const QSet<QString> watchedSet(watchedFiles.cbegin(), watchedFiles.cend());

    QStringList toRemove;
    for (const auto& f : watchedFiles) {
        if (!desiredSet.contains(f)) {
            toRemove << f;
        }
    }
    if (!toRemove.isEmpty()) {
        m_watcher.removePaths(toRemove);
    }

    QStringList toAdd;
    for (const auto& f : desired) {
        if (!watchedSet.contains(f)) {
            toAdd << f;
        }
    }
    if (!toAdd.isEmpty()) {
        m_watcher.addPaths(toAdd);
    }
}

void FileSystemModel::updateEntries() {
    if (m_path.isEmpty()) {
        if (m_loading) {
            m_loading = false;
            emit loadingChanged();
        }
        if (!m_entries.isEmpty()) {
            beginResetModel();
            qDeleteAll(m_entries);
            m_entries.clear();
            endResetModel();
            emit entriesChanged();
        }

        return;
    }

    for (auto& future : m_futures) {
        future.cancel();
    }
    m_futures.clear();

    // Clear stale entries from the previous directory before starting the async scan.
    // For local directories the new entries arrive within one frame (~50ms), so the
    // empty state is invisible.  For remote mounts, the loading indicator fills the gap.
    if (!m_entries.isEmpty()) {
        beginResetModel();
        qDeleteAll(m_entries);
        m_entries.clear();
        endResetModel();
        emit entriesChanged();
    }

    updateEntriesForDir(m_path);
}

void FileSystemModel::updateEntriesForDir(const QString& dir) {
    if (!m_loading) {
        m_loading = true;
        emit loadingChanged();
    }

    const auto recursive = m_recursive;
    const auto showHidden = m_showHidden;
    const auto filter = m_filter;
    const auto nameFilters = m_nameFilters;
    const QDir currentDir = m_dir;

    QSet<QString> oldPaths;
    // Snapshot each current entry's (size, mtime) so the worker can detect files
    // modified in place — a path present in both scans whose size or mtime changed
    // (the in-progress-download case). entry->size()/modifiedDate() read the
    // cached QFileInfo, i.e. the value as of the last scan, which is exactly the
    // baseline we want to diff the fresh stat against.
    QHash<QString, QPair<qint64, qint64>> oldStats;
    oldStats.reserve(static_cast<int>(m_entries.size()));
    for (const auto& entry : std::as_const(m_entries)) {
        oldPaths << entry->path();
        oldStats.insert(
            entry->path(),
            qMakePair(entry->size(), entry->modifiedDate().toMSecsSinceEpoch()));
    }

    const auto future = QtConcurrent::run([=](QPromise<QPair<QSet<QString>, QList<CachedEntryData>>>& promise) {
        // Get the parent directory's filesystem type once (shared by every entry)
        // so we can detect mount boundaries without a per-entry statfs.
        const unsigned long parentFsType = filesystemFsType(dir);

        const auto flags = recursive ? QDirIterator::Subdirectories : QDirIterator::NoIteratorFlags;

        std::optional<QDirIterator> iter;

        if (filter == Images) {
            QStringList extraNameFilters = nameFilters;
            // supportedImageFormats() is a static list that never changes at runtime — cache it.
            static const auto formats = QImageReader::supportedImageFormats();
            for (const auto& format : formats) {
                extraNameFilters << "*." + format;
            }
            extraNameFilters << QStringLiteral("*.rpgmvp") << QStringLiteral("*.png_") << QStringLiteral("*.icns");

            QDir::Filters filters = QDir::Files;
            if (showHidden) {
                filters |= QDir::Hidden;
            }

            iter.emplace(dir, extraNameFilters, filters, flags);
        } else {
            QDir::Filters filters;

            if (filter == Files) {
                filters = QDir::Files;
            } else if (filter == Dirs) {
                filters = QDir::Dirs | QDir::NoDotAndDotDot;
            } else {
                filters = QDir::Dirs | QDir::Files | QDir::NoDotAndDotDot;
            }

            if (showHidden) {
                filters |= QDir::Hidden;
            }

            if (nameFilters.isEmpty()) {
                iter.emplace(dir, filters, flags);
            } else {
                iter.emplace(dir, nameFilters, filters, flags);
            }
        }

        QSet<QString> newPaths;
        // Current (size, mtime) per listed path — diffed against oldStats to find
        // files modified in place. Sourced from the iterator's own QFileInfo so no
        // extra stat() is issued beyond what the listing already performs.
        QHash<QString, QPair<qint64, qint64>> newStats;
        while (iter->hasNext()) {
            if (promise.isCanceled()) {
                return;
            }

            QString path = iter->next();

            if (filter == Images) {
                // These formats use custom decoders (not QImageReader) — skip the
                // canRead() check which would incorrectly reject them.
                if (!path.endsWith(QStringLiteral(".rpgmvp"), Qt::CaseInsensitive)
                    && !path.endsWith(QStringLiteral(".png_"), Qt::CaseInsensitive)
                    && !path.endsWith(QStringLiteral(".icns"), Qt::CaseInsensitive)) {
                    QImageReader reader(path);
                    if (!reader.canRead()) {
                        continue;
                    }
                }
            }

            newPaths.insert(path);
            // Only collect per-file stats when modified-detection can actually
            // act on them — i.e. non-recursive mode, where syncFileWatches() arms
            // the per-file watches that trigger this. In recursive mode no per-file
            // watch exists, so the extra stat()/entry/scan (a network round-trip on
            // SSHFS/FUSE) would be pure waste.
            if (!recursive) {
                const QFileInfo info = iter->fileInfo();
                newStats.insert(path, qMakePair(info.size(), info.lastModified().toMSecsSinceEpoch()));
            }
        }

        if (promise.isCanceled())
            return;

        // Paths present in both scans whose size or mtime changed — the entry's
        // cached QFileInfo is stale (e.g. a download that grew from 0 bytes after
        // it was first listed). These must be rebuilt with a fresh stat. Qt's
        // directory inotify watch never reports this (IN_MODIFY is not in its
        // mask); the trigger comes from the per-file watch in syncFileWatches().
        // Limitation: an in-place overwrite to the SAME size within the same mtime
        // tick (coarse-granularity mounts) is not detected — stat-diffing has no
        // signal there short of hashing contents, which is too costly to do here.
        QSet<QString> modified;
        for (auto it = newStats.cbegin(); it != newStats.cend(); ++it) {
            const auto oldIt = oldStats.constFind(it.key());
            if (oldIt != oldStats.cend() && *oldIt != it.value()) {
                modified.insert(it.key());
            }
        }

        if (newPaths == oldPaths && modified.isEmpty()) {
            // No changes — emit an empty result so the watcher always fires and
            // clears m_loading on the main thread, even when nothing changed.
            promise.addResult(qMakePair(QSet<QString>{}, QList<CachedEntryData>{}));
            return;
        }

        // A modified path is both removed (drop the stale entry) and added
        // (re-inserted with a fresh stat) — applyChanges() removes before it
        // inserts, so the rebuilt entry takes the old one's place.
        // `removed` is intentionally non-const: it is std::move()d into the promise
        // result below. Do not make it const — that would silently turn the move
        // into a copy.
        QSet<QString> removed = (oldPaths - newPaths) | modified;
        const QSet<QString> added = (newPaths - oldPaths) | modified;

        // Build CachedEntryData in the background thread so that stat() calls
        // (which block on SSHFS/FUSE) never run on the main/GUI thread.
        QList<CachedEntryData> cachedEntries;
        cachedEntries.reserve(added.size());
        for (const auto& entryPath : added) {
            if (promise.isCanceled()) return;
            // Shared with the FileInfo element — see buildCachedEntryData in the header.
            cachedEntries.append(buildCachedEntryData(
                entryPath, currentDir.relativeFilePath(entryPath), parentFsType));
        }

        promise.addResult(qMakePair(std::move(removed), std::move(cachedEntries)));
    });

    if (m_futures.contains(dir)) {
        m_futures[dir].cancel();
    }
    m_futures.insert(dir, future);

    const auto watcher = new QFutureWatcher<QPair<QSet<QString>, QList<CachedEntryData>>>(this);

    connect(watcher, &QFutureWatcher<QPair<QSet<QString>, QList<CachedEntryData>>>::finished, this, [dir, watcher, this]() {
        m_futures.remove(dir);

        // Safe for now: a canceled watcher cannot fire between m_futures.clear()
        // and updateEntriesForDir() because both run synchronously on the main
        // thread and Qt delivers the finished signal via the event loop.  If the
        // scan lifecycle ever becomes re-entrant, m_loading should be derived
        // from m_futures.isEmpty() rather than toggled manually.
        if (m_futures.isEmpty() && m_loading) {
            m_loading = false;
            emit loadingChanged();
        }

        if (!watcher->future().isResultReadyAt(0)) {
            watcher->deleteLater();
            return;
        }

        auto result = watcher->result();
        applyChanges(result.first, std::move(result.second));

        watcher->deleteLater();
    });

    watcher->setFuture(future);
}

void FileSystemModel::applyChanges(const QSet<QString>& removedPaths, QList<CachedEntryData> addedEntries) {
    QList<int> removedIndices;
    for (int i = 0; i < m_entries.size(); ++i) {
        if (removedPaths.contains(m_entries[i]->path())) {
            removedIndices << i;
        }
    }
    std::sort(removedIndices.begin(), removedIndices.end(), std::greater<int>());

    // Batch remove old entries
    int start = -1;
    int end = -1;
    for (int idx : std::as_const(removedIndices)) {
        if (start == -1) {
            start = idx;
            end = idx;
        } else if (idx == end - 1) {
            end = idx;
        } else {
            beginRemoveRows(QModelIndex(), end, start);
            for (int i = start; i >= end; --i) {
                m_entries.takeAt(i)->deleteLater();
            }
            endRemoveRows();

            start = idx;
            end = idx;
        }
    }
    if (start != -1) {
        beginRemoveRows(QModelIndex(), end, start);
        for (int i = start; i >= end; --i) {
            m_entries.takeAt(i)->deleteLater();
        }
        endRemoveRows();
    }

    // Guard against duplicate inserts: overlapping watcher scans each snapshot
    // oldPaths at schedule time, so the same path can land in multiple `added`
    // sets. Filter against current m_entries so applyChanges stays idempotent.
    // Also guards within-batch duplicates (same path twice in addedEntries).
    QSet<QString> existingPaths;
    existingPaths.reserve(static_cast<int>(m_entries.size()));
    for (const auto& entry : std::as_const(m_entries)) {
        existingPaths.insert(entry->path());
    }

    // Create and insert new entries, then resort for correct ordering.
    // resort() emits entriesChanged() after sorting; emit it here only when
    // there are no adds (remove-only path) so the signal fires exactly once.
    QList<FileSystemEntry*> newEntries;
    for (auto& data : addedEntries) {
        if (existingPaths.contains(data.path)) {
            continue;
        }
        existingPaths.insert(data.path); // keep set current for within-batch dupes
        newEntries << new FileSystemEntry(std::move(data), this);
    }

    if (!newEntries.isEmpty()) {
        const auto first = static_cast<int>(m_entries.size());
        const auto last = first + static_cast<int>(newEntries.size()) - 1;
        beginInsertRows(QModelIndex(), first, last);
        m_entries.append(newEntries);
        endInsertRows();

        resort(); // emits entriesChanged()
    } else if (!removedPaths.isEmpty()) {
        emit entriesChanged();
    }

    // Re-arm per-file watches against the now-current entry set. Cheap (set
    // diff) and idempotent, so it is safe to run even on a no-op scan; this is
    // also what re-establishes a watch after an atomic replace drops it.
    syncFileWatches();
}

bool FileSystemModel::compareEntries(const FileSystemEntry* a, const FileSystemEntry* b) const {
    // Directories always sort before files, regardless of sort direction
    if (a->isDir() != b->isDir()) {
        return a->isDir();
    }

    int cmp = 0;
    switch (m_sortBy) {
    case Alphabetical:
        cmp = a->relativePath().localeAwareCompare(b->relativePath());
        break;
    case Modified: {
        const auto aTime = a->modifiedDate();
        const auto bTime = b->modifiedDate();
        if (aTime < bTime) cmp = -1;
        else if (aTime > bTime) cmp = 1;
        else cmp = a->relativePath().localeAwareCompare(b->relativePath());
        break;
    }
    case Size: {
        if (a->size() < b->size()) cmp = -1;
        else if (a->size() > b->size()) cmp = 1;
        else cmp = a->relativePath().localeAwareCompare(b->relativePath());
        break;
    }
    case Extension: {
        cmp = a->suffix().localeAwareCompare(b->suffix());
        if (cmp == 0)
            cmp = a->relativePath().localeAwareCompare(b->relativePath());
        break;
    }
    case Natural: {
        static thread_local QCollator collator = []() {
            QCollator c;
            c.setNumericMode(true);
            c.setCaseSensitivity(Qt::CaseInsensitive);
            return c;
        }();
        cmp = collator.compare(a->relativePath(), b->relativePath());
        break;
    }
    }
    return m_sortReverse ? cmp > 0 : cmp < 0;
}

} // namespace symmetria::filemanager::models
