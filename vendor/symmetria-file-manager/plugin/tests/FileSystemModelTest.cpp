// FileSystemModelTest — unit tests for the filesystem model.
//
// All test directories are created in QTemporaryDir. File watcher tests use
// generous timeouts to accommodate kernel inotify latency. Uses QTEST_MAIN
// (not GUILESS) because FileSystemEntry uses QImageReader which needs QGuiApplication.

#include "filesystemmodel.hpp"

#include <QAbstractItemModelTester>
#include <QDir>
#include <QFile>
#include <QSignalSpy>
#include <QTemporaryDir>
#include <QTest>

using namespace symmetria::filemanager::models;

class FileSystemModelTest : public QObject {
    Q_OBJECT

private:
    // Create a file with the given size (filled with 'x' bytes).
    static bool createFile(const QString& path, qint64 size = 0)
    {
        QFile f(path);
        if (!f.open(QIODevice::WriteOnly))
            return false;
        if (size > 0)
            f.write(QByteArray(static_cast<int>(size), 'x'));
        return true;
    }

    // Wait for the model to finish its async scan.
    static bool waitForEntries(FileSystemModel& model, int timeout = 5000)
    {
        if (!model.loading())
            return true;
        QSignalSpy spy(&model, &FileSystemModel::loadingChanged);
        while (model.loading()) {
            if (!spy.wait(timeout))
                return false;
        }
        return true;
    }

    // Collect entry names from the model in current order.
    static QStringList entryNames(FileSystemModel& model)
    {
        QStringList names;
        for (int i = 0; i < model.rowCount(); ++i) {
            const QVariant v = model.data(model.index(i, 0), Qt::UserRole);
            const auto* entry = v.value<FileSystemEntry*>();
            if (entry)
                names.append(entry->name());
        }
        return names;
    }

    // Return whether an entry at the given index is a directory.
    static bool entryIsDir(FileSystemModel& model, int i)
    {
        const QVariant v = model.data(model.index(i, 0), Qt::UserRole);
        const auto* entry = v.value<FileSystemEntry*>();
        return entry && entry->isDir();
    }

    // Return the cached size of the named entry, or -1 if not present.
    static qint64 entrySize(FileSystemModel& model, const QString& name)
    {
        for (int i = 0; i < model.rowCount(); ++i) {
            const QVariant v = model.data(model.index(i, 0), Qt::UserRole);
            const auto* entry = v.value<FileSystemEntry*>();
            if (entry && entry->name() == name)
                return entry->size();
        }
        return -1;
    }

private slots:
    void modelTester()
    {
        QTemporaryDir tmpDir;
        QVERIFY(tmpDir.isValid());
        createFile(tmpDir.path() + "/alpha.txt", 10);
        createFile(tmpDir.path() + "/bravo.txt", 20);
        QDir(tmpDir.path()).mkdir("charlie_dir");

        FileSystemModel model;
        QAbstractItemModelTester tester(&model, QAbstractItemModelTester::FailureReportingMode::QtTest);

        model.setPath(tmpDir.path());
        QVERIFY(waitForEntries(model));
        QVERIFY(model.rowCount() > 0);
    }

    void sortAlphabeticalAsc()
    {
        QTemporaryDir tmpDir;
        QVERIFY(tmpDir.isValid());
        createFile(tmpDir.path() + "/charlie.txt");
        createFile(tmpDir.path() + "/alpha.txt");
        createFile(tmpDir.path() + "/bravo.txt");

        FileSystemModel model;
        model.setSortBy(FileSystemModel::Alphabetical);
        model.setSortReverse(false);
        model.setPath(tmpDir.path());
        QVERIFY(waitForEntries(model));

        const QStringList names = entryNames(model);
        QCOMPARE(names, (QStringList{"alpha.txt", "bravo.txt", "charlie.txt"}));
    }

    void sortAlphabeticalDesc()
    {
        QTemporaryDir tmpDir;
        QVERIFY(tmpDir.isValid());
        createFile(tmpDir.path() + "/charlie.txt");
        createFile(tmpDir.path() + "/alpha.txt");
        createFile(tmpDir.path() + "/bravo.txt");

        FileSystemModel model;
        model.setSortBy(FileSystemModel::Alphabetical);
        model.setSortReverse(true);
        model.setPath(tmpDir.path());
        QVERIFY(waitForEntries(model));

        const QStringList names = entryNames(model);
        QCOMPARE(names, (QStringList{"charlie.txt", "bravo.txt", "alpha.txt"}));
    }

    void sortBySize()
    {
        QTemporaryDir tmpDir;
        QVERIFY(tmpDir.isValid());
        createFile(tmpDir.path() + "/big.txt", 300);
        createFile(tmpDir.path() + "/small.txt", 10);
        createFile(tmpDir.path() + "/medium.txt", 100);

        FileSystemModel model;
        model.setSortBy(FileSystemModel::Size);
        model.setSortReverse(false);
        model.setPath(tmpDir.path());
        QVERIFY(waitForEntries(model));

        const QStringList names = entryNames(model);
        QCOMPARE(names, (QStringList{"small.txt", "medium.txt", "big.txt"}));
    }

    void sortByModified()
    {
        QTemporaryDir tmpDir;
        QVERIFY(tmpDir.isValid());

        // Create files with known modification times (1-second apart)
        const QString pathOld = tmpDir.path() + "/old.txt";
        const QString pathNew = tmpDir.path() + "/new.txt";
        const QString pathMid = tmpDir.path() + "/mid.txt";
        createFile(pathOld);
        createFile(pathMid);
        createFile(pathNew);

        // Force distinct timestamps by setting them explicitly
        const QDateTime base = QDateTime::currentDateTime().addSecs(-100);
        {
            QFile f(pathOld);
            QVERIFY(f.open(QIODevice::ReadWrite));
            QVERIFY(f.setFileTime(base, QFileDevice::FileModificationTime));
        }
        {
            QFile f(pathMid);
            QVERIFY(f.open(QIODevice::ReadWrite));
            QVERIFY(f.setFileTime(base.addSecs(10), QFileDevice::FileModificationTime));
        }
        {
            QFile f(pathNew);
            QVERIFY(f.open(QIODevice::ReadWrite));
            QVERIFY(f.setFileTime(base.addSecs(20), QFileDevice::FileModificationTime));
        }

        FileSystemModel model;
        model.setSortBy(FileSystemModel::Modified);
        model.setSortReverse(false);  // oldest first
        model.setPath(tmpDir.path());
        QVERIFY(waitForEntries(model));

        const QStringList names = entryNames(model);
        QCOMPARE(names, (QStringList{"old.txt", "mid.txt", "new.txt"}));
    }

    void sortByExtension()
    {
        QTemporaryDir tmpDir;
        QVERIFY(tmpDir.isValid());
        createFile(tmpDir.path() + "/b.txt");
        createFile(tmpDir.path() + "/a.cpp");
        createFile(tmpDir.path() + "/c.hpp");

        FileSystemModel model;
        model.setSortBy(FileSystemModel::Extension);
        model.setSortReverse(false);
        model.setPath(tmpDir.path());
        QVERIFY(waitForEntries(model));

        const QStringList names = entryNames(model);
        // Expected order by extension: .cpp → .hpp → .txt (locale-aware)
        QCOMPARE(names, (QStringList{"a.cpp", "c.hpp", "b.txt"}));
    }

    void sortByNatural()
    {
        QTemporaryDir tmpDir;
        QVERIFY(tmpDir.isValid());
        createFile(tmpDir.path() + "/file10.txt");
        createFile(tmpDir.path() + "/file2.txt");
        createFile(tmpDir.path() + "/file1.txt");

        FileSystemModel model;
        model.setSortBy(FileSystemModel::Natural);
        model.setSortReverse(false);
        model.setPath(tmpDir.path());
        QVERIFY(waitForEntries(model));

        const QStringList names = entryNames(model);
        // Natural sort: 1, 2, 10 — not lexicographic (1, 10, 2)
        QCOMPARE(names, (QStringList{"file1.txt", "file2.txt", "file10.txt"}));
    }

    void sortDirsBeforeFiles()
    {
        QTemporaryDir tmpDir;
        QVERIFY(tmpDir.isValid());
        createFile(tmpDir.path() + "/aaa_file.txt");
        QDir(tmpDir.path()).mkdir("zzz_dir");
        createFile(tmpDir.path() + "/bbb_file.txt");
        QDir(tmpDir.path()).mkdir("aaa_dir");

        FileSystemModel model;
        model.setSortBy(FileSystemModel::Alphabetical);
        model.setSortReverse(false);
        model.setPath(tmpDir.path());
        QVERIFY(waitForEntries(model));

        // Directories must always appear before files, regardless of name
        QCOMPARE(model.rowCount(), 4);
        QVERIFY(entryIsDir(model, 0));  // aaa_dir
        QVERIFY(entryIsDir(model, 1));  // zzz_dir
        QVERIFY(!entryIsDir(model, 2)); // aaa_file.txt
        QVERIFY(!entryIsDir(model, 3)); // bbb_file.txt
    }

    void filterByNameGlob()
    {
        QTemporaryDir tmpDir;
        QVERIFY(tmpDir.isValid());
        createFile(tmpDir.path() + "/foo.txt");
        createFile(tmpDir.path() + "/bar.cpp");
        createFile(tmpDir.path() + "/baz.txt");

        FileSystemModel model;
        model.setNameFilters({"*.txt"});
        model.setSortBy(FileSystemModel::Alphabetical);
        model.setSortReverse(false);
        model.setPath(tmpDir.path());
        QVERIFY(waitForEntries(model));

        const QStringList names = entryNames(model);
        QCOMPARE(names, (QStringList{"baz.txt", "foo.txt"}));
    }

    void filterDirsOnly()
    {
        QTemporaryDir tmpDir;
        QVERIFY(tmpDir.isValid());
        createFile(tmpDir.path() + "/file.txt");
        QDir(tmpDir.path()).mkdir("subdir");

        FileSystemModel model;
        model.setFilter(FileSystemModel::Dirs);
        model.setPath(tmpDir.path());
        QVERIFY(waitForEntries(model));

        QCOMPARE(model.rowCount(), 1);
        QVERIFY(entryIsDir(model, 0));
    }

    void filterFilesOnly()
    {
        QTemporaryDir tmpDir;
        QVERIFY(tmpDir.isValid());
        createFile(tmpDir.path() + "/file.txt");
        QDir(tmpDir.path()).mkdir("subdir");

        FileSystemModel model;
        model.setFilter(FileSystemModel::Files);
        model.setPath(tmpDir.path());
        QVERIFY(waitForEntries(model));

        QCOMPARE(model.rowCount(), 1);
        QVERIFY(!entryIsDir(model, 0));
    }

    void asyncScanApplied()
    {
        QTemporaryDir tmpDir;
        QVERIFY(tmpDir.isValid());
        createFile(tmpDir.path() + "/a.txt");
        createFile(tmpDir.path() + "/b.txt");

        FileSystemModel model;
        QSignalSpy loadingSpy(&model, &FileSystemModel::loadingChanged);
        QSignalSpy entriesSpy(&model, &FileSystemModel::entriesChanged);

        model.setPath(tmpDir.path());

        // loading should have been set to true
        QVERIFY(loadingSpy.count() >= 1 || model.loading());

        QVERIFY(waitForEntries(model));
        QCOMPARE(model.loading(), false);
        QVERIFY(entriesSpy.count() >= 1);
        QCOMPARE(model.rowCount(), 2);
    }

    void showHiddenFiles()
    {
        QTemporaryDir tmpDir;
        QVERIFY(tmpDir.isValid());
        createFile(tmpDir.path() + "/visible.txt");
        createFile(tmpDir.path() + "/.hidden");

        FileSystemModel model;
        model.setShowHidden(false);
        model.setPath(tmpDir.path());
        QVERIFY(waitForEntries(model));
        QCOMPARE(model.rowCount(), 1);

        // Enable hidden files — model should rescan
        model.setShowHidden(true);
        QVERIFY(waitForEntries(model));
        QCOMPARE(model.rowCount(), 2);
    }

    void nonExistentPathHandledGracefully()
    {
        FileSystemModel model;
        model.setPath(QStringLiteral("/tmp/nonexistent_symmetria_test_dir_xyz"));
        QVERIFY(waitForEntries(model));

        // A missing directory must not crash and must yield an empty model
        QCOMPARE(model.loading(), false);
        QCOMPARE(model.rowCount(), 0);
    }

    void generationCounterDiscardsStale()
    {
        QTemporaryDir tmpDirA;
        QTemporaryDir tmpDirB;
        QVERIFY(tmpDirA.isValid());
        QVERIFY(tmpDirB.isValid());
        createFile(tmpDirA.path() + "/a1.txt");
        createFile(tmpDirA.path() + "/a2.txt");
        createFile(tmpDirB.path() + "/b1.txt");

        FileSystemModel model;
        model.setSortBy(FileSystemModel::Alphabetical);
        model.setSortReverse(false);
        // Navigate to A then immediately to B — A's result should be discarded
        model.setPath(tmpDirA.path());
        model.setPath(tmpDirB.path());
        QVERIFY(waitForEntries(model));

        // Final state must reflect directory B
        QCOMPARE(model.rowCount(), 1);
        const QStringList names = entryNames(model);
        QCOMPARE(names, QStringList{"b1.txt"});
    }

    void directoryDiffAdd()
    {
        QTemporaryDir tmpDir;
        QVERIFY(tmpDir.isValid());
        createFile(tmpDir.path() + "/existing.txt");

        FileSystemModel model;
        model.setWatchChanges(true);
        model.setPath(tmpDir.path());
        QVERIFY(waitForEntries(model));
        QCOMPARE(model.rowCount(), 1);

        // Create a new file — the watcher should detect it
        QSignalSpy entriesSpy(&model, &FileSystemModel::entriesChanged);
        createFile(tmpDir.path() + "/new_file.txt");

        // Wait for watcher to pick up the change (kernel inotify latency)
        QVERIFY(entriesSpy.wait(5000));
        QVERIFY(waitForEntries(model));
        QCOMPARE(model.rowCount(), 2);
    }

    void directoryDiffRemove()
    {
        QTemporaryDir tmpDir;
        QVERIFY(tmpDir.isValid());
        createFile(tmpDir.path() + "/keep.txt");
        createFile(tmpDir.path() + "/remove.txt");

        FileSystemModel model;
        model.setWatchChanges(true);
        model.setPath(tmpDir.path());
        QVERIFY(waitForEntries(model));
        QCOMPARE(model.rowCount(), 2);

        // Delete a file — the watcher should detect it
        QSignalSpy entriesSpy(&model, &FileSystemModel::entriesChanged);
        QFile::remove(tmpDir.path() + "/remove.txt");

        QVERIFY(entriesSpy.wait(5000));
        QVERIFY(waitForEntries(model));
        QCOMPARE(model.rowCount(), 1);

        const QStringList names = entryNames(model);
        QCOMPARE(names, QStringList{"keep.txt"});
    }

    // Regression: a file written in place after it was first listed — e.g. a
    // download streamed straight to its final name — stayed frozen at its
    // first-seen size (0 bytes) until re-navigation. Two root causes: Qt's
    // directory inotify watch omits IN_MODIFY (so growth emitted no
    // directoryChanged), and the diff compared only the SET of paths (so a
    // same-path size change was a no-op). The fix adds a per-file watch (fires
    // fileChanged on growth) plus size/mtime diffing that rebuilds the entry.
    void growingFileRefreshesSize()
    {
        QTemporaryDir tmpDir;
        QVERIFY(tmpDir.isValid());
        const QString file = tmpDir.path() + "/download.bin";
        QVERIFY(createFile(file, 0)); // first listed at 0 bytes

        FileSystemModel model;
        model.setWatchChanges(true);
        model.setPath(tmpDir.path());
        QVERIFY(waitForEntries(model));
        QCOMPARE(model.rowCount(), 1);
        QCOMPARE(entrySize(model, "download.bin"), qint64(0));

        // White-box: prove the per-file watch is the load-bearing trigger. An
        // append does not bump the parent directory's mtime, so the directory
        // watch stays silent — only this file watch can drive the refresh below.
        QVERIFY(model.m_watcher.files().contains(file));

        // Append bytes to the SAME path (no rename) — emits IN_MODIFY only, which
        // reaches the model solely through the per-file watch, not the dir watch.
        QSignalSpy entriesSpy(&model, &FileSystemModel::entriesChanged);
        {
            QFile f(file);
            QVERIFY(f.open(QIODevice::Append));
            QCOMPARE(f.write(QByteArray(4096, 'x')), qint64(4096));
            f.close();
        }

        // fileChanged → debounced rescan → modified-path detection → rebuild.
        QVERIFY(entriesSpy.wait(5000));
        QVERIFY(waitForEntries(model));
        QCOMPARE(model.rowCount(), 1);
        QCOMPARE(entrySize(model, "download.bin"), qint64(4096));
    }

    // Regression: per-file watches must be released when navigating away.
    // updateWatcher() originally removed only watched directories(), so the file
    // watches syncFileWatches() adds would accumulate across navigation — wasting
    // the inotify budget and rescanning on writes in directories the user has left.
    void fileWatchesDoNotLeakAcrossNavigation()
    {
        QTemporaryDir dirA;
        QVERIFY(dirA.isValid());
        const QString fileA = dirA.path() + "/a.txt";
        QVERIFY(createFile(fileA, 1));

        QTemporaryDir dirB;
        QVERIFY(dirB.isValid());
        const QString fileB = dirB.path() + "/b.txt";
        QVERIFY(createFile(fileB, 1));

        FileSystemModel model;
        model.setWatchChanges(true);
        model.setPath(dirA.path());
        QVERIFY(waitForEntries(model));
        QVERIFY(model.m_watcher.files().contains(fileA));

        // Navigate away — dirA's file watch must be dropped, not carried over.
        model.setPath(dirB.path());
        QVERIFY(waitForEntries(model));
        const QStringList watched = model.m_watcher.files();
        QVERIFY(watched.contains(fileB));
        QVERIFY(!watched.contains(fileA));
    }

    // Regression: "pasted files appear 2-3x until you re-navigate".
    //
    // When a multi-file mv/cp lands in the watched directory, inotify fires
    // several directoryChanged signals and multiple background scans can be in
    // flight at once. Each scan snapshots oldPaths at schedule time (before any
    // prior scan's result is applied), so a freshly-arrived file ends up in the
    // `added` set of more than one scan. If applyChanges() blindly appended its
    // `added` entries, those overlapping scans would each insert the same path —
    // 2x, 3x — until a full re-navigation rebuilt m_entries from a deduplicated
    // QSet. applyChanges() must therefore be idempotent: skip any added path it
    // already holds. This drives applyChanges() directly because the timing race
    // cannot be reproduced reliably through the real inotify path.
    void applyChangesIdempotentOnDuplicatePaths()
    {
        auto makeEntry = [](const QString& path) {
            CachedEntryData data;
            data.path = path;
            data.fileInfo = QFileInfo(path);
            data.relativePath = data.fileInfo.fileName();
            return data;
        };

        FileSystemModel model;

        // First scan adds two files.
        QList<CachedEntryData> firstBatch;
        firstBatch << makeEntry("/tmp/a.jpg") << makeEntry("/tmp/b.jpg");
        model.applyChanges({}, firstBatch);
        QCOMPARE(model.rowCount(), 2);

        // A second, stale scan re-reports an already-present path (a.jpg) along
        // with a genuinely new one (c.jpg) — exactly what two overlapping scans
        // sharing the same oldPaths snapshot would produce.
        QList<CachedEntryData> staleBatch;
        staleBatch << makeEntry("/tmp/a.jpg") << makeEntry("/tmp/c.jpg");
        model.applyChanges({}, staleBatch);

        // a.jpg must not be duplicated; only c.jpg is genuinely new.
        QCOMPARE(model.rowCount(), 3);
        QStringList names = entryNames(model);
        names.sort();
        QCOMPARE(names, (QStringList{"a.jpg", "b.jpg", "c.jpg"}));

        // Re-applying an entirely already-present batch must be a complete no-op.
        model.applyChanges({}, staleBatch);
        QCOMPARE(model.rowCount(), 3);
    }

    // Complementary: remove + all-dupes-added — verifies the else-if branch that
    // emits entriesChanged() when removals happened but no new entries survived dedup.
    void applyChangesRemoveWithAllDupedAdds()
    {
        auto makeEntry = [](const QString& path) {
            CachedEntryData data;
            data.path = path;
            data.fileInfo = QFileInfo(path);
            data.relativePath = data.fileInfo.fileName();
            return data;
        };

        FileSystemModel model;

        // Seed the model with two files.
        QList<CachedEntryData> seed;
        seed << makeEntry("/tmp/x.txt") << makeEntry("/tmp/y.txt");
        model.applyChanges({}, seed);
        QCOMPARE(model.rowCount(), 2);

        // Simulate a stale scan: remove x.txt, but also "add" y.txt which is
        // already present. After dedup filtering, newEntries is empty; only the
        // removal applies. entriesChanged() must still fire (via the else-if branch).
        QSignalSpy spy(&model, &FileSystemModel::entriesChanged);
        QList<CachedEntryData> addAlreadyPresent;
        addAlreadyPresent << makeEntry("/tmp/y.txt");
        model.applyChanges({"/tmp/x.txt"}, addAlreadyPresent);

        QCOMPARE(model.rowCount(), 1);
        QCOMPARE(spy.count(), 1);
        QStringList names = entryNames(model);
        QCOMPARE(names, QStringList{"y.txt"});
    }

    // Within-batch duplicate: same path appearing twice in a single addedEntries
    // list. Unreachable from the production watcher path (which uses QSet
    // subtraction), but applyChanges is now a semi-public interface via friend.
    void applyChangesWithinBatchDuplicate()
    {
        auto makeEntry = [](const QString& path) {
            CachedEntryData data;
            data.path = path;
            data.fileInfo = QFileInfo(path);
            data.relativePath = data.fileInfo.fileName();
            return data;
        };

        FileSystemModel model;

        // Pass the same path twice in a single batch.
        QList<CachedEntryData> dupBatch;
        dupBatch << makeEntry("/tmp/dup.txt") << makeEntry("/tmp/dup.txt");
        model.applyChanges({}, dupBatch);

        // Must appear exactly once, not twice.
        QCOMPARE(model.rowCount(), 1);
        QCOMPARE(entryNames(model), QStringList{"dup.txt"});
    }
};

QTEST_MAIN(FileSystemModelTest)
#include "FileSystemModelTest.moc"
