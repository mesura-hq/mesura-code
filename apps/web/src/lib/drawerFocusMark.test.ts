import { assert, describe, it } from "vite-plus/test";

import { DRAWER_FOCUS_MARK_ATTRIBUTE, registerDrawerFocusMark } from "./drawerFocusMark";

type Listener = (event: { target: unknown; relatedTarget: unknown }) => void;

function createHarness() {
  const listeners = new Map<string, Listener>();
  const attributes = new Map<string, string>();
  const writes: string[] = [];
  const document = {
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
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
  const element = (insideDrawer: boolean) => ({
    closest: (selector: string) =>
      insideDrawer && selector === '[data-terminal-owner="drawer"]' ? {} : null,
  });
  const cleanup = registerDrawerFocusMark({
    document: document as never,
    root,
  });
  const focusIn = (target: unknown) => listeners.get("focusin")?.({ target, relatedTarget: null });
  const focusOut = (relatedTarget: unknown) =>
    listeners.get("focusout")?.({ target: null, relatedTarget });
  const marked = () => attributes.has(DRAWER_FOCUS_MARK_ATTRIBUTE);
  return { cleanup, element, focusIn, focusOut, listeners, marked, writes };
}

describe("registerDrawerFocusMark", () => {
  it("marks the root while focus is inside the drawer and clears it on the way out", () => {
    const harness = createHarness();
    harness.focusIn(harness.element(true));
    assert.isTrue(harness.marked());
    harness.focusOut(harness.element(false));
    assert.isFalse(harness.marked());
  });

  it("clears the mark when focus leaves the drawer for nothing", () => {
    const harness = createHarness();
    harness.focusIn(harness.element(true));
    harness.focusOut(null);
    assert.isFalse(harness.marked());
  });

  it("writes nothing while focus moves on the same side of the drawer boundary", () => {
    const harness = createHarness();
    harness.focusIn(harness.element(false));
    harness.focusOut(harness.element(false));
    harness.focusIn(harness.element(false));
    assert.deepEqual(harness.writes, []);

    harness.focusIn(harness.element(true));
    harness.focusOut(harness.element(true));
    harness.focusIn(harness.element(true));
    assert.deepEqual(harness.writes, [`set ${DRAWER_FOCUS_MARK_ATTRIBUTE}`]);
  });

  it("ignores focus targets that are not elements", () => {
    const harness = createHarness();
    harness.focusIn({});
    harness.focusIn(undefined);
    assert.isFalse(harness.marked());
  });

  it("detaches its listeners and leaves no mark behind", () => {
    const harness = createHarness();
    harness.focusIn(harness.element(true));
    harness.cleanup();
    assert.isFalse(harness.marked());
    assert.equal(harness.listeners.size, 0);
  });
});
