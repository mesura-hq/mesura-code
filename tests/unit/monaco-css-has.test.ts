// @effect-diagnostics nodeBuiltinImport:off - reads installed package files as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import {
  isMonacoActionWidgetCss,
  MONACO_EMPTY_DETAIL_HAS,
  MONACO_STYLE_ATTRIBUTE_HAS,
  rewriteMonacoActionWidgetCss,
} from "../../apps/web/vite/monacoActionWidgetCss.ts";
import { repositoryRoot } from "./contractHarness.ts";

/**
 * Monaco's CSS reaches the page from the first file opened until the window
 * closes, so a `:has()` in it costs every thread switch for the rest of the
 * session, not only while the editor is open. One such rule, which reads the
 * `style` attribute, added ten whole-page restyles to thirteen thread
 * switches; `apps/web/vite/monacoActionWidgetCss.ts` rewrites it at build
 * time. These checks run against the installed Monaco, so a version bump that
 * moves or adds such a rule fails here instead of shipping silently.
 */

// Through the web app's link, not `require.resolve`: Monaco's exports map sends
// every subpath to `./esm/vs/*.js`, so even `monaco-editor/package.json` fails.
const monacoRoot = NodeFS.realpathSync(
  NodePath.join(repositoryRoot, "apps/web/node_modules/monaco-editor"),
);

function monacoCssFiles(directory: string): string[] {
  return NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return monacoCssFiles(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

const actionWidgetCssPath = NodePath.join(
  monacoRoot,
  "esm/vs/platform/actionWidget/browser/actionWidget.css",
);

it("rewrites Monaco's style-attribute :has() to the equivalent :empty check", () => {
  // The plugin keys on the module id; a drift between its pattern and the real
  // path would stop the rewrite without any other signal.
  assert.isTrue(isMonacoActionWidgetCss(actionWidgetCssPath));
  assert.isTrue(isMonacoActionWidgetCss(`${actionWidgetCssPath}?direct`));

  const rewritten = rewriteMonacoActionWidgetCss(NodeFS.readFileSync(actionWidgetCssPath, "utf8"));
  assert.isNotNull(
    rewritten,
    `Monaco no longer ships ${MONACO_STYLE_ATTRIBUTE_HAS}; re-check the plugin`,
  );
  assert.notInclude(rewritten!, MONACO_STYLE_ATTRIBUTE_HAS);
  assert.include(rewritten!, MONACO_EMPTY_DETAIL_HAS);
  // The equivalence holds only while Monaco empties the detail when it hides it.
  const actionList = NodeFS.readFileSync(
    NodePath.join(monacoRoot, "esm/vs/platform/actionWidget/browser/actionList.js"),
    "utf8",
  );
  assert.match(
    actionList,
    /data\.detail\.textContent = '';\s*data\.detail\.style\.display = 'none';/,
    "Monaco no longer empties the hidden detail, so :not(:empty) stops matching the same rows",
  );
});

it("finds no other Monaco :has() that reads an attribute the app rewrites constantly", () => {
  const offenders = monacoCssFiles(NodePath.join(monacoRoot, "esm")).flatMap((file) => {
    // Only the file the plugin rewrites is checked after the rewrite; every
    // other file ships as it is, so it is checked as it is.
    const raw = NodeFS.readFileSync(file, "utf8");
    const css = isMonacoActionWidgetCss(file) ? (rewriteMonacoActionWidgetCss(raw) ?? raw) : raw;
    return [...css.matchAll(/:has\([^{]*\[(style|class)\b/g)].map(
      (match) => `${NodePath.relative(monacoRoot, file)}: ${match[0]}`,
    );
  });
  assert.deepEqual(
    offenders,
    [],
    "a Monaco :has() reads style or class; measure it before shipping",
  );
});
