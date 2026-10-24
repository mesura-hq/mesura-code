import { useEffect, useMemo } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";

import type { ReadingScrollDirection } from "./chatReadingScroll";
import { createChatReadingScroller } from "./chatReadingScroller";

export interface ChatReadingScrollOptions {
  /** The timeline's scroll container, or null before the list has mounted. */
  readonly getScrollNode: () => HTMLElement | null;
  /** Height of the composer floating over the bottom of the timeline. */
  readonly composerOverlayHeight: number;
  /** Called before an upward move; see createChatReadingScroller. */
  readonly onBreakLiveFollow: () => void;
}

// The scroller calls these adapters from input events and animation frames.
// Keep them outside render so constructing the scroller cannot read the clock.
const browserScrollEnvironment = {
  prefersReducedMotion: () =>
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  now: () => performance.now(),
  requestFrame: (callback: () => void) => requestAnimationFrame(callback),
  cancelFrame: (handle: number) => cancelAnimationFrame(handle),
};

/**
 * React binding for the reading scroll. The behaviour lives in
 * `chatReadingScroller.ts`; this only wires it to the component lifecycle.
 *
 * It lives beside ChatView rather than inside it because ChatView is one of
 * the files upstream rewrites most often, and a self-contained hook keeps the
 * weekly merge surface to a single call.
 */
export function useChatReadingScroll(
  options: ChatReadingScrollOptions,
): (direction: ReadingScrollDirection) => void {
  // These callbacks keep the window keydown listener installed while the
  // composer's height changes. They read the latest committed options.
  const getScrollNode = useStableCallback(options.getScrollNode);
  const getComposerOverlayHeight = useStableCallback(() => options.composerOverlayHeight);
  const onBreakLiveFollow = useStableCallback(options.onBreakLiveFollow);
  const scroller = useMemo(
    () =>
      createChatReadingScroller({
        ...browserScrollEnvironment,
        getScrollNode,
        getComposerOverlayHeight,
        onBreakLiveFollow,
      }),
    [getScrollNode, getComposerOverlayHeight, onBreakLiveFollow],
  );

  useEffect(() => scroller.dispose, [scroller]);

  return scroller.scroll;
}
