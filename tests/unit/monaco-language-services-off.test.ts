// @effect-diagnostics nodeBuiltinImport:off - reads repository files as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { repositoryRoot } from "./contractHarness.ts";

/**
 * Monaco ships a language service per family, and this app wants none of them:
 * code intelligence comes from a language server on the backend, and a second
 * analysis running in the browser is a disagreeing answer that costs about two
 * megabytes compressed.
 *
 * This file used to guard nine lines that switched those services off at
 * runtime. They worked and they saved nothing: each service references its
 * worker through the bundler's worker plugin, so the four worker chunks were
 * built either way — 9,160,971 bytes raw, 2,058,703 gzipped, emitted and never
 * fetched. What actually removes them is not importing the services at all.
 *
 * So the thing to guard moved. It is now the curated entry and the alias that
 * points every bare `monaco-editor` import at it, and the way each of them
 * breaks is silent: a stray `languages/features` import puts a service back, a
 * loosened alias pattern swallows the editor worker's own deep import, and
 * neither shows up as anything but a bigger bundle.
 */

const read = (relativePath: string) =>
  NodeFS.readFileSync(NodePath.join(repositoryRoot, relativePath), "utf8");

const entrySource = () => read("apps/web/src/components/files/monaco/monacoEntry.ts");
const environmentSource = () => read("apps/web/src/components/files/monaco/monacoEnvironment.ts");
const viteConfigSource = () => read("apps/web/vite.config.ts");

it("loads no language service, which is what keeps their workers out of the build", () => {
  const entry = entrySource();

  for (const family of ["css", "html", "json", "typescript"]) {
    assert.notInclude(
      entry,
      `languages/features/${family}/register.js`,
      `the ${family} language service is imported again, and its worker is in the bundle with it`,
    );
  }
  assert.notInclude(entry, "monaco-lsp-client", "the LSP client external is reachable again");
});

it("keeps the grammars, because colour is not the expensive part", () => {
  const entry = entrySource();

  // The Monarch grammars are what colour TypeScript, CSS, JSON, Markdown and
  // Lua. They are registered separately from the services and were never the
  // cost, so dropping them with the services would be a silent loss of every
  // colour in the panel.
  for (const language of ["typescript", "css", "html", "markdown", "lua"]) {
    assert.include(
      entry,
      `languages/definitions/${language}/register.js`,
      `the ${language} grammar is gone, so the panel draws it in one colour`,
    );
  }

  // JSON is the exception and it is worth pinning, because the obvious tidy-up
  // is to delete these two lines for consistency with the other three. It has
  // no Monarch grammar at all: its registration and its tokenizer live in the
  // language service, so without this a `.json` file is not a language Monaco
  // knows about.
  assert.include(entry, "languages/features/json/tokenization.js");
  assert.include(entry, 'languages.setTokensProvider("json"');
  assert.notInclude(
    entry,
    "languages/features/json/register.js",
    "the JSON service is back, and its worker with it",
  );
});

it("carries the editor's own contributions, which are what make it an editor", () => {
  const entry = entrySource();

  // A sample rather than the whole list: these are the ones a developer would
  // notice within a minute of losing them.
  for (const contribution of [
    "contrib/find/browser/findController.js",
    "contrib/folding/browser/folding.js",
    "contrib/bracketMatching/browser/bracketMatching.js",
    "contrib/multicursor/browser/multicursor.js",
    "standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js",
  ]) {
    assert.include(entry, contribution, `${contribution} is gone from the curated entry`);
  }
});

it("aliases the bare specifier only, so the editor worker still resolves", () => {
  const config = viteConfigSource();

  // Anchored at both ends. A prefix pattern would also catch
  // `monaco-editor/editor/editor.worker.js?worker`, and an editor with no
  // worker is an editor with no find, no links and no word suggestions.
  assert.include(config, "/^monaco-editor$/", "the alias pattern is no longer an exact match");
  assert.include(config, "monacoEntry.ts", "the alias no longer points at the curated entry");
});

it("has nothing left to switch off at runtime", () => {
  const environment = environmentSource();

  assert.notInclude(environment, "setModeConfiguration");
  for (const namespace of ["css", "html", "json", "typescript"]) {
    assert.notInclude(
      environment,
      `${namespace}.`,
      `the environment reaches into Monaco's ${namespace} namespace again, which loads the service`,
    );
  }
});
