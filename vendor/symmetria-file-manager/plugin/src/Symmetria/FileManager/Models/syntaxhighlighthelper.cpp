#include "syntaxhighlighthelper.hpp"

#include <qfile.h>
#include <qfileinfo.h>
#include <qfuturewatcher.h>
#include <qmimedatabase.h>
#include <qtconcurrentrun.h>
#include <qtextdocument.h>
#include <qtextlayout.h>
#include <qtextobject.h>
#include <QStringDecoder>

#include <KSyntaxHighlighting/SyntaxHighlighter>
#include <KSyntaxHighlighting/Theme>

namespace symmetria::filemanager::models {

SyntaxHighlightHelper::SyntaxHighlightHelper(QObject* parent)
    : QObject(parent) {
    // Register the embedded "Wine" theme's resource root as a custom search path.
    // KSyntaxHighlighting scans "<path>/themes/" beneath each custom path, so the
    // theme at ":/symmetria-fm-syntax/themes/wine.theme" becomes discoverable as
    // the theme named "Wine" (see its metadata.name). The .theme JSON is embedded
    // in this plugin's .so via qt_add_resources (CMakeLists.txt) — no install step.
    m_repository.addCustomSearchPath(QStringLiteral(":/symmetria-fm-syntax"));
}

// --------------------------------------------------------------------------
// previewTheme — resolves the "Wine" preview theme that mirrors the user's
// NeoVim Lush colorscheme. Falls back to KF6's built-in dark theme if the
// embedded theme is missing or failed to parse, so previews never render with
// black-on-black text.
// --------------------------------------------------------------------------
KSyntaxHighlighting::Theme SyntaxHighlightHelper::previewTheme() const {
    const auto wine = m_repository.theme(QStringLiteral("Wine"));
    if (wine.isValid())
        return wine;
    return m_repository.defaultTheme(KSyntaxHighlighting::Repository::DarkTheme);
}

QString SyntaxHighlightHelper::filePath() const { return m_filePath; }

void SyntaxHighlightHelper::setFilePath(const QString& path) {
    if (m_filePath == path) return;
    m_filePath = path;
    emit filePathChanged();
    loadFile();
}

QString SyntaxHighlightHelper::highlightedContent() const { return m_highlightedContent; }
QString SyntaxHighlightHelper::language() const { return m_language; }
int SyntaxHighlightHelper::lineCount() const { return m_lineCount; }
bool SyntaxHighlightHelper::truncated() const { return m_truncated; }
bool SyntaxHighlightHelper::loading() const { return m_loading; }
bool SyntaxHighlightHelper::error() const { return m_error; }
bool SyntaxHighlightHelper::hasContent() const { return !m_highlightedContent.isEmpty(); }

// --------------------------------------------------------------------------
// loadFile — dispatches file reading and syntax highlighting to a worker
// thread via QtConcurrent::run(). Returns immediately so the GUI stays
// responsive. A generation counter discards stale results when the user
// navigates faster than I/O + highlighting can complete.
//
// The highlighted HTML is generated via a *temporary* QTextDocument that is
// completely isolated from the QML TextEdit. This is intentional — attaching
// a QSyntaxHighlighter directly to the QML TextEdit's QTextDocument disrupts
// QQuickTextEdit's internal rendering state, causing text to disappear on
// subsequent file loads. See QUIRKS.md §4 for the full explanation.
// --------------------------------------------------------------------------
void SyntaxHighlightHelper::loadFile() {
    // Increment generation to invalidate any in-flight async results
    const int generation = ++m_generation;

    // Reset state
    const bool wasError = m_error;
    m_error = false;
    m_truncated = false;
    m_lineCount = 0;
    m_highlightedContent.clear();
    m_language.clear();

    if (m_filePath.isEmpty()) {
        m_loading = false;
        emit loadingChanged();
        emit contentChanged();
        if (wasError) emit errorChanged();
        return;
    }

    m_loading = true;
    emit loadingChanged();
    emit contentChanged();
    if (wasError) emit errorChanged();

    // Detect language on the GUI thread — cheap lookups on cached Repository data.
    // Definition and Theme are copyable value types, safe to pass to the worker.
    const QString path = m_filePath;
    auto def = m_repository.definitionForFileName(QFileInfo(path).fileName());
    if (!def.isValid()) {
        static const QMimeDatabase mimeDb;
        def = m_repository.definitionForMimeType(
            mimeDb.mimeTypeForFile(path, QMimeDatabase::MatchExtension).name());
    }
    const auto theme = previewTheme();

    // Heavy work (file I/O + QTextDocument + rehighlight) runs off the GUI thread.
    const auto future = QtConcurrent::run([path, def, theme]() {
        return computeHighlight(path, def, theme);
    });

    auto* watcher = new QFutureWatcher<HighlightResult>(this);
    connect(watcher, &QFutureWatcher<HighlightResult>::finished, this,
        [this, generation, watcher]() {
            watcher->deleteLater();

            // Discard stale results — user navigated to a different file
            if (generation != m_generation)
                return;

            const auto result = watcher->result();

            m_highlightedContent = result.html;
            m_language = result.language;
            m_lineCount = result.lineCount;
            m_truncated = result.truncated;
            m_loading = false;

            const bool errorChanged = (m_error != result.isError);
            m_error = result.isError;

            emit loadingChanged();
            emit contentChanged();
            if (errorChanged) emit this->errorChanged();
        });
    watcher->setFuture(future);
}

// --------------------------------------------------------------------------
// computeHighlight — pure function that runs on a worker thread.
//
// Reads the file, detects binary content, decodes UTF-8, truncates to
// MaxLines, and generates highlighted HTML. All objects (QFile, QTextDocument,
// QSyntaxHighlighter) are created locally — no shared state accessed.
// --------------------------------------------------------------------------
HighlightResult SyntaxHighlightHelper::computeHighlight(
    const QString& path,
    const KSyntaxHighlighting::Definition& def,
    const KSyntaxHighlighting::Theme& theme)
{
    HighlightResult result;

    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) {
        result.isError = true;
        return result;
    }

    const QByteArray raw = file.read(MaxBytes);
    const bool byteTruncated = raw.size() == MaxBytes;

    // Binary detection: scan for null bytes in the first BinaryScanBytes
    const qsizetype scanLen = qMin<qsizetype>(raw.size(), BinaryScanBytes);
    for (qsizetype i = 0; i < scanLen; ++i) {
        if (raw.at(i) == '\0') {
            result.isError = true;
            return result;
        }
    }

    // Decode UTF-8 (replacement chars for invalid sequences)
    QStringDecoder decoder(QStringDecoder::Utf8);
    QString text = decoder.decode(raw);

    // Truncate to MaxLines
    bool linesTruncated = false;
    int newlineCount = 0;
    for (int i = 0; i < text.size(); ++i) {
        if (text.at(i) == u'\n') {
            ++newlineCount;
            if (newlineCount >= MaxLines) {
                text.truncate(i + 1);
                linesTruncated = true;
                break;
            }
        }
    }

    result.lineCount = linesTruncated ? MaxLines + 1 : newlineCount + 1;
    result.truncated = byteTruncated || linesTruncated;
    result.language = def.isValid() ? def.translatedName() : QString();

    // Use the dark theme's normal text color as the <pre> tag's default color.
    // Without this, RichText mode defaults to black text (HTML standard),
    // making text invisible on our dark background.
    const QColor normalColor(theme.textColor(KSyntaxHighlighting::Theme::Normal));
    const QString preOpen = QStringLiteral("<pre style=\"margin:0;padding:0;color:")
        + normalColor.name() + QStringLiteral("\">");

    if (def.isValid()) {
        result.html = preOpen + buildHighlightedHtml(text, def, theme)
            + QStringLiteral("</pre>");
    } else {
        // No language definition — wrap escaped plain text in <pre>
        result.html = preOpen + text.toHtmlEscaped()
            + QStringLiteral("</pre>");
    }

    return result;
}

// --------------------------------------------------------------------------
// buildHighlightedHtml — the core highlighting pipeline.
//
// Architecture: highlight on a temporary QTextDocument, then extract the
// formatting data and build lightweight HTML with only <span> color tags.
//
// WHY NOT attach the highlighter to the QML TextEdit's document directly?
//   QSyntaxHighlighter::rehighlight() calls QTextDocument::markContentsDirty()
//   which disrupts QQuickTextEdit's internal rendering state. The first file
//   renders correctly (the highlighter attaches after QML has already processed
//   the text binding), but subsequent file loads cause the text to vanish.
//   This is a fundamental incompatibility between QSyntaxHighlighter (designed
//   for QTextEdit widgets) and QQuickTextEdit (scene graph renderer).
//   See QUIRKS.md §4.
//
// WHY read from QTextLayout::formats() instead of QTextFragment?
//   QSyntaxHighlighter stores its output on QTextLayout's additional formats
//   layer via setFormats(), NOT on the QTextDocument's fragment/character format
//   layer. Iterating QTextFragment objects returns the document's base
//   formatting (always empty/default), not the syntax highlighting colors.
//   See QUIRKS.md §5.
//
// WHY set theme before definition?
//   setDefinition() triggers rehighlight(). Without a valid theme,
//   Format::toTextCharFormat(invalidTheme) resolves all colors to #000000.
//   Those stale black formats persist in the QTextLayout even after setTheme()
//   triggers its own rehighlight — Qt's applyFormatChanges() optimization
//   fails to detect the difference and doesn't overwrite them.
//   See QUIRKS.md §6.
// --------------------------------------------------------------------------
QString SyntaxHighlightHelper::buildHighlightedHtml(
    const QString& text,
    const KSyntaxHighlighting::Definition& def,
    const KSyntaxHighlighting::Theme& theme)
{
    QTextDocument tempDoc;
    tempDoc.setPlainText(text);

    KSyntaxHighlighting::SyntaxHighlighter highlighter(&tempDoc);

    // CRITICAL: setTheme() MUST be called before setDefinition().
    // See the function-level comment above for the full explanation.
    highlighter.setTheme(theme);
    highlighter.setDefinition(def);

    // Extract format ranges from QTextLayout (NOT QTextFragment — see above).
    // Build lightweight HTML with only color/bold/italic spans, no font info.
    // The QML TextEdit's font properties apply as the base.
    QString html;
    html.reserve(text.size() * 2);

    QTextBlock block = tempDoc.begin();
    while (block.isValid()) {
        const QString blockText = block.text();
        const auto formats = block.layout()->formats();

        int pos = 0;
        for (const auto& range : formats) {
            // Text before this range — inherits <pre> default color
            if (range.start > pos) {
                html += blockText.mid(pos, range.start - pos).toHtmlEscaped();
            }

            const QColor fg = range.format.foreground().color();
            const bool bold = (range.format.fontWeight() >= QFont::Bold);
            const bool italic = range.format.fontItalic();
            const bool underline = range.format.fontUnderline();
            const QString escaped = blockText.mid(range.start, range.length).toHtmlEscaped();

            if (fg.isValid() || bold || italic || underline) {
                html += QStringLiteral("<span style=\"");
                if (fg.isValid())
                    html += QStringLiteral("color:") + fg.name() + u';';
                if (bold)
                    html += QStringLiteral("font-weight:bold;");
                if (italic)
                    html += QStringLiteral("font-style:italic;");
                if (underline)
                    html += QStringLiteral("text-decoration:underline;");
                html += QStringLiteral("\">") + escaped + QStringLiteral("</span>");
            } else {
                html += escaped;
            }

            pos = range.start + range.length;
        }

        // Remaining text after last range
        if (pos < blockText.size()) {
            html += blockText.mid(pos).toHtmlEscaped();
        }

        block = block.next();
        if (block.isValid())
            html += u'\n';
    }

    return html;
}

} // namespace symmetria::filemanager::models
