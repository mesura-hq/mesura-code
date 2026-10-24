// @effect-diagnostics nodeBuiltinImport:off - Real Chromium geometry regression; no Effect runtime or application state.
/** Uses the installed measured list and the same Find policy as MessagesTimeline. */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import {
  buildTimelineFindFixture,
  timelineFixtureVersions,
} from "./mesura-timeline.find.fixture-build.ts";
import { createTimelineFixtureOutput } from "./mesura-timeline.find.fixture-output.ts";

interface RowSnapshot {
  ordinal: number;
  known: number;
  knownSize: number;
  mounted: number;
  width: number;
  height: number;
  top: number;
  bottom: number;
}
interface Snapshot {
  viewportWidth: number;
  viewportHeight: number;
  average: number;
  averageCount: number;
  calibrations: RowSnapshot[];
  target: RowSnapshot;
  dataLength: number;
  coreDataLength: number;
  duplicateKeys: number;
  knownMemberCount: number;
  measuredCount: number;
  signalCount: number;
  pendingRequests: number;
  depthErrors: number;
  otherErrors: number;
  findActive: number;
  highlightCount: number;
  range: { connected: number; height: number; top: number; bottom: number };
  scroll: number;
}
interface NumericTelemetry {
  measurements: {
    action: number;
    ordinal: number;
    previous: number;
    size: number;
    pendingRequests: number;
  }[];
  signals: { action: number; signal: number; value: number }[];
  commits: { action: number; phase: number; commitTime: number }[];
  requests: {
    query: number;
    index: number;
    coreIndex: number;
    viewOffset: number;
    knownSize: number;
  }[];
}

let output: ReturnType<typeof createTimelineFixtureOutput> | undefined;
let fixturePath: string;
let launch: Promise<Browser> | undefined;
const stages: Record<string, Snapshot[]> = {};
const retainedOutput = NodeProcess.env.MESURA_TIMELINE_ARTIFACT_DIR;

beforeAll(async () => {
  expect(timelineFixtureVersions).toEqual({ react: "19.2.6", reactDom: "19.2.6", legend: "3.3.5" });
  output = createTimelineFixtureOutput(retainedOutput);
  fixturePath = await buildTimelineFindFixture(output.directory);
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
  // Keep the launch promise. Cleanup waits for a late launch before removing any fixture files.
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

async function invoke(page: Page, action: number, method: string, value?: number) {
  await page.evaluate(
    `window.telemetry.action = ${action}; window.fixture[${JSON.stringify(method)}](${JSON.stringify(value)})`,
  );
}

async function settle(page: Page): Promise<Snapshot> {
  return page.evaluate<Snapshot>(`(async () => {
    let previous = "", quiet = 0, frames = 0;
    while (quiet < 30) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const snapshot = window.fixture.snapshot();
      if (snapshot.depthErrors || snapshot.otherErrors) return snapshot;
      const signature = JSON.stringify(snapshot);
      if (signature === previous) quiet++; else { previous = signature; quiet = 0; }
      if (++frames > 1200) throw new Error("Measured geometry did not settle within the existing frame bound.");
    }
    return window.fixture.snapshot();
  })()`);
}

it.each([
  { name: "ordinary index", narrow: false, navigation: "index" },
  { name: "narrow index", narrow: true, navigation: "index" },
  { name: "ordinary repository Find", narrow: false, navigation: "hook" },
  { name: "narrow repository Find", narrow: true, navigation: "hook" },
])(
  "preserves measured Find target geometry after estimate reconciliation: $name",
  async (config) => {
    if (!launch) throw new Error("Chromium launch was not initialized.");
    const context = await (await launch).newContext({ viewport: { width: 1184, height: 848 } });
    let page: Page | undefined;
    let browserDepthErrors = 0;
    const browserOtherErrors: string[] = [];
    const captured: Snapshot[] = (stages[config.name] = []);
    try {
      page = await context.newPage();
      page.on("pageerror", (error) => {
        if (error.message.includes("Maximum update depth exceeded")) browserDepthErrors++;
        else browserOtherErrors.push(error.message);
      });
      page.on("console", (message) => {
        if (message.type() === "error" && message.text().includes("Maximum update depth exceeded"))
          browserDepthErrors++;
      });
      const stage = async () => {
        if (!page) throw new Error("The case has no page.");
        const snapshot = await settle(page);
        captured.push(snapshot);
        expect(snapshot.depthErrors, "Actual React depth error").toBe(0);
        expect(snapshot.otherErrors).toBe(0);
        expect(browserDepthErrors).toBe(0);
        expect(browserOtherErrors).toEqual([]);
        expect(snapshot.viewportHeight).toBe(848);
        expect(snapshot.duplicateKeys).toBe(0);
        expect(snapshot.coreDataLength).toBe(snapshot.dataLength);
        return snapshot;
      };
      const url = NodeURL.pathToFileURL(fixturePath);
      // Root can run the identical assertions against the recorded old Find policy without changing source.
      url.searchParams.set(
        "policy",
        NodeProcess.env.MESURA_TIMELINE_TEST_POLICY === "legacy" ? "legacy" : "candidate",
      );
      url.searchParams.set("navigation", config.navigation);
      await page.goto(url.href);
      await page.waitForFunction("window.telemetry?.loaded > 0 && window.fixture");
      await page.evaluate("document.fonts.ready.then(() => window.fixture.observe())");
      expect((await stage()).viewportWidth).toBe(1184);
      if (config.narrow) {
        await invoke(page, 1, "narrow");
        expect((await stage()).viewportWidth).toBe(90);
      }
      for (let ordinal = 0; ordinal < 12; ordinal++) {
        await invoke(page, 2, "position", ordinal);
        expect((await stage()).calibrations[ordinal]?.knownSize).toBeGreaterThan(0);
      }
      await invoke(page, 3, "position", 107);
      const moved = await stage();
      expect(moved.calibrations.every((row) => row.known === 1 && row.mounted === 0)).toBe(true);
      if (config.narrow) await invoke(page, 4, "restore");
      const restored = await stage();
      expect(restored.viewportWidth).toBe(1184);
      expect(
        restored.calibrations.every(
          (row, index) =>
            row.mounted === 0 && row.knownSize === moved.calibrations[index]?.knownSize,
        ),
      ).toBe(true);
      expect(restored.averageCount).toBe(12);
      expect(restored.knownMemberCount).toBe(0);
      // This is the reviewed estimate precondition, not a measurement or callback cap.
      if (config.narrow) expect(restored.average).toBeGreaterThanOrEqual(7000);
      else expect(restored.average).toBeLessThan(7000);
      await invoke(page, 6, "expand");
      const positioned = await stage();
      expect(positioned.dataLength).toBe(164);
      expect(positioned.target.mounted).toBe(1);
      expect(positioned.target.knownSize).toBeGreaterThan(0);
      expect(positioned.target.width).toBeGreaterThan(0);
      expect(
        Math.abs(positioned.target.knownSize - Math.round(positioned.target.height)),
      ).toBeLessThanOrEqual(1);
      expect(positioned.target.top).toBeGreaterThanOrEqual(0);
      expect(positioned.target.bottom).toBeLessThanOrEqual(positioned.viewportHeight);
      if (config.navigation === "index")
        expect(Math.abs(positioned.target.top - 96)).toBeLessThanOrEqual(1);
      else {
        expect(positioned.highlightCount).toBe(1);
        expect(positioned.range.connected).toBe(1);
        expect(positioned.range.height).toBeGreaterThan(0);
        expect(positioned.range.top).toBeGreaterThanOrEqual(0);
        expect(positioned.range.bottom).toBeLessThanOrEqual(positioned.viewportHeight);
      }
      await invoke(page, 7, "snapshot");
      const quiet = await stage();
      expect(quiet.target.mounted).toBe(1);
      expect(quiet.target.width).toBeGreaterThan(0);
      expect(quiet.target.knownSize).toBeGreaterThan(0);
      expect(
        Math.abs(quiet.target.knownSize - Math.round(quiet.target.height)),
      ).toBeLessThanOrEqual(1);
      expect(quiet.target.top).toBeGreaterThanOrEqual(0);
      expect(quiet.target.bottom).toBeLessThanOrEqual(quiet.viewportHeight);
      expect(Math.abs(quiet.target.top - positioned.target.top)).toBeLessThanOrEqual(1);
      expect(Math.abs(quiet.target.bottom - positioned.target.bottom)).toBeLessThanOrEqual(1);
      expect(Math.abs(quiet.scroll - positioned.scroll)).toBeLessThanOrEqual(1);
      if (config.navigation === "index")
        expect(Math.abs(quiet.target.top - 96)).toBeLessThanOrEqual(1);
      else {
        expect(quiet.highlightCount).toBe(1);
        expect(quiet.range.connected).toBe(1);
        expect(quiet.range.height).toBeGreaterThan(0);
        expect(quiet.range.top).toBeGreaterThanOrEqual(0);
        expect(quiet.range.bottom).toBeLessThanOrEqual(quiet.viewportHeight);
        expect(Math.abs(quiet.range.top - positioned.range.top)).toBeLessThanOrEqual(1);
        expect(Math.abs(quiet.range.bottom - positioned.range.bottom)).toBeLessThanOrEqual(1);
      }
      expect(quiet.measuredCount).toBe(positioned.measuredCount);
      expect(quiet.signalCount).toBe(positioned.signalCount);
      expect(quiet.pendingRequests).toBe(0);
      const telemetry = await page.evaluate<NumericTelemetry>("window.telemetry");
      if (config.navigation === "index") {
        const request = telemetry.requests.find((request) => request.query === 1);
        expect(request?.index).toBe(request?.coreIndex);
        expect(request?.knownSize).toBe(-1);
        expect(request?.viewOffset).toBe(96);
        if (config.narrow)
          expect(
            telemetry.measurements.some(
              (measurement) =>
                measurement.action === 6 &&
                measurement.ordinal === 2031 &&
                measurement.previous - measurement.size >= 7000 &&
                measurement.pendingRequests > 0,
            ),
          ).toBe(true);
      }
      await invoke(page, 8, "closeFind");
      const closed = await stage();
      expect(closed.findActive).toBe(0);
      expect(closed.highlightCount).toBe(0);
      expect(Math.abs(closed.target.top - quiet.target.top)).toBeLessThanOrEqual(1);
      expect(Math.abs(closed.scroll - quiet.scroll)).toBeLessThanOrEqual(1);
      await invoke(page, 9, "appendAfterClose");
      const appended = await stage();
      expect(appended.dataLength).toBe(165);
      expect(Math.abs(appended.target.top - closed.target.top)).toBeLessThanOrEqual(1);
    } finally {
      try {
        if (page) {
          const telemetry = await page.evaluate<NumericTelemetry>("window.telemetry");
          output?.writeReceipt(`${config.name.replaceAll(" ", "-")}.json`, {
            stages: captured,
            browserDepthErrors,
            browserOtherErrors,
            measurements: telemetry.measurements,
            signals: telemetry.signals,
            commits: telemetry.commits,
            requests: telemetry.requests,
          });
          await page.evaluate("window.fixture?.dispose()");
        }
      } finally {
        await context.close();
      }
    }
  },
);

it("detects the real React depth error independently of the measured Find cases", async () => {
  if (!launch) throw new Error("Chromium launch was not initialized.");
  const context = await (await launch).newContext();
  try {
    const page = await context.newPage();
    const browserOtherErrors: string[] = [];
    page.on("pageerror", (error) => {
      if (!error.message.includes("Maximum update depth exceeded"))
        browserOtherErrors.push(error.message);
    });
    const url = NodeURL.pathToFileURL(fixturePath);
    url.searchParams.set("control", "depth");
    await page.goto(url.href);
    await page.waitForFunction("window.telemetry.depthErrors.length > 0");
    expect(await page.evaluate<number>("window.telemetry.otherErrors.length")).toBe(0);
    expect(browserOtherErrors).toEqual([]);
  } finally {
    await context.close();
  }
});
