import { compileKeymap } from "@mesura/keys/keymap";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_KEYMAP } from "./defaultKeymap";

describe("default modal keymap", () => {
  it("compiles the default modal keymap without a conflict", () => {
    expect(compileKeymap(DEFAULT_KEYMAP).conflicts).toEqual([]);
  });
});
