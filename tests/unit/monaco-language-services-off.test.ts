// @effect-diagnostics nodeBuiltinImport:off - reads repository files as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { repositoryRoot } from "./contractHarness.ts";

/**
 * Monaco ships a language service per family, and this app wants none of them:
 * code intelligence comes from a language server on the backend, and a second
 * analysis running in the browser would be a disagreeing answer that costs
 * about two megabytes compressed.
 *
 * Switching them off is nine lines pairing a defaults object with an all-false
 * configuration, and every way it breaks is invisible to a test that runs the
 * code. Pair HTML's defaults with the CSS configuration and it still compiles,
 * still runs, and still turns most things off — while quietly leaving whatever
 * HTML has that CSS does not. Drop one of the nine lines and that family simply
 * keeps working, which looks like nothing at all until the bundle is measured.
 */

const read = (relativePath: string) =>
  NodeFS.readFileSync(NodePath.join(repositoryRoot, relativePath), "utf8");

const environmentSource = () => read("apps/web/src/components/files/monaco/monacoEnvironment.ts");

const PAIRINGS: ReadonlyArray<readonly [string, string]> = [
  ["typescript.typescriptDefaults", "ALL_TYPESCRIPT_FEATURES_OFF"],
  ["typescript.javascriptDefaults", "ALL_TYPESCRIPT_FEATURES_OFF"],
  ["json.jsonDefaults", "ALL_JSON_FEATURES_OFF"],
  ["css.cssDefaults", "ALL_CSS_FEATURES_OFF"],
  ["css.lessDefaults", "ALL_CSS_FEATURES_OFF"],
  ["css.scssDefaults", "ALL_CSS_FEATURES_OFF"],
  ["html.htmlDefaults", "ALL_HTML_FEATURES_OFF"],
  ["html.handlebarDefaults", "ALL_HTML_FEATURES_OFF"],
  ["html.razorDefaults", "ALL_HTML_FEATURES_OFF"],
];

it("switches every bundled language service off, each against its own family", () => {
  const source = environmentSource();

  for (const [defaults, configuration] of PAIRINGS) {
    assert.include(
      source,
      `${defaults}.setModeConfiguration(${configuration})`,
      `${defaults} is no longer switched off with ${configuration}, so that language service can start a worker and answer over the backend's language server`,
    );
  }
});

it("keeps only the generic editor worker", () => {
  const workers = read("apps/web/src/components/files/monaco/monacoWorkers.ts");

  assert.include(
    workers,
    'export const EDITOR_WORKER_LABEL = "editorWorkerService"',
    "the editor worker label changed, so every worker request now falls through to the inert branch, including the one worker this app wants",
  );
});

it("requires every feature key, so a Monaco upgrade cannot add one silently", () => {
  const workers = read("apps/web/src/components/files/monaco/monacoWorkers.ts");

  // `ModeConfiguration`'s own fields are optional, so a plain annotation lets an
  // omitted feature compile. The mapped type is what makes the omission fail.
  assert.include(
    workers,
    "type AllFeaturesOff<T> = { readonly [K in keyof Required<T>]: false }",
    "the all-features-off type lost its Required mapping, so a Monaco upgrade adding a feature would compile with that feature still enabled",
  );
  assert.notInclude(
    workers,
    ": typescript.ModeConfiguration = {",
    "a features-off constant is annotated with the plain optional-keyed type again, which cannot catch a newly added feature",
  );
});
