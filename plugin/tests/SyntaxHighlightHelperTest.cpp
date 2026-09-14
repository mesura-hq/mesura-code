// SyntaxHighlightHelperTest — unit tests for syntax-highlighted text preview.
//
// Test files are created programmatically in QTemporaryDir. Uses QTEST_MAIN
// (not GUILESS) because QTextDocument requires QGuiApplication.

#include "syntaxhighlighthelper.hpp"

#include <QFile>
#include <QSignalSpy>
#include <QTemporaryDir>
#include <QTest>

using namespace symmetria::filemanager::models;

class SyntaxHighlightHelperTest : public QObject {
    Q_OBJECT

private:
    QTemporaryDir m_tmpDir;

    // Write a file with the given content and return its full path.
    static QString writeFile(const QTemporaryDir& dir, const QString& name, const QByteArray& content)
    {
        const QString path = dir.path() + "/" + name;
        QFile f(path);
        if (!f.open(QIODevice::WriteOnly))
            return {};
        f.write(content);
        return path;
    }

    // Wait for contentChanged signal (async highlight completion).
    static bool waitForContent(SyntaxHighlightHelper& helper, int timeout = 5000)
    {
        if (!helper.loading())
            return true;
        QSignalSpy spy(&helper, &SyntaxHighlightHelper::contentChanged);
        while (helper.loading()) {
            if (!spy.wait(timeout))
                return false;
        }
        return true;
    }

private slots:
    void initTestCase()
    {
        QVERIFY(m_tmpDir.isValid());
    }

    void themeBeforeDefinitionOrder()
    {
        // Regression test for QUIRKS.md §6: if theme is set AFTER definition,
        // #000000 (black) formats burn into the layout permanently.
        const QString path = writeFile(m_tmpDir, "theme_order.cpp",
            "int main() { return 0; }\n");

        SyntaxHighlightHelper helper;
        helper.setFilePath(path);
        QVERIFY(waitForContent(helper));

        const QString html = helper.highlightedContent();
        QVERIFY(!html.isEmpty());
        // The Wine preview theme should NOT produce #000000 text colors — that's the
        // symptom of reversed theme/definition order (see QUIRKS.md §6).
        QVERIFY2(!html.contains("color:#000000"), "Black color detected — theme/definition order may be wrong");
    }

    void usesWineThemeColors()
    {
        // The preview must use the custom "Wine" theme (mirroring the user's
        // NeoVim colorscheme), NOT KF6's built-in Breeze Dark. Regression guard
        // for the call site in loadFile(): if previewTheme() is bypassed (e.g.
        // reverted to defaultTheme()), these wine-specific hexes vanish.
        //
        // Markdown 'Header H*' maps to the Function text-style; Wine paints
        // Function #fdd888 — a color Breeze Dark never emits, so its presence
        // proves the Wine theme is in effect end-to-end.
        const QString path = writeFile(m_tmpDir, "wine_check.md",
            "# Heading\n\nA `code` span and a string.\n\n1. item\n");

        SyntaxHighlightHelper helper;
        helper.setFilePath(path);
        QVERIFY(waitForContent(helper));

        const QString html = helper.highlightedContent();
        QVERIFY2(html.contains("color:#fdd888"),
            "Wine 'Function' color (markdown heading) missing — preview is not "
            "using the Wine theme (previewTheme() likely bypassed in loadFile)");
    }

    void previewThemeFallbackIsSafe()
    {
        // previewTheme() falls back to KF6's built-in DarkTheme when "Wine" fails
        // to resolve. The embedded resource can't be unloaded at runtime, so we
        // assert the fallback's two invariants directly: an unknown theme name is
        // invalid (so the guard in previewTheme() actually triggers the fallback),
        // and DarkTheme is always valid (so the fallback never yields black-on-black
        // text). If either invariant breaks in a future KF6, the fallback is unsafe.
        KSyntaxHighlighting::Repository repo;
        QVERIFY2(!repo.theme(QStringLiteral("NoSuchTheme")).isValid(),
            "an unknown theme name unexpectedly resolved — fallback guard would not trigger");
        QVERIFY2(repo.defaultTheme(KSyntaxHighlighting::Repository::DarkTheme).isValid(),
            "built-in DarkTheme is invalid — previewTheme() fallback would render unthemed");
    }

    void htmlContainsExpectedTags()
    {
        const QString path = writeFile(m_tmpDir, "tags.cpp",
            "int main() {\n    return 0;\n}\n");

        SyntaxHighlightHelper helper;
        helper.setFilePath(path);
        QVERIFY(waitForContent(helper));

        const QString html = helper.highlightedContent();
        QVERIFY(html.contains("<pre"));
        QVERIFY(html.contains("</pre>"));
        QVERIFY(html.contains("<span style=\""));
        QVERIFY(html.contains("color:"));
    }

    void htmlEscapesSpecialChars()
    {
        const QString path = writeFile(m_tmpDir, "escape.txt",
            "if (a < b && c > d) { x = \"hello\"; }\n");

        SyntaxHighlightHelper helper;
        helper.setFilePath(path);
        QVERIFY(waitForContent(helper));

        const QString html = helper.highlightedContent();
        QVERIFY(html.contains("&lt;"));
        QVERIFY(html.contains("&gt;"));
        QVERIFY(html.contains("&amp;"));
    }

    void asyncResultArrivesAfterSignal()
    {
        const QString path = writeFile(m_tmpDir, "async.cpp",
            "#include <iostream>\nint main() {}\n");

        SyntaxHighlightHelper helper;
        QSignalSpy contentSpy(&helper, &SyntaxHighlightHelper::contentChanged);
        QSignalSpy loadingSpy(&helper, &SyntaxHighlightHelper::loadingChanged);

        helper.setFilePath(path);
        // Should start loading
        QVERIFY(helper.loading() || loadingSpy.count() > 0);

        QVERIFY(waitForContent(helper));
        QVERIFY(!helper.highlightedContent().isEmpty());
        QCOMPARE(helper.loading(), false);
        // contentChanged should have fired at least once with actual content
        QVERIFY(contentSpy.count() >= 1);
    }

    void languageDetection()
    {
        const QString path = writeFile(m_tmpDir, "detect.cpp",
            "void foo() {}\n");

        SyntaxHighlightHelper helper;
        helper.setFilePath(path);
        QVERIFY(waitForContent(helper));

        // KSyntaxHighlighting names the C++ definition "C++"
        QCOMPARE(helper.language(), QStringLiteral("C++"));
    }

    void plainTextNoDefinition()
    {
        // .txt files have no syntax definition — should get plain text wrapping
        const QString path = writeFile(m_tmpDir, "plain.txt",
            "Hello, this is plain text.\nNo highlighting here.\n");

        SyntaxHighlightHelper helper;
        helper.setFilePath(path);
        QVERIFY(waitForContent(helper));

        QVERIFY(helper.language().isEmpty());
        QCOMPARE(helper.error(), false);
        const QString html = helper.highlightedContent();
        QVERIFY(html.contains("<pre"));
        // Plain text path should NOT have <span> tags (no highlighting applied)
        QVERIFY(!html.contains("<span"));
    }

    void binaryFileReturnsError()
    {
        // File with null bytes in the first 8KB triggers binary detection
        QByteArray data(1024, '\x00');
        data.prepend("some text before nulls\n");
        const QString path = writeFile(m_tmpDir, "binary.bin", data);

        SyntaxHighlightHelper helper;
        helper.setFilePath(path);
        QVERIFY(waitForContent(helper));

        QCOMPARE(helper.error(), true);
        QVERIFY(helper.highlightedContent().isEmpty());
    }

    void truncationOnLargeFile()
    {
        // Create a file with > 500 lines. The cap is SyntaxHighlightHelper::MaxLines
        // (private static constexpr int = 500 in syntaxhighlighthelper.hpp). If that
        // constant changes, update the counts here (600 input lines, 501 reported).
        QByteArray data;
        for (int i = 0; i < 600; ++i)
            data.append(QStringLiteral("line %1\n").arg(i).toUtf8());
        const QString path = writeFile(m_tmpDir, "large.txt", data);

        SyntaxHighlightHelper helper;
        helper.setFilePath(path);
        QVERIFY(waitForContent(helper));

        QCOMPARE(helper.truncated(), true);
        // Documented behavior: lineCount is MaxLines + 1 when truncated
        QCOMPARE(helper.lineCount(), 501);
    }

    void emptyFilePathClearsState()
    {
        const QString path = writeFile(m_tmpDir, "clear.cpp", "int x = 42;\n");

        SyntaxHighlightHelper helper;
        helper.setFilePath(path);
        QVERIFY(waitForContent(helper));
        QVERIFY(!helper.highlightedContent().isEmpty());

        // Set empty path — should clear all state
        helper.setFilePath(QString());
        QVERIFY(helper.highlightedContent().isEmpty());
        QCOMPARE(helper.loading(), false);
        QVERIFY(helper.language().isEmpty());
    }

    void generationCounterDiscardsStale()
    {
        // Use a binary file for A — computeHighlight returns early (no
        // KSyntaxHighlighting work) so we avoid concurrent regex compilation
        // which exposes a thread-safety issue in KSyntaxHighlighting's
        // shared DefinitionData.
        QByteArray binaryData(1024, '\x00');
        const QString pathA = writeFile(m_tmpDir, "gen_a.bin", binaryData);
        const QString pathB = writeFile(m_tmpDir, "gen_b.py", "b = 2\n");

        SyntaxHighlightHelper helper;
        // Set A (binary, fast error path) then immediately B — A's result
        // should be discarded by the generation counter.
        helper.setFilePath(pathA);
        helper.setFilePath(pathB);
        QVERIFY(waitForContent(helper));

        // Final state must reflect file B (Python), not A's error
        QCOMPARE(helper.error(), false);
        QCOMPARE(helper.language(), QStringLiteral("Python"));
    }
};

QTEST_MAIN(SyntaxHighlightHelperTest)
#include "SyntaxHighlightHelperTest.moc"
