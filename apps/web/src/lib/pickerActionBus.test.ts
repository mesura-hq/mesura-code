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

  it("never delivers one action to another target", () => {
    // Every target shares one event name, so a missing detail check would make
    // alt+w open the traits menu as well as the workspace one. The question
    // fold is the costliest of these to get wrong: it is the only subscriber
    // that is mounted while the user reads, so a stray delivery hides the very
    // question they are answering.
    const seen: string[] = [];
    const stopTraits = subscribePickerAction("traits", () => seen.push("traits"));
    const stopWorkspace = subscribePickerAction("workspace", () => seen.push("workspace"));
    const stopBranch = subscribePickerAction("branch", () => seen.push("branch"));
    const stopQuestion = subscribePickerAction("question", () => seen.push("question"));

    dispatchPickerAction("workspace");
    dispatchPickerAction("question");

    expect(seen).toEqual(["workspace", "question"]);
    stopTraits();
    stopWorkspace();
    stopBranch();
    stopQuestion();
  });

  it("delivers to every subscriber of the same action", () => {
    // Documents the fan-out invariant the callers rely on: a composer renders
    // either the traits picker or its compact menu, never both, and one
    // branch toolbar is mounted at a time. A second simultaneous subscriber
    // means one of those invariants broke.
    const seen: string[] = [];
    const stopFirst = subscribePickerAction("traits", () => seen.push("first"));
    const stopSecond = subscribePickerAction("traits", () => seen.push("second"));

    dispatchPickerAction("traits");

    expect(seen).toEqual(["first", "second"]);
    stopFirst();
    stopSecond();
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
