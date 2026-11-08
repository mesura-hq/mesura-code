// Entry point: `installNativeFocus` (`nativeFocus.ts`), which `main.tsx` calls
// once. Keys are dispatched on the focused element, as the browser does, and
// a cancelled `keydown` is a `Tab` the browser does not turn into a focus move.
import { describe, expect, it } from "vite-plus/test";

import { createWindowListenerFixture, mountKeyDom } from "~/test/keyBrowserFixtures";

import { installNativeFocus } from "./nativeFocus";

function pressOn(element: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  element.dispatchEvent(event);
  return event;
}

function focusedButton(container: HTMLElement): HTMLButtonElement {
  const button = document.createElement("button");
  container.append(button);
  button.focus();
  return button;
}

const nativeFocusListeners = createWindowListenerFixture(installNativeFocus);

describe("native focus: Tab does not walk the tab order", () => {
  it("cancels a bare Tab and Shift+Tab that no element claimed", () => {
    using _listeners = nativeFocusListeners();
    using fixture = mountKeyDom();
    const button = focusedButton(fixture.container);
    expect(pressOn(button, { key: "Tab" }).defaultPrevented).toBe(true);
    expect(pressOn(button, { key: "Tab", shiftKey: true }).defaultPrevented).toBe(true);
  });

  it("leaves a Tab held with Ctrl, Alt or Meta to the keymap and the browser", () => {
    using _listeners = nativeFocusListeners();
    using fixture = mountKeyDom();
    const button = focusedButton(fixture.container);
    expect(pressOn(button, { key: "Tab", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(pressOn(button, { key: "Tab", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(
      false,
    );
    expect(pressOn(button, { key: "Tab", altKey: true }).defaultPrevented).toBe(false);
    expect(pressOn(button, { key: "Tab", metaKey: true }).defaultPrevented).toBe(false);
  });

  it("lets an element that owns Tab read it first, uncancelled", () => {
    using _listeners = nativeFocusListeners();
    using fixture = mountKeyDom();
    const terminalInput = document.createElement("textarea");
    fixture.container.append(terminalInput);
    terminalInput.focus();
    const seen: boolean[] = [];
    terminalInput.addEventListener("keydown", (event) => seen.push(event.defaultPrevented));

    pressOn(terminalInput, { key: "Tab" });

    expect(seen).toEqual([false]);
  });

  it("cancels only the default action: later listeners still receive the key", () => {
    using _listeners = nativeFocusListeners();
    using fixture = mountKeyDom();
    const button = focusedButton(fixture.container);
    const received: string[] = [];
    const onWindow = (event: KeyboardEvent) => received.push(event.key);
    window.addEventListener("keydown", onWindow);
    try {
      pressOn(button, { key: "Tab" });
    } finally {
      window.removeEventListener("keydown", onWindow);
    }
    expect(received).toEqual(["Tab"]);
  });

  it("cancels a Tab whose propagation an element stopped without cancelling it", () => {
    using _listeners = nativeFocusListeners();
    using fixture = mountKeyDom();
    const field = document.createElement("input");
    const container = document.createElement("div");
    container.append(field);
    fixture.container.append(container);
    field.focus();
    // A rename field's handler, as React runs it from the root container.
    container.addEventListener("keydown", (event) => event.stopPropagation());
    expect(pressOn(field, { key: "Tab" }).defaultPrevented).toBe(true);

    const immediate = document.createElement("textarea");
    fixture.container.append(immediate);
    immediate.focus();
    immediate.addEventListener("keydown", (event) => event.stopImmediatePropagation());
    expect(pressOn(immediate, { key: "Tab", shiftKey: true }).defaultPrevented).toBe(true);
  });

  it("leaves a stopped key that is not a bare Tab alone", () => {
    using _listeners = nativeFocusListeners();
    using fixture = mountKeyDom();
    const field = document.createElement("input");
    fixture.container.append(field);
    field.focus();
    field.addEventListener("keydown", (event) => event.stopPropagation());
    expect(pressOn(field, { key: "Enter" }).defaultPrevented).toBe(false);
    expect(pressOn(field, { key: "Tab", ctrlKey: true }).defaultPrevented).toBe(false);
  });

  it("leaves every other key alone", () => {
    using _listeners = nativeFocusListeners();
    using fixture = mountKeyDom();
    const button = focusedButton(fixture.container);
    expect(pressOn(button, { key: "Enter" }).defaultPrevented).toBe(false);
    expect(pressOn(button, { key: "ArrowDown" }).defaultPrevented).toBe(false);
  });
});
