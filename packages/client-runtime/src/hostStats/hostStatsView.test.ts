/**
 * The Hosts dock's and the mobile Hosts screen's formatting and view logic. The views come
 * from the shared projection (`projectHostStats`) over histories folded from
 * real snapshot messages, so these specs read what the dock will render.
 */
import { describe, expect, it } from "vite-plus/test";

import type { HostStatsRow } from "./projectHostStats.ts";

import {
  HOST_STATS_AGE_REFRESH_MS,
  createHostStatsAgeClock,
  formatGigabytes,
  formatCompactRate,
  formatRate,
  formatReadingAge,
  formatTemperature,
  formatUptime,
  hostFleetSummary,
  hostIsDimmed,
  hostRowDisplay,
  hostServersLine,
  hostShowsUptime,
  hostStatusLine,
  sparklineMax,
  sparklinePath,
  sparklineReading,
  sparklineRuns,
  sparklineSlotAt,
} from "./hostStatsView.ts";
import {
  HOUR,
  MINUTE,
  NO_ACCESS_HOST_ID,
  PRIMARY_GAP_SLOTS,
  SECOND,
  SLOTS,
  gib,
  hostHistory,
  hostStatsFleet,
  hostView,
  projectFleet,
  withNoAccessHost,
} from "./hostStatsFixtures.ts";

/** Host clock of every fixture: the current bucket starts at 12:00 UTC, series[0] at 00:05. */
const NOW = Date.parse("2026-09-29T12:02:30.000Z");

function fleetViews(nowLocal = NOW) {
  return projectFleet(hostStatsFleet(NOW), nowLocal);
}

function rowsOf(id: string) {
  const rows = hostView(fleetViews(), id).rows;
  expect(rows).not.toBeNull();
  return rows!;
}

describe("Hosts dock number formatting", () => {
  it("formats gigabytes with one decimal under 100 and none above", () => {
    expect(formatGigabytes(gib(14.6))).toBe("14.6");
    // Prototype B's GB(): a whole number keeps no decimal, anything else keeps one.
    expect(formatGigabytes(gib(30))).toBe("30");
    expect(formatGigabytes(gib(29.98))).toBe("30.0");
    expect(formatGigabytes(gib(0.07))).toBe("0.1");
    expect(formatGigabytes(gib(160))).toBe("160");
    expect(formatGigabytes(gib(99.97))).toBe("100");
    expect(formatGigabytes(0)).toBe("0");
  });

  it("formats rates in KB/s below a megabyte and MB/s above", () => {
    expect(formatRate(0)).toBe("0 KB/s");
    expect(formatRate(500)).toBe("<1 KB/s");
    expect(formatRate(12_000)).toBe("12 KB/s");
    expect(formatRate(1_572_864)).toBe("1.5 MB/s");
    expect(formatRate(157_286_400)).toBe("150 MB/s");
  });

  it("formats compact rates for the network row's two directions", () => {
    expect(formatCompactRate(0)).toBe("0K");
    expect(formatCompactRate(500)).toBe("<1K");
    expect(formatCompactRate(12_000)).toBe("12K");
    expect(formatCompactRate(1_572_864)).toBe("1.5M");
    expect(formatCompactRate(157_286_400)).toBe("150M");
  });

  it("formats temperatures as whole degrees Celsius", () => {
    expect(formatTemperature(47.6)).toBe("48°C");
  });

  it("formats reading ages the way the usage dock does", () => {
    expect(formatReadingAge(30 * SECOND)).toBe("just now");
    expect(formatReadingAge(3 * MINUTE + 10 * SECOND)).toBe("3m ago");
    expect(formatReadingAge(125 * MINUTE)).toBe("2h 5m ago");
    expect(formatReadingAge(27 * HOUR)).toBe("1d 3h ago");
  });

  it("formats uptime with its two largest units", () => {
    expect(formatUptime(147 * MINUTE)).toBe("up 2h 27m");
    expect(formatUptime(5 * 24 * HOUR + 20 * HOUR + 50 * MINUTE)).toBe("up 5d 20h");
  });
});

describe("Hosts dock rows", () => {
  it("labels and values every one of the eight rows of a live host as prototype B does", () => {
    const rows = rowsOf("vigilia-home");
    expect(hostRowDisplay("cpu", rows.cpu)).toEqual({
      label: "CPU",
      value: "17%",
      suffix: "ld 2.5",
      title: "Load 2.46",
    });
    expect(hostRowDisplay("memory", rows.memory)).toEqual({
      label: "RAM",
      value: "14.6",
      suffix: "/30.0G",
      title: "49% used",
    });
    expect(hostRowDisplay("swap", rows.swap)).toEqual({
      label: "Swap",
      value: "4.2",
      suffix: "/7.6G",
      title: "55% used",
    });
    expect(hostRowDisplay("disk", rows.disk)).toEqual({
      label: "Disk",
      value: "17%",
      suffix: "793G",
      title: "793 GB free of 953 GB",
    });
    expect(hostRowDisplay("gpu", rows.gpu)).toMatchObject({
      label: "GPU",
      value: "12%",
      suffix: "vram 13%",
    });
    expect(hostRowDisplay("temperature", rows.temperature)).toMatchObject({
      label: "Temp",
      value: "48°C",
      suffix: null,
    });
    expect(hostRowDisplay("network", rows.network)).toEqual({
      label: "Net",
      value: "↓12K",
      suffix: "↑3K",
      title: "↓ 12 KB/s received · ↑ 3 KB/s sent",
    });
    expect(hostRowDisplay("agents", rows.agents)).toEqual({
      label: "Agents",
      value: "4",
      suffix: "/11",
      title: "11 agent sessions open",
    });
  });

  it("sums the servers into prototype B's chip line under the rows", () => {
    const rows = rowsOf("vigilia-home");
    expect(hostServersLine(rows.servers)).toEqual({
      text: "9 servers · 8 dev",
      title: "1 installed server, 8 dev servers",
    });
    expect(hostServersLine({ ...rows.servers, value: 1, secondary: 0 })).toEqual({
      text: "1 server · 0 dev",
      title: "1 installed server, 0 dev servers",
    });
  });

  it("says a metric is not available rather than showing zero", () => {
    const notAvailable: HostStatsRow = {
      value: null,
      secondary: null,
      level: null,
      secondaryLevel: null,
      availability: "not-available",
      series: null,
      peakSeries: null,
      total: null,
    };
    expect(hostRowDisplay("swap", notAvailable)).toMatchObject({
      label: "Swap",
      value: "n/a",
      suffix: null,
    });
    expect(hostRowDisplay("gpu", { ...notAvailable, availability: "sleeping" })).toMatchObject({
      label: "GPU",
      value: "asleep",
    });
    expect(hostServersLine(notAvailable)).toEqual({ text: "servers n/a", title: null });
  });
});

describe("Hosts dock trust states", () => {
  it("dims a stale host and names the age of its last reading", () => {
    const stale = hostView(fleetViews(), "arch-laptop");
    expect(stale.state).toBe("stale");
    expect(hostIsDimmed(stale)).toBe(true);
    expect(hostStatusLine(stale)).toEqual({ text: "Stale · last reading 3m ago" });
  });

  it("dims an offline host and names the age of its last reading", () => {
    const offline = hostView(fleetViews(), "conversa");
    expect(offline.state).toBe("offline");
    expect(hostIsDimmed(offline)).toBe(true);
    expect(hostStatusLine(offline)).toEqual({ text: "Offline · last reading 14m ago" });
  });

  it("tells the user to update Mesura Code on a host without the stream", () => {
    const old = hostView(fleetViews(), "old-box");
    expect(old.state).toBe("needs-update");
    expect(old.rows).toBeNull();
    expect(hostStatusLine(old)).toEqual({ text: "Update Mesura Code on this host" });
    expect(hostIsDimmed(old)).toBe(false);
  });

  it("host stats view: a host that refused this device says so, dims what it held and adds no agents", () => {
    // Its last reading is 20 s old with 4 agents: fresh, yet not current.
    const fleet = withNoAccessHost(
      hostStatsFleet(NOW),
      hostHistory({ now: NOW, latestAgeMs: 20 * SECOND }),
    );
    const views = projectFleet(fleet, NOW);
    const refused = hostView(views, NO_ACCESS_HOST_ID);
    expect(refused.state).toBe("no-access");
    expect(hostStatusLine(refused)).toEqual({ text: "No access · pair again with full access" });
    expect(hostIsDimmed(refused)).toBe(true);
    expect(hostShowsUptime(refused)).toBe(false);
    expect(hostFleetSummary(views)).toBe("4 of 5 online · 4 agents running");
  });

  it("host stats view: a host that refused this device before any reading says so too", () => {
    const refused = hostView(
      projectFleet(withNoAccessHost(hostStatsFleet(NOW)), NOW),
      NO_ACCESS_HOST_ID,
    );
    expect(refused.rows).toBeNull();
    expect(hostStatusLine(refused)).toEqual({ text: "No access · pair again with full access" });
  });

  it("gives a live host no status line and full strength", () => {
    const live = hostView(fleetViews(), "vigilia-home");
    expect(live.state).toBe("live");
    expect(hostStatusLine(live)).toBeNull();
    expect(hostIsDimmed(live)).toBe(false);
  });

  it("says a pending host is waiting and an unread offline host has no reading", () => {
    const live = hostView(fleetViews(), "vigilia-home");
    expect(
      hostStatusLine({ ...live, state: "pending", rows: null, lastReadingAgeMs: null }),
    ).toEqual({ text: "Waiting for the first reading" });
    expect(
      hostStatusLine({ ...live, state: "offline", rows: null, lastReadingAgeMs: null }),
    ).toEqual({ text: "Offline · no reading this session" });
  });

  // Review P1-1 (phase 6): a history a client held across a released
  // subscription is recent but not current. It never reads as live, whatever
  // its age, and its agents never count toward the live total.
  function heldFleetViews(nowLocal = NOW) {
    const fleet = hostStatsFleet(NOW);
    const subscriptions = new Map(
      [...fleet.subscriptions].map(([environmentId, subscription]) => [
        environmentId,
        { ...subscription, held: true },
      ]),
    );
    return projectFleet({ ...fleet, subscriptions }, nowLocal);
  }

  it("host stats view: a held reading within the stale threshold reads as updating, with its age", () => {
    const held = hostView(heldFleetViews(NOW + 60 * SECOND), "vigilia-home");
    expect(held.state).toBe("updating");
    expect(held.rows).not.toBeNull();
    expect(hostIsDimmed(held)).toBe(true);
    expect(hostStatusLine(held)).toEqual({ text: "Updating · last reading 1m ago" });
  });

  it("host stats view: a held reading past the stale threshold reads as stale, and offline stays offline", () => {
    expect(hostView(heldFleetViews(), "arch-laptop").state).toBe("stale");
    expect(hostView(heldFleetViews(), "conversa").state).toBe("offline");
  });

  it("host stats view: a held reading's agents do not count toward the live total", () => {
    expect(hostFleetSummary(heldFleetViews())).toBe("3 of 4 online · 0 agents running");
  });

  it("counts connected hosts as online and sums agents from live readings only", () => {
    // Review P1-2: online is the connection. The stale and the outdated host
    // are both connected; only the live host's agent count is current.
    expect(hostFleetSummary(fleetViews())).toBe("3 of 4 online · 4 agents running");
    const live = hostView(fleetViews(), "vigilia-home");
    const oneAgent = {
      ...live,
      rows: { ...live.rows!, agents: { ...live.rows!.agents, value: 1 } },
    };
    expect(hostFleetSummary([oneAgent])).toBe("1 of 1 online · 1 agent running");
    const outdatedOffline = { ...hostView(fleetViews(), "old-box"), connected: false };
    expect(hostFleetSummary([outdatedOffline])).toBe("0 of 1 online · 0 agents running");
  });
});

describe("Hosts dock sparklines", () => {
  it("splits a series into the runs between its gaps", () => {
    expect(sparklineRuns([10, 20, null, 30, 40])).toEqual([
      [0, 1],
      [3, 4],
    ]);
    expect(sparklineRuns([null, 5, null])).toEqual([[1, 1]]);
    expect(sparklineRuns([null, null])).toEqual([]);
  });

  it("breaks the line at every gap instead of bridging it", () => {
    const path = sparklinePath([10, 20, null, 30, 40], { height: 20, max: 100 });
    expect(path.match(/M/g)).toHaveLength(2);
    // The second run starts at slot 3 of 5: x = 3 / 4 of the 100-wide viewBox.
    expect(path).toMatch(/M75,/);
  });

  it("still draws a reading that stands alone between two gaps", () => {
    const path = sparklinePath([null, 5, null], { height: 20, max: 100 });
    expect(path.match(/M/g)).toHaveLength(1);
    expect(path).toMatch(/^M[\d.]+,[\d.]+[HhLl]/);
    expect(sparklinePath([null, null], { height: 20, max: 100 })).toBe("");
  });

  it("draws the agents series as steps", () => {
    const path = sparklinePath([1, 2, 3], { height: 16, max: 3, step: true });
    expect(path).toContain("H");
    expect(path).toContain("V");
    expect(path).not.toContain("L");
  });

  it("scales percent rows to 100, network to its own peak and agents to at least 3", () => {
    expect(sparklineMax("cpu", [20, 40])).toBe(100);
    expect(sparklineMax("memory", [20, 40])).toBe(100);
    expect(sparklineMax("gpu", [20, 40])).toBe(100);
    expect(sparklineMax("network", [1_000, 5_000, null])).toBe(5_000);
    expect(sparklineMax("network", [0, null])).toBeGreaterThan(0);
    expect(sparklineMax("agents", [1, 2])).toBe(3);
    expect(sparklineMax("agents", [5, 9])).toBe(9);
  });

  it("maps a pointer position to the nearest slot, clamped to the window", () => {
    expect(sparklineSlotAt(0, SLOTS)).toBe(0);
    expect(sparklineSlotAt(1, SLOTS)).toBe(SLOTS - 1);
    expect(sparklineSlotAt(0.5, SLOTS)).toBe(72);
    expect(sparklineSlotAt(-0.2, SLOTS)).toBe(0);
    expect(sparklineSlotAt(1.3, SLOTS)).toBe(SLOTS - 1);
  });

  it("reads a hovered bucket as its host-clock time and value", () => {
    const live = hostView(fleetViews(), "vigilia-home");
    expect(sparklineReading(live, "cpu", 0, "UTC")).toEqual({
      time: "00:05–00:10",
      value: "20%",
    });
    expect(sparklineReading(live, "memory", 0, "UTC")?.value).toBe("47%");
    expect(sparklineReading(live, "temperature", 0, "UTC")?.value).toBe("50°C");
    expect(sparklineReading(live, "network", 0, "UTC")?.value).toBe("12 KB/s");
    expect(sparklineReading(live, "agents", SLOTS - 1, "UTC")).toEqual({
      time: "12:00–12:05",
      value: "4 running",
    });
  });

  it("reads a hovered gap as no reading, and a bar row as nothing to hover", () => {
    const live = hostView(fleetViews(), "vigilia-home");
    expect(sparklineReading(live, "cpu", PRIMARY_GAP_SLOTS[0], "UTC")).toEqual({
      time: "08:25–08:30",
      value: "no reading",
    });
    expect(sparklineReading(live, "swap", 0, "UTC")).toBeNull();
  });
});

describe("Hosts dock age clock", () => {
  function harness() {
    let now = NOW;
    let nextHandle = 0;
    const pending = new Map<number, { readonly at: number; readonly callback: () => void }>();
    const ticks: number[] = [];
    const clock = createHostStatsAgeClock({
      intervalMs: HOST_STATS_AGE_REFRESH_MS,
      now: () => now,
      schedule: (callback, delayMs) => {
        const handle = ++nextHandle;
        pending.set(handle, { at: now + delayMs, callback });
        return handle;
      },
      cancel: (handle) => pending.delete(handle as number),
      onTick: (nowLocal) => ticks.push(nowLocal),
    });
    const advance = (ms: number) => {
      const until = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, entry]) => entry.at <= until)
          .toSorted((left, right) => left[1].at - right[1].at)[0];
        if (due === undefined) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = until;
    };
    return { clock, ticks, pending, advance };
  }

  it("refreshes the hosts dock ages every 15 seconds while it is open", () => {
    expect(HOST_STATS_AGE_REFRESH_MS).toBe(15_000);
    const { clock, ticks, advance } = harness();
    clock.setOpen(true);
    advance(60 * SECOND);
    expect(ticks).toEqual([
      NOW,
      NOW + 15 * SECOND,
      NOW + 30 * SECOND,
      NOW + 45 * SECOND,
      NOW + 60 * SECOND,
    ]);
    clock.dispose();
  });

  it("schedules nothing while the hosts dock is closed", () => {
    const { clock, ticks, pending, advance } = harness();
    advance(10 * MINUTE);
    expect(ticks).toEqual([]);
    expect(pending.size).toBe(0);
    clock.setOpen(true);
    clock.setOpen(false);
    expect(pending.size).toBe(0);
    advance(10 * MINUTE);
    expect(ticks).toEqual([NOW + 10 * MINUTE]);
  });

  it("never refreshes the hosts dock ages twice within 15 seconds across a reopen", () => {
    const { clock, ticks, advance } = harness();
    clock.setOpen(true);
    advance(5 * SECOND);
    clock.setOpen(false);
    advance(2 * SECOND);
    clock.setOpen(true);
    advance(30 * SECOND);
    clock.setOpen(false);
    advance(MINUTE);
    clock.setOpen(true);
    for (let index = 1; index < ticks.length; index += 1) {
      expect(ticks[index]! - ticks[index - 1]!).toBeGreaterThanOrEqual(HOST_STATS_AGE_REFRESH_MS);
    }
    // Reopened a minute after the last refresh: the ages are fresh at once.
    expect(ticks.at(-1)).toBe(NOW + 5 * SECOND + 2 * SECOND + 30 * SECOND + MINUTE);
    clock.dispose();
  });
});
