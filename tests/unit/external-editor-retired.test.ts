// @effect-diagnostics nodeBuiltinImport:off - reads the repository tree as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { repositoryRoot } from "./contractHarness.ts";

/**
 * This fork opens files in its own editor, never in Zed, VS Code or another external editor.
 * Upstream still renders its "Open in <editor>" picker and opens file links in the preferred
 * editor, so a sync can bring either back through a cleanly merged hunk, with every suite green.
 */

const WEB_SOURCE_ROOT = "apps/web/src";

// Upstream files this fork keeps on disk but never renders (see knip.jsonc), so a sync does not conflict on them.
const UNRENDERED_UPSTREAM_FILES = new Set([
  "apps/web/src/components/chat/OpenInPicker.tsx",
  "apps/web/src/components/chat/OpenInPicker.logic.ts",
  "apps/web/src/components/chat/OpenInPickerShortcut.ts",
]);

// These open host files outside any project, so they use the host's default app.
const SYSTEM_DEFAULT_APP_CALLERS = new Set([
  "apps/web/src/components/settings/DiagnosticsSettings.tsx",
  "apps/web/src/components/settings/KeybindingsSettings.tsx",
  "apps/web/src/components/KeybindingsConfigWarning.tsx",
]);

const read = (relativePath: string) =>
  NodeFS.readFileSync(NodePath.join(repositoryRoot, relativePath), "utf8");

function productionSourceFiles(): ReadonlyArray<string> {
  const files: string[] = [];
  const walk = (relativeDirectory: string) => {
    for (const entry of NodeFS.readdirSync(NodePath.join(repositoryRoot, relativeDirectory), {
      withFileTypes: true,
    })) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) walk(relativePath);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$|\.testkit\.tsx?$/.test(entry.name))
        files.push(relativePath);
    }
  };
  walk(WEB_SOURCE_ROOT);
  return files;
}

const filesContaining = (pattern: RegExp) =>
  productionSourceFiles().filter(
    (relativePath) =>
      !UNRENDERED_UPSTREAM_FILES.has(relativePath) && pattern.test(read(relativePath)),
  );

it("external editor guard: no surface renders the Open in picker or arms its shortcut", () => {
  assert.deepEqual(filesContaining(/<OpenInPicker\b|useOpenFavoriteEditorShortcut\(/), []);
});

it("external editor guard: only settings open a file through the preferred-editor hook", () => {
  assert.deepEqual(
    filesContaining(/(?<!function )useOpenInPreferredEditor\(/).filter(
      (relativePath) => !SYSTEM_DEFAULT_APP_CALLERS.has(relativePath),
    ),
    [],
  );
  for (const relativePath of [
    "apps/web/src/components/settings/DiagnosticsSettings.tsx",
    "apps/web/src/components/settings/KeybindingsSettings.tsx",
    "apps/web/src/components/KeybindingsUpdateToast.tsx",
  ]) {
    assert.include(read(relativePath), "systemDefaultAppOnly(", relativePath);
  }
});
