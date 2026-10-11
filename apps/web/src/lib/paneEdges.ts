import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";

/**
 * The resizable edges between panes, and the one way to move them from the
 * keyboard.
 *
 * Three components own a resize today, each with its own drag code: the
 * sidebar rail (`ui/sidebar.tsx`), the right panel's handle
 * (`PreviewPanelShell` through `useResizableWidth`) and the terminal drawer's
 * top edge (`ThreadTerminalDrawer`). Each registers its edge here through
 * `usePaneEdge` with a `resizeTo` that runs the same clamp and persistence as
 * its drag. Two keyboard paths then share that code:
 *
 * - The separator itself, focused with Tab: arrow keys move the border in the
 *   arrow's direction. This is the W3C ARIA window splitter pattern
 *   (https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/).
 * - Vim mode's PANE mode (`keys/paneMode.ts`): `h`/`l`/`k`/`j` move a border
 *   left, right, up and down in the same way; the focused pane only picks
 *   which border.
 *
 * One step is 5% of the viewport along the edge's axis.
 */

export type PaneEdgeId = "sidebar" | "right-panel" | "terminal-drawer";

/** The side of its own panel that the edge sits on, which is the side that moves. */
export type PaneEdgeSide = "left" | "right" | "top";

export type BorderDirection = "left" | "right" | "up" | "down";

export interface PaneEdge {
  readonly id: PaneEdgeId;
  readonly side: PaneEdgeSide;
  /** The panel's current size along the edge's axis, in CSS pixels. */
  size(): number;
  /**
   * Applies and persists a size, with the same clamp and persistence as the
   * drag. Returns the size the panel took.
   */
  resizeTo(size: number): number;
  /** Back to the default size, as a double-click on the edge does where it is supported. */
  reset(): void;
}

export const PANE_EDGE_STEP_FRACTION = 0.05;

/** One step for an edge, in CSS pixels: 5% of the viewport along its axis. */
export function paneEdgeStep(
  side: PaneEdgeSide,
  viewport: { readonly width: number; readonly height: number },
): number {
  const extent = side === "top" ? viewport.height : viewport.width;
  return Math.max(1, Math.round(extent * PANE_EDGE_STEP_FRACTION));
}

/**
 * The size change that moves an edge's border `pixels` towards `direction`,
 * or `null` when the edge cannot move that way (a vertical border has no up).
 *
 * A border on the panel's right grows the panel when it moves right; on the
 * left or the top it grows the panel when it moves away from the panel.
 */
export function borderMoveDelta(
  side: PaneEdgeSide,
  direction: BorderDirection,
  pixels: number,
): number | null {
  if (side === "top") {
    if (direction === "up") return pixels;
    if (direction === "down") return -pixels;
    return null;
  }
  if (direction !== "left" && direction !== "right") return null;
  const towardsRight = direction === "right" ? pixels : -pixels;
  return side === "right" ? towardsRight : -towardsRight;
}

const ARROW_DIRECTIONS: Record<string, BorderDirection> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

function currentViewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

/** Moves the edge's border by whole steps, for the separator's arrows and PANE mode alike. */
export function movePaneEdgeBorder(
  edge: PaneEdge,
  direction: BorderDirection,
  steps: number,
): boolean {
  const delta = borderMoveDelta(
    edge.side,
    direction,
    steps * paneEdgeStep(edge.side, currentViewport()),
  );
  if (delta === null) return false;
  edge.resizeTo(edge.size() + delta);
  return true;
}

/**
 * The registered edges. A stack per id rather than one slot, so a second
 * mount of the same panel (the pull requests page reuses the panel shell)
 * never loses the first one's edge when it unmounts.
 */
const edges = new Map<PaneEdgeId, PaneEdge[]>();

export function getPaneEdge(id: PaneEdgeId): PaneEdge | null {
  return edges.get(id)?.at(-1) ?? null;
}

export function getPaneEdges(): PaneEdge[] {
  return [...edges.keys()].flatMap((id) => getPaneEdge(id) ?? []);
}

function registerPaneEdge(edge: PaneEdge): () => void {
  const stack = edges.get(edge.id) ?? [];
  stack.push(edge);
  edges.set(edge.id, stack);
  return () => {
    const current = edges.get(edge.id);
    if (!current) return;
    const index = current.lastIndexOf(edge);
    if (index !== -1) current.splice(index, 1);
    if (current.length === 0) edges.delete(edge.id);
  };
}

export interface UsePaneEdgeOptions extends Omit<PaneEdge, "id" | "side"> {
  readonly id: PaneEdgeId;
  readonly side: PaneEdgeSide;
  /** Off while the edge cannot be dragged: panel closed, maximized, or in sheet mode. */
  readonly enabled: boolean;
  /** For assistive technology; omitted where the owner does not track it in state. */
  readonly valueNow?: number;
  readonly valueMin?: number;
  readonly valueMax?: number;
}

/**
 * Registers an edge while `enabled` and returns the props that make its
 * separator element keyboard-operable. The callbacks are read through a ref,
 * so the owner may pass fresh closures on every render.
 */
export function usePaneEdge(options: UsePaneEdgeOptions) {
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const { id, side, enabled } = options;

  const edge = useMemo<PaneEdge>(
    () => ({
      id,
      side,
      size: () => latest.current.size(),
      resizeTo: (size) => latest.current.resizeTo(size),
      reset: () => latest.current.reset(),
    }),
    [id, side],
  );

  useEffect(() => {
    if (!enabled) return;
    return registerPaneEdge(edge);
  }, [edge, enabled]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!latest.current.enabled) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const direction = ARROW_DIRECTIONS[event.key];
    if (direction === undefined) return;
    if (!movePaneEdgeBorder(edge, direction, 1)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  return {
    tabIndex: enabled ? 0 : -1,
    "aria-orientation": side === "top" ? ("horizontal" as const) : ("vertical" as const),
    ...ariaValue("aria-valuenow", options.valueNow),
    ...ariaValue("aria-valuemin", options.valueMin),
    ...ariaValue("aria-valuemax", options.valueMax),
    onKeyDown,
  };
}

function ariaValue<Name extends string>(name: Name, value: number | undefined) {
  return value !== undefined && Number.isFinite(value)
    ? ({ [name]: Math.round(value) } as Record<Name, number>)
    : {};
}
