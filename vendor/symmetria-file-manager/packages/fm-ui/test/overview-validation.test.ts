import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("records measured local cold, cached and update timings for three fixture sizes", () => {
  const report = readFileSync("../../docs/connected-overview-validation.md", "utf8");
  const block = /```json\n([\s\S]*?)\n```/.exec(report);
  if (!block?.[1]) throw new Error("Missing measured fixture data");
  const fixtures = JSON.parse(block[1]);
  expect(fixtures).toHaveLength(3);
  for (const fixture of fixtures) {
    for (const metric of [
      "entries",
      "coldRootMs",
      "fullScanMs",
      "cachedPaintMs",
      "createMs",
      "renameMs",
      "deleteMs",
      "mountedReading",
      "mountedFit",
    ])
      expect(fixture[metric], metric).toBeGreaterThanOrEqual(0);
  }
});
