import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The virtualiser's scroll authority, pinned as source.
 *
 * A source assertion rather than a behavioural one, because the defect it
 * guards cannot be reproduced in a headless DOM: `happy-dom` has no scrolling,
 * so the race this forbids is invisible there and a component test would pass
 * either way. It was found in real Chromium and the reasoning is recorded in a
 * comment above the code — this makes that comment enforceable.
 *
 * **It lives here and not beside the pointer tests on purpose.** The renderer
 * test context compiles with the DOM and no Node, so a test that reads a file
 * cannot live there; `app/test/*.ts` is the Node-side context, which is also
 * where `theme.test.ts` reads the stylesheets from.
 */

const FILE_LIST = join(import.meta.dirname, "..", "src", "components", "FileList.tsx");

/** The source with its comments removed. */
async function code(): Promise<string> {
  const text = await readFile(FILE_LIST, "utf8");
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("the cursor-following effect", () => {
  it("asks the browser to scroll rather than setting the offset itself", async () => {
    expect(await code()).toContain("scrollIntoView");
  });

  it("never calls scrollToIndex", async () => {
    // A programmatic `scrollToIndex` races the virtualiser's own scroll
    // listener. Under a burst of held-key navigation the container ended up
    // scrolled near the bottom while the virtualiser still believed the offset
    // was zero, so it rendered the rows at the TOP, the cursor row was not
    // among them, and the highlight vanished permanently.
    //
    // Comments are stripped above because the source deliberately NAMES
    // `scrollToIndex` in the comment forbidding it, and matching that text
    // would make this guard fail for the very words that explain it.
    expect(await code()).not.toContain("scrollToIndex");
  });
});
