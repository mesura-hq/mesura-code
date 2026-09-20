#!/usr/bin/env node
/**
 * Convert the KDE syntax theme into a `highlight.js` stylesheet.
 *
 * The theme is the operator's editor colours — the Qt build reads the same file
 * so that previews and the editor share one palette, and the two must not drift.
 * Converting rather than re-authoring is what keeps that true: the KDE file
 * stays the single source, and this regenerates the CSS from it.
 *
 * Usage:
 *   node tools/theme/kde-theme-to-hljs.mjs \
 *     plugin/src/Symmetria/FileManager/Models/themes/wine.theme \
 *     app/src/renderer/syntax-wine.css
 *
 * ── The four traps in this format ───────────────────────────────────────────
 * 1. KDE writes `strike-through`; CSS wants `line-through`.
 * 2. Qt colours may be `#AARRGGBB`, where CSS is `#RRGGBBAA` — the alpha moves
 *    from the front to the back.
 * 3. The read-only key is derived from file permissions rather than stored, so
 *    there is nothing to read for it.
 * 4. The metadata block must stay flat; a nested one truncates the parser.
 */

import { readFile, writeFile } from "node:fs/promises";

/**
 * KDE text style → the `highlight.js` classes it should colour.
 *
 * Not one-to-one, and it cannot be: KDE names styles by what the token IS,
 * `highlight.js` by what its grammar CALLED it. Several `hljs-*` classes
 * therefore share one KDE style, which is the intent — a built-in and a
 * language keyword look the same in the editor and must look the same here.
 */
const MAPPING = {
  Keyword: ["hljs-keyword"],
  ControlFlow: ["hljs-built_in"],
  Function: ["hljs-title", "hljs-title.function_", "hljs-section"],
  Variable: ["hljs-variable", "hljs-template-variable"],
  Operator: ["hljs-operator", "hljs-punctuation"],
  BuiltIn: ["hljs-literal", "hljs-type", "hljs-title.class_"],
  Extension: ["hljs-symbol"],
  Preprocessor: ["hljs-meta", "hljs-meta-keyword"],
  Attribute: ["hljs-attr", "hljs-attribute", "hljs-property"],
  Char: ["hljs-char"],
  SpecialChar: ["hljs-subst", "hljs-template-tag"],
  String: ["hljs-string", "hljs-quote"],
  VerbatimString: ["hljs-regexp"],
  SpecialString: ["hljs-meta-string"],
  Import: ["hljs-keyword.import_"],
  DataType: ["hljs-name", "hljs-selector-tag"],
  DecVal: ["hljs-number"],
  BaseN: ["hljs-number"],
  Float: ["hljs-number"],
  Constant: ["hljs-literal"],
  Comment: ["hljs-comment"],
  Documentation: ["hljs-doctag"],
  Annotation: ["hljs-meta"],
  CommentVar: ["hljs-variable.language_"],
  RegionMarker: ["hljs-section"],
  Information: ["hljs-emphasis"],
  Warning: ["hljs-deletion"],
  Alert: ["hljs-deletion"],
  Error: ["hljs-deletion"],
  Others: ["hljs-addition"],
};

/**
 * Normalise a colour to CSS form.
 *
 * Qt writes `#AARRGGBB`; CSS reads `#RRGGBBAA`. An eight-digit value passed
 * through unchanged silently rotates every channel — a fully opaque dark red
 * becomes a translucent something else, and it looks like a theme mistake
 * rather than a conversion one.
 */
function toCssColour(value) {
  if (typeof value !== "string" || !value.startsWith("#")) return null;

  const digits = value.slice(1);
  if (digits.length !== 8) return value;

  return `#${digits.slice(2)}${digits.slice(0, 2)}`;
}

function colourRules(style) {
  return [
    ["color", toCssColour(style["text-color"])],
    ["background", toCssColour(style["background-color"])],
  ]
    .filter(([, value]) => value !== null)
    .map(([property, value]) => `${property}: ${value};`);
}

function fontRules(style) {
  return [
    style.bold === true ? "font-weight: 600;" : null,
    style.italic === true ? "font-style: italic;" : null,
  ].filter((rule) => rule !== null);
}

/**
 * KDE's key is `strike-through`; the CSS value is `line-through`.
 *
 * Copying the key across verbatim produces a declaration the browser drops in
 * silence, which is the worst kind of conversion bug: the file looks converted.
 */
function decorationRules(style) {
  const decorations = [
    style.underline === true ? "underline" : null,
    style["strike-through"] === true ? "line-through" : null,
  ].filter((value) => value !== null);

  return decorations.length === 0 ? [] : [`text-decoration: ${decorations.join(" ")};`];
}

function declarations(style) {
  return [...colourRules(style), ...fontRules(style), ...decorationRules(style)];
}

const [themePath, outputPath] = process.argv.slice(2);
if (themePath === undefined || outputPath === undefined) {
  process.stderr.write("usage: kde-theme-to-hljs.mjs <theme.json> <output.css>\n");
  process.exit(2);
}

const theme = JSON.parse(await readFile(themePath, "utf8"));
const styles = theme["text-styles"] ?? {};
const editor = theme["editor-colors"] ?? {};

const blocks = [
  `/*
 * GENERATED — do not edit.
 *
 * Source: ${themePath} (KDE syntax theme "${theme.metadata?.name ?? "unknown"}",
 * revision ${theme.metadata?.revision ?? "?"}).
 * Regenerate: node tools/theme/kde-theme-to-hljs.mjs <theme> <output>
 *
 * The same file colours the Qt build's previews and mirrors the operator's
 * editor colourscheme. Edit the theme, not this.
 */`,
  `.hljs {\n  color: ${toCssColour(styles.Normal?.["text-color"]) ?? "#dddddd"};\n  background: ${toCssColour(editor.BackgroundColor) ?? "transparent"};\n}`,
];

for (const [style, classes] of Object.entries(MAPPING)) {
  const definition = styles[style];
  if (definition === undefined) continue;

  const rules = declarations(definition);
  if (rules.length === 0) continue;

  const selector = classes.map((name) => `.${name.replace(/\./g, "\\.")}`).join(",\n");
  blocks.push(`${selector} {\n  ${rules.join("\n  ")}\n}`);
}

await writeFile(outputPath, `${blocks.join("\n\n")}\n`, "utf8");
process.stdout.write(`wrote ${outputPath} from ${Object.keys(styles).length} text styles\n`);
