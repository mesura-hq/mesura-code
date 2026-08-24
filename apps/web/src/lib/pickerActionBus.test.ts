import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

import { dispatchPickerAction, subscribePickerAction, type PickerAction } from "./pickerActionBus";

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
  // Every subscription goes through `track`, and cleanup runs from afterEach
  // rather than from the end of each test body. One shared EventTarget serves
  // the whole file, so a failing assertion — which skips whatever cleanup
  // follows it — would otherwise leak listeners into the next test and make it
  // fail for a reason of its own, hiding the real one.
  const active: Array<() => void> = [];
  const track = (action: PickerAction, listener: () => void) => {
    const stop = subscribePickerAction(action, listener);
    active.push(stop);
    return stop;
  };

  afterEach(() => {
    while (active.length > 0) active.pop()?.();
  });

  it("delivers an action to the picker that asked for it", () => {
    let calls = 0;
    track("traits", () => {
      calls += 1;
    });

    dispatchPickerAction("traits");
    expect(calls).toBe(1);
  });

  it("never delivers one action to another target", () => {
    // Every target shares one event name, so a missing detail check would make
    // alt+w open the traits menu as well as the workspace one. The question
    // fold is the costliest of these to get wrong: it is the only subscriber
    // that is mounted while the user reads, so a stray delivery hides the very
    // question they are answering.
    const seen: string[] = [];
    track("traits", () => seen.push("traits"));
    track("workspace", () => seen.push("workspace"));
    track("branch", () => seen.push("branch"));
    track("question", () => seen.push("question"));

    dispatchPickerAction("workspace");
    dispatchPickerAction("question");

    expect(seen).toEqual(["workspace", "question"]);
  });

  it("delivers to every subscriber of the same action", () => {
    // Documents the fan-out invariant the callers rely on: a composer renders
    // either the traits picker or its compact menu, never both, and one
    // branch toolbar is mounted at a time. A second simultaneous subscriber
    // means one of those invariants broke.
    const seen: string[] = [];
    track("traits", () => seen.push("first"));
    track("traits", () => seen.push("second"));

    dispatchPickerAction("traits");

    expect(seen).toEqual(["first", "second"]);
  });

  it("stops delivering once unsubscribed", () => {
    // The unsubscribe path is the leak-prone one: the workspace picker
    // resubscribes whenever it locks or unlocks, so a listener outliving its
    // subscription would toggle a control that is no longer editable.
    let calls = 0;
    const stop = track("branch", () => {
      calls += 1;
    });

    dispatchPickerAction("branch");
    stop();
    dispatchPickerAction("branch");

    expect(calls).toBe(1);
  });
});
