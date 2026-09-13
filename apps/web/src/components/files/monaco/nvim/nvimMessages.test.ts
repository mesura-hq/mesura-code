import { describe, expect, it } from "vite-plus/test";

import { isErrorMessageKind } from "./nvimMessages.ts";

describe("isErrorMessageKind", () => {
  it("knows Neovim's own names for an error", () => {
    expect(isErrorMessageKind("emsg")).toBe(true);
    expect(isErrorMessageKind("echoerr")).toBe(true);
    expect(isErrorMessageKind("lua_error")).toBe(true);
  });

  it("leaves ordinary messages alone", () => {
    // The empty kind is the common one: `:set` reporting a value, a plugin
    // echoing. Painting those red would make the strip cry wolf all day.
    expect(isErrorMessageKind("")).toBe(false);
    expect(isErrorMessageKind("echo")).toBe(false);
    expect(isErrorMessageKind("wmsg")).toBe(false);
    expect(isErrorMessageKind("search_count")).toBe(false);
  });
});
