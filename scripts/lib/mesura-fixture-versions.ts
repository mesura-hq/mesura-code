import { expect } from "vite-plus/test";

/** Keep the fixture's reviewed minimum while accepting upstream dependency upgrades. */
export function expectFixtureVersionFloor(
  version: string,
  minimum: readonly [number, number, number],
) {
  const actual = version.split(".").map(Number);
  expect(actual).toHaveLength(3);
  expect(actual.every(Number.isSafeInteger)).toBe(true);
  const difference = actual.findIndex((part, index) => part !== minimum[index]);
  if (difference !== -1) expect(actual[difference]).toBeGreaterThan(minimum[difference]!);
}
