// @vitest-environment happy-dom
// Entry point: `installNativeFocus` (`nativeFocus.ts`), which `main.tsx` calls
// once. Keys are dispatched on the focused element, as the browser does, and
// a cancelled `keydown` is a `Tab` the browser does not turn into a focus move.
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

import { installNativeFocus } from "./nativeFocus";

function pressOn(element: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  element.dispatchEvent(event);
  return event;
}

function focusedButton(): HTMLButtonElement {
  const button = document.createElement("button");
  document.body.append(button);
  button.focus();
  return button;
}

describe("native focus: Tab does not walk the tab order", () => {
  beforeAll(() => installNativeFocus());
  afterEach(() => document.body.replaceChildren());

  it("cancels a bare Tab and Shift+Tab that no element claimed", () => {
    const button = focusedButton();
    expect(pressOn(button, { key: "Tab" }).defaultPrevented).toBe(true);
    expect(pressOn(button, { key: "Tab", shiftKey: true }).defaultPrevented).toBe(true);
  });

  it("leaves a Tab held with Ctrl, Alt or Meta to the keymap and the browser", () => {
    const button = focusedButton();
    expect(pressOn(button, { key: "Tab", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(pressOn(button, { key: "Tab", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(
      false,
    );
    expect(pressOn(button, { key: "Tab", altKey: true }).defaultPrevented).toBe(false);
    expect(pressOn(button, { key: "Tab", metaKey: true }).defaultPrevented).toBe(false);
  });

  it("lets an element that owns Tab read it first, uncancelled", () => {
    const terminalInput = document.createElement("textarea");
    document.body.append(terminalInput);
    terminalInput.focus();
    const seen: boolean[] = [];
    terminalInput.addEventListener("keydown", (event) => seen.push(event.defaultPrevented));

    pressOn(terminalInput, { key: "Tab" });

    expect(seen).toEqual([false]);
  });

  it("cancels only the default action: later listeners still receive the key", () => {
    const button = focusedButton();
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

  it("leaves every other key alone", () => {
    const button = focusedButton();
    expect(pressOn(button, { key: "Enter" }).defaultPrevented).toBe(false);
    expect(pressOn(button, { key: "ArrowDown" }).defaultPrevented).toBe(false);
  });
});
