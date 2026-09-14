// @effect-diagnostics nodeBuiltinImport:off - reads a vendored stylesheet off the checkout, outside any Effect
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

/**
 * `fileManager.css` imports the file manager's whole stylesheet. In the
 * standalone that sheet also sized and un-scrolled the window's `html`,
 * `body` and `#root`, and styled every `kbd` and every scrollbar; loaded here
 * those rules restyled the host, and the body losing its scroll is the kind
 * of defect no test of the layer sees. The window rules live in the
 * standalone's own `window.css` now and `kbd` is scoped to the interface's
 * roots; this test is what notices a vendor sync bringing any of it back.
 */
const stylesheet = NodeURL.fileURLToPath(
  new URL(
    "../../../../../../vendor/symmetria-file-manager/packages/fm-ui/src/styles.css",
    import.meta.url,
  ),
);

describe("the vendored file manager stylesheet", () => {
  it("styles no element of the page outside the file manager", () => {
    const source = NodeFS.readFileSync(stylesheet, "utf8");
    // A rule starts at column zero. One that starts with an element name, an
    // id, or a bare pseudo-element reaches the page; a class, an attribute,
    // `:is(…)` over classes, `*` and at-rules do not. The scrollbar's six
    // global rules are the one allowance: the file manager keeps them global
    // by design, and `fileManager.css` points their tokens at the host's own
    // values so they paint the host's scrollbars exactly as before.
    const unscoped = source
      .split("\n")
      .filter((line) => /^[a-zA-Z#]|^::/.test(line) && !line.startsWith("::-webkit-scrollbar"));
    expect(unscoped).toEqual([]);
  });
});
