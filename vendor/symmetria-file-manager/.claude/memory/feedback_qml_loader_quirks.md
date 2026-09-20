---
name: QML Loader quirks — anchors.margins and import scope
description: anchors.margins silently fails inside Loader sourceComponents; always use explicit x/y/width/height. Always declare explicit imports — never rely on scope inheritance.
type: feedback
---

Two critical QML/QuickShell quirks discovered during TextPreview implementation:

1. **anchors.margins silently ignored in Loader sourceComponents**: When a Loader force-sizes the loaded item, `anchors.fill: parent` + `anchors.margins` on children of the loaded root are silently dropped. Use explicit `x/y/width/height` instead.

2. **Missing imports work by accident via scope inheritance**: A component loaded by `sourceComponent:` can inherit the parent's import scope. This is fragile — some bindings (especially x/y/width/height) fail with ReferenceError while anchors/font bindings appear to work. Always add explicit `import "../../services"` and `import "../../components"` to every QML file.

**Why:** Wasted significant debugging time (3+ attempts) before identifying both issues. The silent failure of anchors.margins is especially insidious — no error logged.

**How to apply:** When creating new QML components that will be loaded via Loader:
- Always include ALL required imports explicitly (components, services, Qt modules)
- For padding/margins inside loaded components, use explicit x/y/width/height, NOT anchors.margins
- Document is at `/home/jc/projects/yazi-frontend/QUIRKS.md`
