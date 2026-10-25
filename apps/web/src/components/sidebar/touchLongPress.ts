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
  readonly onClickCapture: (event: ClickLike) => void;
  readonly onContextMenu: (event: CancelableLike) => void;
  readonly dispose: () => void;
}

interface ClickLike extends CancelableLike {
  /** 0 for a click raised by the keyboard (Enter or Space on the button). */
  readonly detail: number;
}

export function createTouchLongPress(input: {
  readonly onLongPress: () => void;
  readonly schedule: (callback: () => void, delayMs: number) => unknown;
  readonly cancel: (handle: unknown) => void;
  readonly vibrate?: (durationMs: number) => void;
}): TouchLongPressHandlers {
  // The finger on the icon, from touch down to lift, whether or not the press
  // has fired yet. A long press on Android Chrome also raises `contextmenu`,
  // swallowed only while a finger is down, so a mouse's right click keeps
  // whatever the page does with it.
  let press: { pointerId: number; x: number; y: number; timer: unknown | null } | null = null;
  // Set when a press fires: the click the browser may send on lift belongs to
  // the press. It is cleared by the next pointer down of any kind, and a
  // keyboard click is never swallowed, so no later input is lost when the
  // browser sends no click at all.
  let swallowClick = false;

  const stopTimer = () => {
    if (press?.timer != null) input.cancel(press.timer);
    if (press) press.timer = null;
  };
  const endPress = () => {
    stopTimer();
    press = null;
  };

  return {
    onPointerDown: (event) => {
      endPress();
      swallowClick = false;
      if (event.pointerType !== "touch") return;
      const pointerId = event.pointerId;
      const current: { pointerId: number; x: number; y: number; timer: unknown | null } = {
        pointerId,
        x: event.clientX,
        y: event.clientY,
        timer: null,
      };
      current.timer = input.schedule(() => {
        if (press !== current) return;
        current.timer = null;
        swallowClick = true;
        input.vibrate?.(10);
        input.onLongPress();
      }, TOUCH_LONG_PRESS_MS);
      press = current;
    },
    onPointerMove: (event) => {
      if (!press || press.timer == null || event.pointerId !== press.pointerId) return;
      const travelled = Math.hypot(event.clientX - press.x, event.clientY - press.y);
      if (travelled > TOUCH_LONG_PRESS_SLOP_PX) endPress();
    },
    onPointerUp: (event) => {
      if (press?.pointerId === event.pointerId) endPress();
    },
    onPointerCancel: (event) => {
      if (press?.pointerId === event.pointerId) endPress();
    },
    onClickCapture: (event) => {
      if (!swallowClick || event.detail === 0) return;
      swallowClick = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onContextMenu: (event) => {
      if (press) event.preventDefault();
    },
    dispose: () => {
      endPress();
      swallowClick = false;
    },
  };
}
