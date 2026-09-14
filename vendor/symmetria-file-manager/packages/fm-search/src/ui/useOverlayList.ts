/**
 * The keyboard behaviour every overlay list shares.
 *
 * Focus on mount, an Escape backstop at the window, a Tab trap, and a clamped
 * highlight moved by the arrows or by Ctrl+J and Ctrl+K. The finder and the
 * panel's zoxide popup both need exactly this, and they differ only in what
 * Enter means — which is why confirming is deliberately NOT in here.
 *
 * **It is extracted because this logic has already had a bug.** The zoxide
 * popup was once UNCLOSABLE by keyboard: Tab moved focus off the field, so its
 * own handler stopped firing, and the dispatch cascade's modal step only calls
 * `preventDefault`, which swallowed every key into a dialog nothing could
 * dismiss. The window-level Escape listener below is the half of that fix which
 * does not depend on having thought of every key. Two copies of a fix like that
 * is one copy that will silently lose it.
 *
 * **It lives in this package for a boundary reason, not a topical one.** It is
 * a generic list primitive rather than anything to do with searching, but the
 * two consumers sit in packages that must not import each other: the finder
 * cannot reach into the file-manager panel, or a host could not mount it alone.
 * The shared home it deserves is a DOM-capable primitives package that does not
 * exist yet; until one does, the package both sides already depend on is the
 * only place it can go without breaking that rule.
 */
import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export interface OverlayList {
  /** Attach to the query field. It takes focus on mount and keeps it. */
  readonly field: RefObject<HTMLInputElement | null>;
  /** The list scrolls independently of the fixed query field. */
  readonly results: RefObject<HTMLDivElement | null>;
  /** The current row, always a real index while the list is non-empty. */
  readonly highlighted: number;
  /** Put the highlight back on the first row. Called when the query changes. */
  resetHighlight(): void;
  /**
   * Handle a key that belongs to the list.
   *
   * Returns whether it consumed the key, so a caller can add its own bindings
   * — Enter, above all — without repeating the ones here.
   */
  handleKey(event: KeyboardEvent): boolean;
}

export function useOverlayList(count: number, onClose: () => void): OverlayList {
  const [active, setActive] = useState(0);
  const field = useRef<HTMLInputElement | null>(null);
  const results = useRef<HTMLDivElement | null>(null);

  // The field takes the keyboard, so what the user types goes into it rather
  // than into the pane behind. The dispatch cascade also reports a text input
  // as focused, which is the other half of the same guarantee.
  useEffect(() => {
    field.current?.focus();
  }, []);

  /**
   * The exact Escape the field already handled.
   *
   * An Escape typed into the field is handled below and then BUBBLES to the
   * window, so without this the backstop closes a second time. Invisible inside
   * the file manager, whose close handler is a `setState(false)` and idempotent
   * — which is why no test there caught it — but a host's may pop a navigation
   * stack or restore a focus, and doing that twice is a real fault. The
   * standalone mount is the only place anything counts the calls.
   *
   * **`defaultPrevented` is NOT usable for this, and was tried.** The dispatch
   * cascade calls `preventDefault` on every key while a modal is open — that is
   * what "a modal handles it" means there — so the flag is already true for
   * reasons that have nothing to do with this component, and checking it
   * swallowed the close entirely. The question is not "did anyone prevent
   * this" but "have I already handled this one", so the event itself is the
   * only honest answer.
   *
   * **Object identity, not a boolean.** That is what makes a ref that is never
   * cleared harmless: no two dispatches share a `KeyboardEvent` instance, so a
   * stale value can only ever match the event it was set from and can never
   * swallow a later, genuine Escape. Clearing it below is about not retaining a
   * spent event and its target, nothing more.
   *
   * **`event.stopPropagation()` is a verified one-line alternative**, confirmed
   * equivalent in this stack by review. It was not taken: it silences the
   * event for EVERY window listener rather than for this hook's own, which is a
   * decision about code this hook does not own, and the shipped form is already
   * verified end to end in a real window. A maintainer who prefers the simpler
   * form should re-verify both paths there before switching — the field path
   * and the backstop path, which is the one that fails silently.
   */
  const handledEscape = useRef<globalThis.KeyboardEvent | null>(null);

  // Escape at the WINDOW, as a backstop. See this module's header for the bug
  // that put it here.
  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (handledEscape.current === event) {
        // Released so this hook holds no reference to a spent event, and its
        // target with it.
        handledEscape.current = null;
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [onClose]);

  const last = Math.max(count - 1, 0);
  // Clamped rather than reset: narrowing the list under a highlight near the
  // bottom must leave it on something real, and putting it back to the top on
  // every keystroke would fight the user's arrow keys.
  const highlighted = Math.min(active, last);

  useLayoutEffect(() => {
    const viewport = results.current;
    const row = viewport?.children[highlighted];
    if (viewport === null || row === undefined || count === 0) return;
    const bounds = viewport.getBoundingClientRect();
    const item = row.getBoundingClientRect();
    // Move only this list. Scrolling ancestors can move the pinned input, and
    // horizontal scrolling would hide the filename when its parent path is long.
    const bottom = bounds.top + viewport.clientHeight;
    if (item.top < bounds.top) viewport.scrollTop += item.top - bounds.top;
    else if (item.bottom > bottom) viewport.scrollTop += item.bottom - bottom;
  }, [highlighted, count]);

  function handleKey(event: KeyboardEvent): boolean {
    // Every key belongs to the overlay while it is up. Letting one through
    // would move the cursor in the pane the user cannot see behind it.
    if (event.key === "Escape") {
      event.preventDefault();
      // Named before closing, because the same physical event is about to reach
      // the window listener above.
      handledEscape.current = event.nativeEvent;
      onClose();
      return true;
    }
    // One focusable element, so Tab has nowhere useful to go and moving focus
    // off the field would take the keyboard with it.
    if (event.key === "Tab") {
      event.preventDefault();
      return true;
    }
    // Ctrl+J and Ctrl+K beside the arrows: the pair the Qt finder binds, and
    // the pair a hand already on the home row reaches for.
    if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "j")) {
      event.preventDefault();
      setActive(Math.min(highlighted + 1, last));
      return true;
    }
    if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "k")) {
      event.preventDefault();
      setActive(Math.max(highlighted - 1, 0));
      return true;
    }
    return false;
  }

  function resetHighlight(): void {
    // A user can scroll while index zero stays selected. Reset the list even
    // when the next query has the same count and setActive(0) causes no render.
    if (results.current !== null) results.current.scrollTop = 0;
    setActive(0);
  }

  return { field, results, highlighted, resetHighlight, handleKey };
}
