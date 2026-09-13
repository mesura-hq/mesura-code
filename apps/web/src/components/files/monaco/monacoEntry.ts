/**
 * Monaco, without the four language services.
 *
 * The package's own entry is `editor.main.js`, and it imports three kinds of
 * thing: the Monarch grammars that colour text, the sixty-odd editor
 * contributions that make it an editor, and the four language *services* for
 * CSS, HTML, JSON and TypeScript. This file is that list with the third kind
 * left out, and with the LSP client external left out with it.
 *
 * The services are what emit the workers. Each one references its worker
 * through Vite's worker plugin, so the chunks are built whether or not the
 * service is ever switched on — last cycle measured the four at 9,160,971
 * bytes raw and 2,058,703 gzipped, emitted and never fetched. Turning them off
 * at runtime, which is what this app did before, keeps them reachable and
 * keeps the chunks.
 *
 * This app wants none of them: code intelligence comes from a language server
 * on the backend, and a second analysis running in the browser is a
 * disagreeing answer that costs two megabytes compressed.
 *
 * **The import list is in upstream's own order on purpose.** A Monaco bump is
 * then a diff against `editor.main.js`, and anything upstream adds shows up as
 * a line that is here or is missing. Keep it that way: sorting it, grouping it
 * or tidying it makes the next bump a reading exercise instead of a diff.
 */

export * from "monaco-editor/editor/editor.api.js";

// The two codicon stylesheets upstream imports here are deliberately absent.
// They cannot be reached through the package name at all: the exports map is
// `./*` to `./esm/vs/*.js`, which appends `.js` to everything, so a `.css`
// specifier resolves to a file that does not exist. They arrive anyway —
// `standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.js`, which
// is in the list below, imports both by a relative path from inside the
// package, where no exports map applies.

// JSON is the one exception, and it is not a matter of taste. Every other
// language this app colours has a Monarch grammar under
// `languages/definitions/`; JSON has none. Its language registration *and* its
// tokenizer live inside the language service module, so leaving that module
// out the way the other three are left out would mean `.json` files are not a
// language Monaco knows about at all — no colour, and `getLanguages()` does
// not list it.
//
// Registering it here takes the tokenizer without the service. `tokenization.js`
// pulls in a scanner and nothing else; `jsonMode.js`, which is what references
// the worker, is only reached through the service's own `onLanguage` handler,
// and that handler is in the module this file does not import.
import { languages } from "monaco-editor/editor/editor.api.js";
import { createTokenizationSupport } from "monaco-editor/languages/features/json/tokenization.js";

languages.register({
  id: "json",
  extensions: [".json", ".bowerrc", ".jshintrc", ".jscsrc", ".eslintrc", ".babelrc", ".har"],
  aliases: ["JSON", "json"],
  mimetypes: ["application/json"],
});
// `true` is "comments are allowed", which is what makes a `tsconfig.json` or a
// `.eslintrc` colour rather than turning red at the first `//`.
languages.setTokensProvider("json", createTokenizationSupport(true));

import "monaco-editor/languages/definitions/abap/register.js";
import "monaco-editor/languages/definitions/apex/register.js";
import "monaco-editor/languages/definitions/azcli/register.js";
import "monaco-editor/languages/definitions/bat/register.js";
import "monaco-editor/languages/definitions/bicep/register.js";
import "monaco-editor/languages/definitions/cameligo/register.js";
import "monaco-editor/languages/definitions/clojure/register.js";
import "monaco-editor/languages/definitions/coffee/register.js";
import "monaco-editor/languages/definitions/cpp/register.js";
import "monaco-editor/languages/definitions/csharp/register.js";
import "monaco-editor/languages/definitions/csp/register.js";
import "monaco-editor/languages/definitions/css/register.js";
import "monaco-editor/languages/definitions/cypher/register.js";
import "monaco-editor/languages/definitions/dart/register.js";
import "monaco-editor/languages/definitions/dockerfile/register.js";
import "monaco-editor/languages/definitions/ecl/register.js";
import "monaco-editor/languages/definitions/elixir/register.js";
import "monaco-editor/languages/definitions/flow9/register.js";
import "monaco-editor/languages/definitions/fsharp/register.js";
import "monaco-editor/languages/definitions/freemarker2/register.js";
import "monaco-editor/languages/definitions/go/register.js";
import "monaco-editor/languages/definitions/graphql/register.js";
import "monaco-editor/languages/definitions/handlebars/register.js";
import "monaco-editor/languages/definitions/hcl/register.js";
import "monaco-editor/languages/definitions/html/register.js";
import "monaco-editor/languages/definitions/ini/register.js";
import "monaco-editor/languages/definitions/java/register.js";
import "monaco-editor/languages/definitions/javascript/register.js";
import "monaco-editor/languages/definitions/julia/register.js";
import "monaco-editor/languages/definitions/kotlin/register.js";
import "monaco-editor/languages/definitions/less/register.js";
import "monaco-editor/languages/definitions/lexon/register.js";
import "monaco-editor/languages/definitions/lua/register.js";
import "monaco-editor/languages/definitions/liquid/register.js";
import "monaco-editor/languages/definitions/m3/register.js";
import "monaco-editor/languages/definitions/markdown/register.js";
import "monaco-editor/languages/definitions/mdx/register.js";
import "monaco-editor/languages/definitions/mips/register.js";
import "monaco-editor/languages/definitions/msdax/register.js";
import "monaco-editor/languages/definitions/mysql/register.js";
import "monaco-editor/languages/definitions/objective-c/register.js";
import "monaco-editor/languages/definitions/pascal/register.js";
import "monaco-editor/languages/definitions/pascaligo/register.js";
import "monaco-editor/languages/definitions/perl/register.js";
import "monaco-editor/languages/definitions/pgsql/register.js";
import "monaco-editor/languages/definitions/php/register.js";
import "monaco-editor/languages/definitions/pla/register.js";
import "monaco-editor/languages/definitions/postiats/register.js";
import "monaco-editor/languages/definitions/powerquery/register.js";
import "monaco-editor/languages/definitions/powershell/register.js";
import "monaco-editor/languages/definitions/protobuf/register.js";
import "monaco-editor/languages/definitions/pug/register.js";
import "monaco-editor/languages/definitions/python/register.js";
import "monaco-editor/languages/definitions/qsharp/register.js";
import "monaco-editor/languages/definitions/r/register.js";
import "monaco-editor/languages/definitions/razor/register.js";
import "monaco-editor/languages/definitions/redis/register.js";
import "monaco-editor/languages/definitions/redshift/register.js";
import "monaco-editor/languages/definitions/restructuredtext/register.js";
import "monaco-editor/languages/definitions/ruby/register.js";
import "monaco-editor/languages/definitions/rust/register.js";
import "monaco-editor/languages/definitions/sb/register.js";
import "monaco-editor/languages/definitions/scala/register.js";
import "monaco-editor/languages/definitions/scheme/register.js";
import "monaco-editor/languages/definitions/scss/register.js";
import "monaco-editor/languages/definitions/shell/register.js";
import "monaco-editor/languages/definitions/solidity/register.js";
import "monaco-editor/languages/definitions/sophia/register.js";
import "monaco-editor/languages/definitions/sparql/register.js";
import "monaco-editor/languages/definitions/sql/register.js";
import "monaco-editor/languages/definitions/st/register.js";
import "monaco-editor/languages/definitions/swift/register.js";
import "monaco-editor/languages/definitions/systemverilog/register.js";
import "monaco-editor/languages/definitions/tcl/register.js";
import "monaco-editor/languages/definitions/twig/register.js";
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/languages/definitions/typespec/register.js";
import "monaco-editor/languages/definitions/vb/register.js";
import "monaco-editor/languages/definitions/wgsl/register.js";
import "monaco-editor/languages/definitions/xml/register.js";
import "monaco-editor/languages/definitions/yaml/register.js";
import "monaco-editor/editor/contrib/anchorSelect/browser/anchorSelect.js";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/editor/contrib/caretOperations/browser/transpose.js";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/editor/contrib/codeAction/browser/codeActionContributions.js";
import "monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget.js";
import "monaco-editor/editor/contrib/codelens/browser/codelensController.js";
import "monaco-editor/editor/contrib/colorPicker/browser/colorPickerContribution.js";
import "monaco-editor/editor/contrib/comment/browser/comment.js";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js";
import "monaco-editor/editor/browser/widget/diffEditor/diffEditor.contribution.js";
import "monaco-editor/editor/contrib/diffEditorBreadcrumbs/browser/contribution.js";
import "monaco-editor/editor/contrib/dnd/browser/dnd.js";
import "monaco-editor/editor/contrib/documentSymbols/browser/documentSymbols.js";
import "monaco-editor/editor/contrib/dropOrPasteInto/browser/dropIntoEditorContribution.js";
import "monaco-editor/features/find/register.js";
import "monaco-editor/editor/contrib/floatingMenu/browser/floatingMenu.contribution.js";
import "monaco-editor/editor/contrib/folding/browser/folding.js";
import "monaco-editor/editor/contrib/fontZoom/browser/fontZoom.js";
import "monaco-editor/editor/contrib/format/browser/formatActions.js";
import "monaco-editor/editor/contrib/gotoError/browser/gotoError.js";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js";
import "monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js";
import "monaco-editor/editor/contrib/gpu/browser/gpuActions.js";
import "monaco-editor/editor/contrib/hover/browser/hoverContribution.js";
import "monaco-editor/editor/contrib/indentation/browser/indentation.js";
import "monaco-editor/editor/contrib/inlayHints/browser/inlayHintsContribution.js";
import "monaco-editor/editor/contrib/inlineCompletions/browser/inlineCompletions.contribution.js";
import "monaco-editor/editor/contrib/inlineProgress/browser/inlineProgress.js";
import "monaco-editor/editor/contrib/inPlaceReplace/browser/inPlaceReplace.js";
import "monaco-editor/editor/contrib/insertFinalNewLine/browser/insertFinalNewLine.js";
import "monaco-editor/editor/standalone/browser/inspectTokens/inspectTokens.js";
import "monaco-editor/editor/standalone/browser/iPadShowKeyboard/iPadShowKeyboard.js";
import "monaco-editor/editor/contrib/lineSelection/browser/lineSelection.js";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js";
import "monaco-editor/editor/contrib/linkedEditing/browser/linkedEditing.js";
import "monaco-editor/editor/contrib/links/browser/links.js";
import "monaco-editor/editor/contrib/longLinesHelper/browser/longLinesHelper.js";
import "monaco-editor/editor/contrib/middleScroll/browser/middleScroll.contribution.js";
import "monaco-editor/editor/contrib/multicursor/browser/multicursor.js";
import "monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js";
import "monaco-editor/editor/contrib/placeholderText/browser/placeholderText.contribution.js";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneHelpQuickAccess.js";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.js";
import "monaco-editor/editor/contrib/readOnlyMessage/browser/contribution.js";
import "monaco-editor/editor/standalone/browser/referenceSearch/standaloneReferenceSearch.js";
import "monaco-editor/editor/contrib/rename/browser/rename.js";
import "monaco-editor/editor/contrib/sectionHeaders/browser/sectionHeaders.js";
import "monaco-editor/editor/contrib/semanticTokens/browser/viewportSemanticTokens.js";
import "monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js";
import "monaco-editor/editor/contrib/snippet/browser/snippetController2.js";
import "monaco-editor/editor/contrib/stickyScroll/browser/stickyScrollContribution.js";
import "monaco-editor/editor/contrib/suggest/browser/suggestInlineCompletions.js";
import "monaco-editor/editor/standalone/browser/toggleHighContrast/toggleHighContrast.js";
import "monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode.js";
import "monaco-editor/editor/contrib/tokenization/browser/tokenization.js";
import "monaco-editor/editor/contrib/unicodeHighlighter/browser/unicodeHighlighter.js";
import "monaco-editor/editor/contrib/unusualLineTerminators/browser/unusualLineTerminators.js";
import "monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js";
import "monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js";
import "monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations.js";
import "monaco-editor/editor/browser/coreCommands.js";
import "monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js";
import "monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution.js";
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js";
import "monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus.js";
import "monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens.js";
import "monaco-editor/editor/contrib/suggest/browser/suggestController.js";
import "monaco-editor/editor/common/standaloneStrings.js";
