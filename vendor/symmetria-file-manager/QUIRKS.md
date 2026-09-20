# QuickShell / QML Quirks

Known platform-specific behaviors encountered during development. These are
not bugs per se, but surprising interactions between QML, QuickShell, and
the Loader/component system that can waste significant debugging time.

---

## 1. Loader `anchors.margins` Silently Ignored on Loaded Components

**Symptom:** You set `anchors.fill: parent` + `anchors.margins: <value>` on an
item inside a Loader's `sourceComponent`, but no padding appears visually. No
error is logged — the margin is simply not applied.

**Root cause:** When a Loader has `anchors.fill: parent` (or explicit
width/height), it **force-sets** the loaded item's geometry, bypassing the
anchor system. Children of the loaded root that use `anchors.fill: parent` +
`anchors.margins` resolve against the parent's geometry, but the anchor chain
appears to be broken — margins evaluate to 0 or are silently dropped.

**Affected patterns (DO NOT USE inside sourceComponent):**
```qml
// These will NOT produce visible margins:
Flickable {
    anchors.fill: parent
    anchors.margins: 15          // ← silently ignored
}

Item {
    anchors.fill: parent
    anchors.margins: 15          // ← silently ignored
    Flickable { anchors.fill: parent }
}
```

**Working pattern (USE THIS):**
```qml
// Explicit x/y/width/height bypasses the anchor system entirely:
Flickable {
    x: 15
    y: 10
    width: parent.width - 30
    height: parent.height - 20
}
```

**Why explicit positioning works:** The `x`, `y`, `width`, `height` properties
are simple numeric bindings that don't depend on the anchor resolution system.
They evaluate against `parent.width`/`parent.height` which ARE correctly set
by the Loader's force-sizing.

**Discovered in:** `TextPreview.qml` — three different anchor-based approaches
(direct margins, wrapper Item, TextEdit padding) all failed before switching
to explicit positioning.

---

## 2. Missing `import "../../services"` Causes ReferenceError in Explicit Bindings

**Symptom:** A QML file uses `Theme.*` properties without importing the
services directory, and it appears to work — until it doesn't. Specifically,
properties bound via `anchors.*` or declarative bindings may resolve (through
scope inheritance from the parent Loader), but explicit `x`/`y`/`width`/
`height` bindings fail with `ReferenceError: Theme is not defined`.

**Root cause:** When a component is loaded via `sourceComponent:` in a Loader,
it can inherit the parent file's import scope. This is fragile — some binding
evaluation contexts (particularly eager property bindings like x/y/width/height)
may execute before scope inheritance is established, causing ReferenceErrors.

**Rule:** Always declare explicit imports in every QML file. Never rely on
scope inheritance from parent Loaders.

```qml
// ALWAYS include both imports in every file that uses Theme:
import "../../components"
import "../../services"
```

**Discovered in:** `TextPreview.qml` and `VideoPreview.qml` — both were
missing `import "../../services"` but appeared to work via scope inheritance
from `PreviewPanel.qml`.

---

## 3. QML Cache Must Be Cleared After C++ Plugin Changes

**Symptom:** After modifying and rebuilding the C++ plugin (Symmetria.Models,
Symmetria.Services, etc.), QML files that use the new/modified types fail to
load or show stale behavior.

**Fix:** The `run.sh` script already handles this:
```bash
rm -rf ~/.cache/quickshell/qmlcache
```

But if running the shell directly (not via `run.sh`), always clear the cache
manually after any C++ plugin rebuild + install.

---

## 4. QSyntaxHighlighter Disrupts QQuickTextEdit Rendering on Subsequent Loads

**Symptom:** A `QSyntaxHighlighter` is attached to a QML `TextEdit`'s
`QTextDocument` via `textEdit.textDocument`. The first file previewed renders
correctly with syntax highlighting. When the user navigates to a second file of
the same type, the text **vanishes** — the preview appears blank.

**Root cause:** `QSyntaxHighlighter::rehighlight()` calls
`QTextDocument::markContentsDirty()`, which disrupts `QQuickTextEdit`'s internal
rendering state (layout cache, implicit size, content tracking). This is a
fundamental incompatibility: `QSyntaxHighlighter` was designed for `QTextEdit`
(widget-based), not `QQuickTextEdit` (scene graph-based).

The first file works because the highlighter attaches via `setDocument()` after
QML has already processed the `text:` binding and rendered the TextEdit. On
subsequent loads, `setFilePath()` triggers `loadFile()` which emits
`contentChanged` and immediately calls `attachHighlighter()` — the highlighter
runs before QQuickTextEdit has finished processing the new content.

**Working pattern:** Generate highlighted HTML on a **temporary** QTextDocument
(completely isolated from the QML TextEdit), then display it via
`textFormat: TextEdit.RichText`:

```cpp
// In C++: highlight on a temp document, extract HTML
QTextDocument tempDoc;
tempDoc.setPlainText(text);
KSyntaxHighlighting::SyntaxHighlighter highlighter(&tempDoc);
highlighter.setTheme(theme);
highlighter.setDefinition(def);
// Read formats from tempDoc blocks, build <span> HTML
```

```qml
// In QML: display the pre-rendered HTML
TextEdit {
    text: helper.highlightedContent
    textFormat: TextEdit.RichText    // NOT PlainText
}
```

See §5 for how to extract format data from the temp document after highlighting.

**DO NOT:**
```cpp
// Never attach a QSyntaxHighlighter to the QML TextEdit's document:
highlighter = new KSyntaxHighlighting::SyntaxHighlighter(
    qmlTextDocument->textDocument()  // ← breaks QQuickTextEdit
);
```

**Discovered in:** `TextPreview.qml` / `SyntaxHighlightHelper` — text vanished
on every file after the first when the highlighter was on the TextEdit's document.

---

## 5. QSyntaxHighlighter Formats Live on QTextLayout, Not QTextFragment

**Symptom:** After highlighting a `QTextDocument` with `QSyntaxHighlighter`, you
iterate `QTextBlock::begin()` → `QTextFragment::charFormat()` to extract colors
— but every fragment returns a default `QTextCharFormat` with no foreground color.
The highlighting appears to not have worked.

**Root cause:** `QTextDocument` has **two separate formatting layers**:

| Layer | Populated by | Read via |
|-------|------------|----------|
| Document fragments | `QTextCursor::setCharFormat()` | `QTextBlock::begin()` → `QTextFragment::charFormat()` |
| Layout additional formats | `QSyntaxHighlighter::setFormat()` | `QTextBlock::layout()->formats()` |

`QSyntaxHighlighter` stores its output exclusively on the **layout layer** via
`QTextLayout::setFormats()`. The document's fragment layer is never modified.

**Working pattern:**
```cpp
QTextBlock block = doc.begin();
while (block.isValid()) {
    // CORRECT: read from the layout layer
    const auto formats = block.layout()->formats();
    for (const auto& range : formats) {
        QColor fg = range.format.foreground().color();
        // range.start, range.length, fg, bold, italic...
    }
    block = block.next();
}
```

**DO NOT:**
```cpp
// WRONG: QTextFragment has NO syntax highlighting data
for (auto it = block.begin(); !it.atEnd(); ++it) {
    QTextFragment fragment = it.fragment();
    fragment.charFormat().foreground().color();  // ← always default/empty
}
```

**Discovered in:** `SyntaxHighlightHelper::buildHighlightedHtml()` — all text
rendered in the theme's default color because fragment iteration found no formats.

---

## 6. KSyntaxHighlighting: setTheme() Must Be Called Before setDefinition()

**Symptom:** You create a `KSyntaxHighlighting::SyntaxHighlighter`, call
`setDefinition()` then `setTheme()`, but all format ranges have foreground
color `#000000` (black) regardless of the theme.

**Root cause:** `setDefinition()` triggers `rehighlight()`. Without a valid
theme, `KSyntaxHighlighting::Format::toTextCharFormat(invalidTheme)` resolves
all colors to `#000000`. These black format ranges are written to the
`QTextLayout` via `setFormats()`.

When `setTheme()` subsequently triggers another `rehighlight()`, Qt's internal
`applyFormatChanges()` compares the new format ranges against the old ones. Due
to a comparison optimization, the stale black ranges are not always detected as
"changed" and persist in the layout.

**Working pattern:**
```cpp
KSyntaxHighlighting::SyntaxHighlighter highlighter(&doc);
highlighter.setTheme(theme);       // FIRST — theme is ready
highlighter.setDefinition(def);    // SECOND — rehighlight uses correct theme
```

**DO NOT:**
```cpp
highlighter.setDefinition(def);    // rehighlight with NO theme → #000000
highlighter.setTheme(theme);       // rehighlight, but stale black persists
```

**Verified via a standalone offline test (not committed to this repo)** — confirmed that
definition-first produces `#000000` for all ranges, while theme-first produces
correct colors (`#8e44ad` headings, `#2980b9` keywords, `#f44f4f` strings).

**Discovered in:** `SyntaxHighlightHelper::buildHighlightedHtml()` — all text
was black-on-dark-background until the call order was reversed.

---

## 7. NumberAnimation (Anim) Silently Breaks Color Property Transitions

**Symptom:** A `Behavior on color { Anim {} }` is added to a Rectangle or
StyledRect. The color appears correct on first render, but after any subsequent
change (theme IPC update, binding re-evaluation), the color snaps to `#000000`
(black) and never recovers. No error or warning is logged.

**Root cause:** `Anim` is a `NumberAnimation`. It cannot interpolate multi-channel
color values — it treats the color as a single numeric zero, producing `#000000`
on every transition. Once stuck at `#000000`, further binding changes produce
`#000000` → `#000000` animations (no-ops), so `onColorChanged` never fires again
and the property appears permanently frozen.

The first render is correct because QML `Behavior` does not fire during component
initialization — the initial binding value is assigned directly. The bug only
manifests on the **second** color change (e.g., when the theme IPC response
arrives ~50ms after startup).

**Working patterns:**
```qml
// For color and border.color, use CAnim (ColorAnimation):
StyledRect {
    color: someBinding
    border.color: anotherBinding
    Behavior on border.color { CAnim {} }
    // NOTE: StyledRect already has internal Behavior on color { CAnim {} }
    // — do NOT add another Behavior on color, it would override the internal one.
}
```

**DO NOT:**
```qml
// NumberAnimation CANNOT interpolate colors:
Behavior on color { Anim {} }              // ← produces #000000
Behavior on border.color { Anim {} }       // ← produces #000000
```

**Built-in color animations in base components:**
- `StyledRect` has `Behavior on color { CAnim {} }` — no need to add your own
- `StyledText` has `Behavior on color { CAnim {} }` — no need to add your own
- `Anim` (NumberAnimation) is correct for numeric properties: `width`, `height`,
  `opacity`, `anchors.*Offset`, `anchors.*Margin`, etc.

**Diagnostic signature in logs:** The `onColorChanged` handler reports
`color=#000000 isActive=true expected=#242424` — the binding evaluates correctly
but the animated value is wrong.

**Discovered in:** `TabBar.qml` — tab pill backgrounds were permanently stuck at
black because `Behavior on color { Anim {} }` overrode StyledRect's internal
`CAnim` with a broken `NumberAnimation`.

---

## 8. `xdg-open` Does NOT Support `--` End-of-Options

**Symptom:** Files fail to open silently when `xdg-open` is invoked with `["xdg-open", "--", path]`.

**Root cause:** `xdg-open` is a shell dispatcher script (not a C program using `getopt`).
It only accepts a single positional argument and `--help`/`--version`. Passing `--` causes
`"xdg-open: unexpected option '--'"` and exit code 1. Because the QML `Process` component
does not surface stderr by default, this failure is silent.

**Rule:** Do NOT add `--` to `xdg-open` calls, even though it is standard practice for
other tools (`mv`, `cp`, `mkdir`, `gio trash`, `bsdtar`, etc.). File paths from
`FileSystemEntry` are always absolute (starting with `/`), so option injection is not a
concern here.

```qml
// CORRECT — no "--":
xdgOpenProcess.command = ["xdg-open", openPath];

// WRONG — silent failure:
xdgOpenProcess.command = ["xdg-open", "--", openPath];
```

**Discovered in:** Tech debt audit attempted to add `--` for consistency with other
Process commands. Files stopped opening with no visible error.
