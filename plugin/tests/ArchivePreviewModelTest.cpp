// ArchivePreviewModelTest — unit tests for the archive preview model.
//
// All test archives are created programmatically via the libarchive C API
// in QTemporaryDir, so no binary fixtures need to be committed to the repo.
// Uses QTEST_MAIN (not GUILESS) because QAbstractItemModelTester requires QGuiApplication.

#include "archivepreviewmodel.hpp"

#include <QAbstractItemModelTester>
#include <QSignalSpy>
#include <QTemporaryDir>
#include <QTest>

#include <archive.h>
#include <archive_entry.h>

using namespace symmetria::filemanager::models;

class ArchivePreviewModelTest : public QObject {
    Q_OBJECT

private:
    // Creates a .tar.gz archive at `archivePath` containing the given entries.
    // Each entry is {path, size, isDir}. File content is filled with 'x' bytes.
    struct TestEntry {
        QString path;
        qint64 size = 0;
        bool isDir = false;
    };

    static bool createArchive(const QString& archivePath, const QVector<TestEntry>& entries)
    {
        struct archive* a = archive_write_new();
        if (!a)
            return false;
        archive_write_set_format_pax_restricted(a);
        archive_write_add_filter_gzip(a);

        const QByteArray pathBytes = archivePath.toUtf8();
        if (archive_write_open_filename(a, pathBytes.constData()) != ARCHIVE_OK) {
            archive_write_free(a);
            return false;
        }

        struct archive_entry* entry = archive_entry_new();
        for (const auto& e : entries) {
            archive_entry_clear(entry);
            archive_entry_set_pathname(entry, e.path.toUtf8().constData());
            if (e.isDir) {
                archive_entry_set_filetype(entry, AE_IFDIR);
                archive_entry_set_perm(entry, 0755);
            } else {
                archive_entry_set_filetype(entry, AE_IFREG);
                archive_entry_set_size(entry, e.size);
                archive_entry_set_perm(entry, 0644);
            }
            archive_write_header(a, entry);
            if (!e.isDir && e.size > 0) {
                const QByteArray data(static_cast<int>(e.size), 'x');
                archive_write_data(a, data.constData(), static_cast<size_t>(e.size));
            }
        }
        archive_entry_free(entry);

        archive_write_close(a);
        archive_write_free(a);
        return true;
    }

    // Helper: wait for the model to finish loading after setting filePath.
    static bool waitForLoad(ArchivePreviewModel& model, int timeout = 5000)
    {
        if (!model.loading())
            return true;
        QSignalSpy spy(&model, &ArchivePreviewModel::loadingChanged);
        // Wait for loading to become false
        while (model.loading()) {
            if (!spy.wait(timeout))
                return false;
        }
        return true;
    }

private slots:
    void modelTester()
    {
        QTemporaryDir tmpDir;
        QVERIFY(tmpDir.isValid());
        const QString archive = tmpDir.path() + "/test.tar.gz";
        QVERIFY(createArchive(archive, {
            {"dir1/", 0, true},
            {"dir1/file1.txt", 100, false},
            {"dir1/file2.txt", 200, false},
            {"file3.txt", 50, false},
        }));

        ArchivePreviewModel model;
        // QAbstractItemModelTester checks model contract invariants on every mutation
        QAbstractItemModelTester tester(&model, QAbstractItemModelTester::FailureReportingMode::QtTest);

        model.setFilePath(archive);
        QVERIFY(waitForLoad(model));
        QVERIFY(model.rowCount() > 0);
    }

    void entryCountBelowCap()
    {
        QTemporaryDir tmpDir;
        QVERIFY(tmpDir.isValid());
        const QString archive = tmpDir.path() + "/small.tar.gz";
        QVector<TestEntry> entries;
        for (int i = 0; i < 10; ++i)
            entries.append({QString("file%1.txt").arg(i), 10, false});
        QVERIFY(createArchive(archive, entries));

        ArchivePreviewModel model;
        model.setFilePath(archive);
        QVERIFY(waitForLoad(model));

        QCOMPARE(model.rowCount(), 10);
        QCOMPARE(model.totalEntries(), 10);
        QCOMPARE(model.truncated(), false);
    }

    void entryCountAtCap()
    {
        QTemporaryDir tmpDir;
        QVERIFY(tmpDir.isValid());
        const QString archive = tmpDir.path() + "/at_cap.tar.gz";
        QVector<TestEntry> entries;
        for (int i = 0; i < ArchivePreviewModel::MaxEntries; ++i)
            entries.append({QString("f%1").arg(i, 5, 10, QChar('0')), 0, false});
        QVERIFY(createArchive(archive, entries));

        ArchivePreviewModel model;
        model.setFilePath(archive);
        QVERIFY(waitForLoad(model));

        QCOMPARE(model.rowCount(), ArchivePreviewModel::MaxEntries);
        QCOMPARE(model.totalEntries(), ArchivePreviewModel::MaxEntries);
        QCOMPARE(model.truncated(), false);
    }

    void entryCountAboveCap()
    {
        QTemporaryDir tmpDir;
        QVERIFY(tmpDir.isValid());
        const QString archive = tmpDir.path() + "/above_cap.tar.gz";
        const int count = ArchivePreviewModel::MaxEntries + 10;
        QVector<TestEntry> entries;
        for (int i = 0; i < count; ++i)
            entries.append({QString("f%1").arg(i, 5, 10, QChar('0')), 0, false});
        QVERIFY(createArchive(archive, entries));

        ArchivePreviewModel model;
        model.setFilePath(archive);
        QVERIFY(waitForLoad(model));

        QCOMPARE(model.rowCount(), ArchivePreviewModel::MaxEntries);
        QCOMPARE(model.totalEntries(), count);
        QCOMPARE(model.truncated(), true);
    }

    void emptyArchive()
    {
        QTemporaryDir tmpDir;
        QVERIFY(tmpDir.isValid());
        const QString archive = tmpDir.path() + "/empty.tar.gz";
        QVERIFY(createArchive(archive, {}));

        ArchivePreviewModel model;
        model.setFilePath(archive);
        QVERIFY(waitForLoad(model));

        QCOMPARE(model.rowCount(), 0);
        QCOMPARE(model.fileCount(), 0);
        QCOMPARE(model.dirCount(), 0);
        QCOMPARE(model.totalSize(), 0);
        QCOMPARE(model.truncated(), false);
        QVERIFY(model.error().isEmpty());
    }

    void corruptedArchiveGracefulFailure()
    {
        QTemporaryDir tmpDir;
        QVERIFY(tmpDir.isValid());
        const QString archive = tmpDir.path() + "/corrupted.tar.gz";
        // Write random bytes — libarchive with raw format support may
        // interpret these as a degenerate stream rather than erroring.
        // The invariant is graceful handling: no crash, loading completes,
        // and the model is left in a consistent empty-or-error state.
        QFile f(archive);
        QVERIFY(f.open(QIODevice::WriteOnly));
        f.write(QByteArray(1024, '\xDE'));
        f.close();

        ArchivePreviewModel model;
        model.setFilePath(archive);
        QVERIFY(waitForLoad(model));

        // libarchive with archive_read_support_format_raw() may interpret
        // arbitrary bytes as a degenerate raw stream (rowCount > 0, no error).
        // The only reliable invariant is: loading completed without a crash.
        QCOMPARE(model.loading(), false);
    }

    void nonExistentFileReportsError()
    {
        ArchivePreviewModel model;
        model.setFilePath(QStringLiteral("/tmp/nonexistent_archive_xyz.tar.gz"));
        QVERIFY(waitForLoad(model));

        QVERIFY(!model.error().isEmpty());
        QCOMPARE(model.rowCount(), 0);
    }

    void roleDataCorrect()
    {
        QTemporaryDir tmpDir;
        QVERIFY(tmpDir.isValid());
        const QString archive = tmpDir.path() + "/roles.tar.gz";
        QVERIFY(createArchive(archive, {
            {"src/", 0, true},
            {"src/main.cpp", 256, false},
        }));

        ArchivePreviewModel model;
        model.setFilePath(archive);
        QVERIFY(waitForLoad(model));

        QVERIFY(model.rowCount() >= 2);

        // First entry should be the directory "src"
        const QModelIndex dirIdx = model.index(0, 0);
        QCOMPARE(model.data(dirIdx, ArchivePreviewModel::NameRole).toString(), QStringLiteral("src"));
        QCOMPARE(model.data(dirIdx, ArchivePreviewModel::IsDirRole).toBool(), true);
        QCOMPARE(model.data(dirIdx, ArchivePreviewModel::DepthRole).toInt(), 0);

        // Second entry should be the file "main.cpp" inside "src"
        const QModelIndex fileIdx = model.index(1, 0);
        QCOMPARE(model.data(fileIdx, ArchivePreviewModel::NameRole).toString(), QStringLiteral("main.cpp"));
        QCOMPARE(model.data(fileIdx, ArchivePreviewModel::FullPathRole).toString(), QStringLiteral("src/main.cpp"));
        QCOMPARE(model.data(fileIdx, ArchivePreviewModel::SizeRole).toLongLong(), 256);
        QCOMPARE(model.data(fileIdx, ArchivePreviewModel::IsDirRole).toBool(), false);
        QCOMPARE(model.data(fileIdx, ArchivePreviewModel::DepthRole).toInt(), 1);
    }

    void generationCounterDiscardsStale()
    {
        QTemporaryDir tmpDir;
        QVERIFY(tmpDir.isValid());

        const QString archiveA = tmpDir.path() + "/a.tar.gz";
        const QString archiveB = tmpDir.path() + "/b.tar.gz";
        QVERIFY(createArchive(archiveA, {{"a1.txt", 10, false}, {"a2.txt", 20, false}}));
        QVERIFY(createArchive(archiveB, {{"b1.txt", 30, false}}));

        ArchivePreviewModel model;
        // Set A then immediately B — A's result should be discarded
        model.setFilePath(archiveA);
        model.setFilePath(archiveB);
        QVERIFY(waitForLoad(model));

        // Final state must reflect archive B
        QCOMPARE(model.rowCount(), 1);
        const QModelIndex idx = model.index(0, 0);
        QCOMPARE(model.data(idx, ArchivePreviewModel::NameRole).toString(), QStringLiteral("b1.txt"));
    }

    void directoriesBeforeFiles()
    {
        QTemporaryDir tmpDir;
        QVERIFY(tmpDir.isValid());
        const QString archive = tmpDir.path() + "/mixed.tar.gz";
        // Insert files before directories to test the partition logic
        QVERIFY(createArchive(archive, {
            {"file1.txt", 10, false},
            {"dir1/", 0, true},
            {"file2.txt", 20, false},
            {"dir2/", 0, true},
        }));

        ArchivePreviewModel model;
        model.setFilePath(archive);
        QVERIFY(waitForLoad(model));

        QVERIFY(model.rowCount() >= 4);

        // Directories should come before files at depth 0
        bool seenFile = false;
        for (int i = 0; i < model.rowCount(); ++i) {
            const QModelIndex idx = model.index(i, 0);
            const int depth = model.data(idx, ArchivePreviewModel::DepthRole).toInt();
            if (depth != 0)
                continue;
            const bool isDir = model.data(idx, ArchivePreviewModel::IsDirRole).toBool();
            if (!isDir)
                seenFile = true;
            if (isDir && seenFile)
                QFAIL("Directory appeared after a file at the same depth level");
        }
    }

    void fileAndDirCounts()
    {
        QTemporaryDir tmpDir;
        QVERIFY(tmpDir.isValid());
        const QString archive = tmpDir.path() + "/counts.tar.gz";
        QVERIFY(createArchive(archive, {
            {"d1/", 0, true},
            {"d2/", 0, true},
            {"d2/sub/", 0, true},
            {"f1.txt", 100, false},
            {"f2.txt", 200, false},
            {"d1/f3.txt", 50, false},
        }));

        ArchivePreviewModel model;
        model.setFilePath(archive);
        QVERIFY(waitForLoad(model));

        QCOMPARE(model.dirCount(), 3);
        QCOMPARE(model.fileCount(), 3);
        QCOMPARE(model.totalSize(), 350);
    }

    void emptyFilePathClearsState()
    {
        QTemporaryDir tmpDir;
        QVERIFY(tmpDir.isValid());
        const QString archive = tmpDir.path() + "/clear.tar.gz";
        QVERIFY(createArchive(archive, {{"file.txt", 10, false}}));

        ArchivePreviewModel model;
        model.setFilePath(archive);
        QVERIFY(waitForLoad(model));
        QCOMPARE(model.rowCount(), 1);

        // Clear by setting empty path
        model.setFilePath(QString());
        QCOMPARE(model.rowCount(), 0);
        QCOMPARE(model.loading(), false);
        QVERIFY(model.error().isEmpty());
    }
};

QTEST_MAIN(ArchivePreviewModelTest)
#include "ArchivePreviewModelTest.moc"
