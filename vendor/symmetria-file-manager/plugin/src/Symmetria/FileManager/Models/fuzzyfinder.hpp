#pragma once

// FuzzyFinder — QML element for fzf-style recursive fuzzy file searching.
//
// Backend: the MIT-licensed Rust `fff` engine (vendored at
// third_party/fff), consumed through its `fff-c` C ABI. This class is a thin
// QAbstractListModel wrapper that owns an `fff` instance and translates its
// results into QML model roles. It REPLACED an in-house C++ Smith-Waterman
// implementation after measurement showed fff's SIMD matcher + warm index is
// 11–20× faster per keystroke on large trees and also returns git status,
// frecency, size/mtime, and a full score breakdown in the same call.
//
// Key design decisions:
//
//   1. Same QML contract as the old implementation — element name `FuzzyFinder`,
//      the original properties (searchPath/query/showHidden/scanning/loading/
//      resultCount/error) and roles (Path/Name/IsDir/Score/MatchIndices/FullPath)
//      are preserved so FuzzyFinderPopup.qml needs no changes for parity. New
//      roles (Size/Modified/GitStatus/FrecencyTotal/IsBinary/ScoreBreakdown/
//      MatchType) feed the File Info side-panel.
//
//   2. fff_search_mixed (not fff_search) — fff_search is files-only; the mixed
//      search returns directories too (item_type), preserving the finder's
//      directory-navigation behaviour.
//
//   3. matchIndices recomputed here — fff's file-search result carries no
//      per-character match positions (only its grep result does). We recompute
//      them with a cheap greedy subsequence match over the ≤200 visible rows so
//      the popup's existing character-highlighting keeps working unchanged.
//
//   4. shared_ptr engine handle — the fff instance is created off-thread and
//      held in a std::shared_ptr<void> whose deleter calls fff_destroy. Each
//      async search captures a copy, so the engine cannot be freed while a
//      search is mid-flight on a worker thread (no use-after-free across the
//      generation-counter handoff).

#include <qabstractitemmodel.h>
#include <qdatetime.h>
#include <qobject.h>
#include <qqmlintegration.h>

#include <memory>

namespace symmetria::filemanager::models {

struct SearchResultEntry {
    QString      relativePath;  // relative to searchPath ("src/utils/format.js")
    QString      name;          // display name (filename, or last dir segment)
    QString      fullPath;      // absolute path
    bool         isDir = false;
    int          score = 0;     // FffScore.total
    QVector<int> matchIndices;  // recomputed char positions in relativePath
    qint64       size = 0;
    QDateTime    modified;
    QString      gitStatus;     // fff git status string ("M ", "??", ...) or empty
    qint64       frecencyTotal = 0;
    bool         isBinary = false;
    QVariantMap  scoreBreakdown;  // FffScore fields for the File Info panel
    QString      matchType;       // "frecency", "exact", ...

    // Themed icon path, resolved lazily on first IconPathRole read (main thread —
    // see data()). Built off-thread during the scan would race IconThemeResolver's
    // unsynchronized static caches, so it is deliberately deferred and memoised
    // here, mirroring FileSystemEntry's mutable lazy-init for the same reason.
    mutable QString iconPath;
    mutable bool    iconResolved = false;
};

class FuzzyFinder : public QAbstractListModel {
    Q_OBJECT
    QML_ELEMENT

    // Input properties
    Q_PROPERTY(QString searchPath READ searchPath WRITE setSearchPath NOTIFY searchPathChanged)
    Q_PROPERTY(QString query READ query WRITE setQuery NOTIFY queryChanged)
    Q_PROPERTY(bool showHidden READ showHidden WRITE setShowHidden NOTIFY showHiddenChanged)

    // Output properties
    Q_PROPERTY(bool scanning READ scanning NOTIFY scanningChanged)
    Q_PROPERTY(bool loading READ loading NOTIFY loadingChanged)
    Q_PROPERTY(int resultCount READ resultCount NOTIFY resultCountChanged)
    Q_PROPERTY(QString error READ error NOTIFY errorChanged)

public:
    enum Roles {
        PathRole = Qt::UserRole,
        NameRole,
        IsDirRole,
        ScoreRole,
        MatchIndicesRole,
        FullPathRole,
        // File Info panel roles
        SizeRole,
        ModifiedRole,
        GitStatusRole,
        FrecencyTotalRole,
        IsBinaryRole,
        ScoreBreakdownRole,
        MatchTypeRole,
        IconPathRole,
    };
    Q_ENUM(Roles)

    explicit FuzzyFinder(QObject* parent = nullptr);
    ~FuzzyFinder() override;

    // QAbstractListModel overrides
    int rowCount(const QModelIndex& parent = QModelIndex()) const override;
    QVariant data(const QModelIndex& index, int role = Qt::DisplayRole) const override;
    QHash<int, QByteArray> roleNames() const override;

    [[nodiscard]] QString searchPath() const;
    void setSearchPath(const QString& path);

    [[nodiscard]] QString query() const;
    void setQuery(const QString& query);

    [[nodiscard]] bool showHidden() const;
    void setShowHidden(bool show);

    [[nodiscard]] bool scanning() const;
    [[nodiscard]] bool loading() const;
    [[nodiscard]] int resultCount() const;
    [[nodiscard]] QString error() const;

    Q_INVOKABLE void clear();

    // Record that the result at `index` was opened for query `query`.
    //
    // This writes fff's QUERY TRACKER, not frecency — `fff_track_access`, the
    // exported C symbol that would write it, is not among the 78 `fff_*` symbols
    // the shipped `libfff_c.so` exports, so no C-ABI caller can write frecency at
    // all. What it buys is a per-`(project path, query)` open count that boosts a
    // later search on the same query.
    // In THIS application that boost is always zero, because `startSearch()`
    // passes `combo_boost_multiplier = 0`. See `recordOpen`'s definition.
    //
    // No-op for an out-of-range index or no engine.
    Q_INVOKABLE void recordOpen(int index, const QString& query);

    static constexpr int MaxResults = 200;

signals:
    void searchPathChanged();
    void queryChanged();
    void showHiddenChanged();
    void scanningChanged();
    void loadingChanged();
    void resultCountChanged();
    void errorChanged();

private:
    void startEngine();  // (re)create the fff instance for m_searchPath, off-thread
    void startSearch();  // run fff_search_mixed for m_query, off-thread

    QString m_searchPath;
    QString m_query;
    bool    m_showHidden = false;

    // fff instance handle, freed via fff_destroy by the shared_ptr deleter once
    // the last in-flight search releases its captured copy.
    std::shared_ptr<void> m_engine;

    QVector<SearchResultEntry> m_results;

    bool    m_scanning = false;
    bool    m_loading = false;
    QString m_error;

    int m_createGeneration = 0;
    int m_searchGeneration = 0;
};

} // namespace symmetria::filemanager::models
