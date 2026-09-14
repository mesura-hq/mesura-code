import { describe, expect, it } from "vite-plus/test";

import {
  decideFileTreeShortcut,
  decideOverviewShortcut,
  type FileTreeShortcutInput,
} from "./fileTreeShortcutDecision";

const base: FileTreeShortcutInput = {
  hasThread: true,
  surfaceKind: "file",
  explorerOpen: true,
  treeFocused: false,
};

describe("decideFileTreeShortcut", () => {
  it("does nothing without a thread", () => {
    expect(decideFileTreeShortcut({ ...base, hasThread: false })).toBe("none");
  });

  it("opens the files surface when another surface, or none, is active", () => {
    expect(decideFileTreeShortcut({ ...base, surfaceKind: null })).toBe("open-surface");
    expect(decideFileTreeShortcut({ ...base, surfaceKind: "diff" })).toBe("open-surface");
    expect(decideFileTreeShortcut({ ...base, surfaceKind: "terminal" })).toBe("open-surface");
  });

  it("shows and focuses the tree when the files surface is up but the tree is hidden or unfocused", () => {
    expect(decideFileTreeShortcut({ ...base, explorerOpen: false })).toBe("show-and-focus");
    expect(decideFileTreeShortcut({ ...base, surfaceKind: "files" })).toBe("show-and-focus");
  });

  it("hides the tree and focuses the editor when the tree is focused beside an open file", () => {
    expect(decideFileTreeShortcut({ ...base, treeFocused: true })).toBe("hide-and-focus-editor");
  });

  it("focuses the composer when the tree is focused and only the tree is shown", () => {
    expect(decideFileTreeShortcut({ ...base, surfaceKind: "files", treeFocused: true })).toBe(
      "focus-composer",
    );
  });
});

describe("decideOverviewShortcut", () => {
  it("does nothing without a thread", () => {
    expect(
      decideOverviewShortcut({ hasThread: false, surfaceKind: null, overviewOpen: false }),
    ).toBe("none");
  });

  it("closes an open overview from any surface", () => {
    expect(
      decideOverviewShortcut({ hasThread: true, surfaceKind: "preview", overviewOpen: true }),
    ).toBe("close");
  });

  it("opens the files surface first when another surface is up", () => {
    expect(
      decideOverviewShortcut({ hasThread: true, surfaceKind: null, overviewOpen: false }),
    ).toBe("open-surface-and-overview");
    expect(
      decideOverviewShortcut({ hasThread: true, surfaceKind: "preview", overviewOpen: false }),
    ).toBe("open-surface-and-overview");
  });

  it("opens the overview over an open file or files surface", () => {
    expect(
      decideOverviewShortcut({ hasThread: true, surfaceKind: "file", overviewOpen: false }),
    ).toBe("open");
    expect(
      decideOverviewShortcut({ hasThread: true, surfaceKind: "files", overviewOpen: false }),
    ).toBe("open");
  });
});
