// @effect-diagnostics nodeBuiltinImport:off - reads the app's stylesheet off the checkout, outside any Effect.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

describe("cite flash stylesheet", () => {
  const stylesheet = NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "../../mesura.css"),
    "utf8",
  );

  it("cite flash guard: every cite flash runs the one 900 ms opacity animation", () => {
    expect(stylesheet).toMatch(
      /\[data-mesura-cite-flash\] \{[^}]*animation: mesura-cite-flash 900ms ease-out forwards;/,
    );
    const keyframes = /@keyframes mesura-cite-flash \{([\s\S]*?)\n\}/.exec(stylesheet)?.[1] ?? "";
    expect(keyframes).toContain("opacity");
    expect(keyframes.replace(/opacity|[\d.%{}:;\s]/g, "")).toBe("");
  });

  it("cite flash guard: under prefers-reduced-motion no cite flash animates", () => {
    const reduced = [
      ...stylesheet.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g),
    ].map((match) => match[1]);
    expect(
      reduced.some((block) => /\[data-mesura-cite-flash\] \{\s*animation: none;\s*\}/.test(block!)),
      "a reduced-motion block sets the cite flash's animation to none",
    ).toBe(true);
  });
});
