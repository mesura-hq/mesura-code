import { describe, expect, it } from "vite-plus/test";

import { useScratchpadStore } from "./scratchpadStore";

const reset = () =>
  useScratchpadStore.setState({
    phase: "closed",
    scope: null,
    openCount: 0,
    owner: null,
    reopen: null,
  });
const state = () => useScratchpadStore.getState();

describe("scratchpad open and close", () => {
  it("keeps a closing overlay mounted until the close settles", () => {
    reset();
    state().toggleScratchpad("view-a");
    expect(state()).toMatchObject({ phase: "open", openCount: 1, owner: "view-a" });
    state().toggleScratchpad("view-a");
    expect(state().phase).toBe("closing");
    state().finishClosing();
    expect(state()).toMatchObject({ phase: "closed", owner: null });
  });

  it("reopens with a fresh mount after a close that was still settling", () => {
    reset();
    state().openScratchpad("view-a", "general");
    state().closeScratchpad();
    state().openScratchpad("view-a", "thread");
    expect(state(), "reopened over the settling close").toMatchObject({ phase: "closing" });
    state().finishClosing();
    expect(state()).toMatchObject({ phase: "open", scope: "thread", openCount: 2, reopen: null });
  });

  it("drops a waiting reopen when the chord is pressed again", () => {
    reset();
    state().toggleScratchpad("view-a");
    state().toggleScratchpad("view-a");
    state().toggleScratchpad("view-a");
    state().toggleScratchpad("view-a");
    state().finishClosing();
    expect(state()).toMatchObject({ phase: "closed", openCount: 1 });
  });

  it("ends an open whose view went away, so the next view does not inherit it", () => {
    reset();
    state().toggleScratchpad("view-a");
    state().abandonScratchpad("view-b");
    expect(state().phase, "another view cannot end it").toBe("open");
    state().abandonScratchpad("view-a");
    expect(state()).toMatchObject({ phase: "closed", owner: null });
  });

  it("does not let another view's open replace the one on screen", () => {
    reset();
    state().openScratchpad("view-a", "project");
    state().openScratchpad("view-b", "general");
    expect(state()).toMatchObject({ owner: "view-a", scope: "project" });
  });

  it("drops a reopen whose view moved to another thread before the close settled", () => {
    reset();
    state().toggleScratchpad("view-a");
    state().closeScratchpad();
    state().openScratchpad("view-b", "general");
    state().dropReopenUnless("view-c");
    state().finishClosing();
    expect(state()).toMatchObject({ phase: "closed", owner: null });
  });
});
