import { expect, it } from "vitest";
import { matchKey } from "../src/keys/keyEvent.ts";
import { bindingsFor } from "../src/keys/registry.ts";

const plain = { ctrl: false, alt: false, meta: false, shift: false };
it("reserves Alt+M for the overview without accepting other modifiers", () => {
  const binding = bindingsFor("overview").find((row) => row.id === "overview.toggle-minimap");
  expect(binding).toBeDefined();
  if (!binding) throw new Error("missing minimap binding");
  expect(matchKey(binding, { ...plain, key: "m", alt: true })).toBe(true);
  for (const modifiers of [
    plain,
    { ...plain, alt: true, ctrl: true },
    { ...plain, alt: true, shift: true },
    { ...plain, meta: true },
  ]) {
    expect(matchKey(binding, { ...modifiers, key: "m" })).toBe(false);
  }
  expect(bindingsFor("miller").some((row) => row.id === binding.id)).toBe(false);
});
it("accepts generated symbols but rejects deliberate Ctrl and Meta combinations", () => {
  for (const key of ["/", "?", "+", "=", "-"]) {
    const binding = bindingsFor("overview").find((row) => row.keys.includes(key));
    if (!binding) throw new Error(`Missing overview key ${key}`);
    expect(matchKey(binding, { ...plain, key, shift: true })).toBe(true);
    expect(matchKey(binding, { ...plain, key, ctrl: true, alt: true, altGraph: true })).toBe(true);
    expect(matchKey(binding, { ...plain, key, ctrl: true })).toBe(false);
    expect(matchKey(binding, { ...plain, key, meta: true })).toBe(false);
  }
});
it("separates every direction from half and full camera commands", () => {
  for (const [key, direction] of [
    ["h", "left"],
    ["j", "down"],
    ["k", "up"],
    ["l", "right"],
    ["ArrowLeft", "left"],
    ["ArrowDown", "down"],
    ["ArrowUp", "up"],
    ["ArrowRight", "right"],
  ]) {
    if (!key) throw new Error("missing key");
    for (const [ctrl, shift, prefix] of [
      [false, false, ""],
      [true, false, "half-"],
      [true, true, "full-"],
    ] as const) {
      expect(
        bindingsFor("overview")
          .filter((binding) => matchKey(binding, { ...plain, key, ctrl, shift }))
          .map((binding) => binding.id),
      ).toEqual([`overview.${prefix}${direction}`]);
    }
  }
});

it("names Space and directional aliases in help", () => {
  const rows = bindingsFor("overview");
  expect(rows.find((row) => row.id === "overview.toggle")?.keycap).toBe("Space");
  expect(rows.find((row) => row.id === "overview.left")?.keycap).toBe("h / ←");
});

it("maps Ctrl+D and Ctrl+U to the existing half-viewport commands", () => {
  for (const [key, direction] of [
    ["d", "down"],
    ["u", "up"],
  ] as const) {
    const matches = bindingsFor("overview").filter((binding) =>
      matchKey(binding, { ...plain, key, ctrl: true }),
    );
    expect(matches.map((binding) => binding.id)).toEqual([`overview.half-${direction}`]);
    expect(matches[0]?.keycap).toContain(key);
    expect(
      bindingsFor("overview").some((binding) =>
        matchKey(binding, { ...plain, key, ctrl: true, shift: true }),
      ),
    ).toBe(false);
  }
});
