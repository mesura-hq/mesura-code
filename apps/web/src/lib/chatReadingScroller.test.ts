import { describe, expect, it } from "vite-plus/test";

import { READING_SCROLL_DURATION_MS } from "./chatReadingScroll";
import {
  type ChatReadingScrollerOptions,
  createChatReadingScroller,
  type ReadingScrollNode,
} from "./chatReadingScroller";

interface Harness {
  readonly node: ReadingScrollNode & { scrollTop: number };
  readonly listeners: Map<string, Array<() => void>>;
  readonly breaks: number[];
  /** Runs pending frames, advancing the clock by `stepMs` before each. */
  readonly runFrames: (count: number, stepMs?: number) => void;
  readonly pendingFrames: () => number;
  setReducedMotion: (value: boolean) => void;
}

function makeHarness(
  overrides: {
    scrollTop?: number;
    clientHeight?: number;
    scrollHeight?: number;
    composerOverlayHeight?: number;
  } = {},
): Harness & { scroller: ReturnType<typeof createChatReadingScroller> } {
  const listeners = new Map<string, Array<() => void>>();
  const node = {
    scrollTop: overrides.scrollTop ?? 1000,
    clientHeight: overrides.clientHeight ?? 800,
    scrollHeight: overrides.scrollHeight ?? 10000,
    addEventListener(type: string, listener: () => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((entry) => entry !== listener),
      );
    },
  };

  const breaks: number[] = [];
  let clock = 0;
  let reducedMotion = false;
  let nextHandle = 1;
  const frames = new Map<number, () => void>();

  const options: ChatReadingScrollerOptions = {
    getScrollNode: () => node,
    getComposerOverlayHeight: () => overrides.composerOverlayHeight ?? 0,
    onBreakLiveFollow: () => breaks.push(clock),
    prefersReducedMotion: () => reducedMotion,
    now: () => clock,
    requestFrame: (callback) => {
      const handle = nextHandle;
      nextHandle += 1;
      frames.set(handle, callback);
      return handle;
    },
    cancelFrame: (handle) => {
      frames.delete(handle);
    },
  };

  return {
    node,
    listeners,
    breaks,
    scroller: createChatReadingScroller(options),
    pendingFrames: () => frames.size,
    setReducedMotion: (value: boolean) => {
      reducedMotion = value;
    },
    runFrames: (count: number, stepMs = 16) => {
      for (let index = 0; index < count; index += 1) {
        const [handle, callback] = [...frames.entries()][0] ?? [];
        if (handle === undefined || !callback) return;
        frames.delete(handle);
        clock += stepMs;
        callback();
      }
    },
  };
}

describe("createChatReadingScroller", () => {
  it("breaks live-follow when scrolling up and never when scrolling down", () => {
    // Direction matters: a downward move travels toward the live edge, so
    // breaking follow there would stop streaming from tracking for no reason.
    const up = makeHarness();
    up.scroller.scroll("up");
    expect(up.breaks).toHaveLength(1);

    const down = makeHarness();
    down.scroller.scroll("down");
    expect(down.breaks).toHaveLength(0);
  });

  it("lands exactly on the target and stops requesting frames", () => {
    const harness = makeHarness();
    harness.scroller.scroll("down");
    harness.runFrames(40, READING_SCROLL_DURATION_MS);

    expect(harness.node.scrollTop).toBe(1400);
    expect(harness.pendingFrames()).toBe(0);
  });

  it("cancels the frame in flight when a second press arrives", () => {
    const harness = makeHarness();
    harness.scroller.scroll("down");
    harness.runFrames(1);
    expect(harness.pendingFrames()).toBe(1);

    harness.scroller.scroll("down");
    // Still one loop, not two racing each other over the same scrollTop.
    expect(harness.pendingFrames()).toBe(1);

    harness.runFrames(40, READING_SCROLL_DURATION_MS);
    // Two presses travel two half-viewports, because the second re-targets
    // off the first one's destination rather than off the live position.
    expect(harness.node.scrollTop).toBe(1800);
  });

  it("jumps without animating under reduced motion", () => {
    const harness = makeHarness();
    harness.setReducedMotion(true);
    harness.scroller.scroll("down");

    expect(harness.node.scrollTop).toBe(1400);
    expect(harness.pendingFrames()).toBe(0);
  });

  it("yields to a real scroll gesture mid-animation", () => {
    const harness = makeHarness();
    harness.scroller.scroll("down");
    harness.runFrames(1);
    const positionWhenUserTookOver = harness.node.scrollTop;

    for (const listener of harness.listeners.get("wheel") ?? []) listener();

    expect(harness.pendingFrames()).toBe(0);
    harness.runFrames(10);
    expect(harness.node.scrollTop).toBe(positionWhenUserTookOver);
  });

  it("releases its gesture listeners once the animation completes", () => {
    const harness = makeHarness();
    harness.scroller.scroll("down");
    harness.runFrames(40, READING_SCROLL_DURATION_MS);

    for (const type of ["wheel", "touchstart", "pointerdown"]) {
      expect(harness.listeners.get(type) ?? []).toHaveLength(0);
    }
  });

  it("cancels everything on dispose", () => {
    const harness = makeHarness();
    harness.scroller.scroll("down");
    harness.runFrames(1);

    harness.scroller.dispose();

    expect(harness.pendingFrames()).toBe(0);
    expect(harness.listeners.get("wheel") ?? []).toHaveLength(0);
  });

  it("does nothing when the list has not mounted", () => {
    const scroller = createChatReadingScroller({
      getScrollNode: () => null,
      getComposerOverlayHeight: () => 0,
      onBreakLiveFollow: () => {
        throw new Error("must not break live-follow without a scroll node");
      },
      prefersReducedMotion: () => false,
      now: () => 0,
      requestFrame: () => {
        throw new Error("must not animate without a scroll node");
      },
      cancelFrame: () => {},
    });

    expect(() => scroller.scroll("up")).not.toThrow();
  });

  it("still travels when the composer covers almost the whole timeline", () => {
    // Subtracting the overlay would leave 20px of readable height here, which
    // rounds the trip to nothing and makes the shortcut a silent no-op.
    const harness = makeHarness({ clientHeight: 800, composerOverlayHeight: 780 });
    harness.scroller.scroll("down");
    harness.runFrames(40, READING_SCROLL_DURATION_MS);

    expect(harness.node.scrollTop).toBe(1200);
  });

  it("stops at the end of the content instead of overrunning it", () => {
    const harness = makeHarness({ scrollTop: 9100, scrollHeight: 10000, clientHeight: 800 });
    harness.scroller.scroll("down");
    harness.runFrames(40, READING_SCROLL_DURATION_MS);

    expect(harness.node.scrollTop).toBe(9200);
  });

  it("is inert once already parked at the end", () => {
    const harness = makeHarness({ scrollTop: 9200, scrollHeight: 10000, clientHeight: 800 });
    harness.scroller.scroll("down");

    expect(harness.pendingFrames()).toBe(0);
    expect(harness.node.scrollTop).toBe(9200);
  });
});
