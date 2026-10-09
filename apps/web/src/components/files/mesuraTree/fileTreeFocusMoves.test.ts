// @vitest-environment happy-dom
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { registerFocusTarget } from "~/lib/focusTargets";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import { leaveFileTree, runFileTreeToggle } from "./fileTreeFocusMoves";
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

describe("runFileTreeToggle on a hidden panel", () => {
  const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("focus-moves-thread"));

  it("restores a file tab opened without the explorer with its explorer shown", () => {
    useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
    const panels = useRightPanelStore.getState();
    panels.open(ref, "diff");
    panels.openFile(ref, "src/edited.ts", undefined, { explorerHidden: true });
    panels.close(ref);

    runFileTreeToggle(ref);

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
    expect(state.isOpen).toBe(true);
    expect(state.activeSurfaceId).toBe("file:src/edited.ts");
    expect(
      state.surfaces.find((surface) => surface.id === "file:src/edited.ts"),
    ).not.toHaveProperty("explorerHidden");
    expect(useFileTreeStore.getState().explorerOpen).toBe(true);
  });
});
