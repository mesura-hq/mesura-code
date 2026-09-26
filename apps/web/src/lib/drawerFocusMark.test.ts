import { assert, describe, it } from "vite-plus/test";

import { DRAWER_FOCUS_MARK_ATTRIBUTE, registerDrawerFocusMark } from "./drawerFocusMark";
import { TERMINAL_DRAWER_SELECTOR } from "./paneFocus";

type Listener = (event: { target: unknown; relatedTarget: unknown }) => void;

function element(insideDrawer: boolean) {
  return {
    closest: (selector: string) =>
      insideDrawer && selector === TERMINAL_DRAWER_SELECTOR ? {} : null,
  };
}

function createHarness(activeElement: unknown = null) {
  const listeners = new Map<string, { listener: Listener; capture: boolean }>();
  const attributes = new Map<string, string>();
  const writes: string[] = [];
  const document = {
    addEventListener: (type: string, listener: Listener, capture: boolean) =>
      listeners.set(type, { listener, capture }),
    // Removes only on an exact match, like the DOM: a cleanup that passes a
    // different function or capture flag leaves the real listener attached.
    removeEventListener: (type: string, listener: Listener, capture: boolean) => {
      const entry = listeners.get(type);
      if (entry?.listener === listener && entry.capture === capture) listeners.delete(type);
    },
  };
  const root = {
    hasAttribute: (name: string) => attributes.has(name),
    setAttribute: (name: string, value: string) => {
      writes.push(`set ${name}`);
      attributes.set(name, value);
    },
    removeAttribute: (name: string) => {
      writes.push(`remove ${name}`);
      attributes.delete(name);
    },
  };
  const cleanup = registerDrawerFocusMark({
    document: document as never,
    root,
    getActiveElement: () => activeElement,
  });
  const focusIn = (target: unknown) =>
    listeners.get("focusin")?.listener({ target, relatedTarget: null });
  const focusOut = (relatedTarget: unknown) =>
    listeners.get("focusout")?.listener({ target: null, relatedTarget });
  const marked = () => attributes.has(DRAWER_FOCUS_MARK_ATTRIBUTE);
  return { cleanup, focusIn, focusOut, listeners, marked, writes };
}

describe("registerDrawerFocusMark", () => {
  it("marks the root while focus is inside the drawer and clears it on the way out", () => {
    const harness = createHarness();
    harness.focusIn(element(true));
    assert.isTrue(harness.marked());
    harness.focusOut(element(false));
    assert.isFalse(harness.marked());
  });

  it("clears the mark when focus leaves the drawer for nothing", () => {
    const harness = createHarness();
    harness.focusIn(element(true));
    harness.focusOut(null);
    assert.isFalse(harness.marked());
  });

  it("starts marked when registered while the drawer already holds focus", () => {
    const harness = createHarness(element(true));
    assert.isTrue(harness.marked());
  });

  it("writes nothing while focus moves on the same side of the drawer boundary", () => {
    const harness = createHarness();
    harness.focusIn(element(false));
    harness.focusOut(element(false));
    harness.focusIn(element(false));
    assert.deepEqual(harness.writes, []);

    harness.focusIn(element(true));
    harness.focusOut(element(true));
    harness.focusIn(element(true));
    assert.deepEqual(harness.writes, [`set ${DRAWER_FOCUS_MARK_ATTRIBUTE}`]);
  });

  it("ignores focus targets that are not elements", () => {
    const harness = createHarness();
    harness.focusIn({});
    harness.focusIn(undefined);
    assert.isFalse(harness.marked());
  });

  it("detaches its capture-phase listeners and leaves no mark behind", () => {
    const harness = createHarness();
    harness.focusIn(element(true));
    harness.cleanup();
    assert.isFalse(harness.marked());
    assert.equal(harness.listeners.size, 0);
  });
});
