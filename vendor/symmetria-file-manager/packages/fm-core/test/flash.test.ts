import { expect, it } from "vitest";
import { computeFlash, flashTransition } from "../src/flash.ts";

it("assigns reachable labels beyond single-character capacity", () => {
  const targets = Array.from({ length: 80 }, (_, index) => ({
    path: `/root/a-${index}`,
    name: `a-${index}`,
  }));
  const result = computeFlash("a", targets);
  expect(result.matches).toHaveLength(targets.length);
  const labels = result.matches.map((match) => match.label);
  expect(labels.every((label) => label.length > 0)).toBe(true);
  expect(new Set(labels).size).toBe(targets.length);
  for (const label of labels) {
    expect(result.continuations.has(label[0] ?? "")).toBe(false);
    expect(labels.some((other) => other !== label && other.startsWith(label))).toBe(false);
  }
});

it("excludes query characters and continuations after every occurrence", () => {
  const result = computeFlash("a", [{ path: "/abacada", name: "abacada" }]);
  expect([...result.continuations].sort()).toEqual(["a", "b", "c", "d"]);
  expect(result.matches[0]?.label).toBe("s");
  expect(computeFlash("a", [{ path: "/abacada", name: "abacada" }])).toEqual(result);
});
it.each([0, 1, 2])("allocates all targets or none with a pool of %i characters", (remaining) => {
  const alphabet = "asdfghjklqwertyuiopzxcvbnm";
  const blocked = alphabet.slice(0, alphabet.length - remaining);
  const name = [...blocked].map((character) => `!${character}`).join("");
  const result = computeFlash(
    "!",
    Array.from({ length: 9 }, (_, index) => ({ path: `/${index}`, name })),
  );
  expect(result.matches).toHaveLength(9);
  expect(result.needsRefinement).toBe(remaining < 2);
  const labels = result.matches.map((match) => match.label);
  if (remaining < 2) expect(labels.every((label) => label === "")).toBe(true);
  else {
    expect(new Set(labels).size).toBe(9);
    expect(labels.every((label) => label.length === 4)).toBe(true);
  }
});
it("matches literal leading and internal spaces consistently", () => {
  const targets = ["a foo", "bar", " foo"].map((name) => ({ path: `/${name}`, name }));
  expect(computeFlash("a ", targets).matches.map((match) => match.name)).toEqual(["a foo"]);
  const result = computeFlash(" ", targets);
  expect(result.matches.map((match) => match.name)).toEqual(["a foo", " foo"]);
  expect(flashTransition(" ", "", "f", result)).toEqual({ kind: "query", query: " f" });
});
it("resolves every overflow label and removes pending prefixes before query text", () => {
  const result = computeFlash(
    "a",
    Array.from({ length: 80 }, (_, index) => ({ path: `/${index}`, name: `a-${index}` })),
  );
  for (const match of result.matches) {
    const prefix = match.label.slice(0, -1);
    expect(flashTransition("a", "", prefix, result)).toEqual({ kind: "prefix", prefix });
    expect(flashTransition("a", prefix, match.label.at(-1) ?? "", result)).toEqual({
      kind: "select",
      path: match.path,
    });
  }
  expect(flashTransition("a", "s", "Backspace", result)).toEqual({ kind: "prefix", prefix: "" });
  expect(flashTransition("a", "", "Backspace", result)).toEqual({ kind: "query", query: "" });
  expect(flashTransition("", "", "Backspace", result)).toEqual({ kind: "cancel" });
  expect(flashTransition("a", "s", "!", result)).toEqual({ kind: "prefix", prefix: "" });
  expect(flashTransition("a", "", "Escape", result)).toEqual({ kind: "cancel" });
});
