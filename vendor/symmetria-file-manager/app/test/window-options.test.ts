import { describe, expect, it } from "vitest";

import { buildWindowOptions, WINDOW_BACKGROUND } from "../src/main/window.ts";

// Acceptance criteria 2 and 4 of phase 2. `buildWindowOptions` is a pure
// function precisely so these can be asserted without launching Electron: it
// imports Electron's types but nothing from Electron at runtime.
describe("buildWindowOptions", () => {
  it("locks the renderer down: sandboxed, isolated, no Node", () => {
    const { webPreferences } = buildWindowOptions();

    expect(webPreferences?.sandbox).toBe(true);
    expect(webPreferences?.contextIsolation).toBe(true);
    expect(webPreferences?.nodeIntegration).toBe(false);
  });

  it("never enables the escape hatches that would undo the sandbox", () => {
    const { webPreferences } = buildWindowOptions();

    // `nodeIntegrationInSubFrames` and `webSecurity` are the two settings that
    // quietly reopen what `sandbox: true` closed. Assert them explicitly rather
    // than trusting the default, because a future edit that sets one would
    // otherwise pass every other test here.
    expect(webPreferences?.nodeIntegrationInSubFrames ?? false).toBe(false);
    expect(webPreferences?.webSecurity ?? true).toBe(true);
  });

  it("points at a preload script", () => {
    const { webPreferences } = buildWindowOptions();

    expect(webPreferences?.preload).toBeTypeOf("string");
    expect(webPreferences?.preload).not.toBe("");
  });

  it("stays hidden until it has painted, over a non-white background", () => {
    const options = buildWindowOptions();

    // `show: false` plus a `ready-to-show` handler is what avoids a white
    // flash on open. The background colour is the second half: without it the
    // first paint is white even when the window is shown late.
    expect(options.show).toBe(false);
    expect(options.backgroundColor).toBe(WINDOW_BACKGROUND);
    expect(WINDOW_BACKGROUND).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("the PDF viewer", () => {
  it("enables plugins, which is the only thing that turns it on", () => {
    // Verification found the document preview producing a correct-looking
    // `<embed type="application/pdf">` whose child frame was actually
    // `chrome-error://chromewebdata`. The flag defaults to false, the DOM hides
    // the failure, and nothing reaches the console — only the frame tree shows
    // it. The name is a leftover: NPAPI and PPAPI are long gone, so the PDF
    // viewer is the only thing this admits.
    expect(buildWindowOptions().webPreferences?.plugins).toBe(true);
  });

  it("does not let the plugin flag weaken anything else", () => {
    const { webPreferences } = buildWindowOptions();

    expect(webPreferences?.sandbox).toBe(true);
    expect(webPreferences?.contextIsolation).toBe(true);
    expect(webPreferences?.nodeIntegration).toBe(false);
    expect(webPreferences?.webSecurity).toBe(true);
  });
});
