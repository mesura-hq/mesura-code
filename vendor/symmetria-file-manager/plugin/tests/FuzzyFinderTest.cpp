// FuzzyFinderTest — tests for the fff-backed fuzzy file finder model.
//
// The finder's backend is the Rust `fff` engine (via fff-c). These tests
// validate the QML-facing CONTRACT — async scan/search lifecycle, the model
// roles (including the File Info panel roles), result cap, match-index
// recomputation, frecency tracking, and generation staleness — rather than the
// engine's internal ranking/ignore semantics, which are fff's own concern.
//
// The frecency LMDB is redirected to a temp dir via SYMMETRIA_FM_FRECENCY_DIR so
// tests never touch the user's real database. QTEST_MAIN (not GUILESS) because
// QAbstractItemModelTester requires QGuiApplication.

#include "fuzzyfinder.hpp"

#include <QAbstractItemModelTester>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QSignalSpy>
#include <QTemporaryDir>
#include <QTest>

using namespace symmetria::filemanager::models;

class FuzzyFinderTest : public QObject {
    Q_OBJECT

private:
    QTemporaryDir m_frecencyDir;  // isolates the frecency/history LMDB

    static void createFile(const QString& basePath, const QString& relativePath,
                           const QByteArray& contents = "x") {
        const QString fullPath = basePath + u'/' + relativePath;
        QDir().mkpath(QFileInfo(fullPath).path());
        QFile f(fullPath);
        if (f.open(QIODevice::WriteOnly)) {
            f.write(contents);
            f.close();
        }
    }

    // Wait for the async engine creation/index to finish (scanning -> false).
    static bool waitForScan(FuzzyFinder& model, int timeout = 30000) {
        if (!model.scanning())
            return true;
        QSignalSpy spy(&model, &FuzzyFinder::scanningChanged);
        while (model.scanning()) {
            if (!spy.wait(timeout))
                return false;
        }
        return true;
    }

    // Wait for an async search to finish (loading -> false).
    static bool waitForSearch(FuzzyFinder& model, int timeout = 10000) {
        if (!model.loading())
            return true;
        QSignalSpy spy(&model, &FuzzyFinder::loadingChanged);
        while (model.loading()) {
            if (!spy.wait(timeout))
                return false;
        }
        return true;
    }

    // Run a query and block until results are ready.
    static bool search(FuzzyFinder& model, const QString& query) {
        model.setQuery(query);
        return waitForSearch(model);
    }

private slots:

    void initTestCase() {
        QVERIFY(m_frecencyDir.isValid());
        qputenv("SYMMETRIA_FM_FRECENCY_DIR", m_frecencyDir.path().toUtf8());
    }

    // QAbstractItemModelTester exercises the model invariants while a real
    // search is driven through it.
    void modelTester() {
        FuzzyFinder model;
        QAbstractItemModelTester tester(
            &model, QAbstractItemModelTester::FailureReportingMode::QtTest);

        QTemporaryDir tmp;
        QVERIFY(tmp.isValid());
        createFile(tmp.path(), "hello.txt");

        model.setSearchPath(tmp.path());
        QVERIFY(waitForScan(model));
        QVERIFY(search(model, "hello"));
        QVERIFY(model.resultCount() > 0);
    }

    // An empty query shows the frecency-ranked file list (fff.nvim behaviour):
    // the finder is populated on open without typing.
    void emptyQueryShowsFileList() {
        QTemporaryDir tmp;
        QVERIFY(tmp.isValid());
        createFile(tmp.path(), "file.txt");

        FuzzyFinder model;
        model.setSearchPath(tmp.path());
        QVERIFY(waitForScan(model));
        QVERIFY(waitForSearch(model));  // initial empty-query search runs on open
        QVERIFY(model.resultCount() > 0);

        // Clearing a typed query also returns to the file list.
        QVERIFY(search(model, "file"));
        QVERIFY(model.resultCount() > 0);
        QVERIFY(search(model, ""));
        QVERIFY(model.resultCount() > 0);
    }

    void findsMatchingFile() {
        QTemporaryDir tmp;
        QVERIFY(tmp.isValid());
        createFile(tmp.path(), "alpha.txt");
        createFile(tmp.path(), "beta.cpp");
        createFile(tmp.path(), "gamma_unique.md");

        FuzzyFinder model;
        model.setSearchPath(tmp.path());
        QVERIFY(waitForScan(model));
        QVERIFY(search(model, "gamma"));

        QVERIFY(model.resultCount() > 0);
        bool found = false;
        for (int i = 0; i < model.resultCount(); ++i) {
            if (model.data(model.index(i, 0), FuzzyFinder::NameRole)
                    .toString().contains("gamma")) {
                found = true;
                break;
            }
        }
        QVERIFY2(found, "expected a result containing 'gamma'");
    }

    // The File Info panel roles must be populated on each result.
    void richRolesPopulated() {
        QTemporaryDir tmp;
        QVERIFY(tmp.isValid());
        createFile(tmp.path(), "rolesfile.txt", QByteArray("hello world"));  // 11 bytes

        FuzzyFinder model;
        model.setSearchPath(tmp.path());
        QVERIFY(waitForScan(model));
        QVERIFY(search(model, "rolesfile"));
        QVERIFY(model.resultCount() > 0);

        const QModelIndex idx = model.index(0, 0);
        QCOMPARE(model.data(idx, FuzzyFinder::NameRole).toString(), QStringLiteral("rolesfile.txt"));
        QVERIFY(model.data(idx, FuzzyFinder::SizeRole).toLongLong() > 0);
        QVERIFY(model.data(idx, FuzzyFinder::ModifiedRole).toDateTime().isValid());
        QVERIFY(model.data(idx, FuzzyFinder::FullPathRole).toString().endsWith("rolesfile.txt"));
        // gitStatus is a string (empty outside a git repo — must not be a null variant)
        QVERIFY(model.data(idx, FuzzyFinder::GitStatusRole).typeId() == QMetaType::QString);
        // scoreBreakdown is a map carrying at least the total
        const QVariantMap breakdown = model.data(idx, FuzzyFinder::ScoreBreakdownRole).toMap();
        QVERIFY(breakdown.contains("total"));
    }

    // fff_search_mixed returns directories too (preserving navigation).
    void directoryResults() {
        QTemporaryDir tmp;
        QVERIFY(tmp.isValid());
        createFile(tmp.path(), "myfolder/inside.txt");  // gives the dir a child to index

        FuzzyFinder model;
        model.setSearchPath(tmp.path());
        QVERIFY(waitForScan(model));
        QVERIFY(search(model, "myfolder"));

        // fff marks directory items with a trailing "/" in their display name.
        bool foundDir = false;
        for (int i = 0; i < model.resultCount(); ++i) {
            const QModelIndex idx = model.index(i, 0);
            QString name = model.data(idx, FuzzyFinder::NameRole).toString();
            if (name.endsWith(u'/'))
                name.chop(1);
            if (model.data(idx, FuzzyFinder::IsDirRole).toBool() && name == "myfolder") {
                foundDir = true;
                break;
            }
        }
        QVERIFY2(foundDir, "expected the 'myfolder' directory in mixed search results");
    }

    // matchIndices are recomputed in the wrapper (fff returns none); they must be
    // the subsequence positions in the relative path, in ascending order.
    void matchIndicesSubsequence() {
        QTemporaryDir tmp;
        QVERIFY(tmp.isValid());
        createFile(tmp.path(), "format.js");

        FuzzyFinder model;
        model.setSearchPath(tmp.path());
        QVERIFY(waitForScan(model));
        QVERIFY(search(model, "fjs"));
        QVERIFY(model.resultCount() > 0);

        const QVariantList indices =
            model.data(model.index(0, 0), FuzzyFinder::MatchIndicesRole).toList();
        QCOMPARE(indices.size(), 3);  // one per query char
        for (int i = 1; i < indices.size(); ++i)
            QVERIFY(indices[i].toInt() > indices[i - 1].toInt());
    }

    void resultCapRespected() {
        QTemporaryDir tmp;
        QVERIFY(tmp.isValid());
        for (int i = 0; i < 250; ++i)
            createFile(tmp.path(), QStringLiteral("file_%1.txt").arg(i, 3, 10, QChar(u'0')));

        FuzzyFinder model;
        model.setSearchPath(tmp.path());
        QVERIFY(waitForScan(model));
        QVERIFY(search(model, "file"));

        QVERIFY(model.resultCount() > 0);
        QVERIFY(model.resultCount() <= FuzzyFinder::MaxResults);
    }

    // recordOpen must be safe to call and must not disturb the model.
    void recordOpenIsSafe() {
        QTemporaryDir tmp;
        QVERIFY(tmp.isValid());
        createFile(tmp.path(), "openme.txt");

        FuzzyFinder model;
        model.setSearchPath(tmp.path());
        QVERIFY(waitForScan(model));
        QVERIFY(search(model, "openme"));
        QVERIFY(model.resultCount() > 0);

        model.recordOpen(0, "openme");          // valid
        model.recordOpen(-1, "openme");         // out of range — no-op
        model.recordOpen(9999, "openme");       // out of range — no-op
        // No qWait needed: the model-unaffected assertion does not depend on the
        // fire-and-forget frecency task completing. recordOpen() launches a
        // QtConcurrent::run() that writes to LMDB independently; the model state
        // is checked on the main thread before that task has any effect.
        QVERIFY(model.resultCount() > 0);        // model unaffected
    }

    void clearResets() {
        QTemporaryDir tmp;
        QVERIFY(tmp.isValid());
        createFile(tmp.path(), "file.txt");

        FuzzyFinder model;
        model.setSearchPath(tmp.path());
        QVERIFY(waitForScan(model));
        QVERIFY(search(model, "file"));
        QVERIFY(model.resultCount() > 0);

        model.clear();
        QCOMPARE(model.resultCount(), 0);
        QVERIFY(!model.scanning());
        QVERIFY(!model.loading());
        QVERIFY(model.searchPath().isEmpty());
        QVERIFY(model.query().isEmpty());
    }

    // Swapping searchPath before the first index finishes must discard the stale
    // engine — only the second directory's results survive.
    //
    // NOTE: FffEngine::acquire() serializes under a mutex, so the two acquire calls
    // actually run sequentially (tmp1 completes, then tmp2 starts). What this test
    // validates is that the generation counter correctly discards the tmp1 result even
    // after sequential serialization — not true concurrent racing acquires.
    void staleSearchPathDiscarded() {
        QTemporaryDir tmp1;
        QVERIFY(tmp1.isValid());
        createFile(tmp1.path(), "firstonly.txt");

        QTemporaryDir tmp2;
        QVERIFY(tmp2.isValid());
        createFile(tmp2.path(), "secondonly.txt");

        FuzzyFinder model;
        model.setSearchPath(tmp1.path());
        model.setSearchPath(tmp2.path());
        QVERIFY(waitForScan(model));
        QVERIFY(search(model, "only"));

        QVERIFY(model.resultCount() > 0);
        for (int i = 0; i < model.resultCount(); ++i) {
            const QString name = model.data(model.index(i, 0), FuzzyFinder::NameRole).toString();
            QVERIFY2(name != "firstonly.txt",
                "stale first-directory result leaked after searchPath swap");
        }
    }

    // Query set before the index completes must still produce results once ready.
    void queryBeforeIndexCompletes() {
        QTemporaryDir tmp;
        QVERIFY(tmp.isValid());
        createFile(tmp.path(), "hello.txt");

        FuzzyFinder model;
        model.setQuery("hello");        // before searchPath
        model.setSearchPath(tmp.path());
        QVERIFY(waitForScan(model));
        QVERIFY(waitForSearch(model));

        QVERIFY(model.resultCount() > 0);
    }
};

QTEST_MAIN(FuzzyFinderTest)
#include "FuzzyFinderTest.moc"
