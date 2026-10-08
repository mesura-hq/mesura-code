import { useSyncExternalStore } from "react";

import type { HighlightName } from "./highlights";

/** The cursor highlights an overlay can stand in for, one overlay each. */
export type CursorHighlightName = Extract<
  HighlightName,
  "mesura-chat-cursor" | "mesura-composer-cursor"
>;

/** The glyph a widened cursor redraws over itself, in the glyph's own font. */
export interface CursorGlyph {
  readonly text: string;
  readonly fontFamily: string;
  readonly fontSize: string;
  readonly fontWeight: string;
  readonly fontStyle: string;
}

/**
 * A block cursor drawn as an element, for the cases a highlight cannot paint:
 * a cursor with no character under it (an empty line, the end of a line),
 * fixed to the viewport; and a glyph narrower than the cursor's minimum
 * width, which carries `width`, `glyph` and the `container` it is drawn in,
 * with an optional `clip` (a `clip-path`). Viewport coordinates.
 */
export interface CursorOverlay {
  readonly left: number;
  readonly top: number;
  readonly height: number;
  readonly width?: number;
  readonly glyph?: CursorGlyph;
  readonly container?: HTMLElement;
  readonly clip?: string;
}

let overlays: ReadonlyMap<CursorHighlightName, CursorOverlay> = new Map();
const listeners = new Set<() => void>();

/** Sets or clears (`null`) the overlay that stands in for one cursor highlight. */
export function setCursorOverlay(owner: CursorHighlightName, next: CursorOverlay | null): void {
  if ((overlays.get(owner) ?? null) === next) return;
  const updated = new Map(overlays);
  if (next === null) updated.delete(owner);
  else updated.set(owner, next);
  overlays = updated;
  for (const listener of listeners) listener();
}

export function useCursorOverlays(): ReadonlyMap<CursorHighlightName, CursorOverlay> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => overlays,
    () => overlays,
  );
}
