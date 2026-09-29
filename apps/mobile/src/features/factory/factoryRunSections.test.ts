/**
 * Review P2-1 of phase 10: the Android Run tab re-renders only the phases a
 * stream item moved. Its phase sections are memoized on the section objects
 * `deriveFactoryRunSections` returns, so this pins that a section the item
 * did not change stays identical, as the phone receives items: decoded, with
 * no object shared with the previous item.
 */
import type { FactoryRunState, FactoryRunStreamItem } from "@t3tools/contracts";
import { makeFactoryRunState } from "@t3tools/client-runtime/factory/testing";
import { describe, expect, it } from "vite-plus/test";

import { deriveFactoryRunSections } from "./factoryRunSections";
import { readFactoryRunEventsFixture } from "./factoryRun.test-support";

const events = readFactoryRunEventsFixture();
const decodedAt = (point: "verify" | "review" | "degraded"): FactoryRunStreamItem => ({
  state: JSON.parse(JSON.stringify(makeFactoryRunState(events, point))) as FactoryRunState,
  roles: [],
});
const NO_OVERRIDES = new Map<number, boolean>();

describe("phase10 android run sections review regressions", () => {
  it("phase10 android run sections P2-1 keep a folded phase's section identical when an item moves another phase", () => {
    const first = deriveFactoryRunSections(decodedAt("verify"), NO_OVERRIDES, null);
    const second = deriveFactoryRunSections(decodedAt("review"), NO_OVERRIDES, first);

    expect(first.sections.map((section) => section.view === null)).toEqual([false, true]);
    expect(second.sections[1]).toBe(first.sections[1]);
    expect(second.sections[0]).not.toBe(first.sections[0]);
  });

  it("phase10 android run sections P2-1 keep an open phase's section identical when an item leaves it unchanged", () => {
    const opened = new Map([[1, true]]);
    const first = deriveFactoryRunSections(decodedAt("degraded"), opened, null);
    const second = deriveFactoryRunSections(decodedAt("degraded"), opened, first);

    expect(first.sections[0]?.view).not.toBeNull();
    expect(second.sections[0]).toBe(first.sections[0]);
    expect(second.sections[1]).toBe(first.sections[1]);
  });

  it("phase10 android run sections P2-1 replace only the section the reader opened or folded", () => {
    const item = decodedAt("degraded");
    const first = deriveFactoryRunSections(item, NO_OVERRIDES, null);
    const second = deriveFactoryRunSections(item, new Map([[2, true]]), first);

    expect(second.sections[0]).toBe(first.sections[0]);
    expect(second.sections[1]).not.toBe(first.sections[1]);
    expect(second.sections[1]?.view).not.toBeNull();
  });
});
