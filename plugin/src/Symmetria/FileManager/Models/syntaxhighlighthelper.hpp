#pragma once

// SyntaxHighlightHelper — QML element for syntax-highlighted text file previews.
//
// Reads the first 64KB of a file, detects its language via KSyntaxHighlighting,
// and produces highlighted HTML for display in a QML TextEdit (RichText mode).
//
// Key architecture decisions (all documented in QUIRKS.md §4–§6):
//
//   1. Highlighting happens on a TEMPORARY QTextDocument, not on the QML
//      TextEdit's document. Attaching QSyntaxHighlighter to QQuickTextEdit's
//      document disrupts its rendering state on subsequent file loads.
//
//   2. Format data is read from QTextBlock::layout()->formats() (the
//      QTextLayout additional formats layer), NOT from QTextFragment iteration
//      (the document's character format layer — QSyntaxHighlighter doesn't
//      write there).
//
//   3. Theme must be set BEFORE definition on the highlighter. Reversing the
//      order burns black (#000000) formats into the layout that persist even
//      after a subsequent setTheme() + rehighlight().

#include <qobject.h>
#include <qqmlintegration.h>

#include <KSyntaxHighlighting/Definition>
#include <KSyntaxHighlighting/Repository>
#include <KSyntaxHighlighting/Theme>

namespace symmetria::filemanager::models {

// Result of the background highlight computation.
struct HighlightResult {
    QString html;
    QString language;
    int lineCount = 0;
    bool truncated = false;
    bool isError = false;
};

class SyntaxHighlightHelper : public QObject {
    Q_OBJECT
    QML_ELEMENT

    // Input property (set from QML)
    Q_PROPERTY(QString filePath READ filePath WRITE setFilePath NOTIFY filePathChanged)

    // Output properties (read from QML)
    Q_PROPERTY(QString highlightedContent READ highlightedContent NOTIFY contentChanged)
    Q_PROPERTY(QString language READ language NOTIFY contentChanged)
    Q_PROPERTY(int lineCount READ lineCount NOTIFY contentChanged)
    Q_PROPERTY(bool truncated READ truncated NOTIFY contentChanged)
    Q_PROPERTY(bool loading READ loading NOTIFY loadingChanged)
    Q_PROPERTY(bool error READ error NOTIFY errorChanged)
    Q_PROPERTY(bool hasContent READ hasContent NOTIFY contentChanged)

public:
    explicit SyntaxHighlightHelper(QObject* parent = nullptr);

    [[nodiscard]] QString filePath() const;
    void setFilePath(const QString& path);

    [[nodiscard]] QString highlightedContent() const;
    [[nodiscard]] QString language() const;
    [[nodiscard]] int lineCount() const;
    [[nodiscard]] bool truncated() const;
    [[nodiscard]] bool loading() const;
    [[nodiscard]] bool error() const;
    [[nodiscard]] bool hasContent() const;

signals:
    void filePathChanged();
    void contentChanged();
    void loadingChanged();
    void errorChanged();

private:
    static constexpr qint64 MaxBytes = 65536;   // 64KB read cap
    static constexpr int MaxLines = 500;         // line count cap
    static constexpr int BinaryScanBytes = 8192; // null-byte scan window

    void loadFile();

    // Returns the "Wine" preview theme (mirrors the user's NeoVim colorscheme),
    // falling back to KF6's built-in dark theme if the embedded theme fails to load.
    [[nodiscard]] KSyntaxHighlighting::Theme previewTheme() const;

    // Pure computation — safe to call from any thread.
    static HighlightResult computeHighlight(
        const QString& path,
        const KSyntaxHighlighting::Definition& def,
        const KSyntaxHighlighting::Theme& theme);
    static QString buildHighlightedHtml(
        const QString& text,
        const KSyntaxHighlighting::Definition& def,
        const KSyntaxHighlighting::Theme& theme);

    QString m_filePath;
    QString m_highlightedContent;
    QString m_language;
    int m_lineCount = 0;
    bool m_truncated = false;
    bool m_loading = false;
    bool m_error = false;
    int m_generation = 0;

    KSyntaxHighlighting::Repository m_repository;
};

} // namespace symmetria::filemanager::models
