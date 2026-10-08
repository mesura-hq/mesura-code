import { describe, expect, it } from "vite-plus/test";

import { borderMoveDelta, paneEdgeStep } from "./paneEdges";
import { resizeEdgeFor } from "../keys/paneMode";

describe("paneEdgeStep", () => {
  it("is 5% of the viewport along the edge's axis", () => {
    const viewport = { width: 1920, height: 1080 };
    expect(paneEdgeStep("left", viewport)).toBe(96);
    expect(paneEdgeStep("right", viewport)).toBe(96);
    expect(paneEdgeStep("top", viewport)).toBe(54);
  });
});

describe("borderMoveDelta (arrow keys on a focused separator)", () => {
  it("moves the border with the arrow, whichever side of its panel it is on", () => {
    // The sidebar's border is on its right: moving it right widens the sidebar.
    expect(borderMoveDelta("right", "right", 10)).toBe(10);
    expect(borderMoveDelta("right", "left", 10)).toBe(-10);
    // The right panel's border is on its left: moving it right narrows the panel.
    expect(borderMoveDelta("left", "right", 10)).toBe(-10);
    expect(borderMoveDelta("left", "left", 10)).toBe(10);
    // The terminal drawer's border is on its top: moving it up makes it taller.
    expect(borderMoveDelta("top", "up", 10)).toBe(10);
    expect(borderMoveDelta("top", "down", 10)).toBe(-10);
  });

  it("ignores the arrows across the edge's axis", () => {
    expect(borderMoveDelta("left", "up", 10)).toBeNull();
    expect(borderMoveDelta("top", "left", 10)).toBeNull();
  });
});

describe("resizeEdgeFor (PANE mode: the focused pane picks the border, the key moves it)", () => {
  it("moves each side pane's own border", () => {
    expect(resizeEdgeFor("sidebar", "right")).toBe("sidebar");
    expect(resizeEdgeFor("panel", "left")).toBe("right-panel");
    expect(resizeEdgeFor("panel", "right")).toBe("right-panel");
  });

  it("moves the sidebar's border from the chat when no panel is open", () => {
    expect(resizeEdgeFor("chat", "right")).toBe("sidebar");
  });

  it("moves the terminal drawer's border vertically, from the chat column only", () => {
    expect(resizeEdgeFor("chat", "up")).toBe("terminal-drawer");
    expect(resizeEdgeFor("terminal", "down")).toBe("terminal-drawer");
    expect(resizeEdgeFor("sidebar", "up")).toBeNull();
    expect(resizeEdgeFor("panel", "down")).toBeNull();
  });
});

describe("PANE mode on the right panel", () => {
  // Regression: the first build grew the focused pane, so `l` on the right
  // panel moved its border left. The border must follow the key.
  it("narrows the panel on l and widens it on h", () => {
    expect(borderMoveDelta("left", "right", 10)).toBe(-10);
    expect(borderMoveDelta("left", "left", 10)).toBe(10);
  });
});
