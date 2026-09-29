import type { KeybindingShortcut, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  INITIAL_USAGE_PEEK_STATE,
  closeHeldUsagePeek,
  createUsagePeekHoverBridge,
  createUsagePeekKeyboardLifecycle,
  isKeybindingCaptureTarget,
  transitionUsagePeekKeyDown,
  transitionUsagePeekKeyUp,
  type UsagePeekKeyboardEvent,
} from "./AccountLimitsPanel.logic";

function shortcut(overrides: Partial<KeybindingShortcut> = {}): KeybindingShortcut {
  return {
    key: "u",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: true,
    modKey: false,
    ...overrides,
  };
}

function bindings(value = shortcut()): ResolvedKeybindingsConfig {
  return [{ command: "usage.peek", shortcut: value }];
}

function keyEvent(overrides: Partial<UsagePeekKeyboardEvent> = {}): UsagePeekKeyboardEvent {
  return {
    key: "u",
    code: "KeyU",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: true,
    repeat: false,
    ...overrides,
  };
}

describe("held Usage peek transitions", () => {
  it("ignores a Settings keybinding recorder target", () => {
    const captureTarget = {
      closest: (selector: string) =>
        selector === "[data-keybinding-capture]" ? captureTarget : null,
    };
    expect(isKeybindingCaptureTarget(captureTarget as unknown as EventTarget)).toBe(true);
    expect(isKeybindingCaptureTarget(null)).toBe(false);
  });

  it("opens on Alt+U and closes when U is released", () => {
    const opened = transitionUsagePeekKeyDown(
      INITIAL_USAGE_PEEK_STATE,
      keyEvent(),
      bindings(),
      "Linux",
    );
    expect(opened.handled).toBe(true);
    expect(opened.state.held).toBe(true);

    const closed = transitionUsagePeekKeyUp(opened.state, keyEvent(), "Linux");
    expect(closed.handled).toBe(true);
    expect(closed.state).toEqual(INITIAL_USAGE_PEEK_STATE);
  });

  it("closes when a required modifier is released first", () => {
    const opened = transitionUsagePeekKeyDown(
      INITIAL_USAGE_PEEK_STATE,
      keyEvent(),
      bindings(),
      "Linux",
    );
    const closed = transitionUsagePeekKeyUp(
      opened.state,
      keyEvent({ key: "Alt", code: "AltLeft", altKey: false }),
      "Linux",
    );
    expect(closed.state.held).toBe(false);
  });

  it("does not open from a repeated or incomplete keydown", () => {
    const repeated = transitionUsagePeekKeyDown(
      INITIAL_USAGE_PEEK_STATE,
      keyEvent({ repeat: true }),
      bindings(),
      "Linux",
    );
    expect(repeated.handled).toBe(true);
    expect(repeated.state.held).toBe(false);

    const incomplete = transitionUsagePeekKeyDown(
      INITIAL_USAGE_PEEK_STATE,
      keyEvent({ altKey: false }),
      bindings(),
      "Linux",
    );
    expect(incomplete.handled).toBe(false);
  });

  it("uses the physical U key for a non-Latin layout", () => {
    const opened = transitionUsagePeekKeyDown(
      INITIAL_USAGE_PEEK_STATE,
      keyEvent({ key: "г" }),
      bindings(),
      "Linux",
    );
    expect(opened.state.held).toBe(true);
  });

  it("keeps held state for unrelated keyup and clears it on reset", () => {
    const opened = transitionUsagePeekKeyDown(
      INITIAL_USAGE_PEEK_STATE,
      keyEvent(),
      bindings(),
      "Linux",
    );
    const unrelated = transitionUsagePeekKeyUp(
      opened.state,
      keyEvent({ key: "x", code: "KeyX" }),
      "Linux",
    );
    expect(unrelated.handled).toBe(false);
    expect(unrelated.state.held).toBe(true);
    expect(closeHeldUsagePeek()).toEqual(INITIAL_USAGE_PEEK_STATE);
  });

  it("tracks a customized modifier set through release", () => {
    const custom = shortcut({ altKey: false, ctrlKey: true, shiftKey: true });
    const opened = transitionUsagePeekKeyDown(
      INITIAL_USAGE_PEEK_STATE,
      keyEvent({ altKey: false, ctrlKey: true, shiftKey: true }),
      bindings(custom),
      "Linux",
    );
    const closed = transitionUsagePeekKeyUp(
      opened.state,
      keyEvent({ key: "Control", code: "ControlLeft", altKey: false, ctrlKey: false }),
      "Linux",
    );
    expect(closed.state.held).toBe(false);
  });

  it("honors a terminal-focus condition while resolving the configured binding", () => {
    const conditional: ResolvedKeybindingsConfig = [
      {
        command: "usage.peek",
        shortcut: shortcut(),
        whenAst: { type: "identifier", name: "terminalFocus" },
      },
    ];
    expect(
      transitionUsagePeekKeyDown(INITIAL_USAGE_PEEK_STATE, keyEvent(), conditional, "Linux", {
        terminalFocus: false,
      }).handled,
    ).toBe(false);
    expect(
      transitionUsagePeekKeyDown(INITIAL_USAGE_PEEK_STATE, keyEvent(), conditional, "Linux", {
        terminalFocus: true,
      }).state.held,
    ).toBe(true);
  });
});

describe("Usage peek lifecycle", () => {
  it("closes held state on blur, visibility loss, disposal, and binding replacement", () => {
    const states: boolean[] = [];
    const lifecycle = createUsagePeekKeyboardLifecycle({
      keybindings: bindings(),
      platform: "Linux",
      getContext: () => ({ terminalFocus: true }),
      onStateChange: (state) => states.push(state.held),
    });

    expect(lifecycle.keyDown(keyEvent()).state.held).toBe(true);
    lifecycle.close();
    expect(lifecycle.getState().held).toBe(false);
    lifecycle.keyDown(keyEvent());
    lifecycle.visibilityChange(false);
    expect(lifecycle.getState().held).toBe(false);
    lifecycle.keyDown(keyEvent());
    lifecycle.dispose();
    expect(lifecycle.getState().held).toBe(false);

    const replacement = createUsagePeekKeyboardLifecycle({
      keybindings: bindings(shortcut({ key: "i" })),
      platform: "Linux",
      getContext: () => ({}),
      onStateChange: (state) => states.push(state.held),
    });
    expect(replacement.keyDown(keyEvent()).handled).toBe(false);
    expect(states).toEqual([true, false, true, false, true, false, false]);
  });

  it("cancels a pending hover close while the pointer crosses into the panel", () => {
    let nextHandle = 0;
    const scheduled = new Map<number, () => void>();
    const hovered: boolean[] = [];
    const bridge = createUsagePeekHoverBridge({
      delayMs: 120,
      schedule: (callback) => {
        const handle = ++nextHandle;
        scheduled.set(handle, callback);
        return handle;
      },
      cancel: (handle) => scheduled.delete(handle as number),
      onHoverChange: (value) => hovered.push(value),
    });

    bridge.enter();
    bridge.leave();
    bridge.enter();
    expect(scheduled.size).toBe(0);
    expect(hovered.at(-1)).toBe(true);

    bridge.leave();
    const close = [...scheduled.values()][0];
    close?.();
    expect(hovered.at(-1)).toBe(false);
    bridge.dispose();
  });
});

// Phase 5 fence, criterion 1: the Hosts dock peeks on its own command with the
// usage dock's rules. The command is a trailing argument so every Alt+U call
// above stays as it was written.
function hostsBindings(value = shortcut({ key: "s" })): ResolvedKeybindingsConfig {
  return [
    { command: "usage.peek", shortcut: shortcut() },
    { command: "hosts.peek", shortcut: value },
  ];
}

function hostsKeyEvent(overrides: Partial<UsagePeekKeyboardEvent> = {}): UsagePeekKeyboardEvent {
  return keyEvent({ key: "s", code: "KeyS", ...overrides });
}

describe("held Hosts peek transitions", () => {
  it("opens the hosts peek on Alt+S and closes it when S is released", () => {
    const opened = transitionUsagePeekKeyDown(
      INITIAL_USAGE_PEEK_STATE,
      hostsKeyEvent(),
      hostsBindings(),
      "Linux",
      undefined,
      "hosts.peek",
    );
    expect(opened.handled).toBe(true);
    expect(opened.state.held).toBe(true);

    const closed = transitionUsagePeekKeyUp(opened.state, hostsKeyEvent(), "Linux");
    expect(closed.handled).toBe(true);
    expect(closed.state).toEqual(INITIAL_USAGE_PEEK_STATE);
  });

  it("closes the hosts peek when Alt is released before S", () => {
    const opened = transitionUsagePeekKeyDown(
      INITIAL_USAGE_PEEK_STATE,
      hostsKeyEvent(),
      hostsBindings(),
      "Linux",
      undefined,
      "hosts.peek",
    );
    expect(opened.state.held).toBe(true);
    const closed = transitionUsagePeekKeyUp(
      opened.state,
      hostsKeyEvent({ key: "Alt", code: "AltLeft", altKey: false }),
      "Linux",
    );
    expect(closed.handled).toBe(true);
    expect(closed.state.held).toBe(false);
  });

  it("swallows a repeated Alt+S without reopening the hosts peek", () => {
    const repeated = transitionUsagePeekKeyDown(
      INITIAL_USAGE_PEEK_STATE,
      hostsKeyEvent({ repeat: true }),
      hostsBindings(),
      "Linux",
      undefined,
      "hosts.peek",
    );
    expect(repeated.handled).toBe(true);
    expect(repeated.state.held).toBe(false);
  });

  it("opens the hosts peek from the physical S key on a non-Latin layout", () => {
    const opened = transitionUsagePeekKeyDown(
      INITIAL_USAGE_PEEK_STATE,
      hostsKeyEvent({ key: "ы" }),
      hostsBindings(),
      "Linux",
      undefined,
      "hosts.peek",
    );
    expect(opened.state.held).toBe(true);
  });

  it("honors a terminal-focus condition on the hosts peek binding", () => {
    const conditional: ResolvedKeybindingsConfig = [
      {
        command: "hosts.peek",
        shortcut: shortcut({ key: "s" }),
        whenAst: { type: "identifier", name: "terminalFocus" },
      },
    ];
    const at = (terminalFocus: boolean) =>
      transitionUsagePeekKeyDown(
        INITIAL_USAGE_PEEK_STATE,
        hostsKeyEvent(),
        conditional,
        "Linux",
        { terminalFocus },
        "hosts.peek",
      );
    expect(at(false).handled).toBe(false);
    expect(at(true).state.held).toBe(true);
  });

  it("keeps the two peeks on their own chords", () => {
    const hostsOnAltU = transitionUsagePeekKeyDown(
      INITIAL_USAGE_PEEK_STATE,
      keyEvent(),
      hostsBindings(),
      "Linux",
      undefined,
      "hosts.peek",
    );
    expect(hostsOnAltU.handled).toBe(false);
    const usageOnAltS = transitionUsagePeekKeyDown(
      INITIAL_USAGE_PEEK_STATE,
      hostsKeyEvent(),
      hostsBindings(),
      "Linux",
      undefined,
      "usage.peek",
    );
    expect(usageOnAltS.handled).toBe(false);
  });
});

describe("Hosts peek lifecycle", () => {
  it("drives the hosts peek through its own lifecycle and closes it on blur and visibility loss", () => {
    const states: boolean[] = [];
    const lifecycle = createUsagePeekKeyboardLifecycle({
      command: "hosts.peek",
      keybindings: hostsBindings(),
      platform: "Linux",
      getContext: () => ({ terminalFocus: false }),
      onStateChange: (state) => states.push(state.held),
    });

    expect(lifecycle.keyDown(keyEvent()).handled).toBe(false);
    expect(lifecycle.keyDown(hostsKeyEvent()).state.held).toBe(true);
    lifecycle.close();
    expect(lifecycle.getState().held).toBe(false);
    lifecycle.keyDown(hostsKeyEvent());
    lifecycle.visibilityChange(false);
    expect(lifecycle.getState().held).toBe(false);
    expect(states).toEqual([false, true, false, true, false]);
  });
});
