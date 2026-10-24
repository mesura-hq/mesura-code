// @effect-diagnostics nodeBuiltinImport:off - reads repository files as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "vite-plus/test";

import { repositoryRoot } from "./contractHarness.ts";

/**
 * The modal key layer's block cursor is static: it is repainted on the events
 * that move it (a key, a scroll, a composer layout change) and never by a
 * loop. AGENTS.md ("Taste") bans continuously repainting animations because
 * they peg the GPU on high-refresh displays, and a frame loop that keeps a
 * cursor overlay in place works, so no behavioural test notices it. These
 * assertions read the sources.
 *
 * Phase 7 of the modal keys production cycle, criterion 6: no continuous
 * animation is added for the widened cursor on narrow glyphs.
 */

const keysSource = NodePath.join(repositoryRoot, "apps/web/src/keys");

const read = (absolutePath: string) => NodeFS.readFileSync(absolutePath, "utf8");

function sourceFiles(directory: string): string[] {
  return NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** The text from `start` to the brace that closes the first `{` after it. */
function braceBlock(source: string, start: number): string {
  const open = source.indexOf("{", start);
  if (open === -1) return "";
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  return source.slice(start);
}

/** The body of the function or arrow-function constant named `name`, or null. */
function functionBody(source: string, name: string): string | null {
  const declaration = new RegExp(
    `(?:function\\s+${name}\\s*\\(|(?:const|let)\\s+${name}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|\\w+)\\s*=>)`,
  ).exec(source);
  return declaration ? braceBlock(source, declaration.index) : null;
}

const ANIMATION_IN_MARKUP = /\banimate-|\btransition\b|\banimation\b|setInterval\s*\(/;

describe("modal keys block cursor: static, never animated", () => {
  it("modal keys block cursor guard: no frame callback in apps/web/src/keys requests itself again", () => {
    const loops: string[] = [];
    for (const file of sourceFiles(keysSource)) {
      const source = read(file);
      for (const call of source.matchAll(/requestAnimationFrame\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
        const name = call[1]!;
        const body = functionBody(source, name);
        if (body !== null && body.slice(body.indexOf("{")).includes("requestAnimationFrame(")) {
          loops.push(`${NodePath.relative(repositoryRoot, file)}: ${name}`);
        }
      }
    }
    assert.deepEqual(loops, [], "a requestAnimationFrame callback schedules another frame");
  });

  it("modal keys block cursor guard: the block cursor component declares no animation, transition or timer", () => {
    const host = read(NodePath.join(keysSource, "KeyEngineHost.tsx"));
    const blockCursor = functionBody(host, "BlockCursor");
    assert.isNotNull(blockCursor, "KeyEngineHost.tsx still defines BlockCursor");
    assert.notMatch(blockCursor!, ANIMATION_IN_MARKUP);
    assert.notInclude(blockCursor!, "requestAnimationFrame");
  });

  it("modal keys block cursor guard: the cursor overlay modules schedule no frames or timers", () => {
    const modules = ["cursorOverlayStore.ts", "blockCursor.ts"]
      .map((name) => NodePath.join(keysSource, name))
      .filter((path) => NodeFS.existsSync(path));
    assert.isAbove(modules.length, 0, "the cursor overlay store exists");
    for (const path of modules) {
      const source = read(path);
      assert.notInclude(source, "requestAnimationFrame", path);
      assert.notMatch(source, /setInterval\s*\(|setTimeout\s*\(/, path);
    }
  });

  it("modal keys block cursor guard: mesura.css gives the cursor rules no animation or transition", () => {
    const css = read(NodePath.join(repositoryRoot, "apps/web/src/mesura.css")).replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const cursorRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((rule) =>
      /cursor/.test(rule[1]!),
    );
    assert.isAbove(cursorRules.length, 0, "mesura.css styles the cursor highlights");
    for (const rule of cursorRules) {
      assert.notMatch(rule[2]!, /\b(?:animation|transition)\b/, rule[1]!.trim());
    }
    assert.notMatch(css, /@keyframes[^{]*cursor/);
  });
});
