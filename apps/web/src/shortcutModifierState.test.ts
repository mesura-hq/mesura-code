import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  areShortcutModifierStatesEqual,
  shortcutModifierStateAfterKeyboardEvent,
  type ShortcutModifierState,
  useShortcutModifierState,
} from "./shortcutModifierState";

const emptyState = (): ShortcutModifierState => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
});

function keyboardEventLike(type: "keydown" | "keyup", init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    type,
    key: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  } as KeyboardEvent;
}

describe("shortcutModifierState", () => {
  it("compares modifier states by value", () => {
    expect(
      areShortcutModifierStatesEqual(
        { metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
        { metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
      ),
    ).toBe(true);
    expect(
      areShortcutModifierStatesEqual(
        { metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
        { metaKey: false, ctrlKey: false, altKey: false, shiftKey: true },
      ),
    ).toBe(false);
  });

  it("preserves the current object when modifier values do not change", () => {
    const initialState = emptyState();
    const nextState = shortcutModifierStateAfterKeyboardEvent(
      initialState,
      keyboardEventLike("keyup", { key: "Shift" }),
    );
    expect(nextState).toBe(initialState);
  });

  it("tracks bare modifier keydown and keyup events explicitly", () => {
    let state = emptyState();
    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keydown", {
        key: "Meta",
        metaKey: false,
      }),
    );
    expect(state).toEqual({
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    });

    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keydown", {
        key: "Shift",
        metaKey: true,
        shiftKey: false,
      }),
    );
    expect(state).toEqual({
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    });

    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keyup", {
        key: "Meta",
        metaKey: true,
        shiftKey: true,
      }),
    );
    expect(state).toEqual({
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    });

    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keyup", {
        key: "Shift",
        shiftKey: true,
      }),
    );
    expect(state).toEqual({
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    });
  });

  it("ignores poisoned modifier flags on non-modifier keys", () => {
    // A dictation paste (synthetic ⌘V) can leave the browser reporting
    // metaKey=true on later real key events. Enter to submit must not
    // re-mark ⌘ as held.
    const state = shortcutModifierStateAfterKeyboardEvent(
      emptyState(),
      keyboardEventLike("keydown", { key: "Enter", metaKey: true }),
    );
    expect(state).toEqual(emptyState());
  });

  it("clears a held modifier when a non-modifier key reports it released", () => {
    const heldMeta: ShortcutModifierState = {
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    };
    const state = shortcutModifierStateAfterKeyboardEvent(
      heldMeta,
      keyboardEventLike("keydown", { key: "a", metaKey: false }),
    );
    expect(state).toEqual(emptyState());
  });
});

describe("useShortcutModifierState", () => {
  let renderer: ReactTestRenderer | null = null;

  afterEach(() => {
    if (renderer) act(() => renderer?.unmount());
    renderer = null;
    vi.unstubAllGlobals();
  });

  function mountCountingRenders() {
    const events = new EventTarget();
    vi.stubGlobal("window", events);
    const seen: ShortcutModifierState[] = [];
    function Probe() {
      seen.push(useShortcutModifierState());
      return null;
    }
    act(() => {
      renderer = create(createElement(Probe));
    });
    const press = (type: "keydown" | "keyup", init: Partial<KeyboardEvent>) =>
      act(() => {
        // `type` is a read-only getter on a real Event; the rest are plain fields.
        const { type: _type, ...fields } = keyboardEventLike(type, init);
        events.dispatchEvent(Object.assign(new Event(type), fields));
      });
    return { seen, press };
  }

  it("does not re-render for keys that leave the modifiers unchanged", () => {
    // Holding an arrow key in the file tree sends a keydown per repeat; each
    // one used to re-render the whole sidebar. The modifier press comes first
    // because React skips a same-value update without rendering only while
    // the component has no work left over from its last update.
    const { seen, press } = mountCountingRenders();
    press("keydown", { key: "Control", ctrlKey: true });
    press("keyup", { key: "Control" });
    const rendersBeforeArrows = seen.length;
    for (let repeat = 0; repeat < 20; repeat += 1) press("keydown", { key: "ArrowDown" });
    press("keyup", { key: "ArrowDown" });
    expect(seen).toHaveLength(rendersBeforeArrows);
  });

  it("re-renders once when a modifier is pressed and once when it is released", () => {
    const { seen, press } = mountCountingRenders();
    const rendersAfterMount = seen.length;
    press("keydown", { key: "Control", ctrlKey: true });
    press("keydown", { key: "Control", ctrlKey: true });
    expect(seen).toHaveLength(rendersAfterMount + 1);
    expect(seen.at(-1)?.ctrlKey).toBe(true);
    press("keyup", { key: "Control" });
    expect(seen).toHaveLength(rendersAfterMount + 2);
    expect(seen.at(-1)).toEqual(emptyState());
  });
});
