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
 * Owners register an object map, a spread of a named object map, or literal
 * command/mode pairs mapped through `Object.fromEntries`. Only declarations
 * that reach a registration call count as owners.
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

/** The distinct `command: "…"` values in `file` from `startMarker` to the next `];`. */
function commandsDeclaredIn(file: string, startMarker: string): string[] {
  const source = read(file);
  const start = source.indexOf(startMarker);
  assert.isAbove(start, -1, `${file} no longer declares "${startMarker}"`);
  const end = source.indexOf("];", start);
  const rows = source.slice(start, end);
  return [...new Set([...rows.matchAll(/command: "([^"]+)"/g)].map((match) => match[1]!))];
}

/** The keybinding commands the default modal keymap's leader rows reach. */
const leaderAppCommands = () =>
  commandsDeclaredIn("apps/web/src/keys/defaultKeymap.ts", "const BRIDGED");

/** The commands the panel launcher's Panel section runs (`panelLauncherActions`). */
const panelLauncherCommands = () =>
  commandsDeclaredIn("apps/web/src/lib/panelLauncher.ts", "export function panelLauncherActions(");

/** Keeps literals atomic, so comments and quoted examples cannot register commands. */
function sourceTokens(source: string): string[] {
  return (
    source.match(
      /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\.\.\.|=>|[\w$]+|[^\s]/g,
    ) ?? []
  ).filter((token) => !token.startsWith("//") && !token.startsWith("/*"));
}

/** Splits only at this expression's level, outside nested calls, arrays and objects. */
function expressionParts(tokens: readonly string[]): string[][] {
  const parts: string[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (token === "," && depth === 0) {
      parts.push([]);
      continue;
    }
    parts.at(-1)!.push(token);
    if (["(", "[", "{"].includes(token)) depth += 1;
    if ([")", "]", "}"].includes(token)) depth -= 1;
  }
  return parts.filter((part) => part.length > 0);
}

function closingToken(tokens: readonly string[], open: number): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    if (["(", "[", "{"].includes(tokens[index]!)) depth += 1;
    if ([")", "]", "}"].includes(tokens[index]!) && --depth === 0) return index;
  }
  assert.fail("a command registration expression never closes");
}

function registeredCommands(source: string): Set<string> {
  const tokens = sourceTokens(source);
  const commands = new Set<string>();
  const visitMap = (map: readonly string[], visited = new Set<string>()): void => {
    if (map[0] === "{") {
      for (const property of expressionParts(map.slice(1, closingToken(map, 0)))) {
        if (/^["']/.test(property[0]!) && property[1] === ":" && property[2] !== "undefined") {
          commands.add(property[0]!.slice(1, -1));
        } else if (property[0] === "..." && property.length === 2) {
          visitMap(property.slice(1), visited);
        }
      }
      return;
    }
    if (map.length === 1 && !visited.has(map[0]!)) {
      const name = map[0]!;
      const declaration = tokens.findIndex(
        (token, index) =>
          token === "const" && tokens[index + 1] === name && tokens[index + 2] === "=",
      );
      if (declaration !== -1 && tokens[declaration + 3] === "{") {
        visitMap(
          tokens.slice(declaration + 3, closingToken(tokens, declaration + 3) + 1),
          new Set([...visited, name]),
        );
      }
      return;
    }
    if (map.slice(0, 5).join(" ") !== "Object . fromEntries ( [") return;
    const arrayEnd = closingToken(map, 4);
    if (map.slice(arrayEnd + 1, arrayEnd + 5).join(" ") !== ". map ( (") return;
    const parameterStart = arrayEnd + 5;
    if (map[parameterStart] !== "[") return;
    const parameterEnd = closingToken(map, parameterStart);
    const commandParameter = map[parameterStart + 1];
    if (map.slice(parameterEnd + 1, parameterEnd + 4).join(" ") !== ") => [") return;
    const projectionStart = parameterEnd + 3;
    const projection = expressionParts(
      map.slice(projectionStart + 1, closingToken(map, projectionStart)),
    );
    if (projection.length !== 2 || projection[0]?.join("") !== commandParameter) return;
    if (!projection[1]?.includes("=>")) return;
    for (const pair of expressionParts(map.slice(5, arrayEnd))) {
      if (pair[0] !== "[") continue;
      const entries = expressionParts(pair.slice(1, closingToken(pair, 0)));
      if (entries.length === 2 && entries[0]?.length === 1 && /^["']/.test(entries[0][0]!)) {
        commands.add(entries[0][0]!.slice(1, -1));
      }
    }
  };
  for (let index = 0; index < tokens.length; index += 1) {
    if (!["useCommandHandlers", "registerCommandHandlers"].includes(tokens[index]!)) continue;
    if (tokens[index + 1] !== "(") continue;
    const args = expressionParts(tokens.slice(index + 2, closingToken(tokens, index + 1)));
    if (args[0]) visitMap(args[0]);
  }
  return commands;
}

/** The commands no source outside `apps/web/src/commands` registers a handler for. */
function commandsWithoutOwner(commands: readonly string[], sources?: readonly string[]): string[] {
  const owners = (
    sources ??
    sourceFiles(webSource)
      .filter((file) => !file.startsWith(NodePath.join(webSource, "commands")))
      .map((file) => NodeFS.readFileSync(file, "utf8"))
  ).map(registeredCommands);
  return commands.filter((command) => !owners.some((registered) => registered.has(command)));
}

it("modal keys registry scanner follows registered maps and mapped command pairs", () => {
  const source = `
    const shared = { "thread.pin": pin };
    useCommandHandlers({ ...shared, "thread.rename": rename });
    registerCommandHandlers({ "thread.next": next });
    useCommandHandlers(Object.fromEntries([
      ["filePicker.toggle", "files"],
      ["threadSearch.toggle", "threads"],
    ].map(([command, mode]) => [command, () => toggleMode(mode)])));
  `;
  assert.deepEqual(
    commandsWithoutOwner(
      ["thread.pin", "thread.rename", "thread.next", "filePicker.toggle", "threadSearch.toggle"],
      [source],
    ),
    [],
  );
});

it("modal keys registry scanner rejects commands outside the registered map", () => {
  const source = `
    const unused = { "thread.pin": pin };
    const unusedPairs = [["filePicker.toggle", "files"]];
    // useCommandHandlers({ "thread.rename": rename });
    const example = 'useCommandHandlers({ "thread.next": next })';
    useCommandHandlers({ "thread.stop": undefined });
    useCommandHandlers(Object.fromEntries([
      ["threadSearch.toggle", "threads"],
    ].map(([command, mode]) => ["other.command", () => toggleMode(mode)])));
  `;
  const commands = [
    "thread.pin",
    "thread.rename",
    "thread.next",
    "thread.stop",
    "filePicker.toggle",
    "threadSearch.toggle",
  ];
  assert.deepEqual(commandsWithoutOwner(commands, [source]), commands);
});

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
  assert.deepEqual(commandsWithoutOwner(commands), []);
});

// Round 7 moved the `<leader>p*` rows into the launcher, so the leader guard
// above no longer sees these commands.
it("modal keys registry guard: every panel launcher action has an owner that registers it", () => {
  const commands = panelLauncherCommands();
  assert.sameMembers(
    commands,
    [
      "rightPanel.toggleMaximized",
      "rightPanel.close",
      "rightPanel.toggle",
      "fileTree.toggle",
      "fileTree.miller",
    ],
    "the launcher's Panel section no longer offers Z, X, O, E and C",
  );
  assert.deepEqual(commandsWithoutOwner(commands), []);
});
