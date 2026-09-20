import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("records measured fixture coverage and runtime results for laptop evaluation", () => {
  const report = readFileSync(
    new URL("../../../docs/file-tree-validation.md", import.meta.url),
    "utf8",
  );
  for (const topic of [
    "Small",
    "Medium",
    "Large",
    "Mesura",
    "cold",
    "cached",
    "mounted",
    "memory",
    "150",
    "1,000",
    "depth",
  ])
    expect(report).toContain(topic);
});
