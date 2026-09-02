// @effect-diagnostics nodeBuiltinImport:off - reads two repository files as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { DEFAULT_KEYBINDINGS } from "../../packages/shared/src/keybindings.ts";
import { repositoryRoot } from "./contractHarness.ts";

/**
 * The chord a command ships on and the chord the manual tells a user to press
 * are two facts in two files, and nothing but this test makes them agree.
 * Moving the settle chord off `alt+s` needed edits in five places, and a
 * review still found a sixth that was wrong.
 *
 * It reads the key out of `DEFAULT_KEYBINDINGS` rather than naming it, so the
 * next move of this default only has to change the table and the prose. It
 * asserts nothing about the surrounding wording on purpose:
 * `docs/user/keybindings.md` is an upstream file this fork edits, and pinning
 * its prose would conflict at every weekly merge for no gain.
 */
const KEYBINDINGS_DOC = NodePath.join(repositoryRoot, "docs/user/keybindings.md");

const readDoc = () => NodeFS.readFileSync(KEYBINDINGS_DOC, "utf8");

const shippedKeysFor = (command: string) =>
  DEFAULT_KEYBINDINGS.filter((rule) => rule.command === command).map((rule) => rule.key);

it("documents every chord the settle toggle actually ships on", () => {
  const doc = readDoc();
  const keys = shippedKeysFor("thread.settle");

  assert.isAbove(keys.length, 0, "thread.settle lost its default binding");
  for (const key of keys) {
    assert.include(doc, `\`${key}\``, `docs/user/keybindings.md never names ${key}`);
  }
});

it("stops telling anyone to press the chord the settle toggle moved off", () => {
  // A specific historical pin rather than a derived one: the move left no
  // RETIRED_KEYBINDING_DEFAULTS entry to read the old key back out of, because
  // the backfill delivers the new chord on its own. A manual that still names
  // alt+s is worse than one that says nothing — the reader presses it, nothing
  // happens, and the manual is what told them to.
  assert.notInclude(shippedKeysFor("thread.settle"), "alt+s");
  assert.notMatch(readDoc(), /`alt\+s`/);
});
