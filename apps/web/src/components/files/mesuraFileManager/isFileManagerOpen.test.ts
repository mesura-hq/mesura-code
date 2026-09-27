import { describe, expect, it, vi } from "vite-plus/test";

import {
  FILE_MANAGER_ROOT_ATTRIBUTE,
  focusFileManager,
  isFileManagerOpen,
} from "./isFileManagerOpen";

function page(roots: ReadonlyArray<string>): ParentNode {
  return {
    querySelector: (selector: string) => (roots.includes(selector) ? {} : null),
  } as unknown as ParentNode;
}

describe("isFileManagerOpen", () => {
  it("is true exactly while the layer's root is in the page", () => {
    expect(isFileManagerOpen(page([`[${FILE_MANAGER_ROOT_ATTRIBUTE}]`]))).toBe(true);
    expect(isFileManagerOpen(page(["[data-command-palette]"]))).toBe(false);
  });

  it("is false where there is no page at all", () => {
    expect(isFileManagerOpen(null)).toBe(false);
  });
});

describe("focusFileManager", () => {
  it("focuses the layer's root when it is up", () => {
    const focus = vi.fn();
    const withRoot = {
      querySelector: (selector: string) =>
        selector === `[${FILE_MANAGER_ROOT_ATTRIBUTE}]` ? { focus } : null,
    } as unknown as ParentNode;
    expect(focusFileManager(withRoot)).toBe(true);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("takes nothing when the layer is down, so the caller keeps its own target", () => {
    expect(focusFileManager(page([]))).toBe(false);
    expect(focusFileManager(null)).toBe(false);
  });
});
