import { describe, expect, it } from "vite-plus/test";

import { useScratchpadStore } from "./scratchpadStore";

const reset = () =>
  useScratchpadStore.setState({ phase: "closed", scope: null, openCount: 0, reopen: null });
const state = () => useScratchpadStore.getState();

describe("scratchpad open and close", () => {
  it("keeps a closing overlay mounted until the close settles", () => {
    reset();
    state().toggleScratchpad();
    expect(state()).toMatchObject({ phase: "open", openCount: 1 });
    state().toggleScratchpad();
    expect(state().phase).toBe("closing");
    state().finishClosing();
    expect(state().phase).toBe("closed");
  });

  it("reopens with a fresh mount after a close that was still settling", () => {
    reset();
    state().openScratchpad("general");
    state().closeScratchpad();
    state().openScratchpad("thread");
    expect(state(), "reopened over the settling close").toMatchObject({ phase: "closing" });
    state().finishClosing();
    expect(state()).toMatchObject({ phase: "open", scope: "thread", openCount: 2, reopen: null });
  });

  it("drops a waiting reopen when the chord is pressed again", () => {
    reset();
    state().toggleScratchpad();
    state().toggleScratchpad();
    state().toggleScratchpad();
    state().toggleScratchpad();
    state().finishClosing();
    expect(state()).toMatchObject({ phase: "closed", openCount: 1 });
  });
});
