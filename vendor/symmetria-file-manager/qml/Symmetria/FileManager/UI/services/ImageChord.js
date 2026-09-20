// Pure helpers for the "copy image to clipboard" (ci) chord gate.
//
// Extracted from WindowState.qml so the gating logic is hermetically testable
// (tst_chordbindings.qml imports this file directly — no UI-module load), the
// same testability pattern KeyRegistry.js follows. `.pragma library` keeps it
// stateless: every function is pure, taking plain data and returning plain data
// with no QML-scope or singleton access.
.pragma library

// Predicate behind WindowState.currentEntryIsImage. A FileSystemEntry (or null)
// in → bool out. Defensive against null/undefined and a missing isImage prop so
// callers can pass the raw cursor entry without pre-checking.
function entryIsImage(entry) {
    return !!(entry && entry.isImage);
}

// Build the "copy to clipboard" chord group to render. When the cursor sits on
// an image, the image-to-clipboard (ci) row is appended after the static binds;
// otherwise the static group is returned untouched so the row stays hidden.
//
// NEVER mutates `copyGroup` or its `binds` array — WindowState shares the one
// static config across every chordBindings re-evaluation, so an in-place push
// would permanently grow the menu (the regression this contract guards). Uses
// Object.assign + Array.concat, both of which allocate fresh containers.
function copyGroupWithImageRow(copyGroup, currentEntryIsImage) {
    if (!currentEntryIsImage)
        return copyGroup;
    return Object.assign({}, copyGroup, {
        binds: copyGroup.binds.concat([
            { key: "i", label: "Image to clipboard", icon: "image" }
        ])
    });
}
