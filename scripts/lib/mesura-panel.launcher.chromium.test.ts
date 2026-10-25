// @effect-diagnostics nodeBuiltinImport:off - Real Base UI lifecycle regression without an application profile or services.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import { chromium, devices, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import {
  buildPanelLauncherFixture,
  panelFixtureVersions,
} from "./mesura-panel.launcher.fixture-build.ts";
import { createTimelineFixtureOutput as createFixtureOutput } from "./mesura-timeline.find.fixture-output.ts";
import { expectFixtureVersionFloor } from "./mesura-fixture-versions.ts";

interface Snapshot {
  focus: number;
  editable: number;
  focusInOwner: number;
  contentToken: number;
  contentTabIndex: number;
  treeToken: number;
  treeCount: number;
  tabCount: number;
  launcherCount: number;
  selected: number;
  treeWidth: number;
  treeHeight: number;
  open: number;
  errors: number;
}

interface LazyEntryEvidence {
  parkedTitleTime: number | null;
  parkedTitleToken: number;
  releaseTime: number | null;
  pointerdowns: {
    time: number;
    isTrusted: boolean;
    pointerType: string;
    targetIsWaitingTitle: boolean;
    targetToken: number;
    focus: number;
    defaultPrevented: boolean;
  }[];
}

// panelSurfaceFocus's private ENTRY_WAIT_MS is 4000. Release before that deadline
// so an expired entry wait cannot impersonate cancellation by a native title tap.
const LAZY_ENTRY_WAIT_MS = 4000;

let output: ReturnType<typeof createFixtureOutput> | undefined;
let fixturePath: string;
let launch: Promise<Browser> | undefined;
beforeAll(async () => {
  expectFixtureVersionFloor(panelFixtureVersions.react, [19, 2, 6]);
  expect(panelFixtureVersions.reactDom).toBe(panelFixtureVersions.react);
  expectFixtureVersionFloor(panelFixtureVersions.baseUi, [1, 5, 0]);
  output = createFixtureOutput(NodeProcess.env.MESURA_PANEL_ARTIFACT_DIR);
  fixturePath = await buildPanelLauncherFixture(output.directory);
  const cache =
    NodeProcess.env.PLAYWRIGHT_BROWSERS_PATH ??
    NodePath.join(NodeOS.homedir(), ".cache/ms-playwright");
  const executablePath = NodeFS.readdirSync(cache)
    .filter((name) => name.startsWith("chromium_headless_shell-"))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((name) =>
      NodePath.join(cache, name, "chrome-headless-shell-linux64/chrome-headless-shell"),
    )
    .find((name) => NodeFS.existsSync(name));
  if (!executablePath) throw new Error("Cached Chromium is required; this test installs nothing.");
  launch = chromium.launch({
    headless: true,
    executablePath,
    args: ["--js-flags=--max-old-space-size=384"],
  });
  await launch;
});
afterAll(async () => {
  try {
    if (launch) await (await launch).close();
  } finally {
    output?.dispose();
  }
});

/** Thirty stationary real frames include Base UI's competing restoration frame. */
async function settle(page: Page): Promise<Snapshot> {
  return page.evaluate<Snapshot>(`(async () => {
    let previous = "", quiet = 0, frames = 0;
    while (quiet < 30) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const snapshot = window.fixture.snapshot();
      if (snapshot.errors) return snapshot;
      const signature = JSON.stringify(snapshot);
      if (signature === previous) quiet++; else { previous = signature; quiet = 0; }
      if (++frames > 1200) throw new Error("The sheet focus and geometry did not settle within the existing frame bound.");
    }
    return window.fixture.snapshot();
  })()`);
}

async function withPanel(
  name: string,
  options: { inline?: boolean; lazy?: boolean; retained?: boolean },
  run: (page: Page, stage: () => Promise<Snapshot>) => Promise<void>,
) {
  if (!launch) throw new Error("Chromium launch was not initialized.");
  const context = await (
    await launch
  ).newContext(
    options.inline
      ? { viewport: { width: 1184, height: 848 } }
      : { ...devices["Pixel 7"], viewport: { width: 412, height: 839 } },
  );
  let page: Page | undefined;
  const stages: Snapshot[] = [];
  const browserErrors: string[] = [];
  try {
    page = await context.newPage();
    page.on("pageerror", (error) => browserErrors.push(error.message));
    const url = NodeURL.pathToFileURL(fixturePath);
    url.searchParams.set(
      "policy",
      NodeProcess.env.MESURA_PANEL_TEST_POLICY === "legacy" ? "legacy" : "candidate",
    );
    url.searchParams.set("mode", options.inline ? "inline" : "sheet");
    url.searchParams.set("entry", options.lazy ? "lazy" : "ready");
    url.searchParams.set("retained", options.retained ? "1" : "0");
    await page.goto(url.href);
    await page.waitForFunction("window.telemetry?.ready > 0 && window.fixture");
    await page.evaluate("document.fonts.ready");
    const stage = async () => {
      if (!page) throw new Error("The case has no page.");
      const snapshot = await settle(page);
      stages.push(snapshot);
      expect(browserErrors).toEqual([]);
      expect(snapshot.errors).toBe(0);
      return snapshot;
    };
    await stage();
    // Public keyboard ownership after the sheet's opening lifecycle finishes.
    await page.getByLabel("Open a surface", { exact: true }).focus();
    await run(page, stage);
  } finally {
    try {
      if (page) {
        const events = await page.evaluate<unknown>("window.telemetry?.events");
        const lazyEntry = await page.evaluate<LazyEntryEvidence>("window.telemetry?.lazyEntry");
        output?.writeReceipt(`${name}.json`, { stages, browserErrors, events, lazyEntry });
      }
    } finally {
      await context.close();
    }
  }
}

function expectTree(snapshot: Snapshot) {
  expect(snapshot.open).toBe(1);
  expect(snapshot.tabCount).toBe(1);
  expect(snapshot.launcherCount).toBe(0);
  expect(snapshot.treeCount).toBe(1);
  expect(snapshot.treeWidth).toBeGreaterThan(0);
  expect(snapshot.treeHeight).toBeGreaterThan(0);
  expect(snapshot.focus).toBe(5);
  expect(snapshot.focusInOwner).toBe(1);
  expect(snapshot.editable).toBe(0);
}

it.each([
  { name: "ready letter", lazy: false, activation: "letter" },
  { name: "lazy letter", lazy: true, activation: "letter" },
  { name: "ready Enter", lazy: false, activation: "Enter" },
  { name: "ready native Enter", lazy: false, activation: "native Enter" },
  { name: "ready native Space", lazy: false, activation: "native Space" },
])(
  "preserves first-creation tree focus through the real sheet restoration: $name",
  async (config) => {
    await withPanel(
      config.name.replaceAll(" ", "-"),
      { lazy: config.lazy },
      async (page, stage) => {
        const before = await stage();
        expect(before.tabCount).toBe(0);
        expect(before.focus).toBe(3);
        if (config.activation === "letter") await page.keyboard.press("f");
        else if (config.activation === "Enter") {
          await page.keyboard.press("ArrowDown");
          await page.keyboard.press("Enter");
        } else {
          await page.getByRole("button", { name: "Files", exact: true }).focus();
          await page.keyboard.press(config.activation === "native Enter" ? "Enter" : "Space");
        }
        if (config.lazy) {
          const loading = await stage();
          expect(loading.focus).toBe(4);
          expect(loading.tabCount).toBe(1);
          expect(loading.treeCount).toBe(0);
          await page.evaluate("window.fixture.makeReady()");
        }
        const focused = await stage();
        expectTree(focused);
        expect(focused.contentToken).toBe(before.contentToken);
        expect(focused.contentTabIndex).toBe(-1);
        await page.keyboard.press("ArrowDown");
        const usable = await stage();
        expectTree(usable);
        expect(usable.selected).toBe(1);
        expect(usable.treeToken).toBe(focused.treeToken);
        // Repeat focus and usability after another stationary boundary, not a transient focusin.
        const stationary = await stage();
        expectTree(stationary);
        expect(stationary.selected).toBe(1);
        expect(stationary.treeToken).toBe(usable.treeToken);
      },
    );
  },
);

it("keeps an existing phone Files tree mounted and usable after keyboard launcher selection", async () => {
  await withPanel("retained", { retained: true }, async (page, stage) => {
    const before = await stage();
    expect(before.tabCount).toBe(1);
    await page.keyboard.press("f");
    const focused = await stage();
    expectTree(focused);
    expect(focused.treeToken).toBe(before.treeToken);
    await page.keyboard.press("ArrowDown");
    expect((await stage()).selected).toBe(1);
  });
});

it("preserves the desktop inline launcher entry without a sheet", async () => {
  await withPanel("inline", { inline: true }, async (page, stage) => {
    expect(await page.locator('[data-slot="sheet-popup"]').count()).toBe(0);
    await page.keyboard.press("f");
    expectTree(await stage());
    await page.keyboard.press("ArrowDown");
    expect((await stage()).selected).toBe(1);
  });
});

it("does not transfer phone touch activation to an editable or keyboard tree entry", async () => {
  await withPanel("touch", {}, async (page, stage) => {
    await page.getByRole("button", { name: "Files", exact: true }).tap();
    const result = await stage();
    expect(result.tabCount).toBe(1);
    expect(result.treeCount).toBe(1);
    expect(result.launcherCount).toBe(0);
    expect(result.focus).not.toBe(5);
    expect(result.editable).toBe(0);
    expect((await stage()).focus).toBe(result.focus);
  });
});

it("respects a phone user's focus move while a selected surface entry loads", async () => {
  await withPanel("user-focus", { lazy: true }, async (page, stage) => {
    await page.keyboard.press("f");
    expect((await stage()).focus).toBe(4);
    await page.getByRole("button", { name: "User focus target" }).focus();
    await page.evaluate("window.fixture.makeReady()");
    const result = await stage();
    expect(result.treeCount).toBe(1);
    expect(result.focus).toBe(6);
    expect((await stage()).focus).toBe(6);
  });
});

it("cancels lazy keyboard entry on phone touch that retains the waiting title focus", async () => {
  await withPanel("lazy-touch-cancel", { lazy: true }, async (page, stage) => {
    await page.keyboard.press("f");
    const loading = await stage();
    expect(loading.focus, "Insufficient setup: the waiting title must own focus.").toBe(4);
    expect(loading.tabCount, "Insufficient setup: expected one created Files tab.").toBe(1);
    expect(loading.treeCount, "Insufficient setup: the tree must still be lazy.").toBe(0);
    expect(loading.launcherCount, "Insufficient setup: the launcher must be removed.").toBe(0);
    await page.getByRole("button", { name: "Files", exact: true }).tap();
    expect(
      (await stage()).focus,
      "Insufficient setup: the title tap must retain the waiting title focus.",
    ).toBe(4);
    await page.evaluate("window.fixture.makeReady()");
    const evidence = await page.evaluate<LazyEntryEvidence>("window.telemetry.lazyEntry");
    expect(
      evidence.parkedTitleTime,
      "Insufficient setup: no parked-title transition.",
    ).not.toBeNull();
    expect(
      evidence.releaseTime,
      "Insufficient setup: lazy content was not released.",
    ).not.toBeNull();
    if (evidence.parkedTitleTime === null || evidence.releaseTime === null)
      throw new Error("Insufficient setup: the lazy-entry timing evidence is missing.");
    expect(
      evidence.releaseTime - evidence.parkedTitleTime,
      "Insufficient setup: lazy content must release before the production entry wait expires.",
    ).toBeLessThan(LAZY_ENTRY_WAIT_MS);
    expect(
      evidence.pointerdowns,
      "Insufficient setup: expected one native title tap.",
    ).toHaveLength(1);
    const [input] = evidence.pointerdowns;
    if (!input) throw new Error("Insufficient setup: the native title tap is missing.");
    expect(input.isTrusted, "Insufficient setup: the title tap must be trusted.").toBe(true);
    expect(input.pointerType, "Insufficient setup: native touch input is required.").toBe("touch");
    expect(
      input.targetIsWaitingTitle,
      "Insufficient setup: touch must target the waiting title.",
    ).toBe(true);
    expect(
      input.targetToken,
      "Insufficient setup: touch must target the original parked title.",
    ).toBe(evidence.parkedTitleToken);
    expect(input.focus, "Insufficient setup: the title must already own focus during touch.").toBe(
      4,
    );
    expect(input.defaultPrevented, "Insufficient setup: native touch must not be prevented.").toBe(
      false,
    );
    expect(
      input.time,
      "Insufficient setup: touch must follow title parking.",
    ).toBeGreaterThanOrEqual(evidence.parkedTitleTime);
    expect(
      evidence.releaseTime,
      "Insufficient setup: release must follow the title tap.",
    ).toBeGreaterThanOrEqual(input.time);
    const expectUsableTreeWithTitleFocus = async (snapshot: Snapshot) => {
      expect(snapshot.treeCount).toBe(1);
      expect(snapshot.treeWidth).toBeGreaterThan(0);
      expect(snapshot.treeHeight).toBeGreaterThan(0);
      expect(snapshot.focus).toBe(4);
      expect(snapshot.focusInOwner).toBe(1);
      expect(snapshot.editable).toBe(0);
      const tree = page.getByRole("tree", { name: "Synthetic Files" });
      expect(await tree.isVisible()).toBe(true);
      expect(await tree.isEnabled()).toBe(true);
      expect(await tree.getByRole("treeitem").count()).toBe(2);
      expect(await tree.evaluate((element) => element.closest("[inert]") === null)).toBe(true);
    };
    const result = await stage();
    await expectUsableTreeWithTitleFocus(result);
    const stationary = await stage();
    await expectUsableTreeWithTitleFocus(stationary);
    expect(stationary.treeToken).toBe(result.treeToken);
  });
});

it("closes the real phone sheet with Escape and preserves its retained content", async () => {
  await withPanel("escape-close", { retained: true }, async (page, stage) => {
    const before = await stage();
    await page.keyboard.press("Escape");
    const closed = await stage();
    expect(closed.open).toBe(0);
    expect(closed.treeToken).toBe(before.treeToken);
    expect(closed.contentToken).toBe(before.contentToken);
    expect(await page.locator('[data-slot="sheet-popup"][data-closed]').count()).toBe(1);
  });
});
