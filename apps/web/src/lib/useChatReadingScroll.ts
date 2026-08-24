import { useEffect, useMemo, useRef } from "react";

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
  // Read through a ref so the returned callback keeps a stable identity. It is
  // a dependency of ChatView's capture-phase window keydown effect, and the
  // composer's height changes on every line the user types: depending on the
  // value directly would tear down and re-add that global listener mid-typing.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const scroller = useMemo(
    () =>
      createChatReadingScroller({
        getScrollNode: () => optionsRef.current.getScrollNode(),
        getComposerOverlayHeight: () => optionsRef.current.composerOverlayHeight,
        onBreakLiveFollow: () => optionsRef.current.onBreakLiveFollow(),
        prefersReducedMotion: () =>
          window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
        now: () => performance.now(),
        requestFrame: (callback) => requestAnimationFrame(callback),
        cancelFrame: (handle) => cancelAnimationFrame(handle),
      }),
    [],
  );

  useEffect(() => scroller.dispose, [scroller]);

  return scroller.scroll;
}
