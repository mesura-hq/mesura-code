import {
  MIN_READABLE_HEIGHT,
  READING_SCROLL_DURATION_MS,
  type ReadingScrollDirection,
  readingScrollPositionAt,
  resolveReadingScrollTarget,
} from "./chatReadingScroll";

/** The part of a scroll container this scroller reads and writes. */
export interface ReadingScrollNode {
  scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
  addEventListener(type: string, listener: () => void, options?: { passive?: boolean }): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface ChatReadingScrollerOptions {
  /** The timeline's scroll container, or null before the list has mounted. */
  readonly getScrollNode: () => ReadingScrollNode | null;
  /** Height of the composer floating over the bottom of the timeline. */
  readonly getComposerOverlayHeight: () => number;
  /**
   * Called before an upward move. A programmatic scroll fires no wheel or
   * pointer event, so the timeline's own live-follow opt-out listeners never
   * observe it and the next stream chunk would yank the reader back to the
   * live edge. Downward moves need no break, for the same reason a downward
   * wheel does not: they travel toward the end.
   */
  readonly onBreakLiveFollow: () => void;
  readonly prefersReducedMotion: () => boolean;
  readonly now: () => number;
  readonly requestFrame: (callback: () => void) => number;
  readonly cancelFrame: (handle: number) => void;
}

export interface ChatReadingScroller {
  readonly scroll: (direction: ReadingScrollDirection) => void;
  /** Cancels any animation in flight and releases its listeners. */
  readonly dispose: () => void;
}

/** Gestures that mean the reader took over and the animation must yield. */
const USER_GESTURE_EVENTS = ["wheel", "touchstart", "pointerdown"] as const;

/**
 * Drives the animated half-viewport reading scroll behind
 * `chat.scrollHalfPageUp` and `chat.scrollHalfPageDown`.
 *
 * Every effectful dependency is injected so the behaviour that carries the
 * risk — which direction breaks live-follow, cancelling a frame loop on
 * re-press, yielding to a real gesture — is testable without a DOM.
 */
export function createChatReadingScroller(
  options: ChatReadingScrollerOptions,
): ChatReadingScroller {
  let frame: number | null = null;
  let pendingTarget: number | null = null;
  let releaseGestureListeners: (() => void) | null = null;

  const stop = () => {
    if (frame !== null) {
      options.cancelFrame(frame);
      frame = null;
    }
    releaseGestureListeners?.();
    releaseGestureListeners = null;
  };

  const scroll = (direction: ReadingScrollDirection) => {
    const node = options.getScrollNode();
    if (!node) return;

    // A composer tall enough to cover the timeline would otherwise leave no
    // readable height, making both shortcuts silent no-ops.
    const readableHeight = node.clientHeight - options.getComposerOverlayHeight();
    const target = resolveReadingScrollTarget(
      {
        scrollTop: node.scrollTop,
        visibleHeight:
          readableHeight >= MIN_READABLE_HEIGHT ? readableHeight : node.clientHeight / 2,
        maxScrollTop: node.scrollHeight - node.clientHeight,
      },
      direction,
      // Re-target off the pending destination, not off the position the
      // animation is passing through, so repeated presses keep travelling
      // instead of each one re-measuring a viewport barely underway.
      pendingTarget,
    );

    if (Math.abs(target - node.scrollTop) < 1) {
      // Cancel before clearing: a frame loop still in flight would otherwise
      // keep moving toward a destination nothing tracks any more, and the next
      // press would re-target off a position mid-animation.
      stop();
      pendingTarget = null;
      return;
    }

    if (direction === "up") {
      options.onBreakLiveFollow();
    }

    stop();
    pendingTarget = target;

    if (options.prefersReducedMotion()) {
      node.scrollTop = target;
      pendingTarget = null;
      return;
    }

    // A real scroll gesture arriving mid-animation wins. Without this the
    // frame loop keeps writing scrollTop and drags the viewport back out from
    // under the wheel or the scrollbar drag.
    const abandonToUser = () => {
      stop();
      pendingTarget = null;
    };
    for (const eventName of USER_GESTURE_EVENTS) {
      node.addEventListener(eventName, abandonToUser, { passive: true });
    }
    releaseGestureListeners = () => {
      for (const eventName of USER_GESTURE_EVENTS) {
        node.removeEventListener(eventName, abandonToUser);
      }
    };

    const from = node.scrollTop;
    const startedAt = options.now();
    const step = () => {
      const elapsed = options.now() - startedAt;
      if (elapsed >= READING_SCROLL_DURATION_MS) {
        node.scrollTop = target;
        frame = null;
        pendingTarget = null;
        releaseGestureListeners?.();
        releaseGestureListeners = null;
        return;
      }
      node.scrollTop = readingScrollPositionAt(from, target, elapsed);
      frame = options.requestFrame(step);
    };
    frame = options.requestFrame(step);
  };

  return { scroll, dispose: stop };
}
