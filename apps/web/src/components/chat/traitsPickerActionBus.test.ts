import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { dispatchTraitsPickerToggle, subscribeTraitsPickerToggle } from "./traitsPickerActionBus";

// This package's unit suite runs on Node with no DOM, and the bus guards on
// `typeof window`. An EventTarget is the whole surface it uses, so standing one
// up is enough to exercise the real dispatch and subscribe paths.
const globalWithWindow = globalThis as { window?: EventTarget };
const hadWindow = "window" in globalWithWindow;

beforeAll(() => {
  if (!hadWindow) globalWithWindow.window = new EventTarget();
});

afterAll(() => {
  if (!hadWindow) delete globalWithWindow.window;
});

describe("traitsPickerActionBus", () => {
  it("delivers a dispatch to a subscriber", () => {
    let calls = 0;
    const stop = subscribeTraitsPickerToggle(() => {
      calls += 1;
    });

    dispatchTraitsPickerToggle();
    expect(calls).toBe(1);

    stop();
  });

  it("stops delivering once unsubscribed", () => {
    // The unsubscribe path is the leak-prone one: the picker resubscribes
    // whenever its visibility changes, so a listener that outlives its
    // subscription would toggle a menu belonging to an unmounted composer.
    let calls = 0;
    const stop = subscribeTraitsPickerToggle(() => {
      calls += 1;
    });

    dispatchTraitsPickerToggle();
    stop();
    dispatchTraitsPickerToggle();

    expect(calls).toBe(1);
  });

  it("delivers to every subscriber", () => {
    // Documents the contract deliberately: the bus is unscoped, so it reaches
    // all subscribers. Only the composer's picker opts in
    // (renderProviderTraitsPicker sets respondsToShortcut), and the composer
    // renders either the picker or its compact menu, never both. A second
    // simultaneous subscriber would mean that invariant broke.
    const seen: string[] = [];
    const stopFirst = subscribeTraitsPickerToggle(() => seen.push("first"));
    const stopSecond = subscribeTraitsPickerToggle(() => seen.push("second"));

    dispatchTraitsPickerToggle();

    expect(seen).toEqual(["first", "second"]);
    stopFirst();
    stopSecond();
  });
});
