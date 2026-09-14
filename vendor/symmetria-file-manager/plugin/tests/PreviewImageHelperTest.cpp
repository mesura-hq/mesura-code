// PreviewImageHelperTest — unit tests for the open/preview path-resolution policy.
//
// These tests verify the policy split introduced in 782e596: resolvePathForOpen
// must NEVER redirect PDFs to cached thumbnails; resolvePathForPreview must return
// the cached path only when it already exists.
//
// All files are created in QTemporaryDir. RPGMV test assets use the minimum valid
// 32-byte layout (16-byte RPGMV signature + 16-byte encrypted PNG header). The
// decrypted output is a valid PNG (pngMagic prefix + empty remainder) — small
// enough that it writes in < 1ms.
//
// Uses QTEST_MAIN (not GUILESS) because QStandardPaths in some Qt builds queries
// the display. QT_QPA_PLATFORM=offscreen is set via CMake for all model tests.

#include "previewimagehelper.hpp"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QStandardPaths>
#include <QTemporaryDir>
#include <QTest>

using namespace symmetria::filemanager::models;

class PreviewImageHelperTest : public QObject {
    Q_OBJECT

private:
    QTemporaryDir m_tmpDir;

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    // Write bytes to a file under m_tmpDir and return its absolute path.
    QString writeFile(const QString& name, const QByteArray& content) const
    {
        const QString path = m_tmpDir.path() + "/" + name;
        QFile f(path);
        if (!f.open(QIODevice::WriteOnly))
            return {};
        f.write(content);
        return path;
    }

    // Build a minimal .rpgmvp payload: 16-byte RPGMV signature + 16 zero bytes
    // (where the encrypted PNG header would live) + 1 padding byte.
    // The 1 padding byte ensures remainder (bytes [32..]) is non-empty so
    // decryptRpgmvp does not bail out at the `remainder.isEmpty()` guard.
    // resolvePathForOpen will decrypt this to a 16-byte PNG magic header +
    // 1 zero byte — technically invalid PNG, but QFile writes it without error.
    static QByteArray minimalRpgmvpBytes()
    {
        QByteArray data(33, '\x00'); // 32-byte header + 1 remainder byte
        // RPGMV signature in the first 16 bytes (any value — not validated by decoder)
        data[0] = static_cast<char>(0x52); // 'R'
        data[1] = static_cast<char>(0x50); // 'P'
        data[2] = static_cast<char>(0x47); // 'G'
        return data;
    }

    // Return the path where PreviewImageHelper would cache a given source path.
    // Must stay in sync with cachedPreviewPathFor (which is private — we
    // reconstruct its logic here using QCryptographicHash directly).
    static QString expectedCachePathFor(const QString& sourcePath)
    {
        const QFileInfo info(sourcePath);
        const QByteArray key = QCryptographicHash::hash(
            (sourcePath + QStringLiteral(":") +
             QString::number(info.lastModified().toSecsSinceEpoch())).toUtf8(),
            QCryptographicHash::Sha1
        ).toHex();

        return QStandardPaths::writableLocation(QStandardPaths::CacheLocation)
            + QStringLiteral("/preview/") + key + QStringLiteral(".png");
    }

    // Create an empty file at the given path (including parent dirs).
    static bool touchFile(const QString& path)
    {
        QDir().mkpath(QFileInfo(path).absolutePath());
        QFile f(path);
        return f.open(QIODevice::WriteOnly);
    }

    // Delete a file if it exists (used to reset cache state between test cases).
    static void removeIfExists(const QString& path)
    {
        if (QFileInfo::exists(path))
            QFile::remove(path);
    }

private slots:
    void initTestCase()
    {
        QVERIFY(m_tmpDir.isValid());
    }

    // -----------------------------------------------------------------------
    // resolvePathForOpen — PDF tests
    // -----------------------------------------------------------------------

    // Core regression: a pre-cached PDF must be opened by source path, not
    // by the cached thumbnail. This is the exact bug fixed in 782e596.
    void resolvePathForOpen_cachedPdf_returnsSoucePath()
    {
        const QString pdfPath = writeFile("document.pdf", "fake-pdf-content");
        QVERIFY(!pdfPath.isEmpty());

        // Simulate the preview pane having already populated the cache.
        const QString cachePath = expectedCachePathFor(pdfPath);
        QVERIFY(touchFile(cachePath));

        const QString resolved = PreviewImageHelper::resolvePathForOpen(pdfPath);
        removeIfExists(cachePath);

        QCOMPARE(resolved, pdfPath);
    }

    void resolvePathForOpen_uncachedPdf_returnsSourcePath()
    {
        const QString pdfPath = writeFile("uncached.pdf", "fake-pdf-content");
        QVERIFY(!pdfPath.isEmpty());

        // Guarantee no cache entry exists.
        const QString cachePath = expectedCachePathFor(pdfPath);
        removeIfExists(cachePath);

        const QString resolved = PreviewImageHelper::resolvePathForOpen(pdfPath);

        QCOMPARE(resolved, pdfPath);
    }

    // -----------------------------------------------------------------------
    // resolvePathForOpen — RPGMV tests
    // -----------------------------------------------------------------------

    void resolvePathForOpen_cachedRpgmvp_returnsCachePath()
    {
        const QString rpgPath = writeFile("asset.rpgmvp", minimalRpgmvpBytes());
        QVERIFY(!rpgPath.isEmpty());

        const QString cachePath = expectedCachePathFor(rpgPath);
        QVERIFY(touchFile(cachePath));

        const QString resolved = PreviewImageHelper::resolvePathForOpen(rpgPath);
        removeIfExists(cachePath);

        QCOMPARE(resolved, cachePath);
    }

    // Cache miss: resolvePathForOpen must synchronously decrypt and write the
    // cache, then return the resulting cache path (not the encrypted source).
    void resolvePathForOpen_uncachedRpgmvp_decryptsAndReturnsCachePath()
    {
        const QString rpgPath = writeFile("fresh.rpgmvp", minimalRpgmvpBytes());
        QVERIFY(!rpgPath.isEmpty());

        const QString cachePath = expectedCachePathFor(rpgPath);
        removeIfExists(cachePath);

        const QString resolved = PreviewImageHelper::resolvePathForOpen(rpgPath);

        // Must return the cache path, not the source.
        QCOMPARE(resolved, cachePath);
        // The cache file must now exist.
        QVERIFY(QFileInfo::exists(cachePath));

        removeIfExists(cachePath);
    }

    // If decryption fails (e.g. file too small / corrupt), resolvePathForOpen
    // must fall back to the source path rather than returning an empty string.
    void resolvePathForOpen_corruptRpgmvp_fallsBackToSourcePath()
    {
        // A 10-byte file is below the 32-byte minimum — decryptRpgmvp returns {}.
        const QString rpgPath = writeFile("corrupt.rpgmvp", QByteArray(10, '\x00'));
        QVERIFY(!rpgPath.isEmpty());

        const QString cachePath = expectedCachePathFor(rpgPath);
        removeIfExists(cachePath);

        const QString resolved = PreviewImageHelper::resolvePathForOpen(rpgPath);

        // Must not return empty — xdg-open "" would be silently broken.
        QVERIFY(!resolved.isEmpty());
        QCOMPARE(resolved, rpgPath);
    }

    // -----------------------------------------------------------------------
    // resolvePathForPreview
    // -----------------------------------------------------------------------

    // A normal file (not PDF/RPGMV/ICNS) passes through unchanged.
    void resolvePathForPreview_normalFile_passthrough()
    {
        const QString imgPath = writeFile("photo.jpg", "fake-jpeg");
        QVERIFY(!imgPath.isEmpty());

        QCOMPARE(PreviewImageHelper::resolvePathForPreview(imgPath), imgPath);
    }

    // Cache hit for PDF: must return the cached path.
    void resolvePathForPreview_cachedPdf_returnsCachePath()
    {
        const QString pdfPath = writeFile("preview.pdf", "fake-pdf");
        QVERIFY(!pdfPath.isEmpty());

        const QString cachePath = expectedCachePathFor(pdfPath);
        QVERIFY(touchFile(cachePath));

        const QString resolved = PreviewImageHelper::resolvePathForPreview(pdfPath);
        removeIfExists(cachePath);

        QCOMPARE(resolved, cachePath);
    }

    // Cache miss for PDF: must return source path (no generation).
    void resolvePathForPreview_uncachedPdf_returnsSourcePath()
    {
        const QString pdfPath = writeFile("nocache.pdf", "fake-pdf");
        QVERIFY(!pdfPath.isEmpty());

        const QString cachePath = expectedCachePathFor(pdfPath);
        removeIfExists(cachePath);

        const QString resolved = PreviewImageHelper::resolvePathForPreview(pdfPath);

        QCOMPARE(resolved, pdfPath);
        // Must not have generated the cache as a side effect.
        QVERIFY(!QFileInfo::exists(cachePath));
    }

    // Cache hit for RPGMV: must return the cached path.
    void resolvePathForPreview_cachedRpgmvp_returnsCachePath()
    {
        const QString rpgPath = writeFile("cached_asset.rpgmvp", minimalRpgmvpBytes());
        QVERIFY(!rpgPath.isEmpty());

        const QString cachePath = expectedCachePathFor(rpgPath);
        QVERIFY(touchFile(cachePath));

        const QString resolved = PreviewImageHelper::resolvePathForPreview(rpgPath);
        removeIfExists(cachePath);

        QCOMPARE(resolved, cachePath);
    }

    // Cache miss for RPGMV: must return source path without generating the cache.
    void resolvePathForPreview_uncachedRpgmvp_returnsSourcePathWithoutDecrypting()
    {
        const QString rpgPath = writeFile("nocache_asset.rpgmvp", minimalRpgmvpBytes());
        QVERIFY(!rpgPath.isEmpty());

        const QString cachePath = expectedCachePathFor(rpgPath);
        removeIfExists(cachePath);

        const QString resolved = PreviewImageHelper::resolvePathForPreview(rpgPath);

        QCOMPARE(resolved, rpgPath);
        // resolvePathForPreview must never generate the cache.
        QVERIFY(!QFileInfo::exists(cachePath));
    }

    // -----------------------------------------------------------------------
    // HEIF/HEIC routing
    //
    // Guards the classification seam: .heic/.heif must route through the
    // cached-decode path (needsCachedDecode) so the preview pane shows the
    // libheif-rendered PNG, yet must NOT be openable artifacts — opening
    // launches the real viewer on the source, like PDF/ICNS. These use fake
    // bytes (never decoded here) because resolvePathFor* only inspect the
    // suffix and the cache; actual decode is covered by HeifDecoderTest.
    // -----------------------------------------------------------------------

    // Cache hit for HEIC: preview must return the cached PNG path — proves
    // .heic is in needsCachedDecode.
    void resolvePathForPreview_cachedHeic_returnsCachePath()
    {
        const QString heicPath = writeFile("photo.heic", "fake-heic");
        QVERIFY(!heicPath.isEmpty());

        const QString cachePath = expectedCachePathFor(heicPath);
        QVERIFY(touchFile(cachePath));

        const QString resolved = PreviewImageHelper::resolvePathForPreview(heicPath);
        removeIfExists(cachePath);

        QCOMPARE(resolved, cachePath);
    }

    // Cache miss for HEIF: preview returns the source path without generating
    // the cache (also exercises the .heif suffix, not just .heic).
    void resolvePathForPreview_uncachedHeif_returnsSourcePath()
    {
        const QString heifPath = writeFile("nocache.heif", "fake-heif");
        QVERIFY(!heifPath.isEmpty());

        const QString cachePath = expectedCachePathFor(heifPath);
        removeIfExists(cachePath);

        const QString resolved = PreviewImageHelper::resolvePathForPreview(heifPath);

        QCOMPARE(resolved, heifPath);
        QVERIFY(!QFileInfo::exists(cachePath));
    }

    // Opening a HEIC must launch the real viewer on the source, never the
    // cached thumbnail — even when a cache entry exists (same policy as PDF).
    void resolvePathForOpen_cachedHeic_returnsSourcePath()
    {
        const QString heicPath = writeFile("open.heic", "fake-heic");
        QVERIFY(!heicPath.isEmpty());

        const QString cachePath = expectedCachePathFor(heicPath);
        QVERIFY(touchFile(cachePath));

        const QString resolved = PreviewImageHelper::resolvePathForOpen(heicPath);
        removeIfExists(cachePath);

        QCOMPARE(resolved, heicPath);
    }
};

QTEST_MAIN(PreviewImageHelperTest)
#include "PreviewImageHelperTest.moc"
