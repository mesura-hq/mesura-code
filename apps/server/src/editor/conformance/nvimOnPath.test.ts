// Entry point: `isContinuousIntegration`, the decision between failing and
// skipping when a conformance harness finds no Neovim.
import { describe, expect, it } from "@effect/vitest";

import { isContinuousIntegration } from "./nvimOnPath.ts";

describe("a missing Neovim in continuous integration", () => {
  it("counts the values CI providers set as continuous integration", () => {
    for (const value of ["true", "1", "TRUE", " true ", "yes"]) {
      expect(isContinuousIntegration(value)).toBe(true);
    }
  });

  it("counts an absent, empty or switched-off CI variable as a local run", () => {
    for (const value of [undefined, "", "  ", "false", "False", "0"]) {
      expect(isContinuousIntegration(value)).toBe(false);
    }
  });
});
