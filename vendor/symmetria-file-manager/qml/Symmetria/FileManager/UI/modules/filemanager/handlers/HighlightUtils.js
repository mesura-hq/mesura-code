// HighlightUtils.js — shared HTML-escaping helper for rich-text match highlighting.
//
// Used by FileListItem (search/flash highlighting) and FuzzyFinderResultDelegate
// (fuzzy-match index-set highlighting). Centralised here so any future extension
// (e.g. adding apostrophe or backtick escaping) is made once.
//
// Usage: import "handlers/HighlightUtils.js" as HighlightUtils
//        HighlightUtils.htmlEscape(str)

.pragma library

function htmlEscape(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
               .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
