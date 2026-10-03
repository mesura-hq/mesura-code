// @effect-diagnostics nodeBuiltinImport:off - locates the real nvim binary before spawning it.
/**
 * Whether the conformance harnesses can reach a real Neovim, and what a file
 * that needs one shows when it cannot.
 *
 * A file that needs Neovim registers its suites only when `nvimAvailable`, and
 * otherwise calls `reportMissingNvim` once. A suite registered without its
 * tests fails as empty, and tests skipped one by one look like a pass in CI.
 *
 * @module nvimOnPath
 */
import * as NodeChildProcess from "node:child_process";
import { it } from "@effect/vitest";

/** Whether `nvim` runs from PATH, which is where the adapter looks for it. */
export const nvimAvailable = (() => {
  try {
    NodeChildProcess.execFileSync("nvim", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const inContinuousIntegration = (() => {
  const value = process.env["CI"]?.trim().toLowerCase() ?? "";
  return value !== "" && value !== "false" && value !== "0";
})();

/**
 * Registers the one test a file shows in place of `harness` when Neovim is
 * missing: a failure in continuous integration, which installs Neovim, so a
 * harness cannot vanish there unnoticed; a skip that says why everywhere else.
 */
export const reportMissingNvim = (harness: string): void => {
  const title = `the ${harness} needs nvim on PATH`;
  if (!inContinuousIntegration) {
    it.skip(title, () => {});
    return;
  }
  it(title, () => {
    throw new Error(
      `Neovim is required to run the ${harness}, and nvim is not on PATH. ` +
        "Continuous integration installs it in .github/workflows/ci.yml.",
    );
  });
};
