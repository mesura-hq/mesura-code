import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { dispatchPickerAction, subscribePickerAction } from "./pickerActionBus";

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

describe("pickerActionBus", () => {
  it("delivers an action to the picker that asked for it", () => {
    let calls = 0;
    const stop = subscribePickerAction("traits", () => {
      calls += 1;
    });

    dispatchPickerAction("traits");
    expect(calls).toBe(1);

    stop();
  });

  it("never delivers one picker's action to another", () => {
    // The three pickers share one event name, so a missing detail check would
    // make alt+w open the traits menu as well as the workspace one.
    const seen: string[] = [];
    const stopTraits = subscribePickerAction("traits", () => seen.push("traits"));
    const stopWorkspace = subscribePickerAction("workspace", () => seen.push("workspace"));
    const stopBranch = subscribePickerAction("branch", () => seen.push("branch"));

    dispatchPickerAction("workspace");

    expect(seen).toEqual(["workspace"]);
    stopTraits();
    stopWorkspace();
    stopBranch();
  });

  it("stops delivering once unsubscribed", () => {
    // The unsubscribe path is the leak-prone one: the workspace picker
    // resubscribes whenever it locks or unlocks, so a listener outliving its
    // subscription would toggle a control that is no longer editable.
    let calls = 0;
    const stop = subscribePickerAction("branch", () => {
      calls += 1;
    });

    dispatchPickerAction("branch");
    stop();
    dispatchPickerAction("branch");

    expect(calls).toBe(1);
  });
});
