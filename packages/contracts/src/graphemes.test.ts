import { afterEach, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("contracts load and validate monograms when Hermes has no Intl.Segmenter", async () => {
  vi.stubGlobal("Intl", Object.create(Intl, { Segmenter: { value: undefined } }));
  vi.resetModules();
  const contracts = await import("./index.ts");
  const accepts = Schema.is(contracts.ProjectMonogramText);
  expect(accepts("e\u0301A")).toBe(true);
  expect(accepts("e\u0301AB")).toBe(false);
  expect(accepts("क्‍षA")).toBe(true);
  expect(accepts("क्‍षAB")).toBe(false);
  // Emoji remain valid icon overrides, not letter/number monograms.
  expect(accepts("👩🏽‍💻")).toBe(false);
  const acceptsIcon = Schema.is(contracts.ProjectIconOverride);
  expect(acceptsIcon({ kind: "emoji", emoji: "👩🏽‍💻" })).toBe(true);
});

it.each(["native", "without Segmenter"])(
  "contracts count complete graphemes with %s segmentation",
  async (runtime) => {
    if (runtime === "without Segmenter") {
      vi.stubGlobal("Intl", Object.create(Intl, { Segmenter: { value: undefined } }));
    }
    vi.resetModules();
    const { countGraphemes } = await import("./graphemes.ts");
    for (const [text, expected] of [
      ["", 0],
      ["AB", 2],
      ["ABC", 3],
      ["e\u0301", 1],
      ["e\u0301o\u0308A", 3],
      ["👩🏽‍💻", 1],
      ["👨‍👩‍👧‍👦", 1],
      ["👍🏿👍🏻", 2],
      ["🇦🇷🇯🇵", 2],
      ["1️⃣", 1],
      ["क्‍ष", 1],
      ["한", 1],
      ["👩🏽‍💻A👍🏿", 3],
    ] as const) {
      expect(countGraphemes(text), text).toBe(expected);
    }
    const { ProjectMonogramText } = await import("./orchestration.ts");
    const accepts = Schema.is(ProjectMonogramText);
    expect(accepts("A" + "\u0301".repeat(31))).toBe(true);
    expect(accepts("A" + "\u0301".repeat(32))).toBe(false);
    expect(accepts("AB")).toBe(true);
    expect(accepts("ABC")).toBe(false);
    expect(accepts("A B")).toBe(false);
  },
);
