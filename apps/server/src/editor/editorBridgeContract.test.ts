// @effect-diagnostics nodeBuiltinImport:off - reads this package's own files as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

/**
 * Two properties no behavioural test can see. A test that waits on a clock passes or fails on
 * machine speed, not on a defect. Every dependency added here is a manifest line upstream also
 * edits, which costs a conflict at each weekly merge.
 */

const editorDirectory = NodePath.join(import.meta.dirname);

function editorSourceFiles(): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      const full = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) found.push(full);
    }
  };
  walk(editorDirectory);
  return found;
}

/**
 * The tests allowed to wait on a clock, as a list a reviewer reads rather than a marker a file
 * could set on itself. The bench models the gap between keys and asserts no duration, so no
 * threshold depends on machine speed.
 */
const MAY_WAIT_ON_A_CLOCK: ReadonlyMap<string, string> = new Map([
  // Keyed by a phrase the file would not survive losing, so the exemption follows the file:
  // another file landing on the same path does not inherit the pass.
  ["conformance/insertModeLatency.test.ts", "MESURA_NVIM_CONFIG_DIR"],
  // Pins the hold's time bound, which nothing but a clock can show.
  ["Manager.cursorWait.test.ts", "TEXT_WAIT_MS"],
  // The escape fallback is a timeout contract. Its virtual clock advances only
  // after the fake Neovim reports the held read, so machine speed cannot decide it.
  ["Manager.escapeAnswer.test.ts", "mesura.escape_state"],
]);

describe("the editor bridge's contract with the repository", () => {
  it("exempts only the file it meant to exempt", () => {
    const unmatched: string[] = [];
    for (const [name, marker] of MAY_WAIT_ON_A_CLOCK) {
      const full = NodePath.join(editorDirectory, name);
      if (!NodeFS.existsSync(full)) {
        unmatched.push(`${name} is not there`);
        continue;
      }
      if (!NodeFS.readFileSync(full, "utf8").includes(marker)) {
        unmatched.push(`${name} no longer contains ${marker}`);
      }
    }
    assert.deepStrictEqual(unmatched, [], "these exemptions no longer name what they meant to");
  });

  it("waits on Neovim rather than on a clock, in every test it owns", () => {
    const offenders: string[] = [];
    for (const file of editorSourceFiles()) {
      if (!file.endsWith(".test.ts")) continue;
      // This file names the patterns it looks for, so it always matches itself.
      if (file === import.meta.filename) continue;
      if (MAY_WAIT_ON_A_CLOCK.has(NodePath.relative(editorDirectory, file))) continue;
      const source = NodeFS.readFileSync(file, "utf8");
      // `Effect.sleep`, `setTimeout` and a bare promise-with-delay are all the
      // same mistake wearing different spellings.
      if (/Effect\.sleep\(|setTimeout\(|TestClock/.test(source)) {
        offenders.push(NodePath.relative(editorDirectory, file));
      }
    }

    assert.deepStrictEqual(offenders, [], "these tests wait on a clock");
  });

  it("adds msgpackr to the server, and nothing else", () => {
    const manifest = JSON.parse(
      NodeFS.readFileSync(NodePath.join(editorDirectory, "../../package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const dependencies = manifest.dependencies ?? {};

    assert.property(dependencies, "msgpackr");
    // The `neovim` npm package is the one to stay away from: it pulls winston,
    // and it routes `nvim_buf_lines_event` to Buffer objects rather than to the
    // generic notification listener, which is the incremental path we need.
    assert.notProperty(dependencies, "neovim");
  });
});
