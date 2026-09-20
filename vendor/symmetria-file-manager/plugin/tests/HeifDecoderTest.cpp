// HeifDecoderTest — unit tests for the libheif-backed HEIF/HEIC decoder.
//
// Qt has no native HEIF image plugin on our target (Arch's qt6-imageformats is
// built without libheif), so HEIC previews route through HeifDecoder::decodeToPng
// rather than a QML Image. These tests decode a small checked-in fixture and
// assert the output PNG has the right dimensions and pixel content, plus that
// the decoder fails gracefully (empty string, no output file) on bad input.
//
// The fixture (fixtures/sample.heic) is a 32x24 HEIC: left half red, right half
// blue. Decoding requires only libde265 (a runtime dependency of libheif), so it
// works anywhere libheif is installed — no HEVC *encoder* needed at test time.
//
// QTEST_MAIN (not GUILESS) + QT_QPA_PLATFORM=offscreen (set via CMake) because
// QImage save/load and libheif's decode path expect a QGuiApplication.

#include "heifdecoder.hpp"

#include <QColor>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QImage>
#include <QTemporaryDir>
#include <QTest>

using namespace symmetria::filemanager::models;

class HeifDecoderTest : public QObject {
    Q_OBJECT

private:
    QTemporaryDir m_tmpDir;

    static QString fixture(const QString& name)
    {
        return QStringLiteral(HEIF_FIXTURE_DIR) + QStringLiteral("/") + name;
    }

    QString outPath(const QString& name) const
    {
        return m_tmpDir.path() + QStringLiteral("/") + name;
    }

private slots:
    void initTestCase()
    {
        QVERIFY(m_tmpDir.isValid());
        QVERIFY2(QFileInfo::exists(fixture(QStringLiteral("sample.heic"))),
                 "HEIF fixture missing — check plugin/tests/fixtures/sample.heic");
    }

    // Happy path: a valid HEIC decodes to a PNG with the correct dimensions and
    // the expected left-red / right-blue content.
    void decodeToPng_validHeic_producesCorrectPng()
    {
        const QString out = outPath(QStringLiteral("decoded.png"));
        const QString result =
            HeifDecoder::decodeToPng(fixture(QStringLiteral("sample.heic")), out);

        // Named before the comparison, because an empty result has one common
        // cause and a bare string mismatch does not say so: a libheif with no
        // HEVC decoder plugin. It reports "Unsupported codec" and returns
        // nothing, exactly as a corrupt file would.
        QVERIFY2(!result.isEmpty(),
                 "decodeToPng returned empty for a VALID HEIC. The usual cause is a "
                 "libheif with no HEVC decoder plugin — on Debian/Ubuntu install "
                 "libheif-plugin-libde265. The qWarning from heifdecoder.cpp carries "
                 "libheif's own message.");
        QCOMPARE(result, out);
        QVERIFY(QFileInfo::exists(out));

        QImage img(out);
        QVERIFY(!img.isNull());
        QCOMPARE(img.width(), 32);
        QCOMPARE(img.height(), 24);

        // Sample well inside each half to avoid HEVC block-edge color bleed at
        // the boundary. Loose thresholds absorb lossy-codec drift.
        const QColor left = img.pixelColor(6, 12);
        const QColor right = img.pixelColor(26, 12);

        QVERIFY2(left.red() > 150 && left.blue() < 100,
                 qPrintable(QStringLiteral("left pixel not red-dominant: %1")
                                .arg(left.name())));
        QVERIFY2(right.blue() > 150 && right.red() < 100,
                 qPrintable(QStringLiteral("right pixel not blue-dominant: %1")
                                .arg(right.name())));
    }

    // The cache directory is created if absent (decodeToPng mkpath's it).
    void decodeToPng_createsCacheParentDir()
    {
        const QString out = outPath(QStringLiteral("nested/sub/decoded.png"));
        QVERIFY(!QFileInfo::exists(QFileInfo(out).absolutePath()));

        const QString result =
            HeifDecoder::decodeToPng(fixture(QStringLiteral("sample.heic")), out);

        QCOMPARE(result, out);
        QVERIFY(QFileInfo::exists(out));
    }

    // A non-existent source returns empty and writes nothing.
    void decodeToPng_missingSource_returnsEmpty()
    {
        const QString out = outPath(QStringLiteral("missing.png"));
        const QString result =
            HeifDecoder::decodeToPng(m_tmpDir.path() + QStringLiteral("/nope.heic"), out);

        QVERIFY(result.isEmpty());
        QVERIFY(!QFileInfo::exists(out));
    }

    // Garbage bytes with a .heic name must not crash and must return empty.
    void decodeToPng_corruptData_returnsEmpty()
    {
        const QString src = m_tmpDir.path() + QStringLiteral("/corrupt.heic");
        QFile f(src);
        QVERIFY(f.open(QIODevice::WriteOnly));
        f.write(QByteArray(128, '\x00'));
        f.close();

        const QString out = outPath(QStringLiteral("corrupt.png"));
        const QString result = HeifDecoder::decodeToPng(src, out);

        QVERIFY(result.isEmpty());
        QVERIFY(!QFileInfo::exists(out));
    }
};

QTEST_MAIN(HeifDecoderTest)
#include "HeifDecoderTest.moc"
