import {
  setCursorOverlay,
  type CursorHighlightName,
  type CursorOverlay,
} from "./cursorOverlayStore";
import { subscribeComposerLayout } from "./composer/composerExpanded";
import { paintHighlight } from "./highlights";

/**
 * The block cursor of the chat and the composer. On a glyph it is the CSS
 * highlight, which paints only the glyph's own box: on `l`, `i` or `.` that
 * is a sliver. A glyph narrower than half an em gets an overlay instead, half
 * an em wide and centred on the glyph, which redraws the glyph inside it.
 *
 * The highlight is clipped and covered exactly where its glyph is, so the
 * overlay renders in the glyph's own context rather than above every layer:
 * in a container the surface names (the chat row; the composer editor's
 * host, because Lexical owns the editable content), positioned from an anchor
 * there. Whatever covers or clips the container covers or clips the overlay.
 * Clipping ancestors between the glyph and that container (the composer's
 * scrolling editor) are applied as a `clip-path`.
 *
 * It is measured again on scroll, on a resize of its container (a pane
 * resize reflows the text) and on composer layout changes, while the cursor
 * is on a narrow glyph, in the event: no frame loop.
 */

/** The narrowest block cursor, in em of the glyph's own font size. */
const MIN_CURSOR_WIDTH_EM = 0.5;

export interface GlyphBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The box of the widened cursor on a glyph, or null when the highlight paints
 * it: a glyph half an em or wider, a font size that gives no em, or a glyph
 * with no height, which is not laid out (an all-zero box) and has nothing to
 * centre on.
 */
export function widenedCursorBox(glyph: GlyphBox, fontSizePx: number): GlyphBox | null {
  if (!Number.isFinite(fontSizePx) || fontSizePx <= 0 || !(glyph.height > 0)) return null;
  const width = fontSizePx * MIN_CURSOR_WIDTH_EM;
  if (glyph.width >= width) return null;
  return {
    left: glyph.left + glyph.width / 2 - width / 2,
    top: glyph.top,
    width,
    height: glyph.height,
  };
}

/** Clips a box to the visible area of the clipping elements from `holder` up to `container`. */
function clipInset(box: GlyphBox, holder: Element, container: Element): string | null | undefined {
  let top = box.top;
  let right = box.left + box.width;
  let bottom = box.top + box.height;
  let left = box.left;
  for (let element = holder.parentElement; element && element !== container;) {
    const style = getComputedStyle(element);
    if (isClipping(style.overflowX) || isClipping(style.overflowY)) {
      const bounds = element.getBoundingClientRect();
      top = Math.max(top, bounds.top);
      right = Math.min(right, bounds.right);
      bottom = Math.min(bottom, bounds.bottom);
      left = Math.max(left, bounds.left);
    }
    element = element.parentElement;
  }
  if (bottom <= top || right <= left) return null;
  const inset = [
    top - box.top,
    box.left + box.width - right,
    box.top + box.height - bottom,
    left - box.left,
  ];
  return inset.every((side) => side === 0)
    ? undefined
    : `inset(${inset.map((side) => `${side}px`).join(" ")})`;
}

const isClipping = (overflow: string) => overflow !== "" && overflow !== "visible";

/**
 * The widened overlay for the glyph `range` covers, drawn in `container`; null
 * to paint the highlight (a wide glyph, or one its own clipping hides).
 */
function widenedOverlay(range: Range, container: HTMLElement): CursorOverlay | null {
  const holder = range.startContainer.parentElement;
  if (!holder?.isConnected || !container.contains(holder)) return null;
  const style = getComputedStyle(holder);
  const box = widenedCursorBox(range.getBoundingClientRect(), Number.parseFloat(style.fontSize));
  if (box === null) return null;
  const clip = clipInset(box, holder, container);
  if (clip === null) return null;
  return {
    ...box,
    container,
    ...(clip ? { clip } : {}),
    glyph: {
      text: range.toString(),
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      fontStyle: style.fontStyle,
    },
  };
}

interface FollowedCursor {
  readonly range: Range;
  readonly container: HTMLElement;
}

/** The cursors on a narrow glyph, measured again on the events that move them. */
const followed = new Map<CursorHighlightName, FollowedCursor>();
let stopFollowing: (() => void) | null = null;
let containerSizes: ResizeObserver | null = null;

function follow(): void {
  for (const [name, cursor] of followed) paintBlockCursor(name, cursor.range, cursor.container);
}

function startFollowing(): () => void {
  // Capture: an element's scroll event does not bubble. The composer's editor
  // scrolls inside the host the overlay is drawn in.
  document.addEventListener("scroll", follow, { capture: true, passive: true });
  const unsubscribeComposer = subscribeComposerLayout(follow);
  containerSizes = new ResizeObserver(follow);
  return () => {
    document.removeEventListener("scroll", follow, { capture: true });
    unsubscribeComposer();
    containerSizes?.disconnect();
    containerSizes = null;
  };
}

function setFollowed(name: CursorHighlightName, cursor: FollowedCursor | null): void {
  const previous = followed.get(name);
  if (cursor === null) followed.delete(name);
  else followed.set(name, cursor);
  if (followed.size > 0 && stopFollowing === null) stopFollowing = startFollowing();
  if (previous && previous.container !== cursor?.container) {
    const stillObserved = [...followed.values()].some(
      (other) => other.container === previous.container,
    );
    if (!stillObserved) containerSizes?.unobserve(previous.container);
  }
  if (cursor && previous?.container !== cursor.container) containerSizes?.observe(cursor.container);
  if (followed.size === 0 && stopFollowing !== null) {
    stopFollowing();
    stopFollowing = null;
  }
}

/**
 * Paints the cursor on the glyph `range` covers, a widened one drawn in
 * `container`; a `null` range clears it.
 */
export function paintBlockCursor(
  name: CursorHighlightName,
  range: Range | null,
  container: HTMLElement | null,
): void {
  const widened = range && container ? widenedOverlay(range, container) : null;
  paintHighlight(name, range && widened === null ? [range] : []);
  setCursorOverlay(name, widened);
  setFollowed(name, widened && range && container ? { range, container } : null);
}

/** Paints a cursor with no glyph under it (an empty line) as an overlay at `box`. */
export function paintEmptyLineCursor(name: CursorHighlightName, box: CursorOverlay | null): void {
  paintHighlight(name, []);
  setCursorOverlay(name, box);
  setFollowed(name, null);
}
