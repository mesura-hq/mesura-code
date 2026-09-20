#include "spreadsheetpreviewmodel.hpp"

#include <qfuturewatcher.h>
#include <qtconcurrentrun.h>

#include <xlsxdocument.h>
#include <xlsxcellrange.h>
#include <xlsxworksheet.h>

#include <freexl.h>

namespace symmetria::filemanager::models {

// Result struct returned from the async spreadsheet reading task.
struct SpreadsheetReadResult {
    QVector<QVector<QString>> cells;
    QStringList sheetNames;
    int totalRows = 0;
    int totalCols = 0;
    int cappedRows = 0;
    int cappedCols = 0;
    QString error;
};

// Determine if a file extension indicates legacy .xls (BIFF) format.
static bool isLegacyXlsFormat(const QString& filePath) {
    return filePath.endsWith(QStringLiteral(".xls"), Qt::CaseInsensitive);
}

// Read .xlsx/.xlsm/.xltx/.xltm files using QXlsx. Runs on a worker thread.
static SpreadsheetReadResult readXlsxContents(const QString& filePath, int sheetIndex) {
    SpreadsheetReadResult result;

    QXlsx::Document doc(filePath);
    if (!doc.load()) {
        result.error = QStringLiteral("Failed to open spreadsheet");
        return result;
    }

    result.sheetNames = doc.sheetNames();
    if (result.sheetNames.isEmpty()) {
        result.error = QStringLiteral("No sheets found");
        return result;
    }

    // Clamp sheet index to valid range
    const int sheet = qBound(0, sheetIndex, static_cast<int>(result.sheetNames.size()) - 1);
    doc.selectSheet(result.sheetNames.at(sheet));

    const QXlsx::CellRange range = doc.dimension();
    if (!range.isValid()) {
        // Empty sheet — valid but no data
        return result;
    }

    result.totalRows = range.rowCount();
    result.totalCols = range.columnCount();
    result.cappedRows = qMin(result.totalRows, SpreadsheetPreviewModel::MaxRows);
    result.cappedCols = qMin(result.totalCols, SpreadsheetPreviewModel::MaxCols);

    result.cells.resize(result.cappedRows);
    for (int r = 0; r < result.cappedRows; ++r) {
        result.cells[r].resize(result.cappedCols);
        for (int c = 0; c < result.cappedCols; ++c) {
            // QXlsx uses 1-based row/col indices
            const QVariant val = doc.read(range.firstRow() + r, range.firstColumn() + c);
            result.cells[r][c] = val.isNull() ? QString() : val.toString();
        }
    }

    return result;
}

// Read .xls (BIFF) files using libfreexl. Runs on a worker thread.
static SpreadsheetReadResult readXlsContents(const QString& filePath, int sheetIndex) {
    SpreadsheetReadResult result;

    const void* handle = nullptr;
    const QByteArray pathBytes = filePath.toUtf8();
    int ret = freexl_open(pathBytes.constData(), &handle);
    if (ret != FREEXL_OK) {
        result.error = QStringLiteral("Failed to open spreadsheet");
        return result;
    }

    // RAII guard — freexl_close() is called when we leave scope
    auto cleanup = qScopeGuard([&]() { freexl_close(handle); });

    unsigned int sheetCount = 0;
    freexl_get_worksheets_count(handle, &sheetCount);

    for (unsigned int i = 0; i < sheetCount; ++i) {
        const char* name = nullptr;
        freexl_get_worksheet_name(handle, static_cast<unsigned short>(i), &name);
        result.sheetNames.append(name ? QString::fromUtf8(name) : QStringLiteral("Sheet %1").arg(i + 1));
    }

    if (sheetCount == 0) {
        result.error = QStringLiteral("No sheets found");
        return result;
    }

    const unsigned short sheet = static_cast<unsigned short>(
        qBound(0, sheetIndex, static_cast<int>(sheetCount) - 1));
    ret = freexl_select_active_worksheet(handle, sheet);
    if (ret != FREEXL_OK) {
        result.error = QStringLiteral("Failed to select sheet");
        return result;
    }

    unsigned int rows = 0;
    unsigned short cols = 0;
    freexl_worksheet_dimensions(handle, &rows, &cols);

    result.totalRows = static_cast<int>(rows);
    result.totalCols = static_cast<int>(cols);
    result.cappedRows = qMin(result.totalRows, SpreadsheetPreviewModel::MaxRows);
    result.cappedCols = qMin(result.totalCols, SpreadsheetPreviewModel::MaxCols);

    result.cells.resize(result.cappedRows);
    for (int r = 0; r < result.cappedRows; ++r) {
        result.cells[r].resize(result.cappedCols);
        for (int c = 0; c < result.cappedCols; ++c) {
            FreeXL_CellValue cell;
            if (freexl_get_cell_value(handle, static_cast<unsigned int>(r),
                    static_cast<unsigned short>(c), &cell) != FREEXL_OK) {
                continue;
            }

            switch (cell.type) {
            case FREEXL_CELL_INT:
                result.cells[r][c] = QString::number(cell.value.int_value);
                break;
            case FREEXL_CELL_DOUBLE:
                result.cells[r][c] = QString::number(cell.value.double_value, 'g', 10);
                break;
            case FREEXL_CELL_TEXT:
            case FREEXL_CELL_SST_TEXT:
            case FREEXL_CELL_DATE:
            case FREEXL_CELL_DATETIME:
            case FREEXL_CELL_TIME:
                result.cells[r][c] = QString::fromUtf8(cell.value.text_value);
                break;
            default:
                // FREEXL_CELL_NULL → empty string (default-constructed QString)
                break;
            }
        }
    }

    return result;
}

SpreadsheetPreviewModel::SpreadsheetPreviewModel(QObject* parent)
    : QAbstractTableModel(parent) {}

int SpreadsheetPreviewModel::rowCount(const QModelIndex& parent) const {
    if (parent.isValid())
        return 0;
    return m_cappedRows;
}

int SpreadsheetPreviewModel::columnCount(const QModelIndex& parent) const {
    if (parent.isValid())
        return 0;
    return m_cappedCols;
}

QVariant SpreadsheetPreviewModel::data(const QModelIndex& index, int role) const {
    if (!index.isValid() || role != Qt::DisplayRole)
        return {};
    if (index.row() < 0 || index.row() >= m_cappedRows)
        return {};
    if (index.column() < 0 || index.column() >= m_cappedCols)
        return {};

    return m_cells.at(index.row()).at(index.column());
}

QVariant SpreadsheetPreviewModel::headerData(int section, Qt::Orientation orientation, int role) const {
    if (role != Qt::DisplayRole)
        return {};

    if (orientation == Qt::Horizontal)
        return columnLetter(section);

    // Vertical headers: 1-based row numbers
    return section + 1;
}

QHash<int, QByteArray> SpreadsheetPreviewModel::roleNames() const {
    return {
        {Qt::DisplayRole, "display"},
    };
}

QString SpreadsheetPreviewModel::filePath() const { return m_filePath; }

void SpreadsheetPreviewModel::setFilePath(const QString& path) {
    if (m_filePath == path)
        return;
    m_filePath = path;
    m_activeSheet = 0;
    emit filePathChanged();
    emit activeSheetChanged();
    readSpreadsheet();
}

int SpreadsheetPreviewModel::activeSheet() const { return m_activeSheet; }

void SpreadsheetPreviewModel::setActiveSheet(int sheet) {
    if (m_activeSheet == sheet)
        return;
    m_activeSheet = sheet;
    emit activeSheetChanged();
    readSpreadsheet();
}

QStringList SpreadsheetPreviewModel::sheetNames() const { return m_sheetNames; }
int SpreadsheetPreviewModel::sheetCount() const { return static_cast<int>(m_sheetNames.size()); }
int SpreadsheetPreviewModel::totalRows() const { return m_totalRows; }
int SpreadsheetPreviewModel::totalCols() const { return m_totalCols; }
bool SpreadsheetPreviewModel::truncatedRows() const { return m_totalRows > m_cappedRows; }
bool SpreadsheetPreviewModel::truncatedCols() const { return m_totalCols > m_cappedCols; }
bool SpreadsheetPreviewModel::loading() const { return m_loading; }
QString SpreadsheetPreviewModel::error() const { return m_error; }

QString SpreadsheetPreviewModel::columnLetter(int col) {
    QString result;
    while (col >= 0) {
        result.prepend(QChar('A' + (col % 26)));
        col = col / 26 - 1;
    }
    return result;
}

void SpreadsheetPreviewModel::readSpreadsheet() {
    // Increment generation to invalidate any in-flight async results
    const int generation = ++m_generation;

    // Clear current state
    if (m_cappedRows > 0 || m_cappedCols > 0) {
        beginResetModel();
        m_cells.clear();
        m_cappedRows = 0;
        m_cappedCols = 0;
        endResetModel();
    }

    m_sheetNames.clear();
    m_totalRows = 0;
    m_totalCols = 0;

    const bool hadError = !m_error.isEmpty();
    m_error.clear();

    if (m_filePath.isEmpty()) {
        m_loading = false;
        emit loadingChanged();
        emit dataReady();
        if (hadError) emit errorChanged();
        return;
    }

    m_loading = true;
    emit loadingChanged();
    emit dataReady();
    if (hadError) emit errorChanged();

    const QString path = m_filePath;
    const int sheet = m_activeSheet;
    const bool legacy = isLegacyXlsFormat(path);

    const auto future = QtConcurrent::run([path, sheet, legacy]() {
        return legacy ? readXlsContents(path, sheet) : readXlsxContents(path, sheet);
    });

    auto* watcher = new QFutureWatcher<SpreadsheetReadResult>(this);
    connect(watcher, &QFutureWatcher<SpreadsheetReadResult>::finished, this,
        [this, generation, watcher]() {
            watcher->deleteLater();

            // Discard stale results — user navigated to a different file
            if (generation != m_generation)
                return;

            const auto result = watcher->result();

            beginResetModel();
            m_cells = result.cells;
            m_cappedRows = result.cappedRows;
            m_cappedCols = result.cappedCols;
            endResetModel();

            m_sheetNames = result.sheetNames;
            m_totalRows = result.totalRows;
            m_totalCols = result.totalCols;
            m_loading = false;

            const bool hasError = !result.error.isEmpty();
            if (hasError)
                m_error = result.error;

            emit loadingChanged();
            emit dataReady();
            if (hasError) emit errorChanged();
        });
    watcher->setFuture(future);
}

} // namespace symmetria::filemanager::models
