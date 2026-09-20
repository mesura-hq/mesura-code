import { describe, expect, it } from "vite-plus/test";

import { FILE_MANAGER_ROOT_ATTRIBUTE, isFileManagerOpen } from "./isFileManagerOpen";

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
