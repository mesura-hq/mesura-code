// @effect-diagnostics nodeBuiltinImport:off - reads a vendored stylesheet off the checkout, outside any Effect
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

/**
 * `fileManager.css` imports the file manager's whole stylesheet, so any unscoped rule
 * in it restyles the host (the body once lost its scroll). The standalone's window
 * rules live in its own `window.css`; this test notices a vendor sync bringing one back.
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
    // A column-zero rule starting with an element name, an id or a bare
    // pseudo-element reaches the page. The global scrollbar rules are allowed:
    // `fileManager.css` points their tokens at the host's own values.
    const unscoped = source
      .split("\n")
      .filter((line) => /^[a-zA-Z#]|^::/.test(line) && !line.startsWith("::-webkit-scrollbar"));
    expect(unscoped).toEqual([]);
  });
});
