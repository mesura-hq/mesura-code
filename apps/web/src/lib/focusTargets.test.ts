import { describe, expect, it } from "vite-plus/test";

import { focusTarget, registerFocusTarget } from "./focusTargets";

describe("focus targets", () => {
  it("reports false when nothing is registered or the target had nothing to focus", () => {
    expect(focusTarget("editor")).toBe(false);
    const unregister = registerFocusTarget("editor", () => false);
    expect(focusTarget("editor")).toBe(false);
    unregister();
  });

  it("reports true once a target lands focus", () => {
    const unregister = registerFocusTarget("editor", () => true);
    expect(focusTarget("editor")).toBe(true);
    unregister();
    expect(focusTarget("editor")).toBe(false);
  });

  it("lets a stale disposer leave a newer registration alone", () => {
    const first = registerFocusTarget("tree", () => false);
    const second = registerFocusTarget("tree", () => true);
    first();
    expect(focusTarget("tree")).toBe(true);
    second();
    expect(focusTarget("tree")).toBe(false);
  });
});
