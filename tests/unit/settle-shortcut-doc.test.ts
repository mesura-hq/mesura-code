// @effect-diagnostics nodeBuiltinImport:off - reads two repository files as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { DEFAULT_KEYBINDINGS } from "../../packages/shared/src/keybindings.ts";
import { repositoryRoot } from "./contractHarness.ts";

/**
 * Only this test keeps the settle command's shipped chord and the manual's chord in agreement. It
 * reads the key from `DEFAULT_KEYBINDINGS` and pins no surrounding wording, because
 * `docs/user/keybindings.md` is an upstream file and pinning its prose would conflict every merge.
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
  // A historical pin: the move left no RETIRED_KEYBINDING_DEFAULTS entry to read the old key from.
  // A manual that still names alt+s sends the reader to a key that does nothing.
  assert.notInclude(shippedKeysFor("thread.settle"), "alt+s");
  assert.notMatch(readDoc(), /`alt\+s`/);
});
