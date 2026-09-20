#include "previewimagehelper.hpp"
#include "icnsdecoder.hpp"
#include "heifdecoder.hpp"

#include <qcryptographichash.h>
#include <qdir.h>
#include <qfile.h>
#include <qfileinfo.h>
#include <qimage.h>
#include <qimagereader.h>
#include <qstandardpaths.h>
#include <qtconcurrentrun.h>

namespace symmetria::filemanager::models {

static QString buildCacheKey(const QString& path) {
    const QFileInfo info(path);
    return QCryptographicHash::hash(
        (path + QStringLiteral(":") + QString::number(info.lastModified().toSecsSinceEpoch())).toUtf8(),
        QCryptographicHash::Sha1
    ).toHex();
}

PreviewImageHelper::PreviewImageHelper(QObject* parent)
    : QObject(parent) {}

PreviewImageHelper::~PreviewImageHelper() {
    // Cancel in-flight work without blocking the GUI thread.
    // The thread pool will finish the job on its own; the watcher is parented
    // to this object and will be collected when the parent is destroyed, but we
    // disconnect it first to prevent the finished signal firing after destruction.
    if (m_watcher) {
        m_watcher->disconnect();
        m_watcher->cancel();
    }
}

QString PreviewImageHelper::source() const { return m_source; }

void PreviewImageHelper::setSource(const QString& path) {
    if (m_source == path) return;
    m_source = path;
    emit sourceChanged();
    processSource();
}

QString PreviewImageHelper::resolvedUrl() const { return m_resolvedUrl; }

bool PreviewImageHelper::loading() const { return m_loading; }

// Sets m_resolvedUrl and emits resolvedUrlChanged. Also clears m_loading and
// emits loadingChanged if it was set. Used by all synchronous return paths.
void PreviewImageHelper::applyResolvedUrl(const QString& url) {
    if (m_resolvedUrl != url) {
        m_resolvedUrl = url;
        emit resolvedUrlChanged();
    }
    if (m_loading) {
        m_loading = false;
        emit loadingChanged();
    }
}

void PreviewImageHelper::processSource() {
    // Cancel any in-flight async work without blocking the GUI thread.
    // Disconnect signals first so the old watcher's finished signal cannot
    // fire against a stale this-pointer after we null out m_watcher.
    if (m_watcher) {
        m_watcher->disconnect();
        m_watcher->cancel();
        m_watcher->deleteLater();
        m_watcher = nullptr;
    }

    // Empty source — clear everything
    if (m_source.isEmpty()) {
        if (!m_resolvedUrl.isEmpty()) {
            m_resolvedUrl.clear();
            emit resolvedUrlChanged();
        }
        if (m_loading) {
            m_loading = false;
            emit loadingChanged();
        }
        return;
    }

    // Files that don't need cached decoding — passthrough
    if (!needsCachedDecode(m_source)) {
        applyResolvedUrl(QStringLiteral("file://") + m_source);
        return;
    }

    // PDF / RPGMV / .icns — check cache first, then generate asynchronously
    const auto cachePath = cachedPreviewPathFor(m_source);

    // Cache hit — return immediately without spinning up a thread
    if (QFileInfo::exists(cachePath)) {
        applyResolvedUrl(QStringLiteral("file://") + cachePath);
        return;
    }

    // Cache miss — render asynchronously
    if (!m_loading) {
        m_loading = true;
        emit loadingChanged();
    }

    // Capture both the source string and the watcher pointer so the lambda
    // is self-contained and does not touch m_watcher after it has been nulled
    // or replaced by a subsequent processSource() call.
    const auto capturedSource = m_source;

    m_watcher = new QFutureWatcher<QString>(this);
    connect(m_watcher, &QFutureWatcher<QString>::finished, this,
            [this, capturedSource, watcher = m_watcher]() {
        // Stale result — source changed while we were rendering
        if (m_source != capturedSource) return;

        const auto result = watcher->result();
        watcher->deleteLater();
        m_watcher = nullptr;

        m_loading = false;
        emit loadingChanged();

        if (!result.isEmpty()) {
            m_resolvedUrl = QStringLiteral("file://") + result;
        } else {
            // Render failed — fall back to raw file URL
            m_resolvedUrl = QStringLiteral("file://") + m_source;
        }
        emit resolvedUrlChanged();
    });

    m_watcher->setFuture(QtConcurrent::run(generateCachedPreview, m_source, cachePath));
}

bool PreviewImageHelper::needsCachedDecode(const QString& path) {
    // Use a fast suffix check to avoid opening the file on the GUI thread.
    // The reader-based format detection would perform synchronous I/O here.
    return path.endsWith(QStringLiteral(".pdf"), Qt::CaseInsensitive)
        || path.endsWith(QStringLiteral(".rpgmvp"), Qt::CaseInsensitive)
        || path.endsWith(QStringLiteral(".png_"), Qt::CaseInsensitive)
        || path.endsWith(QStringLiteral(".icns"), Qt::CaseInsensitive)
        || isHeifFormat(path);
}

// True for HEIF/HEIC containers (.heic / .heif). Qt has no native HEIF image
// plugin on our target, so these are decoded via libheif into a cache PNG
// rather than passed through to the QML Image (which would fail to load them).
bool PreviewImageHelper::isHeifFormat(const QString& path) {
    return path.endsWith(QStringLiteral(".heic"), Qt::CaseInsensitive)
        || path.endsWith(QStringLiteral(".heif"), Qt::CaseInsensitive);
}

// Returns true for encrypted RPGMV game assets (.rpgmvp / .png_).
// Used in two places: routing the open-path vs. preview-path policy, and
// selecting the decryption branch inside generateCachedPreview.
bool PreviewImageHelper::isRpgmvFormat(const QString& path) {
    return path.endsWith(QStringLiteral(".rpgmvp"), Qt::CaseInsensitive)
        || path.endsWith(QStringLiteral(".png_"), Qt::CaseInsensitive);
}

// True only for formats where the cached file IS the artifact the user wants
// to open — i.e. decrypted RPGMV game assets whose source bytes are unusable
// without decryption. PDFs and ICNS are NOT in this set: their cache is just
// a thumbnail; the source is what the user actually wants to launch.
bool PreviewImageHelper::cacheIsOpenableArtifact(const QString& path) {
    return isRpgmvFormat(path);
}

QString PreviewImageHelper::cachedPreviewPathFor(const QString& sourcePath) {
    return cacheDir() + QStringLiteral("/") + buildCacheKey(sourcePath) + QStringLiteral(".png");
}

QString PreviewImageHelper::generateCachedPreview(const QString& sourcePath, const QString& cachePath) {
    // Ensure the cache directory exists before any format handler runs.
    QDir().mkpath(QFileInfo(cachePath).absolutePath());

    if (isRpgmvFormat(sourcePath))
        return decryptRpgmvp(sourcePath, cachePath);

    if (sourcePath.endsWith(QStringLiteral(".icns"), Qt::CaseInsensitive))
        return IcnsDecoder::extractLargestPng(sourcePath, cachePath);

    if (isHeifFormat(sourcePath))
        return HeifDecoder::decodeToPng(sourcePath, cachePath);

    // PDF — render first page with white background compositing
    QImageReader reader(sourcePath);
    reader.setBackgroundColor(Qt::white);

    const QImage image = reader.read();
    if (image.isNull()) return {};

    if (!image.save(cachePath, "PNG")) return {};

    return cachePath;
}

QString PreviewImageHelper::decryptRpgmvp(const QString& sourcePath, const QString& cachePath) {
    QFile input(sourcePath);
    if (!input.open(QIODevice::ReadOnly))
        return {};

    // File layout: [16-byte RPGMV signature] [16-byte XOR-encrypted PNG header] [rest of PNG]
    // The first 16 plaintext bytes of any PNG are always identical:
    //   PNG magic (8 bytes) + IHDR chunk length (4 bytes) + "IHDR" tag (4 bytes).
    // We restore them directly — no XOR key needed.
    if (input.size() < 32)
        return {};

    static constexpr char pngMagic[16] = {
        '\x89', '\x50', '\x4E', '\x47', '\x0D', '\x0A', '\x1A', '\x0A',
        '\x00', '\x00', '\x00', '\x0D', '\x49', '\x48', '\x44', '\x52'
    };

    // Skip both the 16-byte RPGMV signature and the 16 encrypted PNG header bytes;
    // the unencrypted remainder starts at offset 32.
    input.seek(32);
    const QByteArray remainder = input.readAll();
    input.close();

    if (remainder.isEmpty())
        return {};

    QFile output(cachePath);
    if (!output.open(QIODevice::WriteOnly))
        return {};

    auto cleanupPartial = [&]() -> QString {
        output.close();
        QFile::remove(cachePath);
        return {};
    };

    if (output.write(pngMagic, 16) != 16)
        return cleanupPartial();
    if (output.write(remainder) != remainder.size())
        return cleanupPartial();

    output.close();
    return cachePath;
}

QString PreviewImageHelper::resolvePathForOpen(const QString& path) {
    // Only RPGMV-style decrypted assets need cache redirection at open time.
    // Every other format — including PDF and ICNS — must open by source path
    // so the user's configured handler launches (e.g. sioyek for PDFs).
    // Returning the cached PNG here used to misroute PDFs into the image
    // viewer because the preview pane had already populated the cache.
    if (!cacheIsOpenableArtifact(path))
        return path;

    const auto cachePath = cachedPreviewPathFor(path);

    if (QFileInfo::exists(cachePath))
        return cachePath;

    // Cache miss for RPGMV: trivial header-skip + memcopy, safe on the GUI
    // thread (<1ms even for large files). Fall back to source path if the
    // write fails — xdg-open on the encrypted source is better than an empty
    // path being passed to the caller.
    const auto result = generateCachedPreview(path, cachePath);
    return result.isEmpty() ? path : result;
}

QString PreviewImageHelper::resolvePathForPreview(const QString& path) {
    if (!needsCachedDecode(path))
        return path;

    const auto cachePath = cachedPreviewPathFor(path);
    return QFileInfo::exists(cachePath) ? cachePath : path;
}

const QString& PreviewImageHelper::cacheDir() {
    // Compute once per process lifetime — QStandardPaths does not change at runtime.
    static const QString dir = QStandardPaths::writableLocation(QStandardPaths::CacheLocation)
        + QStringLiteral("/preview");
    return dir;
}

} // namespace symmetria::filemanager::models
