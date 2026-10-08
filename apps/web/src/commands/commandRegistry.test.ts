// @vitest-environment happy-dom
// Entry points: the registry's own API (`registerCommandHandlers`,
// `useCommandHandlers`, `runRegisteredCommand`), and for the leader rows the
// key engine's window `keydown` listener (`installKeyEngine` in
// `keys/keyEngine.ts`), driven by real `KeyboardEvent`s from a focused element
// in the chat. Phase 3 of the modal keys production cycle, criteria 2 to 5.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { KeybindingCommand } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { parseKeySequence } from "@mesura/keys/keyToken";

import { findEffectiveShortcutForCommand } from "~/keybindings";
import { DEFAULT_KEYMAP, isEngineCommand } from "~/keys/defaultKeymap";
import { configureKeyEngine, installKeyEngine, registerKeySurface } from "~/keys/keyEngine";
import { readKeyEngineSnapshot } from "~/keys/keyEngineStore";

import {
  registerCommandHandlers,
  runRegisteredCommand,
  useCommandHandlers,
} from "./commandRegistry";

/** A command no default chord reaches: only the registry can run it. */
const CHORDLESS_COMMAND: KeybindingCommand = "rightPanel.toggleMaximized";

let disposers: Array<() => void> = [];
function register(handlers: Parameters<typeof registerCommandHandlers>[0]) {
  const dispose = registerCommandHandlers(handlers);
  disposers.push(dispose);
  return dispose;
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

describe("command registry", () => {
  it("runs the handler registered for a command and reports that it ran", () => {
    const run = vi.fn();
    register({ "thread.pin": run });
    expect(runRegisteredCommand("thread.pin")).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reports a command with no registered handler as not run", () => {
    expect(runRegisteredCommand("thread.settle")).toBe(false);
  });

  it("runs a command with no default chord from the registry", () => {
    expect(findEffectiveShortcutForCommand(DEFAULT_RESOLVED_KEYBINDINGS, CHORDLESS_COMMAND)).toBe(
      null,
    );
    const run = vi.fn();
    register({ [CHORDLESS_COMMAND]: run });
    expect(runRegisteredCommand(CHORDLESS_COMMAND)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("registers every command in one map and disposes them together", () => {
    const pin = vi.fn();
    const settle = vi.fn();
    const dispose = register({ "thread.pin": pin, "thread.settle": settle });
    runRegisteredCommand("thread.pin");
    runRegisteredCommand("thread.settle");
    expect([pin.mock.calls.length, settle.mock.calls.length]).toEqual([1, 1]);

    dispose();
    expect(runRegisteredCommand("thread.pin")).toBe(false);
    expect(runRegisteredCommand("thread.settle")).toBe(false);
  });

  it("runs the most recent registration and restores the previous one on dispose", () => {
    const first = vi.fn();
    const second = vi.fn();
    register({ "rightPanel.close": first });
    const disposeSecond = register({ "rightPanel.close": second });

    runRegisteredCommand("rightPanel.close");
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([0, 1]);

    disposeSecond();
    runRegisteredCommand("rightPanel.close");
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([1, 1]);
  });

  it("keeps the most recent registration when an older one is disposed first", () => {
    const first = vi.fn();
    const second = vi.fn();
    const disposeFirst = register({ "rightPanel.close": first });
    register({ "rightPanel.close": second });

    disposeFirst();
    runRegisteredCommand("rightPanel.close");
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([0, 1]);
  });
});

describe("command registry hook", () => {
  let root: Root | undefined;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    container.remove();
    vi.unstubAllGlobals();
  });

  function Owner(props: { readonly onPin: () => void }) {
    useCommandHandlers({ "thread.pin": () => props.onPin() });
    return null;
  }

  function render(owners: ReadonlyArray<{ readonly key: string; readonly onPin: () => void }>) {
    act(() => {
      root ??= createRoot(container);
      root.render(owners.map((owner) => createElement(Owner, owner)));
    });
  }

  it("runs the most recently mounted owner and restores the previous one on unmount", () => {
    const first = vi.fn();
    const second = vi.fn();
    render([{ key: "first", onPin: first }]);
    render([
      { key: "first", onPin: first },
      { key: "second", onPin: second },
    ]);

    expect(runRegisteredCommand("thread.pin")).toBe(true);
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([0, 1]);

    render([{ key: "first", onPin: first }]);
    expect(runRegisteredCommand("thread.pin")).toBe(true);
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([1, 1]);

    render([]);
    expect(runRegisteredCommand("thread.pin")).toBe(false);
  });

  it("runs the owner's latest callback after a re-render with a fresh closure", () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    render([{ key: "owner", onPin: stale }]);
    render([{ key: "owner", onPin: fresh }]);

    runRegisteredCommand("thread.pin");
    expect([stale.mock.calls.length, fresh.mock.calls.length]).toEqual([0, 1]);
  });
});

/** Every `keydown` that reaches `window`, seen before the key engine. */
const keydownsAtWindow: KeyboardEvent[] = [];
const pressedByTest = new Set<Event>();

function pressToken(token: string) {
  const key = token === "<Space>" ? " " : token;
  const code =
    token === "<Space>" ? "Space" : /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : "";
  const event = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true });
  pressedByTest.add(event);
  (document.activeElement ?? document.body).dispatchEvent(event);
}

function pressSequence(keys: string) {
  for (const token of parseKeySequence(keys)) pressToken(token);
}

function syntheticKeydowns() {
  return keydownsAtWindow.filter((event) => !pressedByTest.has(event)).map((event) => event.key);
}

/** The leader rows that run an app command rather than one of the engine's own. */
const OWNED_ROWS = DEFAULT_KEYMAP.bindings
  .filter((binding) => !isEngineCommand(binding.command))
  .map((binding) => ({ keys: binding.keys, command: binding.command as KeybindingCommand }));

describe("command registry from the key engine", () => {
  let disposeSurface: () => void = () => {};

  beforeAll(() => {
    window.addEventListener("keydown", (event) => keydownsAtWindow.push(event), true);
    installKeyEngine();
  });

  beforeEach(() => {
    document.body.innerHTML = `
      <div data-chat-column-maximized-away="false">
        <div data-testid="chat-focus" tabindex="0">chat</div>
      </div>`;
    keydownsAtWindow.length = 0;
    pressedByTest.clear();
    configureKeyEngine({ enabled: true });
    disposeSurface = registerKeySurface({
      scope: "chat",
      mode: () => "normal",
      label: () => "NORMAL",
      isPending: () => false,
      handleKey: () => false,
      reset: () => {},
    });
    document.querySelector<HTMLElement>('[data-testid="chat-focus"]')!.focus();
  });

  afterEach(() => {
    disposeSurface();
    configureKeyEngine({ enabled: false });
    document.body.innerHTML = "";
  });

  it("covers every app command the default keymap binds", () => {
    expect(OWNED_ROWS.length).toBeGreaterThanOrEqual(30);
  });

  for (const row of OWNED_ROWS) {
    it(`runs ${row.command} from ${row.keys} through its owner, with no synthetic keydown`, () => {
      const ran: string[] = [];
      for (const other of new Set(OWNED_ROWS.map((entry) => entry.command))) {
        register({ [other]: () => ran.push(other) });
      }

      pressSequence(row.keys);

      expect(ran).toEqual([row.command]);
      expect(syntheticKeydowns()).toEqual([]);
      expect(readKeyEngineSnapshot().notice).toBeNull();
    });
  }

  it("runs an owner's command from the leader when no chord binds it", () => {
    const pin = vi.fn();
    register({ "thread.pin": pin });

    pressSequence("<leader>tp");

    expect(pin).toHaveBeenCalledTimes(1);
    expect(readKeyEngineSnapshot().notice).toBeNull();
  });

  it("shows the not available notice once the command's owner is gone", () => {
    const pin = vi.fn();
    const dispose = register({ "thread.pin": pin });
    dispose();

    pressSequence("<leader>tp");

    expect(pin).not.toHaveBeenCalled();
    expect(readKeyEngineSnapshot().notice).toContain("is not available here");
    expect(syntheticKeydowns()).toEqual([]);
  });

  it("runs the most recent owner of a leader command and the previous one after it leaves", () => {
    const first = vi.fn();
    const second = vi.fn();
    register({ "thread.pin": first });
    const disposeSecond = register({ "thread.pin": second });

    pressSequence("<leader>tp");
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([0, 1]);

    disposeSecond();
    pressSequence("<leader>tp");
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([1, 1]);
    expect(syntheticKeydowns()).toEqual([]);
  });
});
