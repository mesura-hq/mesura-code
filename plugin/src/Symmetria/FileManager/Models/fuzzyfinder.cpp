#include "fuzzyfinder.hpp"
#include "iconthemeresolver.hpp"

#include <qdir.h>
#include <qfileinfo.h>
#include <qfuturewatcher.h>
#include <qlogging.h>
#include <qmimedatabase.h>
#include <qmutex.h>
#include <qstandardpaths.h>
#include <qtconcurrentrun.h>

#include <tuple>

// fff-c's cbindgen header is plain C with no `extern "C"` guard, so it must be
// wrapped to give the declarations C linkage — otherwise the C++ compiler mangles
// the names and the link against libfff_c.so fails with undefined references.
extern "C" {
#include "fff.h"
}

namespace symmetria::filemanager::models {

namespace {

// fff-c's item_type field: 0 = file, 1 = directory (see fff.h line ~355).
// No enum is provided in the C ABI; name the constant here to avoid magic integers.
constexpr uint8_t kFffItemTypeDirectory = 1;

// Greedy case-insensitive subsequence match of `query` against `path`, returning
// the matched character positions in `path`. fff's file-search result carries no
// per-character match info, so we recompute it for highlighting. If `query` is
// not a subsequence (e.g. it uses fff constraint syntax like "*.rs" or
// "git:modified"), returns empty — the popup then renders the path un-highlighted.
QVector<int> computeMatchIndices(const QString& path, const QString& query) {
    QVector<int> indices;
    if (query.isEmpty())
        return indices;

    const QString p = path.toLower();
    const QString q = query.toLower();
    indices.reserve(static_cast<int>(q.size()));

    qsizetype qi = 0;
    for (qsizetype i = 0; i < p.size() && qi < q.size(); ++i) {
        if (p[i] == q[qi]) {
            indices.append(static_cast<int>(i));
            ++qi;
        }
    }
    if (qi < q.size())
        indices.clear();  // not a full subsequence — no highlight
    return indices;
}

QVariantMap makeBreakdownMap(const FffScore& sc) {
    QVariantMap m;
    m[QStringLiteral("total")]                = sc.total;
    m[QStringLiteral("base")]                 = sc.base_score;
    m[QStringLiteral("filenameBonus")]        = sc.filename_bonus;
    m[QStringLiteral("specialFilenameBonus")] = sc.special_filename_bonus;
    m[QStringLiteral("frecencyBoost")]        = sc.frecency_boost;
    m[QStringLiteral("distancePenalty")]      = sc.distance_penalty;
    m[QStringLiteral("currentFilePenalty")]   = sc.current_file_penalty;
    m[QStringLiteral("comboBoost")]           = sc.combo_match_boost;
    m[QStringLiteral("pathAlignmentBonus")]   = sc.path_alignment_bonus;
    m[QStringLiteral("exactMatch")]           = sc.exact_match;
    m[QStringLiteral("matchType")] =
        sc.match_type ? QString::fromUtf8(sc.match_type) : QString();
    return m;
}

// Result of the off-thread engine acquisition.
struct CreateResult {
    std::shared_ptr<void> engine;
    QString               error;
};

// Frecency/history LMDB live alongside the file manager's logs. fff itself
// create_dir_all's these paths, so we only pre-create the parent defensively.
// SYMMETRIA_FM_FRECENCY_DIR overrides the location (used by tests to isolate the
// DB into a temp dir; also a relocation hook for users).
QString frecencyDbDir() {
    const QByteArray override = qgetenv("SYMMETRIA_FM_FRECENCY_DIR");
    if (!override.isEmpty())
        return QString::fromUtf8(override);
    return QStandardPaths::writableLocation(QStandardPaths::GenericDataLocation)
           + QStringLiteral("/symmetria/fff");
}

// Process-wide singleton fff engine.
//
// WHY a singleton: LMDB (heed) refuses to open the same frecency-DB environment
// twice within one process ("environment already open in this program"). Creating
// one fff instance per FuzzyFinder (per popup / per window) would therefore fail
// the moment a second finder opens. fff is designed as ONE long-lived engine with
// a warm index; we match that — open it once, then re-point it at a new directory
// with fff_restart_index when the search path changes. The engine is intentionally
// never destroyed (process-lifetime); the OS reclaims it at exit.
//
// KNOWN LIMITATION: two finders open simultaneously in different directories share
// this one engine, so the last `acquire` wins the indexed path. That only matters
// if two finder modals are open across two windows at once (rare, transient) and
// never crashes — it just shows the other path's results until re-queried.
class FffEngine {
public:
    static FffEngine& instance() {
        static FffEngine self;
        return self;
    }

    // Ensure the engine exists and is indexing `basePath`. Returns the shared
    // handle (or null with `error` set). Runs on a worker thread; serialized so
    // the single LMDB env is never opened/mutated concurrently.
    //
    // The mutex is intentionally held across fff_wait_for_scan (up to 30s) rather
    // than narrowed around the create/restart calls. Narrowing it would let a
    // second concurrent acquire race in and call fff_create_instance_with against
    // the same frecency env — the exact "environment already open in this program"
    // LMDB failure this singleton exists to prevent. The wait only ever blocks a
    // background worker thread (never the UI thread), and a second finder opening
    // simultaneously is rare and transient, so the coarse lock is the correct
    // trade-off. Do NOT narrow it. See CLAUDE.md "Critical Pitfalls".
    std::shared_ptr<void> acquire(const QString& basePath, QString& error) {
        QMutexLocker lock(&m_mutex);

        if (!m_engine) {
            const QString dbDir = frecencyDbDir();
            QDir().mkpath(dbDir);
            const QByteArray base     = basePath.toUtf8();
            const QByteArray frecency = (dbDir + QStringLiteral("/frecency")).toUtf8();
            const QByteArray history  = (dbDir + QStringLiteral("/history")).toUtf8();

            FffCreateOptions opts{};
            opts.version                  = FFF_CREATE_OPTIONS_VERSION;
            opts.base_path                = base.constData();
            opts.frecency_db_path         = frecency.constData();
            opts.history_db_path          = history.constData();
            opts.enable_mmap_cache        = false;
            opts.enable_content_indexing  = false;
            opts.watch                    = false;
            opts.ai_mode                  = false;
            opts.enable_fs_root_scanning  = true;
            opts.enable_home_dir_scanning = true;

            FffResult* cr = fff_create_instance_with(&opts);
            if (!cr || !cr->success || !cr->handle) {
                error = (cr && cr->error)
                    ? QString::fromUtf8(cr->error)
                    : QStringLiteral("Failed to create file-search engine");
                if (cr) fff_free_result(cr);
                return nullptr;
            }
            void* handle = cr->handle;
            fff_free_result(cr);

            FffResult* wr = fff_wait_for_scan(handle, 30000);
            if (wr) {
                // int_value: 1 = scan completed, 0 = timed out.
                // A timeout means the initial index is still in progress; searches will
                // return partial/frecency-only results until the scan finishes in background.
                if (!wr->int_value)
                    qWarning("FffEngine: initial scan timed out (30 s) for %s — "
                             "results may be incomplete until the index finishes",
                             basePath.toUtf8().constData());
                fff_free_result(wr);
            }

            // Never destroyed: the deleter exists for completeness but the static
            // singleton outlives the process, so it is effectively never invoked.
            m_engine = std::shared_ptr<void>(handle, [](void* h) { if (h) fff_destroy(h); });
            m_currentBase = basePath;
            return m_engine;
        }

        if (m_currentBase != basePath) {
            const QByteArray base = basePath.toUtf8();
            FffResult* rr = fff_restart_index(m_engine.get(), base.constData());
            const bool ok = rr && rr->success;
            if (rr) fff_free_result(rr);
            if (!ok) {
                error = QStringLiteral("Failed to re-index %1").arg(basePath);
                return nullptr;
            }
            FffResult* wr = fff_wait_for_scan(m_engine.get(), 30000);
            if (wr) {
                if (!wr->int_value)
                    qWarning("FffEngine: re-index scan timed out (30 s) for %s",
                             basePath.toUtf8().constData());
                fff_free_result(wr);
            }
            m_currentBase = basePath;
        }
        return m_engine;
    }

private:
    FffEngine() = default;
    QMutex                m_mutex;
    std::shared_ptr<void> m_engine;
    QString               m_currentBase;
};

} // namespace

FuzzyFinder::FuzzyFinder(QObject* parent)
    : QAbstractListModel(parent) {}

FuzzyFinder::~FuzzyFinder() {
    // Invalidate any in-flight async handlers. m_engine is just this instance's
    // copy of the process-wide singleton handle; resetting it does NOT destroy the
    // shared engine (the singleton keeps it alive for the process lifetime).
    ++m_createGeneration;
    ++m_searchGeneration;
    m_engine.reset();
}

int FuzzyFinder::rowCount(const QModelIndex& parent) const {
    if (parent.isValid())
        return 0;
    return static_cast<int>(m_results.size());
}

QVariant FuzzyFinder::data(const QModelIndex& index, int role) const {
    if (!index.isValid() || index.row() < 0 || index.row() >= static_cast<int>(m_results.size()))
        return {};

    const auto& e = m_results.at(index.row());
    switch (role) {
    case PathRole:         return e.relativePath;
    case NameRole:         return e.name;
    case IsDirRole:        return e.isDir;
    case ScoreRole:        return e.score;
    case MatchIndicesRole: {
        QVariantList list;
        list.reserve(e.matchIndices.size());
        for (int idx : e.matchIndices)
            list.append(idx);
        return list;
    }
    case FullPathRole:       return e.fullPath;
    case SizeRole:           return QVariant::fromValue<qlonglong>(e.size);
    case ModifiedRole:       return e.modified;
    case GitStatusRole:      return e.gitStatus;
    case FrecencyTotalRole:  return QVariant::fromValue<qlonglong>(e.frecencyTotal);
    case IsBinaryRole:       return e.isBinary;
    case ScoreBreakdownRole: return e.scoreBreakdown;
    case MatchTypeRole:      return e.matchType;
    case IconPathRole: {
        // Lazy, main-thread resolution (the view calls data() on the GUI thread),
        // memoised into the mutable fields. Directories short-circuit inside
        // resolveForFile; files look up their MIME on demand since the scan does
        // not carry one. Empty mimeType for a dir is fine — it is never read.
        if (!e.iconResolved) {
            const QFileInfo info(e.fullPath);
            QString mimeType;
            if (!e.isDir) {
                static const QMimeDatabase db;
                mimeType = db.mimeTypeForFile(info).name();
            }
            e.iconPath = IconThemeResolver::resolveForFile(info, mimeType);
            e.iconResolved = true;
        }
        return e.iconPath;
    }
    default:                 return {};
    }
}

QHash<int, QByteArray> FuzzyFinder::roleNames() const {
    return {
        {PathRole,           "path"},
        {NameRole,           "name"},
        {IsDirRole,          "isDir"},
        {ScoreRole,          "score"},
        {MatchIndicesRole,   "matchIndices"},
        {FullPathRole,       "fullPath"},
        {SizeRole,           "size"},
        {ModifiedRole,       "modified"},
        {GitStatusRole,      "gitStatus"},
        {FrecencyTotalRole,  "frecencyTotal"},
        {IsBinaryRole,       "isBinary"},
        {ScoreBreakdownRole, "scoreBreakdown"},
        {MatchTypeRole,      "matchType"},
        {IconPathRole,       "iconPath"},
    };
}

QString FuzzyFinder::searchPath() const { return m_searchPath; }

void FuzzyFinder::setSearchPath(const QString& path) {
    if (m_searchPath == path)
        return;
    m_searchPath = path;
    emit searchPathChanged();
    startEngine();
}

QString FuzzyFinder::query() const { return m_query; }

void FuzzyFinder::setQuery(const QString& query) {
    if (m_query == query)
        return;
    m_query = query;
    emit queryChanged();
    startSearch();
}

bool FuzzyFinder::showHidden() const { return m_showHidden; }

void FuzzyFinder::setShowHidden(bool show) {
    if (m_showHidden == show)
        return;
    m_showHidden = show;
    emit showHiddenChanged();
    // No re-index: fff governs hidden/ignored files through its own ignore model
    // (FffCreateOptions has no hidden toggle), so this property is currently inert
    // for the fff backend. Kept for QML binding compatibility.
}

bool FuzzyFinder::scanning() const { return m_scanning; }
bool FuzzyFinder::loading() const { return m_loading; }
int FuzzyFinder::resultCount() const { return static_cast<int>(m_results.size()); }
QString FuzzyFinder::error() const { return m_error; }

void FuzzyFinder::clear() {
    ++m_createGeneration;
    ++m_searchGeneration;

    if (!m_results.isEmpty()) {
        beginResetModel();
        m_results.clear();
        endResetModel();
        emit resultCountChanged();
    }

    m_engine.reset();
    m_searchPath.clear();
    m_query.clear();

    if (m_scanning) {
        m_scanning = false;
        emit scanningChanged();
    }
    if (m_loading) {
        m_loading = false;
        emit loadingChanged();
    }
    if (!m_error.isEmpty()) {
        m_error.clear();
        emit errorChanged();
    }
}

void FuzzyFinder::startEngine() {
    const int generation = ++m_createGeneration;
    ++m_searchGeneration;  // invalidate any in-flight scoring against the old engine

    m_engine.reset();
    if (!m_results.isEmpty()) {
        beginResetModel();
        m_results.clear();
        endResetModel();
        emit resultCountChanged();
    }

    const bool hadError = !m_error.isEmpty();
    m_error.clear();

    if (m_searchPath.isEmpty()) {
        if (m_scanning) { m_scanning = false; emit scanningChanged(); }
        if (hadError) emit errorChanged();
        return;
    }

    m_scanning = true;
    emit scanningChanged();
    if (hadError) emit errorChanged();

    const QString path = m_searchPath;
    const auto future = QtConcurrent::run([path]() -> CreateResult {
        // Acquire the process-wide engine (created once, re-pointed thereafter).
        CreateResult out;
        out.engine = FffEngine::instance().acquire(path, out.error);
        return out;
    });

    auto* watcher = new QFutureWatcher<CreateResult>(this);
    connect(watcher, &QFutureWatcher<CreateResult>::finished, this,
        [this, generation, watcher]() {
            watcher->deleteLater();
            if (generation != m_createGeneration)
                return;  // a newer searchPath superseded this create; drop it

            CreateResult result = watcher->result();

            m_scanning = false;
            emit scanningChanged();

            if (!result.engine) {
                m_error = result.error;
                emit errorChanged();
                return;
            }

            m_engine = std::move(result.engine);
            // Always search — an empty query yields the frecency-ranked file list
            // that populates the finder on open.
            startSearch();
        });
    watcher->setFuture(future);
}

void FuzzyFinder::startSearch() {
    const int generation = ++m_searchGeneration;

    // NOTE: an empty query is NOT short-circuited — fff returns the frecency-ranked
    // file list for it, which is what the finder shows on open (fff.nvim behaviour).

    if (!m_engine) {
        // Engine still indexing — startEngine's completion handler re-triggers us.
        return;
    }

    m_loading = true;
    emit loadingChanged();

    auto          engine = m_engine;  // shared_ptr copy keeps the engine alive
    const QString query  = m_query;
    const QString base   = m_searchPath;

    const auto future = QtConcurrent::run(
        [engine, query, base]() -> QVector<SearchResultEntry> {
            QVector<SearchResultEntry> out;
            const QByteArray q = query.toUtf8();

            // page_size = MaxResults to match the old finder's cap.
            FffResult* sr = fff_search_mixed(
                engine.get(), q.constData(), nullptr,
                /*max_threads*/ 0, /*page_index*/ 0, /*page_size*/ MaxResults,
                /*combo_boost_multiplier*/ 0, /*min_combo_count*/ 0);

            if (sr && sr->success && sr->handle) {
                auto* res = static_cast<FffMixedSearchResult*>(sr->handle);
                out.reserve(static_cast<int>(res->count));
                for (uint32_t i = 0; i < res->count; ++i) {
                    const FffMixedItem& it = res->items[i];
                    const FffScore&     sc = res->scores[i];

                    SearchResultEntry e;
                    e.relativePath = QString::fromUtf8(it.relative_path);
                    e.name         = QString::fromUtf8(it.display_name);
                    e.isDir        = (it.item_type == kFffItemTypeDirectory);
                    e.fullPath     = base + QStringLiteral("/") + e.relativePath;
                    e.size         = static_cast<qint64>(it.size);
                    e.modified     = QDateTime::fromSecsSinceEpoch(static_cast<qint64>(it.modified));
                    e.gitStatus    = it.git_status ? QString::fromUtf8(it.git_status) : QString();
                    e.frecencyTotal = static_cast<qint64>(it.total_frecency_score);
                    e.isBinary     = it.is_binary;
                    e.score        = sc.total;
                    e.matchType    = sc.match_type ? QString::fromUtf8(sc.match_type) : QString();
                    e.scoreBreakdown = makeBreakdownMap(sc);
                    e.matchIndices = computeMatchIndices(e.relativePath, query);
                    out.append(std::move(e));
                }
                fff_free_mixed_search_result(res);
            }
            if (sr)
                fff_free_result(sr);
            return out;
        });

    auto* watcher = new QFutureWatcher<QVector<SearchResultEntry>>(this);
    connect(watcher, &QFutureWatcher<QVector<SearchResultEntry>>::finished, this,
        [this, generation, watcher]() {
            watcher->deleteLater();
            if (generation != m_searchGeneration)
                return;

            beginResetModel();
            m_results = watcher->result();
            endResetModel();

            m_loading = false;
            emit loadingChanged();
            emit resultCountChanged();
        });
    watcher->setFuture(future);
}

void FuzzyFinder::recordOpen(int index, const QString& query) {
    if (!m_engine || index < 0 || index >= static_cast<int>(m_results.size()))
        return;

    auto             engine = m_engine;
    const QByteArray q      = query.toUtf8();
    // fff_track_query does NOT write frecency. It writes the QUERY TRACKER:
    // one record per (project path, query) pair, holding the opened path as
    // its selection and an open_count. A later search on the same query adds
    // open_count * combo_boost_multiplier to the score.
    //
    // Frecency is unreachable from here: fff_track_access — the exported C
    // symbol that would write it — is not among the 78 fff_* symbols the
    // shipped libfff_c.so exports, so no C-ABI caller can write frecency.
    // (Frecency::track_access is the Rust function behind it, reachable only
    // from the Neovim binding and the background watcher.) Measured three ways in
    // docs/electron-transition/20-spike-search-topology.md section 2.1.
    //
    // And in THIS application the gain is always zero anyway: startSearch()
    // passes combo_boost_multiplier = 0 to fff_search_mixed.
    const QByteArray p      = m_results.at(index).fullPath.toUtf8();

    // Fire-and-forget on a worker thread — the tracker write must never block UI.
    // The returned QFuture is deliberately discarded (cast to void to silence the
    // [[nodiscard]] warning); we never await this write.
    std::ignore = QtConcurrent::run([engine, q, p]() {
        FffResult* r = fff_track_query(engine.get(), q.constData(), p.constData());
        if (r) fff_free_result(r);
    });
}

} // namespace symmetria::filemanager::models
