// @effect-diagnostics nodeBuiltinImport:off -- This guard inspects runtime source without loading the application.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import ts from "typescript-legacy";
import { expect, it } from "vite-plus/test";

const root = NodePath.dirname(import.meta.dirname);
const web = NodePath.join(root, "apps/web/src");

// Read the authoritative arrays without importing the application contracts into this composite
// tooling project. Expanding spreads also covers future additions to command families.
const contract = ts.createSourceFile(
  "keybindings.ts",
  NodeFS.readFileSync(NodePath.join(root, "packages/contracts/src/keybindings.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const arrays = new Map<string, ts.Expression>();
function collectArrays(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    arrays.set(node.name.text, node.initializer);
  }
  ts.forEachChild(node, collectArrays);
}
collectArrays(contract);
function commandList(name: string): string[] {
  let expression = arrays.get(name);
  while (expression && (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression))) {
    expression = expression.expression;
  }
  if (!expression || !ts.isArrayLiteralExpression(expression))
    throw new Error(`Not a command array: ${name}`);
  return expression.elements.flatMap((element) => {
    if (ts.isStringLiteral(element)) return [element.text];
    if (ts.isSpreadElement(element) && ts.isIdentifier(element.expression))
      return commandList(element.expression.text);
    throw new Error(`Unsupported command entry in ${name}: ${element.getText(contract)}`);
  });
}

/** Follow runtime imports, including lazy routes. Type imports and test files cannot supply owners. */
function runtimeSources(): Map<string, ts.SourceFile> {
  const sources = new Map<string, ts.SourceFile>();
  function load(file: string): void {
    if (sources.has(file)) return;
    const source = ts.createSourceFile(
      file,
      NodeFS.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    sources.set(file, source);
    function visit(node: ts.Node): void {
      let specifier: string | undefined;
      if (
        (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) ||
        (ts.isExportDeclaration(node) && !node.isTypeOnly)
      ) {
        const module = node.moduleSpecifier;
        if (module && ts.isStringLiteral(module)) specifier = module.text;
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        specifier = node.arguments[0].text;
      }
      if (specifier && (specifier.startsWith(".") || specifier.startsWith("~/"))) {
        const base = specifier.startsWith("~/")
          ? NodePath.join(web, specifier.slice(2))
          : NodePath.resolve(NodePath.dirname(file), specifier);
        const target = [
          base,
          `${base}.ts`,
          `${base}.tsx`,
          `${base}/index.ts`,
          `${base}/index.tsx`,
        ].find((candidate) => /\.tsx?$/.test(candidate) && NodeFS.existsSync(candidate));
        if (target && !/\.(?:test|browser\.test|d)\.tsx?$/.test(target)) load(target);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  load(NodePath.join(web, "main.tsx"));
  return sources;
}

function visitRuntime(node: ts.Node, visit: (node: ts.Node) => void): void {
  if (ts.isTypeNode(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
  visit(node);
  ts.forEachChild(node, (child) => visitRuntime(child, visit));
}

/**
 * Handler maps and command branches count. Contract lists, labels, defaults, Vim keymap entries,
 * and Settings metadata do not. Data-driven dispatchers below need both their table and consumer.
 * This is a structural guard, not a proof that every handler is enabled in every UI state.
 */
function handlerCommands(sources: Map<string, ts.SourceFile>): Set<string> {
  const commands = new Set<string>();
  for (const [file, source] of sources) {
    if (file.endsWith("/keybindings.ts") || file.includes("/settings/Keybindings")) continue;
    // A model picker can consume chat shortcuts only while it is open. It cannot own their broad
    // defaults: counting that secondary consumer hid a deleted ChatView dispatcher during review.
    const addOwner = (command: string) => {
      if (
        /\/(?:Combined)?ModelPickerContent\.tsx$/.test(file) &&
        !command.startsWith("modelPicker.")
      )
        return;
      commands.add(command);
    };
    visitRuntime(source, (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isStringLiteral(node.name) &&
        (ts.isArrowFunction(node.initializer) ||
          ts.isFunctionExpression(node.initializer) ||
          ts.isCallExpression(node.initializer) ||
          (ts.isConditionalExpression(node.initializer) &&
            ts.isArrowFunction(node.initializer.whenTrue)) ||
          (ts.isIdentifier(node.initializer) && node.initializer.text !== "undefined"))
      ) {
        addOwner(node.name.text);
      }
      if (ts.isCallExpression(node) && node.expression.getText(source) === "useCommandHandlers") {
        visitRuntime(node, (child) => {
          if (
            ts.isArrayLiteralExpression(child) &&
            child.elements.length === 2 &&
            child.elements[0] &&
            ts.isStringLiteral(child.elements[0])
          )
            addOwner(child.elements[0].text);
        });
      }
      if (
        ts.isBinaryExpression(node) &&
        [
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ].includes(node.operatorToken.kind) &&
        ts.isStringLiteral(node.right) &&
        /command|action/i.test(node.left.getText(source))
      ) {
        addOwner(node.right.text);
      }
      if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression))
        addOwner(node.expression.text);
    });
  }
  return commands;
}

function assertChatPickerConsumers(sources: Map<string, ts.SourceFile>): void {
  // Before the fork table existed, the base guard must still report the original missing commands.
  if (!sources.has(NodePath.join(web, "components/chat/chatPickerCommands.ts"))) return;
  const chatView = sources.get(NodePath.join(web, "components/ChatView.tsx"));
  const consumers = new Set<string>();
  if (chatView)
    visitRuntime(chatView, (node) => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
      const name = node.expression.text;
      if (name !== "useCommandHandlers" && name !== "useChatShortcuts") return;
      const input = node.arguments[0];
      if (!input || !ts.isObjectLiteralExpression(input)) return;
      const property = input.properties.find(
        (entry) => ts.isPropertyAssignment(entry) && entry.name.getText(chatView) === "commands",
      );
      const map =
        name === "useCommandHandlers"
          ? input
          : property && ts.isPropertyAssignment(property)
            ? property.initializer
            : undefined;
      if (!map || !ts.isObjectLiteralExpression(map)) return;
      if (
        map.properties.some(
          (entry) =>
            ts.isSpreadAssignment(entry) &&
            ts.isIdentifier(entry.expression) &&
            entry.expression.text === "chatPickerCommands",
        )
      ) {
        consumers.add(name === "useCommandHandlers" ? "registry" : "chord");
      }
    });
  for (const consumer of ["chord", "registry"]) {
    if (!consumers.has(consumer))
      throw new Error(`chatPickerCommands has no ${consumer} consumer in ChatView`);
  }
}

function missingCommands(sources: Map<string, ts.SourceFile>): string[] {
  // The table alone is not a runtime owner. Both entry points must consume it: an upstream sync
  // previously dropped chord dispatch while leaving another entry point reachable.
  assertChatPickerConsumers(sources);
  const commands = handlerCommands(sources);
  const source = (path: string) => {
    const file = sources.get(NodePath.join(web, path));
    expect(file, `${path} must be reachable from main.tsx`).toBeDefined();
    return file!.getText();
  };
  // These owners dispatch through a table or a classifier instead of literal command branches.
  const sidebar = source("components/Sidebar.tsx");
  expect(sidebar).toContain("threadTraversalDirectionFromCommand(command)");
  expect(sidebar).toContain("threadKeyForJump(command)");
  expect(source("components/sidebar/threadJumpTargets.ts")).toContain(
    "threadJumpIndexFromCommand(command)",
  );
  const resolver = source("keybindings.ts");
  expect(resolver).toContain("THREAD_JUMP_KEYBINDING_COMMANDS.indexOf(command");
  for (const command of [
    "thread.previous",
    "thread.next",
    "thread.previousPage",
    "thread.nextPage",
  ]) {
    expect(resolver).toContain(`if (command === "${command}") return`);
    commands.add(command);
  }
  commandList("THREAD_JUMP_KEYBINDING_COMMANDS").forEach((command) => commands.add(command));
  expect(source("components/chat/ModelPickerContent.tsx")).toContain(
    "modelPickerJumpIndexFromCommand(command",
  );
  expect(resolver).toContain("MODEL_PICKER_JUMP_KEYBINDING_COMMANDS.indexOf(");
  commandList("MODEL_PICKER_JUMP_KEYBINDING_COMMANDS").forEach((command) => commands.add(command));

  const pane = source("lib/usePaneNavigation.ts");
  expect(pane).toContain('input.window.addEventListener("keydown"');
  expect(pane).toContain("PANE_COMMAND_DIRECTIONS");
  for (const command of ["pane.focusLeft", "pane.focusRight", "pane.focusUp", "pane.focusDown"]) {
    expect(pane).toContain(`["${command}",`);
    commands.add(command);
  }
  for (const [path, command] of [
    ["components/sidebar/AccountLimitsPanel.tsx", "usage.peek"],
    ["components/sidebar/SidebarChrome.tsx", "hosts.peek"],
  ]) {
    expect(source(path!)).toContain(`command: "${command}"`);
    expect(source(path!)).toContain("useSidebarDockController(");
    commands.add(command!);
  }
  expect(source("components/sidebar/sidebarDockController.ts")).toContain(
    'addEventListener("keydown"',
  );
  const usage = source("components/usage/UsagePage.tsx");
  expect(usage).toContain("METRIC_OPTIONS.find((option) => option.command === command)");
  expect(usage).toContain("WINDOW_OPTIONS.find((option) => option.command === command)");
  const options = sources.get(NodePath.join(web, "components/usage/usageShortcuts.ts"))!;
  visitRuntime(options, (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText() === "command" &&
      ts.isStringLiteral(node.initializer)
    ) {
      commands.add(node.initializer.text);
    }
  });
  return commandList("STATIC_KEYBINDING_COMMANDS").filter((command) => !commands.has(command));
}

it("gives every contract keybinding command a handler in the runtime import graph", () => {
  expect(
    missingCommands(runtimeSources()),
    "Commands without runtime owners (restore a handler or retire through the command migration path)",
  ).toEqual([]);
});

it("does not let a picker-scoped consumer hide a missing chat dispatcher", () => {
  const sources = runtimeSources();
  const file = NodePath.join(web, "components/chat/chatPickerCommands.ts");
  const source = sources.get(file)!;
  // This models a sync dropping the primary dispatchers while the model picker still consumes traits.
  const mutated = source
    .getText()
    .replace(/^.*"(?:traitsPicker.toggle|runContext.toggle)":.*\n/gm, "");
  sources.set(file, ts.createSourceFile(file, mutated, ts.ScriptTarget.Latest, true));
  expect(missingCommands(sources)).toEqual(["traitsPicker.toggle", "runContext.toggle"]);
});

it.each(["chord", "registry"] as const)(
  "detects a missing %s consumer of the picker command table",
  (consumer) => {
    const sources = runtimeSources();
    const file = NodePath.join(web, "components/ChatView.tsx");
    const source = sources.get(file)!;
    const pattern =
      consumer === "chord"
        ? /(commands: \{\s*)\.\.\.chatPickerCommands,/
        : /(useCommandHandlers\(\{\s*)\.\.\.chatPickerCommands,/;
    const mutated = source.getText().replace(pattern, "$1");
    expect(mutated).not.toBe(source.getText());
    sources.set(file, ts.createSourceFile(file, mutated, ts.ScriptTarget.Latest, true));
    expect(() => missingCommands(sources)).toThrow(
      `chatPickerCommands has no ${consumer} consumer in ChatView`,
    );
  },
);
