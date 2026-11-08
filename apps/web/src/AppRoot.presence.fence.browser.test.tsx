// Phone push phase 4, the client's half, through AppRoot on fake timers
// (`test/presenceFenceMocks.ts`). As built, an unchanged `active` is renewed at most every 30 s
// while input continues, so the host's two-minute expiry does not lapse; criterion 2 read literally
// forbids that. A report is an open `push.presence` call, and the client keeps at most one open.
import { describe, expect, it, vi } from "vite-plus/test";

const fenceMocks = vi.hoisted(() => () => import("./test/presenceFenceMocks"));
vi.mock("./state/pushNotifications", async (original) =>
  (await fenceMocks()).mockPushNotificationsState(original),
);
vi.mock("./state/environments", async (original) =>
  (await fenceMocks()).mockEnvironments(original),
);
vi.mock("./state/primaryEnvironment", async (original) =>
  (await fenceMocks()).mockPrimaryEnvironment(original),
);
vi.mock("./state/entities", async (original) => (await fenceMocks()).mockEntities(original));
vi.mock("./browser/ElectronBrowserHost", () => ({ ElectronBrowserHost: () => null }));
vi.mock("./browser/BrowserProfileReporter", () => ({ BrowserProfileReporter: () => null }));
vi.mock("./components/QuitHoldOverlay", () => ({ QuitHoldOverlay: () => null }));

import { advance, mountPresenceApp, onPage } from "./test/presenceFenceApp";
import {
  giveInput,
  hostHoldsPushesAt,
  PRESENCE_FENCE_PRIMARY_ENVIRONMENT_ID,
  presenceFence,
  reportedStates,
  setPage,
} from "./test/presenceFenceMocks";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** No two reports closer than 30 seconds, measured on the fake clock. */
function expectReportsSpacedBy30Seconds() {
  const times = presenceFence.reports.map((report) => report.at);
  for (let index = 1; index < times.length; index += 1) {
    expect(times[index]! - times[index - 1]!, `report ${index}`).toBeGreaterThanOrEqual(
      30 * SECOND,
    );
  }
}

describe("presence report (criterion 1: what counts as active)", () => {
  it("presence report spec: input on a visible, focused page reports active to the primary environment", async () => {
    await using _app = await mountPresenceApp();

    await onPage(() => giveInput("pointer"));

    expect(reportedStates()).toEqual([true]);
    expect(presenceFence.reports[0]!.environmentId).toBe(PRESENCE_FENCE_PRIMARY_ENVIRONMENT_ID);
    expect(presenceFence.reports[0]!.input).toEqual({ active: true });
  });

  it("presence report spec: a key press counts as input", async () => {
    await using _app = await mountPresenceApp();

    await onPage(() => giveInput("key"));

    expect(reportedStates()).toEqual([true]);
  });

  it("presence report spec: input on a hidden page never reports active", async () => {
    await using _app = await mountPresenceApp({ visible: false });

    await onPage(() => giveInput("pointer"));
    await advance(MINUTE);

    expect(reportedStates()).not.toContain(true);
  });

  it("presence report spec: input while the window lacks focus never reports active", async () => {
    await using _app = await mountPresenceApp({ focused: false });

    await onPage(() => giveInput("key"));
    await advance(MINUTE);

    expect(reportedStates()).not.toContain(true);
  });

  it("presence report spec: two minutes without input report inactive", async () => {
    await using _app = await mountPresenceApp();
    await onPage(() => giveInput("pointer"));
    expect(reportedStates()).toEqual([true]);

    await advance(119 * SECOND);
    expect(reportedStates(), "1:59 after the input").toEqual([true]);

    await advance(1 * SECOND);
    expect(reportedStates(), "2:00 after the input").toEqual([true, false]);
  });

  // regression: phase 4 verifier criterion 1 — a 30-second tick anchored at mount
  // reported inactive up to 30 seconds after the two minutes; a live page idle for
  // 125 seconds had sent none. Fake timers fire a timeout at its due time, as a
  // browser does on a visible page, so an input off the tick's phase shows it.
  it("presence report regression: input between ticks still reports inactive exactly two minutes later", async () => {
    await using _app = await mountPresenceApp();
    await advance(17 * SECOND);
    await onPage(() => giveInput("pointer"));
    const inputAt = presenceFence.reports[0]!.at;

    await advance(2 * MINUTE - 1);
    expect(reportedStates(), "1 ms before two minutes").toEqual([true]);

    await advance(1);
    expect(reportedStates()).toEqual([true, false]);
    expect(presenceFence.reports[1]!.at - inputAt).toBe(2 * MINUTE);
  });

  it("presence report regression: later input moves the inactive report to two minutes after it", async () => {
    await using _app = await mountPresenceApp();
    await onPage(() => giveInput("pointer"));
    await advance(1 * MINUTE);
    await onPage(() => giveInput("key"));

    await advance(1 * MINUTE);
    expect(reportedStates(), "two minutes after the first input").toEqual([true, true]);

    await advance(1 * MINUTE);
    expect(reportedStates(), "two minutes after the last input").toEqual([true, true, false]);
  });

  it("presence report spec: hiding the page reports inactive", async () => {
    await using _app = await mountPresenceApp();
    await onPage(() => giveInput("pointer"));
    await advance(40 * SECOND);

    await onPage(() => setPage({ visible: false }));
    await advance(30 * SECOND);

    expect(reportedStates()).toEqual([true, false]);
  });

  it("presence report spec: the window losing focus reports inactive", async () => {
    await using _app = await mountPresenceApp();
    await onPage(() => giveInput("pointer"));
    await advance(40 * SECOND);

    await onPage(() => setPage({ focused: false }));
    await advance(30 * SECOND);

    expect(reportedStates()).toEqual([true, false]);
  });

  it("presence report spec: coming back to the page with input reports active again", async () => {
    await using _app = await mountPresenceApp();
    await onPage(() => giveInput("pointer"));
    await advance(40 * SECOND);
    await onPage(() => setPage({ visible: false }));
    await advance(40 * SECOND);
    expect(reportedStates()).toEqual([true, false]);

    await onPage(() => setPage({ visible: true }));
    await onPage(() => giveInput("key"));
    await advance(30 * SECOND);

    expect(reportedStates()).toEqual([true, false, true]);
  });
});

/**
 * Two reports in a row with the same state are only ever an `active` renewal:
 * at least 30 seconds apart. An `inactive` report is never repeated.
 */
function expectRepeatsOnlyAsActiveRenewals() {
  const { reports } = presenceFence;
  for (let index = 1; index < reports.length; index += 1) {
    const previous = (reports[index - 1]!.input as { active: boolean }).active;
    const current = (reports[index]!.input as { active: boolean }).active;
    if (previous !== current) continue;
    expect(current, `report ${index} repeats inactive`).toBe(true);
    expect(reports[index]!.at - reports[index - 1]!.at).toBeGreaterThanOrEqual(30 * SECOND);
  }
}

describe("presence report (criterion 2 as built: transitions, and active renewals at most every 30 seconds while input continues)", () => {
  it("presence report spec: mounting with no input sends nothing", async () => {
    await using _app = await mountPresenceApp();

    await advance(10 * MINUTE);

    expect(presenceFence.reports).toEqual([]);
  });

  it("presence report spec: steady input renews active at most once per 30 seconds, not once per input", async () => {
    await using _app = await mountPresenceApp();

    for (let second = 0; second < 55; second += 5) {
      await onPage(() => giveInput(second % 10 === 0 ? "pointer" : "key"));
      await advance(5 * SECOND);
    }

    // Eleven inputs in 55 seconds: the first report, and one renewal at 30 seconds.
    expect(reportedStates()).toEqual([true, true]);
    expectReportsSpacedBy30Seconds();
    expectRepeatsOnlyAsActiveRenewals();
  });

  it("presence report spec: steady activity for minutes keeps re-reporting active before the host's two minutes lapse", async () => {
    await using _app = await mountPresenceApp();

    for (let second = 0; second < 5 * 60; second += 10) {
      await onPage(() => giveInput(second % 20 === 0 ? "pointer" : "key"));
      await advance(10 * SECOND);
    }

    expect(new Set(reportedStates())).toEqual(new Set([true]));
    expectReportsSpacedBy30Seconds();
    expectRepeatsOnlyAsActiveRenewals();
    // The first report left with the first input; the loop ran five minutes from there.
    const endedAt = presenceFence.reports[0]!.at + 5 * MINUTE;
    const times = [...presenceFence.reports.map((report) => report.at), endedAt];
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]! - times[index - 1]!, `gap ${index}`).toBeLessThan(2 * MINUTE);
    }
  });

  it("presence report spec: the client holds one report at a time and ends it when the app unmounts", async () => {
    {
      await using _app = await mountPresenceApp();
      await onPage(() => giveInput("pointer"));
      expect(presenceFence.openReports).toBe(1);
      await advance(40 * SECOND);
      await onPage(() => setPage({ visible: false }));
      expect(reportedStates()).toEqual([true, false]);
      expect(presenceFence.openReports, "the active report was replaced").toBe(1);
    }
    expect(presenceFence.openReports, "unmounting ended the report").toBe(0);
  });

  it("presence report spec: an inactive client stays silent once it reported inactive", async () => {
    await using _app = await mountPresenceApp();
    await onPage(() => giveInput("pointer"));
    await advance(40 * SECOND);
    await onPage(() => setPage({ focused: false }));
    await advance(30 * SECOND);
    expect(reportedStates()).toEqual([true, false]);

    await advance(10 * MINUTE);

    expect(reportedStates()).toEqual([true, false]);
    expectRepeatsOnlyAsActiveRenewals();
  });

  // regression: phase 4 review P1-1 — input at 0 and 29 seconds sent one report;
  // the host forgot it at 120 seconds while the client stayed active until 149,
  // and a push in that gap reached the phone.
  it("presence report regression: input inside the 30-second limit renews when the limit ends, so the host holds pushes until the client goes inactive", async () => {
    await using _app = await mountPresenceApp();
    await onPage(() => giveInput("pointer"));
    const start = presenceFence.reports[0]!.at;
    await advance(29 * SECOND);
    await onPage(() => giveInput("key"));

    await advance(1 * SECOND);
    expect(reportedStates(), "the renewal left when the limit ended").toEqual([true, true]);
    expect(presenceFence.reports[1]!.at - start).toBe(30 * SECOND);

    await advance(119 * SECOND);
    expect(reportedStates(), "149 seconds in").toEqual([true, true, false]);
    for (const second of [120, 130, 140, 148]) {
      expect(hostHoldsPushesAt(start + second * SECOND), `host at ${second} s`).toBe(true);
    }
    expect(hostHoldsPushesAt(start + 149 * SECOND), "host once the client went inactive").toBe(
      false,
    );
  });

  it("presence report spec: a state that flips every few seconds sends at most one report per 30 seconds", async () => {
    await using _app = await mountPresenceApp();

    // Active, then blur and refocus with input every 5 seconds for 25 seconds.
    await onPage(() => giveInput("pointer"));
    for (let step = 0; step < 5; step += 1) {
      await advance(5 * SECOND);
      await onPage(() => setPage({ focused: step % 2 === 1 }));
      if (step % 2 === 1) await onPage(() => giveInput("key"));
    }
    expect(presenceFence.reports, "inside the first 30 seconds").toHaveLength(1);
    expectReportsSpacedBy30Seconds();

    // The page ends blurred, so the last report must say inactive.
    expect(presenceFence.focused).toBe(false);
    await advance(MINUTE);
    expectReportsSpacedBy30Seconds();
    expect(reportedStates().at(-1)).toBe(false);
    expect(presenceFence.reports.length).toBeLessThanOrEqual(3);
  });
});
