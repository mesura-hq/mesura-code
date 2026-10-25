import { describe, expect, it } from "vite-plus/test";

import { createTouchLongPress, TOUCH_LONG_PRESS_MS } from "./touchLongPress";

function harness() {
  const timers = new Map<number, () => void>();
  let nextHandle = 0;
  const fired: string[] = [];
  const press = createTouchLongPress({
    onLongPress: () => fired.push("long-press"),
    schedule: (callback, delayMs) => {
      expect(delayMs).toBe(TOUCH_LONG_PRESS_MS);
      nextHandle += 1;
      timers.set(nextHandle, callback);
      return nextHandle;
    },
    cancel: (handle) => timers.delete(handle as number),
    vibrate: () => fired.push("vibrate"),
  });
  const runTimers = () => {
    for (const [handle, callback] of timers) {
      timers.delete(handle);
      callback();
    }
  };
  const cancelable = () => {
    const calls: string[] = [];
    return {
      calls,
      event: {
        detail: 1,
        preventDefault: () => calls.push("preventDefault"),
        stopPropagation: () => calls.push("stopPropagation"),
      },
    };
  };
  return { press, fired, runTimers, timers, cancelable };
}

const finger = (x = 0, y = 0, pointerId = 1) => ({
  pointerType: "touch",
  pointerId,
  clientX: x,
  clientY: y,
});

describe("createTouchLongPress", () => {
  it("fires once the finger stays down past the delay, with a short vibration", () => {
    const { press, fired, runTimers } = harness();
    press.onPointerDown(finger());
    runTimers();
    expect(fired).toEqual(["vibrate", "long-press"]);
  });

  it("swallows the click that follows a fired press, and only that one", () => {
    const { press, runTimers, cancelable } = harness();
    press.onPointerDown(finger());
    runTimers();
    press.onPointerUp(finger());
    const first = cancelable();
    press.onClickCapture(first.event);
    expect(first.calls).toEqual(["preventDefault", "stopPropagation"]);
    const second = cancelable();
    press.onClickCapture(second.event);
    expect(second.calls).toEqual([]);
  });

  it("lets a short tap's click through", () => {
    const { press, fired, timers, cancelable } = harness();
    press.onPointerDown(finger());
    press.onPointerUp(finger());
    expect(timers.size).toBe(0);
    const click = cancelable();
    press.onClickCapture(click.event);
    expect(click.calls).toEqual([]);
    expect(fired).toEqual([]);
  });

  it("cancels when the finger travels past the slop, as a scroll does", () => {
    const { press, timers } = harness();
    press.onPointerDown(finger(0, 0));
    press.onPointerMove(finger(0, 8));
    expect(timers.size).toBe(1);
    press.onPointerMove(finger(0, 11));
    expect(timers.size).toBe(0);
  });

  it("ignores a mouse and a pen entirely", () => {
    const { press, timers } = harness();
    press.onPointerDown({ ...finger(), pointerType: "mouse" });
    press.onPointerDown({ ...finger(), pointerType: "pen" });
    expect(timers.size).toBe(0);
  });

  it("swallows the context menu only while a finger is down", () => {
    const { press, runTimers, cancelable } = harness();
    const idle = cancelable();
    press.onContextMenu(idle.event);
    expect(idle.calls).toEqual([]);
    press.onPointerDown(finger());
    const pending = cancelable();
    press.onContextMenu(pending.event);
    expect(pending.calls).toEqual(["preventDefault"]);
    runTimers();
    const fired = cancelable();
    press.onContextMenu(fired.event);
    expect(fired.calls).toEqual(["preventDefault"]);
    press.onPointerUp(finger());
    const afterLift = cancelable();
    press.onContextMenu(afterLift.event);
    expect(afterLift.calls).toEqual([]);
  });

  it("loses no later input when the browser sends no click after a fired press", () => {
    const { press, runTimers, cancelable } = harness();
    press.onPointerDown(finger());
    runTimers();
    press.onPointerCancel(finger());
    const keyboard = cancelable();
    press.onClickCapture({ ...keyboard.event, detail: 0 });
    expect(keyboard.calls).toEqual([]);
    press.onPointerDown({ ...finger(), pointerType: "mouse" });
    press.onPointerUp({ ...finger(), pointerType: "mouse" });
    const mouse = cancelable();
    press.onClickCapture(mouse.event);
    expect(mouse.calls).toEqual([]);
    const rightClick = cancelable();
    press.onContextMenu(rightClick.event);
    expect(rightClick.calls).toEqual([]);
  });

  it("drops a pending press on pointer cancel and on dispose", () => {
    const { press, timers, fired } = harness();
    press.onPointerDown(finger());
    press.onPointerCancel(finger());
    expect(timers.size).toBe(0);
    press.onPointerDown(finger());
    press.dispose();
    expect(timers.size).toBe(0);
    expect(fired).toEqual([]);
  });
});
