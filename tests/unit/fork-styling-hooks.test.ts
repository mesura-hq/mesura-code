// @effect-diagnostics nodeBuiltinImport:off - reads repository files as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { repositoryRoot } from "./contractHarness.ts";

/**
 * CSS answers a missing rule with silence, so a fork class or data attribute whose rule went away
 * renders unstyled with every suite green; a sync once deleted `.mesura-dictation-strip` with
 * upstream's glass block. This guards that the hooks a fork component sets still land in a rule.
 */

const read = (relativePath: string) =>
  NodeFS.readFileSync(NodePath.join(repositoryRoot, relativePath), "utf8");

// Each entry: a fork component, and the styling hooks it sets that the fork's
// own stylesheet has to answer. Named individually rather than scraped, so a
// hook removed from the component fails here instead of passing vacuously.
const STYLED_FORK_COMPONENTS: ReadonlyArray<{
  readonly component: string;
  readonly stylesheet: string;
  readonly hooks: ReadonlyArray<string>;
}> = [
  // Deliberately absent, because their hooks now feed no rule and stay only as stable selectors for
  // tests and browser checks: DictationStripBanner (its pulse went with the Symmetria Shell link) and
  // AccountLimitsPanel (`data-usage-limits-panel` fed a rule that went with the popover).
  // Listing either here asserts the opposite and fails.
];

it.each(STYLED_FORK_COMPONENTS)("styles every hook $component sets", (entry) => {
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

it("stacks the dictation strip inside the composer's banner column", () => {
  // Inside ComposerBanner.Column the strip joins the attached-banner stack and
  // the Dock's side tabs (Stash) sit beside it. Mounted above the form instead,
  // it fused onto the Dock and left the Stash tab hanging below it as a step.
  const composer = read("apps/web/src/components/chat/ChatComposer.tsx");
  assert.match(
    composer,
    /\{dictationStrip\}\s*<\/ComposerBanner\.Column>/,
    "ChatComposer no longer renders dictationStrip as the last child of ComposerBanner.Column",
  );
  const chatView = read("apps/web/src/components/ChatView.tsx");
  assert.match(
    chatView,
    /<ChatComposer\b[\s\S]*?dictationStrip=\{<DictationRecordingStrip\s*\/>\}/,
    "ChatView no longer hands the dictation strip to ChatComposer",
  );
  assert.equal(
    chatView.match(/<DictationRecordingStrip\b/g)?.length,
    1,
    "DictationRecordingStrip must mount exactly once, through ChatComposer",
  );
  assert.match(
    composer,
    /<ComposerBanner\.Dock>\s*<ComposerBanner\.Column>[\s\S]*?\{dictationStrip\}\s*<\/ComposerBanner\.Column>\s*<ComposerStashBadge\b/,
    "the dictation banner must stay inside the column, beside the Dock's Stash tab",
  );
  assert.equal(
    composer.match(/\{dictationStrip\}/g)?.length,
    1,
    "the composer must render the supplied dictation strip exactly once",
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

it("keeps :has() out of the fork's stylesheet", () => {
  // A `:has()` anchored on the chat column made Chromium re-check it on every DOM change there, and
  // upstream's `group-has-*` utilities turned each re-check into a subtree restyle on every thread
  // switch. The "Which pane has the keyboard" block in mesura.css holds the measurement.
  const rules = read("apps/web/src/mesura.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.notInclude(
    rules,
    ":has(",
    "mesura.css uses :has() again; anchor the state on an attribute instead (see lib/drawerFocusMark.ts)",
  );
});

it("rings the composer for Vim normal and visual mode through an attribute on its surface", () => {
  // `composerSurface.ts` writes the mode onto the surface, because the `:has()` form is forbidden
  // above. The colours match the mode indicator and are part of the baseline: keep them.
  // `apps/web/src/keys/composer/composerSurface.test.ts` pins that mode changes write and clear it.
  const rules = read("apps/web/src/mesura.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const expectedRings = [
    { mode: "normal", outline: "outline: 1.5px solid oklch(68.5% 0.169 237.323);" },
    { mode: "visual", outline: "outline: 1.5px solid oklch(76.9% 0.188 70.08);" },
  ];
  for (const ring of expectedRings) {
    const selector = `[data-chat-composer-main-surface][data-mesura-composer-vim="${ring.mode}"]`;
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const body = rules.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1];
    assert.isDefined(
      body,
      `mesura.css has no rule for ${selector}, so the ${ring.mode} ring is gone`,
    );
    assert.include(body, ring.outline, `the ${ring.mode} ring changed colour or width`);
    assert.include(body, "outline-offset: -1px;", `the ${ring.mode} ring changed its offset`);
  }
});
