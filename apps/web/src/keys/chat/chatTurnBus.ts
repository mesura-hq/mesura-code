/**
 * Lets the chat buffer jump to the developer's previous or next message
 * through the timeline minimap, which already knows the current turn and how
 * to scroll the virtualized list to one. The minimap answers with the row id
 * it scrolled to, or leaves it null when there is no such message.
 */

export type TurnJumpDirection = "previous" | "next";

export interface TurnJumpRequest {
  readonly direction: TurnJumpDirection;
  rowId: string | null;
}

const EVENT_NAME = "mesura:chat-turn-jump";

/** Dispatches synchronously, so the answer is known on return. */
export function requestTurnJump(direction: TurnJumpDirection): string | null {
  if (typeof window === "undefined") return null;
  const request: TurnJumpRequest = { direction, rowId: null };
  window.dispatchEvent(new CustomEvent<TurnJumpRequest>(EVENT_NAME, { detail: request }));
  return request.rowId;
}

export function subscribeTurnJumpRequest(listener: (request: TurnJumpRequest) => void): () => void {
  // Test renderers in Node mount the subscriber with no DOM.
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => listener((event as CustomEvent<TurnJumpRequest>).detail);
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
