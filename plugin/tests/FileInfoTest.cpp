// FileInfoTest — unit tests for the FileInfo element (path → async
// FileSystemEntry). Uses QTEST_MAIN (not GUILESS) because the entry derivation
// runs QImageReader, which needs QGuiApplication; offscreen platform avoids a
// display server.

#include "fileinfo.hpp"
#include "filesystemmodel.hpp"

#include <QDir>
#include <QFile>
#include <QImage>
#include <QSignalSpy>
#include <QTemporaryDir>
#include <QTest>

using namespace symmetria::filemanager::models;

class FileInfoTest : public QObject {
    Q_OBJECT

private:
    QTemporaryDir m_tmpDir;

    static QString writeText(const QTemporaryDir& dir, const QString& name, const QByteArray& content)
    {
        const QString path = dir.path() + "/" + name;
        QFile f(path);
        if (!f.open(QIODevice::WriteOnly))
            return {};
        f.write(content);
        return path;
    }

    static QString writePng(const QTemporaryDir& dir, const QString& name)
    {
        const QString path = dir.path() + "/" + name;
        QImage img(8, 8, QImage::Format_RGB32);
        img.fill(Qt::red);
        return img.save(path, "PNG") ? path : QString();
    }

    // Wait until the async build settles (loading() returns to false).
    static bool waitForReady(FileInfo& fi, int timeout = 5000)
    {
        if (!fi.loading())
            return true;
        QSignalSpy spy(&fi, &FileInfo::loadingChanged);
        while (fi.loading()) {
            if (!spy.wait(timeout))
                return false;
        }
        return true;
    }

private slots:
    void initTestCase()
    {
        QVERIFY(m_tmpDir.isValid());
    }

    void imageFileDerivesImageEntry()
    {
        const QString path = writePng(m_tmpDir, "pic.png");
        QVERIFY(!path.isEmpty());

        FileInfo fi;
        fi.setPath(path);
        QVERIFY(waitForReady(fi));

        QVERIFY(fi.ready());
        auto* e = fi.entry();
        QVERIFY(e != nullptr);
        QCOMPARE(e->isDir(), false);
        QCOMPARE(e->isImage(), true);
        QCOMPARE(e->isVideo(), false);
        QVERIFY(e->mimeType().startsWith(QStringLiteral("image/")));
        QVERIFY(e->size() > 0);
        QCOMPARE(e->name(), QStringLiteral("pic.png"));
    }

    void textFileDerivesNonImageEntry()
    {
        const QString path = writeText(m_tmpDir, "notes.txt", "hello world\n");

        FileInfo fi;
        fi.setPath(path);
        QVERIFY(waitForReady(fi));

        auto* e = fi.entry();
        QVERIFY(e != nullptr);
        QCOMPARE(e->isDir(), false);
        QCOMPARE(e->isImage(), false);
        QCOMPARE(e->isVideo(), false);
        QCOMPARE(e->mimeType(), QStringLiteral("text/plain"));
    }

    void directoryDerivesDirEntry()
    {
        const QString dirPath = m_tmpDir.path() + "/subdir";
        QVERIFY(QDir(m_tmpDir.path()).mkpath("subdir"));

        FileInfo fi;
        fi.setPath(dirPath);
        QVERIFY(waitForReady(fi));

        auto* e = fi.entry();
        QVERIFY(e != nullptr);
        QCOMPARE(e->isDir(), true);
        QCOMPARE(e->isImage(), false);
        QCOMPARE(e->isVideo(), false);
    }

    void emptyPathClearsEntry()
    {
        const QString path = writeText(m_tmpDir, "clear.txt", "x\n");

        FileInfo fi;
        fi.setPath(path);
        QVERIFY(waitForReady(fi));
        QVERIFY(fi.entry() != nullptr);

        QSignalSpy entrySpy(&fi, &FileInfo::entryChanged);
        fi.setPath(QString());

        // Empty path clears synchronously — no async round-trip.
        QCOMPARE(fi.ready(), false);
        QCOMPARE(fi.entry(), nullptr);
        QVERIFY(entrySpy.count() >= 1);
    }

    void staleBuildDiscarded()
    {
        const QString pathA = writePng(m_tmpDir, "stale_a.png");
        const QString pathB = writeText(m_tmpDir, "stale_b.txt", "b\n");
        QVERIFY(!pathA.isEmpty());

        FileInfo fi;
        // Set A then immediately B — the generation counter must discard A's
        // result so the final entry reflects B.
        fi.setPath(pathA);
        fi.setPath(pathB);
        QVERIFY(waitForReady(fi));

        auto* e = fi.entry();
        QVERIFY(e != nullptr);
        QCOMPARE(e->name(), QStringLiteral("stale_b.txt"));
        QCOMPARE(e->isImage(), false);
    }

    void nonexistentPathDegradesGracefully()
    {
        // buildCachedEntryData degrades gracefully for paths that do not exist
        // (e.g. a file deleted between the fuzzy finder scan and the preview).
        // The entry should still be produced (QFileInfo does not throw for missing
        // paths) but reflect the missing state: size <= 0, isImage/isVideo false.
        const QString missingPath = m_tmpDir.path() + "/does_not_exist.txt";
        QVERIFY(!QFile::exists(missingPath));

        FileInfo fi;
        fi.setPath(missingPath);
        QVERIFY(waitForReady(fi));

        // An entry IS produced — no nullptr / crash — just with degenerate metadata.
        auto* e = fi.entry();
        QVERIFY(e != nullptr);
        QCOMPARE(e->isDir(), false);
        QCOMPARE(e->isImage(), false);
        QCOMPARE(e->isVideo(), false);
        QVERIFY(e->size() <= 0);
    }

    void yamlIsTextViaMimeInheritance()
    {
        // Regression for the YAML-no-preview bug: Qt resolves *.yaml to
        // application/yaml (NOT the legacy application/x-yaml), which inherits
        // text/plain. isText must be true so the preview router shows it as text.
        const QString path = writeText(m_tmpDir, "config.yaml", "key: value\nlist:\n  - a\n");

        FileInfo fi;
        fi.setPath(path);
        QVERIFY(waitForReady(fi));

        auto* e = fi.entry();
        QVERIFY(e != nullptr);
        QCOMPARE(e->isText(), true);
        QCOMPARE(e->isImage(), false);
        QCOMPARE(e->isDir(), false);
    }

    void plainTextIsText()
    {
        const QString path = writeText(m_tmpDir, "istext.txt", "hello\n");

        FileInfo fi;
        fi.setPath(path);
        QVERIFY(waitForReady(fi));

        QVERIFY(fi.entry() != nullptr);
        QCOMPARE(fi.entry()->isText(), true);
    }

    void extensionlessConfigIsText()
    {
        // Config-ish files with no registered extension are classified as text/plain
        // by QMimeDatabase's magic/content detection — isTextLike takes the MIME-inheritance
        // branch (mime.inherits("text/plain")), NOT the NUL-byte sniff. The sniff only fires
        // when Qt returns application/octet-stream, which content-magic prevents for readable
        // text (libmagic identifies ASCII content as text/plain regardless of extension).
        const QString path = writeText(m_tmpDir, "somerc", "# config\nsetting = 1\n");

        FileInfo fi;
        fi.setPath(path);
        QVERIFY(waitForReady(fi));

        QVERIFY(fi.entry() != nullptr);
        QCOMPARE(fi.entry()->isText(), true);
    }

    void binaryImageIsNotText()
    {
        // A real binary (PNG) must NOT be misclassified as text — it keeps the
        // image route, and the fallback card is reserved for NUL-containing
        // unknowns. Guards the router's text-as-catch-all from swallowing binaries.
        const QString path = writePng(m_tmpDir, "nottext.png");
        QVERIFY(!path.isEmpty());

        FileInfo fi;
        fi.setPath(path);
        QVERIFY(waitForReady(fi));

        QVERIFY(fi.entry() != nullptr);
        QCOMPARE(fi.entry()->isText(), false);
    }
};

QTEST_MAIN(FileInfoTest)
#include "FileInfoTest.moc"
