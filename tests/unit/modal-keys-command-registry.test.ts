// @effect-diagnostics nodeBuiltinImport:off - reads repository files as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { repositoryRoot } from "./contractHarness.ts";

/**
 * The modal key layer runs app commands through the command registry
 * (`apps/web/src/commands/commandRegistry.ts`), never by replaying a chord.
 *
 * The prototype ran a leader command by dispatching its chord as a synthetic
 * `keydown` (`keybindingCommandBridge.ts`), so the component that already
 * handled the chord ran it. That breaks for a command with no chord, runs the
 * wrong owner when a chord means two things, and fakes input to reach code the
 * app already owns. These assertions read the sources, because a replay that
 * comes back works and no behavioural test of the effect notices.
 *
 * Owners are found by name: a file that calls `useCommandHandlers` or
 * `registerCommandHandlers` and names the command as a quoted key of the
 * handler map (`"thread.pin": …`).
 */

const webSource = NodePath.join(repositoryRoot, "apps/web/src");

const read = (relativePath: string) =>
  NodeFS.readFileSync(NodePath.join(repositoryRoot, relativePath), "utf8");

function sourceFiles(directory: string): string[] {
  if (!NodeFS.existsSync(directory)) return [];
  return NodeFS.readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((entry) => /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry))
    .map((entry) => NodePath.join(directory, entry));
}

/** The keybinding commands the default modal keymap's leader rows reach. */
function leaderAppCommands(): string[] {
  const keymap = read("apps/web/src/keys/defaultKeymap.ts");
  const start = keymap.indexOf("const BRIDGED");
  const end = keymap.indexOf("];", start);
  assert.isAbove(start, -1, "defaultKeymap.ts no longer declares its app command rows");
  const rows = keymap.slice(start, end);
  return [...new Set([...rows.matchAll(/command: "([^"]+)"/g)].map((match) => match[1]!))];
}

it("modal keys registry guard: the chord replay bridge is gone", () => {
  assert.isFalse(
    NodeFS.existsSync(NodePath.join(webSource, "keys/keybindingCommandBridge.ts")),
    "apps/web/src/keys/keybindingCommandBridge.ts still exists",
  );
});

it("modal keys registry guard: no key engine or registry source builds a KeyboardEvent", () => {
  const offenders = [
    ...sourceFiles(NodePath.join(webSource, "keys")),
    ...sourceFiles(NodePath.join(webSource, "commands")),
  ]
    .filter((file) => /new KeyboardEvent\(/.test(NodeFS.readFileSync(file, "utf8")))
    .map((file) => NodePath.relative(repositoryRoot, file));
  assert.deepEqual(offenders, []);
});

it("modal keys registry guard: the registry module exists beside the key engine", () => {
  const registry = read("apps/web/src/commands/commandRegistry.ts");
  for (const name of ["registerCommandHandlers", "useCommandHandlers", "runRegisteredCommand"]) {
    assert.match(registry, new RegExp(`export function ${name}\\b`), `${name} is not exported`);
  }
  assert.include(read("apps/web/src/keys/keyEngine.ts"), "runRegisteredCommand(");
});

it("modal keys registry guard: every leader app command has an owner that registers it", () => {
  const commands = leaderAppCommands();
  assert.isAtLeast(commands.length, 25, "the leader rows were not found");
  const owners = sourceFiles(webSource)
    .filter((file) => !file.startsWith(NodePath.join(webSource, "commands")))
    .map((file) => NodeFS.readFileSync(file, "utf8"))
    .filter((source) => /\b(useCommandHandlers|registerCommandHandlers)\(/.test(source));
  const unowned = commands.filter(
    (command) => !owners.some((source) => source.includes(`"${command}":`)),
  );
  assert.deepEqual(unowned, []);
});
