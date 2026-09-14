// FileWatcherTest — unit tests for the file-watching QML element.
//
// The atomic-rename test (atomicReplaceTenTimes) is the load-bearing one:
// it asserts that QFileSystemWatcher's "drop watch on atomic replace" quirk
// is mitigated by the FileWatcher's re-arm pattern. If this test breaks, the
// hot-reload of color-scheme.json and bookmarks.json silently fails after
// the first `:w` in nvim.

#include "filewatcher.hpp"

#include <QFile>
#include <QFileInfo>
#include <QSignalSpy>
#include <QTemporaryDir>
#include <QTest>

using namespace symmetria::filemanager::models;

class FileWatcherTest : public QObject {
    Q_OBJECT

private:
    QTemporaryDir m_tmpDir;

    static bool writeFile(const QString& path, const QByteArray& content)
    {
        QFile f(path);
        if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate))
            return false;
        f.write(content);
        f.close();
        return true;
    }

    // Atomic replace: write to tmp + rename over target. Mirrors nvim :w.
    static bool atomicReplace(const QString& target, const QByteArray& content)
    {
        const QString tmp = target + ".tmp";
        if (!writeFile(tmp, content))
            return false;
        QFile::remove(target);
        return QFile::rename(tmp, target);
    }

    static bool waitForLoaded(FileWatcher& watcher, int timeout = 3000)
    {
        if (watcher.loaded())
            return true;
        QSignalSpy spy(&watcher, &FileWatcher::loadedChanged);
        return spy.wait(timeout);
    }

private slots:
    void initTestCase()
    {
        QVERIFY(m_tmpDir.isValid());
    }

    void initialReadEmitsLoaded()
    {
        const QString path = m_tmpDir.path() + "/initial.txt";
        QVERIFY(writeFile(path, "hello"));

        FileWatcher watcher;
        QSignalSpy loadedSpy(&watcher, &FileWatcher::loadedChanged);
        watcher.setPath(path);

        QVERIFY(watcher.loaded());
        QCOMPARE(watcher.text(), QStringLiteral("hello"));
        QVERIFY(loadedSpy.count() >= 1);
    }

    void missingFileEmitsLoadFailed()
    {
        const QString path = m_tmpDir.path() + "/does_not_exist.txt";

        FileWatcher watcher;
        QSignalSpy failedSpy(&watcher, &FileWatcher::loadFailed);
        watcher.setPath(path);

        QCOMPARE(failedSpy.count(), 1);
        QCOMPARE(watcher.loaded(), false);
        QVERIFY(!watcher.errorString().isEmpty());
    }

    void overwriteInPlaceFiresFileChanged()
    {
        const QString path = m_tmpDir.path() + "/inplace.txt";
        QVERIFY(writeFile(path, "v1"));

        FileWatcher watcher;
        watcher.setPath(path);
        QVERIFY(watcher.loaded());

        QSignalSpy changedSpy(&watcher, &FileWatcher::fileChanged);
        QSignalSpy textSpy(&watcher, &FileWatcher::textChanged);

        QVERIFY(writeFile(path, "v2"));
        QVERIFY(changedSpy.wait(2000));
        QCOMPARE(watcher.text(), QStringLiteral("v2"));
        QVERIFY(textSpy.count() >= 1);
    }

    void atomicReplaceTenTimes()
    {
        // CRITICAL test — see filewatcher.hpp top-of-file comment.
        // QFileSystemWatcher silently drops the file watch on atomic replace
        // (rename-into-place). Without our re-arm pattern, only the first
        // replace would fire fileChanged(); subsequent ones would be silent.
        const QString path = m_tmpDir.path() + "/atomic.txt";
        QVERIFY(writeFile(path, "v0"));

        FileWatcher watcher;
        watcher.setPath(path);
        QVERIFY(watcher.loaded());

        for (int i = 1; i <= 10; ++i) {
            QSignalSpy changedSpy(&watcher, &FileWatcher::fileChanged);
            const QByteArray content = QStringLiteral("v%1").arg(i).toUtf8();

            QVERIFY2(atomicReplace(path, content),
                     qPrintable(QStringLiteral("atomic replace failed at iteration %1").arg(i)));

            // Either fileChanged or directoryChanged fires; both go through
            // the watcher's signal pipeline and re-read the file.
            const bool gotSignal = changedSpy.wait(2000);
            QVERIFY2(gotSignal,
                     qPrintable(QStringLiteral("no fileChanged signal at iteration %1 — atomic-replace mitigation broke").arg(i)));

            QCOMPARE(watcher.text(), QString::fromUtf8(content));
            QVERIFY2(watcher.loaded(),
                     qPrintable(QStringLiteral("loaded flag dropped at iteration %1").arg(i)));
        }
    }

    void deletedFileMarksUnloaded()
    {
        const QString path = m_tmpDir.path() + "/will_delete.txt";
        QVERIFY(writeFile(path, "x"));

        FileWatcher watcher;
        watcher.setPath(path);
        QVERIFY(watcher.loaded());

        QSignalSpy loadedSpy(&watcher, &FileWatcher::loadedChanged);
        QFile::remove(path);

        // Either fileChanged (file unlinked) or directoryChanged (parent
        // dir mutated) fires — both routes mark the watcher unloaded.
        QVERIFY(loadedSpy.wait(2000));
        QCOMPARE(watcher.loaded(), false);
    }

    void deleteThenRecreateRecoversWatch()
    {
        // Delete the file, then recreate it. The watcher should pick up the
        // new file via the parent-directory watch and re-arm.
        const QString path = m_tmpDir.path() + "/recreate.txt";
        QVERIFY(writeFile(path, "old"));

        FileWatcher watcher;
        watcher.setPath(path);
        QVERIFY(watcher.loaded());

        QFile::remove(path);
        // Wait briefly for the deletion to register.
        QTest::qWait(150);

        QSignalSpy loadedSpy(&watcher, &FileWatcher::loadedChanged);
        QSignalSpy changedSpy(&watcher, &FileWatcher::fileChanged);
        QVERIFY(writeFile(path, "new"));

        // Recovery may come via fileChanged or loadedChanged depending on
        // which signal lands first; either should drive the re-read.
        const bool recovered = loadedSpy.wait(2000) || changedSpy.count() > 0;
        QVERIFY2(recovered, "watcher did not recover after delete + recreate");
        QCOMPARE(watcher.text(), QStringLiteral("new"));
        QVERIFY(watcher.loaded());
    }

    void watchChangesFalseSuppressesEvents()
    {
        const QString path = m_tmpDir.path() + "/no_watch.txt";
        QVERIFY(writeFile(path, "a"));

        FileWatcher watcher;
        watcher.setWatchChanges(false);
        watcher.setPath(path);

        QVERIFY(watcher.loaded());
        QCOMPARE(watcher.text(), QStringLiteral("a"));

        QSignalSpy changedSpy(&watcher, &FileWatcher::fileChanged);
        QVERIFY(writeFile(path, "b"));
        // Brief wait to give any spurious watcher signal a chance to fire.
        QTest::qWait(300);
        QCOMPARE(changedSpy.count(), 0);
        // text should still be the initial value — we suppressed re-read
        QCOMPARE(watcher.text(), QStringLiteral("a"));
    }

    void reloadReReadsManually()
    {
        const QString path = m_tmpDir.path() + "/manual.txt";
        QVERIFY(writeFile(path, "v1"));

        FileWatcher watcher;
        watcher.setWatchChanges(false);
        watcher.setPath(path);
        QCOMPARE(watcher.text(), QStringLiteral("v1"));

        QVERIFY(writeFile(path, "v2"));
        watcher.reload();
        QCOMPARE(watcher.text(), QStringLiteral("v2"));
    }

    void changingPathClearsState()
    {
        const QString pathA = m_tmpDir.path() + "/clear_a.txt";
        const QString pathB = m_tmpDir.path() + "/clear_b.txt";
        QVERIFY(writeFile(pathA, "A"));
        QVERIFY(writeFile(pathB, "B"));

        FileWatcher watcher;
        watcher.setPath(pathA);
        QCOMPARE(watcher.text(), QStringLiteral("A"));

        watcher.setPath(pathB);
        QCOMPARE(watcher.text(), QStringLiteral("B"));
    }
};

QTEST_MAIN(FileWatcherTest)
#include "FileWatcherTest.moc"
