import { describe, expect, it } from "vite-plus/test";

import { measureRestingComposerControls } from "./restingComposerControlsMeasurement";

/** A controls row whose model picker is capped by a max-width, with a label wider than the cap. */
function mountControls(pickerMaxWidth: string) {
  const controls = document.createElement("div");
  controls.style.cssText = "display:flex;width:300px;padding:0 10px;box-sizing:content-box";
  controls.innerHTML = `
    <button data-chat-provider-model-picker style="display:inline-flex;max-width:${pickerMaxWidth};white-space:nowrap">
      <span data-chat-provider-model-picker-label="true" style="min-width:0;overflow:hidden;text-overflow:ellipsis">${"Long model name ".repeat(12)}</span>
    </button>`;
  document.body.append(controls);
  return { controls, [Symbol.dispose]: () => controls.remove() };
}

describe("resting composer controls measurement", () => {
  it("resolves a percentage max-width against the row, not as pixels", () => {
    using row = mountControls("100%");
    const measurement = measureRestingComposerControls(row.controls);
    // The cap is the row's 300 px content width; reading "100%" as 100 px under-reports it.
    expect(measurement?.naturalFixedWidth).toBeCloseTo(300, 0);
  });

  it("keeps a pixel max-width as the cap", () => {
    using row = mountControls("120px");
    expect(measureRestingComposerControls(row.controls)?.naturalFixedWidth).toBeCloseTo(120, 0);
  });
});
