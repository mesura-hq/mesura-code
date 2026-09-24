// @effect-diagnostics nodeBuiltinImport:off - reads repository files as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { repositoryRoot } from "./contractHarness.ts";

/**
 * A fork component that styles itself through a class or a data attribute has no
 * compiler and no test to tell it the rule went away. CSS answers a missing rule
 * with silence, so the element renders unstyled and every suite stays green.
 *
 * This happened during the 2026-W35 sync. Upstream moved the composer's glass
 * into `ComposerSurface` and deleted the 548-line block that had held it in
 * `index.css`. Every class in that block was upstream's and genuinely superseded
 * — except `.mesura-dictation-strip`, which is this fork's. Taking the deletion
 * whole left `DictationStrip.tsx` still setting the class and its `data-phase`
 * and `data-dictation-mode-control` hooks with nothing driving them: the strip
 * lost its surface and the delivery pulse never fired.
 *
 * The strip's surface now comes from upstream's `ComposerBanner` primitives;
 * what remains in `mesura.css` — which upstream never touches — is the
 * confirmation pulse, and that is what these hooks feed. What this guards is
 * the other direction from the W35 deletion — that the hooks a fork component
 * sets still have somewhere to land.
 */

const read = (relativePath: string) =>
  NodeFS.readFileSync(NodePath.join(repositoryRoot, relativePath), "utf8");

// Each entry: a fork component, and the styling hooks it sets that the fork's
// own stylesheet has to answer. Named individually rather than scraped, so a
// hook removed from the component fails here instead of passing vacuously.
const STYLED_FORK_COMPONENTS = [
  {
    component: "apps/web/src/symmetria/DictationStrip.tsx",
    stylesheet: "apps/web/src/mesura.css",
    hooks: ["mesura-dictation-strip", "data-phase", "data-dictation-mode-control"],
  },
  // AccountLimitsPanel is deliberately absent. It still sets
  // `data-usage-limits-panel`, but that attribute stopped being a styling hook
  // when the panel became a band inside the sidebar: the rule it fed existed to
  // strip upstream's popover glass, and it went with the popover. The attribute
  // is kept as a stable selector for browser checks, so it has nothing to land
  // on by design. Listing it here asserts the opposite and fails.
] as const;

for (const entry of STYLED_FORK_COMPONENTS) {
  it(`styles every hook ${entry.component} sets`, () => {
    const component = read(entry.component);
    const stylesheet = read(entry.stylesheet);
    for (const hook of entry.hooks) {
      assert.include(
        component,
        hook,
        `${entry.component} no longer sets "${hook}" — either the component changed or this guard is stale`,
      );
      assert.include(
        stylesheet,
        hook,
        `${entry.stylesheet} has no rule for "${hook}", which ${entry.component} still sets, so that element renders unstyled and nothing fails`,
      );
    }
  });
}

it("stacks the dictation strip inside the composer's banner column", () => {
  // Inside ComposerBanner.Column the strip joins the attached-banner stack and
  // the Dock's side tabs (Stash) sit beside it. Mounted above the form instead,
  // it fused onto the Dock and left the Stash tab hanging below it as a step.
  assert.match(
    read("apps/web/src/components/chat/ChatComposer.tsx"),
    /\{dictationStrip\}\s*<\/ComposerBanner\.Column>/,
    "ChatComposer no longer renders dictationStrip as the last child of ComposerBanner.Column",
  );
  const chatView = read("apps/web/src/components/ChatView.tsx");
  assert.match(
    chatView,
    /dictationStrip=\{dictationStrip\}/,
    "ChatView no longer hands the dictation strip to ChatComposer",
  );
  assert.equal(
    chatView.match(/<DictationStrip\b/g)?.length,
    1,
    "DictationStrip must mount exactly once, through ChatComposer",
  );
});

it("keeps the fork's stylesheet loaded after upstream's", () => {
  // Unlayered rules in mesura.css outrank upstream's layered ones whatever the
  // specificity, but only while the file is actually imported.
  assert.include(
    read("apps/web/src/main.tsx"),
    './mesura.css"',
    "mesura.css is no longer imported, so every fork style override is inert",
  );
});
