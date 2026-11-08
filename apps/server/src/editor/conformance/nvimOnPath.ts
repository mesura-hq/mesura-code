// @effect-diagnostics nodeBuiltinImport:off - locates the real nvim binary before spawning it.
/**
 * A file that needs Neovim registers its suites only when `nvimAvailable`, else calls
 * `reportMissingNvim` once: an empty suite fails, and tests skipped one by one look like a pass.
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

/** Whether a `CI` variable's value means continuous integration: set, and not "false" or "0". */
export const isContinuousIntegration = (value: string | undefined): boolean => {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized !== "" && normalized !== "false" && normalized !== "0";
};

const inContinuousIntegration = isContinuousIntegration(process.env["CI"]);

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
