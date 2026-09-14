#pragma once

// SpreadsheetPreviewModel — QML element for previewing spreadsheet data in a TableView.
//
// Reads .xlsx files via QXlsx (Qt-native) and .xls files via libfreexl (pure C).
// Parses cell data into a flat 2D grid of display-ready QStrings, exposed as a
// QAbstractTableModel for Qt 6's TableView + HorizontalHeaderView.
//
// Key design decisions:
//
//   1. QAbstractTableModel (not list) — spreadsheet data is inherently 2D.
//      data(row, col) maps directly to TableView cells without flattening.
//
//   2. Pre-formatted QStrings — cell values (numbers, dates, booleans) are
//      converted to display strings on the worker thread. The model's data()
//      just returns m_cells[row][col] — zero per-cell formatting on the main thread.
//
//   3. Dual-library approach — QXlsx for .xlsx (ZIP of XML), libfreexl for
//      .xls (BIFF binary). Format detected by file extension.
//
//   4. Cell cap of 200×50 — preview doesn't need the full spreadsheet. Keeps
//      QML delegate count manageable and parsing fast.
//
//   5. Async via QtConcurrent — same generation-counter pattern as
//      ArchivePreviewModel to discard stale results during fast navigation.

#include <qabstractitemmodel.h>
#include <qobject.h>
#include <qqmlintegration.h>
#include <qstringlist.h>

namespace symmetria::filemanager::models {

class SpreadsheetPreviewModel : public QAbstractTableModel {
    Q_OBJECT
    QML_ELEMENT

    // Input properties (set from QML)
    Q_PROPERTY(QString filePath READ filePath WRITE setFilePath NOTIFY filePathChanged)
    Q_PROPERTY(int activeSheet READ activeSheet WRITE setActiveSheet NOTIFY activeSheetChanged)

    // Output metadata
    Q_PROPERTY(QStringList sheetNames READ sheetNames NOTIFY dataReady)
    Q_PROPERTY(int sheetCount READ sheetCount NOTIFY dataReady)
    Q_PROPERTY(int totalRows READ totalRows NOTIFY dataReady)
    Q_PROPERTY(int totalCols READ totalCols NOTIFY dataReady)
    Q_PROPERTY(bool truncatedRows READ truncatedRows NOTIFY dataReady)
    Q_PROPERTY(bool truncatedCols READ truncatedCols NOTIFY dataReady)
    Q_PROPERTY(bool loading READ loading NOTIFY loadingChanged)
    Q_PROPERTY(QString error READ error NOTIFY errorChanged)

public:
    static constexpr int MaxRows = 200;
    static constexpr int MaxCols = 50;

    explicit SpreadsheetPreviewModel(QObject* parent = nullptr);

    // QAbstractTableModel overrides
    int rowCount(const QModelIndex& parent = QModelIndex()) const override;
    int columnCount(const QModelIndex& parent = QModelIndex()) const override;
    QVariant data(const QModelIndex& index, int role = Qt::DisplayRole) const override;
    QVariant headerData(int section, Qt::Orientation orientation, int role) const override;
    QHash<int, QByteArray> roleNames() const override;

    [[nodiscard]] QString filePath() const;
    void setFilePath(const QString& path);

    [[nodiscard]] int activeSheet() const;
    void setActiveSheet(int sheet);

    [[nodiscard]] QStringList sheetNames() const;
    [[nodiscard]] int sheetCount() const;
    [[nodiscard]] int totalRows() const;
    [[nodiscard]] int totalCols() const;
    [[nodiscard]] bool truncatedRows() const;
    [[nodiscard]] bool truncatedCols() const;
    [[nodiscard]] bool loading() const;
    [[nodiscard]] QString error() const;

    // Excel-style column letter: 0→"A", 1→"B", 25→"Z", 26→"AA", ...
    static QString columnLetter(int col);

signals:
    void filePathChanged();
    void activeSheetChanged();
    void dataReady();
    void loadingChanged();
    void errorChanged();

private:
    void readSpreadsheet();

    QString m_filePath;
    int m_activeSheet = 0;
    QVector<QVector<QString>> m_cells;
    QStringList m_sheetNames;
    int m_totalRows = 0;
    int m_totalCols = 0;
    int m_cappedRows = 0;
    int m_cappedCols = 0;
    bool m_loading = false;
    QString m_error;
    int m_generation = 0;
};

} // namespace symmetria::filemanager::models
