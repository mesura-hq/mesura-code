// @vitest-environment happy-dom
// Entry point: `installKeyEngine` (`keyEngine.ts`), the window `keydown`
// listener `KeyEngineHost` installs before React renders. Every spec here
// dispatches a real `KeyboardEvent` from a focused element and reads what the
// app sees: whether the event was prevented, whether a window listener
// registered after the engine still received it, and the engine's snapshot.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { compileKeymap, type KeyMode } from "@mesura/keys/keymap";

import { DEFAULT_KEYMAP } from "./defaultKeymap";
import {
  configureKeyEngine,
  installKeyEngine,
  registerKeySurface,
  type KeySurface,
} from "./keyEngine";
import { readKeyEngineSnapshot, type EngineModeLabel } from "./keyEngineStore";
import { isPaneModeActive } from "./paneMode";

const LAYOUT = `
  <div data-app-sidebar><button data-testid="sidebar-row">row</button></div>
  <div data-chat-column-maximized-away="false">
    <div data-testid="chat-focus" tabindex="0">chat</div>
    <div data-testid="composer-editor" contenteditable="true"></div>
    <div data-terminal-owner="drawer"><textarea data-testid="terminal-input"></textarea></div>
  </div>
  <div data-preview-panel-mode="inline">
    <div class="monaco-editor"><textarea data-testid="monaco-input"></textarea></div>
    <div role="tree" tabindex="0" data-testid="file-tree"></div>
  </div>`;

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

/** Keys that the engine would act on in the chat: leader, motions, an operator, insert, flash, Escape. */
const KEYS: ReadonlyArray<{ readonly key: string; readonly code: string }> = [
  { key: " ", code: "Space" },
  { key: "j", code: "KeyJ" },
  { key: "x", code: "KeyX" },
  { key: "i", code: "KeyI" },
  { key: "s", code: "KeyS" },
  { key: "Escape", code: "Escape" },
];

const reachedLaterListener: KeyboardEvent[] = [];
const laterWindowListener = (event: KeyboardEvent) => reachedLaterListener.push(event);

/** Dispatches a keydown from the focused element, as the browser does. */
function press(key: string, code = key.length === 1 ? `Key${key.toUpperCase()}` : key) {
  const target = document.activeElement ?? document.body;
  const event = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true });
  const before = reachedLaterListener.length;
  target.dispatchEvent(event);
  return { prevented: event.defaultPrevented, reachedLater: reachedLaterListener.length > before };
}

function fakeSurface(scope: KeySurface["scope"], mode: KeyMode = "normal") {
  const commands: Array<readonly [string, number | null]> = [];
  const label: EngineModeLabel = mode === "visual" ? "VISUAL" : "NORMAL";
  const surface: KeySurface = {
    scope,
    mode: () => mode,
    label: () => label,
    isPending: () => false,
    handleKey: () => false,
    runCommand: (command, count) => {
      commands.push([command, count]);
      return true;
    },
    reset: () => {},
  };
  return { commands, dispose: registerKeySurface(surface) };
}

beforeAll(() => {
  installKeyEngine();
  // Registered after the engine and in the same capture phase, as the pane
  // chords are in the app (`usePaneNavigation.ts`). Only
  // `stopImmediatePropagation` keeps a consumed key from a later listener on
  // the same target and phase; `stopPropagation` would let it through.
  window.addEventListener("keydown", laterWindowListener, true);
});

let disposeSurfaces: Array<() => void> = [];

beforeEach(() => {
  document.body.innerHTML = LAYOUT;
  reachedLaterListener.length = 0;
  configureKeyEngine({ enabled: true });
});

afterEach(() => {
  vi.useRealTimers();
  for (const dispose of disposeSurfaces) dispose();
  disposeSurfaces = [];
  configureKeyEngine({ enabled: false });
  document.body.innerHTML = "";
});

describe("key engine leader in the chat", () => {
  it("consumes the leader in the chat and opens which-key only after 200 ms", () => {
    vi.useFakeTimers();
    disposeSurfaces.push(fakeSurface("chat").dispose);
    byTestId("chat-focus").focus();

    const leader = press(" ", "Space");
    expect(leader).toEqual({ prevented: true, reachedLater: false });
    expect(readKeyEngineSnapshot().pending).toEqual(["<Space>"]);
    expect(readKeyEngineSnapshot().whichKey).toBeNull();

    vi.advanceTimersByTime(199);
    expect(readKeyEngineSnapshot().whichKey).toBeNull();

    vi.advanceTimersByTime(1);
    const whichKey = readKeyEngineSnapshot().whichKey;
    expect(whichKey).not.toBeNull();
    expect(whichKey!.rows).toContainEqual(
      expect.objectContaining({ token: "w", label: "Resize panes", isGroup: false }),
    );
    expect(whichKey!.rows).toContainEqual(
      expect.objectContaining({ token: "t", label: "thread", isGroup: true }),
    );
  });

  it("runs the leader command a sequence reaches and closes which-key", () => {
    vi.useFakeTimers();
    disposeSurfaces.push(fakeSurface("chat").dispose);
    byTestId("chat-focus").focus();

    press(" ", "Space");
    vi.advanceTimersByTime(200);
    expect(readKeyEngineSnapshot().whichKey).not.toBeNull();

    expect(press("w")).toEqual({ prevented: true, reachedLater: false });
    expect(isPaneModeActive()).toBe(true);
    expect(readKeyEngineSnapshot().mode).toBe("PANE");
    expect(readKeyEngineSnapshot().whichKey).toBeNull();
    expect(readKeyEngineSnapshot().pending).toEqual([]);

    press("Escape");
    expect(isPaneModeActive()).toBe(false);
  });

  it("hands a scoped leader command to the chat surface that owns it", () => {
    const chat = fakeSurface("chat", "visual");
    disposeSurfaces.push(chat.dispose);
    byTestId("chat-focus").focus();

    press(" ", "Space");
    press("c");
    expect(chat.commands).toEqual([["chat.cite", null]]);
  });

  it("reports a leader command whose owner is not mounted as not available, and does nothing else", () => {
    disposeSurfaces.push(fakeSurface("chat").dispose);
    byTestId("chat-focus").focus();

    expect(press(" ", "Space")).toEqual({ prevented: true, reachedLater: false });
    expect(press("t")).toEqual({ prevented: true, reachedLater: false });
    expect(press("p")).toEqual({ prevented: true, reachedLater: false });

    expect(readKeyEngineSnapshot().notice).toContain("is not available here");
    expect(reachedLaterListener.map((event) => event.key)).toEqual([]);
    expect(readKeyEngineSnapshot().pending).toEqual([]);
    expect(readKeyEngineSnapshot().whichKey).toBeNull();
    expect(readKeyEngineSnapshot().mode).toBe("NORMAL");
    expect(document.activeElement).toBe(byTestId("chat-focus"));
  });

  it("reports a leader sequence that leaves the keymap as not mapped", () => {
    disposeSurfaces.push(fakeSurface("chat").dispose);
    byTestId("chat-focus").focus();

    press(" ", "Space");
    expect(press("z")).toEqual({ prevented: true, reachedLater: false });
    expect(readKeyEngineSnapshot().notice).toBe("<Space>z is not mapped");
    expect(readKeyEngineSnapshot().pending).toEqual([]);
  });
});

describe("key engine passthrough scopes", () => {
  const cases: ReadonlyArray<readonly [string, () => void]> = [
    ["the terminal", () => byTestId("terminal-input").focus()],
    ["the Monaco editor", () => byTestId("monaco-input").focus()],
    [
      "an open dialog holding focus",
      () => {
        document.body.insertAdjacentHTML(
          "beforeend",
          '<div role="dialog"><button data-testid="dialog-button">ok</button></div>',
        );
        byTestId("dialog-button").focus();
      },
    ],
    [
      "an open modal dialog with focus left behind it",
      () => {
        document.body.insertAdjacentHTML(
          "beforeend",
          '<div role="dialog" aria-modal="true"></div>',
        );
        byTestId("chat-focus").focus();
      },
    ],
    [
      "the command palette",
      () => {
        document.body.insertAdjacentHTML("beforeend", "<div data-command-palette></div>");
        byTestId("chat-focus").focus();
      },
    ],
  ];

  for (const [name, focusIt] of cases) {
    it(`passes every key through unconsumed in ${name}`, () => {
      disposeSurfaces.push(fakeSurface("chat").dispose);
      focusIt();
      for (const { key, code } of KEYS) {
        expect({ key, ...press(key, code) }).toEqual({
          key,
          prevented: false,
          reachedLater: true,
        });
      }
      expect(readKeyEngineSnapshot().scope).toBe("passthrough");
      expect(readKeyEngineSnapshot().pending).toEqual([]);
    });
  }
});

describe("key engine in a tree", () => {
  it("leaves the tree its own keys and takes the leader", () => {
    byTestId("file-tree").focus();
    for (const { key, code } of KEYS.filter(({ key }) => key !== " ")) {
      expect({ key, ...press(key, code) }).toEqual({ key, prevented: false, reachedLater: true });
    }
    expect(press(" ", "Space")).toEqual({ prevented: true, reachedLater: false });
    expect(readKeyEngineSnapshot().scope).toBe("tree");
    expect(readKeyEngineSnapshot().pending).toEqual(["<Space>"]);
    // The key after the leader is the sequence's, even one the tree would take.
    expect(press("j")).toEqual({ prevented: true, reachedLater: false });
  });
});

describe("key engine in the chat without a binding", () => {
  it("swallows a printable chat key so no later window listener types it", () => {
    disposeSurfaces.push(fakeSurface("chat").dispose);
    byTestId("chat-focus").focus();

    for (const key of ["x", "q", "Z", "/"]) {
      expect({ key, ...press(key) }).toEqual({ key, prevented: true, reachedLater: false });
    }
    expect(document.activeElement).toBe(byTestId("chat-focus"));
  });

  it("lets a named chat key the keymap does not bind reach later listeners", () => {
    disposeSurfaces.push(fakeSurface("chat").dispose);
    byTestId("chat-focus").focus();

    expect(press("F5", "F5")).toEqual({ prevented: false, reachedLater: true });
  });

  it("leaves every key alone while Vim mode is off", () => {
    disposeSurfaces.push(fakeSurface("chat").dispose);
    configureKeyEngine({ enabled: false });
    byTestId("chat-focus").focus();

    for (const { key, code } of KEYS) {
      expect({ key, ...press(key, code) }).toEqual({ key, prevented: false, reachedLater: true });
    }
  });
});

describe("default modal keymap", () => {
  it("compiles the default modal keymap without a conflict", () => {
    expect(compileKeymap(DEFAULT_KEYMAP).conflicts).toEqual([]);
  });
});
