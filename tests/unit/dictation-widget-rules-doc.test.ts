// @effect-diagnostics nodeBuiltinImport:off - reads a repository file as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { repositoryRoot } from "./contractHarness.ts";

/**
 * Search unification, phase 5, criterion 6. The desktop app applies the dictation widget's
 * Hyprland window rules itself (`apps/desktop/src/dictation/hyprlandWidgetRules.ts`), so the
 * composer guide must not ask the user to add them to a Hyprland config. It asserts nothing
 * about the surrounding wording.
 */
const COMPOSER_DOC = NodePath.join(repositoryRoot, "docs/user/composer.md");

it("search unification phase 5 AC6: the composer guide asks for no window rules for the dictation widget", () => {
  const ruleLines = NodeFS.readFileSync(COMPOSER_DOC, "utf8")
    .split("\n")
    .filter((line) => /^\s*windowrule\w*\s*=/.test(line));
  assert.deepEqual(ruleLines, []);
});
