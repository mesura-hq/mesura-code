// @effect-diagnostics nodeBuiltinImport:off - reads this package's own files as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

/**
 * Two properties of this phase that no behavioural test can see.
 *
 * The sleep rule is about the harness itself: a test that waits on a clock
 * passes on a fast machine for the wrong reason and fails on a loaded one for
 * no defect, and a text-sync harness that does it is worse than none, because
 * it reports confidence it has not earned.
 *
 * The dependency rule is about the merge: this fork takes upstream every week,
 * and every dependency added here is a line in a manifest upstream also edits.
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
 * The one file allowed to wait on a clock, and why.
 *
 * A list rather than a marker comment a file could put on itself: widening
 * this is an edit somebody reads, not something a new test can do quietly.
 *
 * The bench measures how long a keystroke takes; the gap between keys is part
 * of what it models, because a person types rather than holding the key down.
 * The rule above does not apply to it for a specific reason — it asserts
 * nothing about a duration, so there is no threshold for a fast machine to
 * pass for the wrong reason or a loaded one to fail against.
 */
const MAY_WAIT_ON_A_CLOCK: ReadonlyMap<string, string> = new Map([
  // Keyed by a phrase the file would not survive losing, so the exemption
  // follows the file rather than the path. Checking only that *something*
  // exists at the path is the same hole one step removed: delete the bench,
  // let anything else land on that name, and it inherits a pass it never
  // asked for.
  ["conformance/insertModeLatency.test.ts", "MESURA_NVIM_CONFIG_DIR"],
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
