// @effect-diagnostics nodeBuiltinImport:off - reads the marker stylesheet off the checkout; no DOM test environment applies CSS.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

/**
 * Phase 4 of the STT redesign, criterion 4, the half a DOM test cannot see: the marker's wave
 * is stepped, travels left to right, and holds still under reduced motion. The chip that uses
 * these classes is mounted through the app in `AppRoot.dictation.fence.test.tsx`.
 */
const stylesheet = NodeURL.fileURLToPath(new URL("./dictationSlot.css", import.meta.url));

describe("the dictation marker stylesheet", () => {
  it("dictation phase 4 AC4 stylesheet: six bars run one stepped 0.96 s cycle left to right and stop under reduced motion", () => {
    const css = NodeFS.readFileSync(stylesheet, "utf8");
    const barRule = /\.dictation-slot-wave\s*>\s*span\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(barRule).toMatch(/animation:[^;]*0\.96s[^;]*steps\(/);
    const delays = [1, 2, 3, 4, 5, 6].map((child) => {
      const rule = new RegExp(
        String.raw`\.dictation-slot-wave\s*>\s*span:nth-child\(${child}\)\s*\{[^}]*animation-delay:\s*(-?[\d.]+)s`,
      ).exec(css);
      return rule ? Number(rule[1]) : Number.NaN;
    });
    expect(delays).toEqual([-0.96, -0.8, -0.64, -0.48, -0.32, -0.16]);
    const reduced = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(css);
    expect(reduced?.[1]).toMatch(/\.dictation-slot-wave\s*>\s*span[\s\S]*animation:\s*none/);
  });
});
