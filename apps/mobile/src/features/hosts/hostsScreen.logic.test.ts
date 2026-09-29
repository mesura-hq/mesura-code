/**
 * The mobile Hosts screen's own logic, over histories folded from real
 * snapshot messages: what a return shows before fresh data arrives, what a
 * pull resubscribes, and what a screen reader hears for a coloured row.
 */
import { projectHostStats } from "@t3tools/client-runtime/host-stats";
import {
  SECOND,
  hostHistory,
  hostPresentation,
  hostStatsFleet,
} from "@t3tools/client-runtime/host-stats/fixtures";
import { hostRowDisplay } from "@t3tools/client-runtime/host-stats/view";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  holdLastReadings,
  hostBarFillClass,
  hostRowAccessibilityLabel,
  hostsToResubscribe,
  nextHeldReadings,
} from "./hostsScreen.logic";

const NOW = Date.parse("2026-09-29T12:02:30.000Z");
const HOME = EnvironmentId.make("vigilia-home");
const LAPTOP = EnvironmentId.make("arch-laptop");

describe("readings held across a released subscription", () => {
  it("hosts logic: a restarted subscription with no history shows the held one, marked held, keeping its failure", () => {
    const held = hostHistory({ now: NOW, latestAgeMs: 20 * SECOND });

    const merged = holdLastReadings(
      new Map([[HOME, held]]),
      new Map([[HOME, { history: null, failed: true }]]),
    );

    expect(merged.get(HOME)).toEqual({ history: held, failed: true, held: true });
  });

  it("hosts logic: a delivered history wins over the held one", () => {
    const held = hostHistory({ now: NOW - 60 * SECOND, latestAgeMs: 20 * SECOND });
    const fresh = { history: hostHistory({ now: NOW, latestAgeMs: 5 * SECOND }), failed: false };

    const merged = holdLastReadings(new Map([[HOME, held]]), new Map([[HOME, fresh]]));

    expect(merged.get(HOME)).toBe(fresh);
  });

  it("hosts logic: with no subscription read, every held history shows", () => {
    const held = hostHistory({ now: NOW, latestAgeMs: 20 * SECOND });

    expect(holdLastReadings(new Map([[LAPTOP, held]]), new Map()).get(LAPTOP)).toEqual({
      history: held,
      failed: false,
      held: true,
    });
  });

  it("hosts logic: the held readings change only when a subscription delivers a new history", () => {
    const first = hostHistory({ now: NOW, latestAgeMs: 20 * SECOND });
    const held = new Map([[HOME, first]]);

    expect(nextHeldReadings(held, new Map([[HOME, { history: first, failed: false }]]))).toBe(held);
    expect(nextHeldReadings(held, new Map([[HOME, { history: null, failed: true }]]))).toBe(held);

    const second = hostHistory({ now: NOW + 60 * SECOND, latestAgeMs: 5 * SECOND });
    const next = nextHeldReadings(held, new Map([[LAPTOP, { history: second, failed: false }]]));
    expect(next).not.toBe(held);
    expect([...next]).toEqual([
      [HOME, first],
      [LAPTOP, second],
    ]);
  });
});

describe("what a pull to refresh resubscribes", () => {
  it("hosts logic: a pull resubscribes the connected environments only", () => {
    const fleet = hostStatsFleet(NOW);

    expect([...hostsToResubscribe(fleet.presentations)].toSorted()).toEqual([
      "arch-laptop",
      "old-box",
      "vigilia-home",
    ]);
  });
});

describe("what a screen reader hears for a row", () => {
  function primaryRows(sample: Parameters<typeof hostHistory>[0]["sample"]) {
    const presentation = hostPresentation({ id: "vigilia-home", primary: true });
    const [view] = projectHostStats({
      presentations: new Map([[HOME, presentation]]),
      subscriptions: new Map([
        [HOME, { history: hostHistory({ now: NOW, latestAgeMs: 0, sample }), failed: false }],
      ]),
      nowLocal: NOW,
    });
    return view!.rows!;
  }

  it("hosts logic: a row reads its label, value and suffix, and no level when healthy", () => {
    const rows = primaryRows({});

    expect(hostRowAccessibilityLabel(hostRowDisplay("cpu", rows.cpu), rows.cpu)).toBe(
      "CPU 17% ld 2.5",
    );
  });

  it("hosts logic: a row names its level in words", () => {
    const rows = primaryRows({ cpuPercent: 97, cpuTemperatureC: 88 });

    expect(hostRowAccessibilityLabel(hostRowDisplay("cpu", rows.cpu), rows.cpu)).toBe(
      "CPU 97% ld 2.5, critical",
    );
    expect(
      hostRowAccessibilityLabel(hostRowDisplay("temperature", rows.temperature), rows.temperature),
    ).toBe("Temp 88°C, warning");
  });

  it("hosts logic: the processor row names the load level when it is the worse one", () => {
    // 20 of 16 cores' load is 1.25 per core, amber, while 17 % busy is fine.
    const rows = primaryRows({ load1: 20 });

    expect(hostRowAccessibilityLabel(hostRowDisplay("cpu", rows.cpu), rows.cpu)).toBe(
      "CPU 17% ld 20.0, warning",
    );
  });
});

describe("hosts screen bar fills", () => {
  it("hosts logic: warning and critical bars fill with the Usage meter's solid amber and red", () => {
    // The theme's `bg-warning` and `bg-danger` are pale surface tints: a 98 % swap bar read pale pink.
    expect(hostBarFillClass("crit")).toBe("bg-red-500");
    expect(hostBarFillClass("warn")).toBe("bg-amber-500");
    expect(hostBarFillClass("ok")).toBe("bg-foreground-muted");
    expect(hostBarFillClass(null)).toBe("bg-foreground-muted");
  });
});

describe("a refused subscription over held readings", () => {
  it("hosts logic: a refused subscription with no history keeps its refusal over the held reading", () => {
    const held = hostHistory({ now: NOW, latestAgeMs: 20 * SECOND });
    const merged = holdLastReadings(
      new Map([[HOME, held]]),
      new Map([[HOME, { history: null, failed: true, unauthorized: true }]]),
    );
    expect(merged.get(HOME)).toEqual({
      history: held,
      failed: true,
      unauthorized: true,
      held: true,
    });
  });
});
