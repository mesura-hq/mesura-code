/**
 * Mesura: a long press by touch on a sidebar footer icon. A phone has no hover,
 * so holding the Usage or Hosts icon is how it reaches the card a desktop
 * pointer opens by resting on the icon.
 *
 * Touch only: a mouse or a pen keeps its hover and its click. The press that
 * fires swallows the click the browser sends when the finger lifts, so the
 * icon's own tap action (open the Usage page, pin the Hosts dock) does not run
 * on top of it.
 */

export const TOUCH_LONG_PRESS_MS = 450;
/** A finger that travels further than this is scrolling the drawer, not pressing. */
export const TOUCH_LONG_PRESS_SLOP_PX = 10;

interface PointerLike {
  readonly pointerType: string;
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
}

interface CancelableLike {
  preventDefault(): void;
  stopPropagation(): void;
}

export interface TouchLongPressHandlers {
  readonly onPointerDown: (event: PointerLike) => void;
  readonly onPointerMove: (event: PointerLike) => void;
  readonly onPointerUp: (event: PointerLike) => void;
  readonly onPointerCancel: (event: PointerLike) => void;
  readonly onClickCapture: (event: CancelableLike) => void;
  readonly onContextMenu: (event: CancelableLike) => void;
  readonly dispose: () => void;
}

export function createTouchLongPress(input: {
  readonly onLongPress: () => void;
  readonly schedule: (callback: () => void, delayMs: number) => unknown;
  readonly cancel: (handle: unknown) => void;
  readonly vibrate?: (durationMs: number) => void;
}): TouchLongPressHandlers {
  let pending: { handle: unknown; pointerId: number; x: number; y: number } | null = null;
  let swallowClick = false;
  // A long press on Android Chrome also raises `contextmenu`; it is swallowed
  // only while a press is pending or has just fired, so a mouse's right click
  // keeps whatever the page does with it.
  let pressActive = false;

  const clear = () => {
    if (pending) input.cancel(pending.handle);
    pending = null;
  };

  return {
    onPointerDown: (event) => {
      if (event.pointerType !== "touch") return;
      clear();
      swallowClick = false;
      pressActive = true;
      const pointerId = event.pointerId;
      pending = {
        pointerId,
        x: event.clientX,
        y: event.clientY,
        handle: input.schedule(() => {
          if (pending?.pointerId !== pointerId) return;
          pending = null;
          swallowClick = true;
          input.vibrate?.(10);
          input.onLongPress();
        }, TOUCH_LONG_PRESS_MS),
      };
    },
    onPointerMove: (event) => {
      if (!pending || event.pointerId !== pending.pointerId) return;
      const travelled = Math.hypot(event.clientX - pending.x, event.clientY - pending.y);
      if (travelled > TOUCH_LONG_PRESS_SLOP_PX) {
        clear();
        pressActive = false;
      }
    },
    onPointerUp: (event) => {
      if (pending?.pointerId === event.pointerId) {
        clear();
        pressActive = false;
      }
    },
    onPointerCancel: (event) => {
      if (pending?.pointerId === event.pointerId) {
        clear();
        pressActive = false;
      }
    },
    onClickCapture: (event) => {
      if (!swallowClick) return;
      swallowClick = false;
      pressActive = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onContextMenu: (event) => {
      if (pressActive || swallowClick) event.preventDefault();
    },
    dispose: () => {
      clear();
      pressActive = false;
      swallowClick = false;
    },
  };
}
