import { afterEach, describe, expect, it } from "vite-plus/test";

import { registerFocusTarget } from "~/lib/focusTargets";

import { leaveFileTree } from "./fileTreeFocusMoves";
import { useFileTreeStore } from "./fileTreeStore";

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  useFileTreeStore.getState().setExplorerOpen(true);
  useFileTreeStore.getState().clearPendingFocus();
});

describe("leaveFileTree", () => {
  it("hides the tree only after an editor took focus", () => {
    let editorFocused = 0;
    disposers.push(
      registerFocusTarget("editor", () => {
        editorFocused += 1;
        return true;
      }),
    );
    leaveFileTree();
    expect(editorFocused).toBe(1);
    expect(useFileTreeStore.getState().explorerOpen).toBe(false);
  });

  it("falls back to the composer and keeps the tree when no editor is mounted", () => {
    let composerFocused = 0;
    disposers.push(
      registerFocusTarget("composer", () => {
        composerFocused += 1;
        return true;
      }),
    );
    leaveFileTree();
    expect(composerFocused).toBe(1);
    expect(useFileTreeStore.getState().explorerOpen).toBe(true);
  });

  it("drops a pending focus request on the way out", () => {
    useFileTreeStore.getState().requestFocus();
    leaveFileTree();
    expect(useFileTreeStore.getState().consumePendingFocus()).toBe(false);
  });
});
