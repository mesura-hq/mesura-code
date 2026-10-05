/**
 * Entry point: `createDictationWidgetWindow`, the controller the desktop main
 * process feeds with the renderer's published dictation state and the main
 * window's focus, with the Electron window factory injected. The decision
 * itself is `shouldShowDictationWidget`, tested directly.
 *
 * STT redesign, phase 6, criteria 3 and 4.
 */
import type * as Electron from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createDictationWidgetWindow,
  DICTATION_WIDGET_RESULT_MS,
  DICTATION_WIDGET_TITLE,
  shouldShowDictationWidget,
  type DictationWidgetHostWindow,
  type DictationWidgetMessage,
  type DictationWidgetPresence,
} from "./DictationWidgetWindow.ts";

const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const nothing: DictationWidgetPresence = {
  recording: false,
  transcribing: false,
  deliveredAt: null,
};
const recording = { ...nothing, recording: true };
const transcribing = { ...nothing, transcribing: true };

function makeFakeWindow() {
  let visible = false;
  let destroyed = false;
  const calls: string[] = [];
  const titleListeners: Array<(event: { preventDefault: () => void }) => void> = [];
  const window = {
    calls,
    titleListeners,
    setTitle: vi.fn((title: string) => {
      calls.push(`setTitle:${title}`);
    }),
    showInactive: vi.fn(() => {
      calls.push("showInactive");
      visible = true;
    }),
    show: vi.fn(() => {
      visible = true;
    }),
    focus: vi.fn(),
    hide: vi.fn(() => {
      visible = false;
    }),
    isVisible: () => visible,
    isDestroyed: () => destroyed,
    destroy: vi.fn(() => {
      destroyed = true;
      visible = false;
    }),
    loadURL: vi.fn(async () => undefined),
    setBounds: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setIgnoreMouseEvents: vi.fn(),
    on: vi.fn((event: string, listener: (event: { preventDefault: () => void }) => void) => {
      if (event === "page-title-updated") titleListeners.push(listener);
    }),
    once: vi.fn(),
    /** What the page was sent, in order. */
    messages: [] as DictationWidgetMessage[],
    /** Called with each message, as the page's renderer would receive it. */
    onMessage: (_message: DictationWidgetMessage) => undefined as void,
    webContents: {
      send: vi.fn((_channel: string, message: DictationWidgetMessage) => {
        window.messages.push(message);
        window.onMessage(message);
      }),
      on: vi.fn(),
      once: vi.fn(),
    },
  };
  return window;
}

/**
 * `renders: "at once"` is a page that commits and acknowledges each snapshot as it arrives;
 * `"never"` is one still on its boot splash, acknowledged by hand through `widget.acknowledge`.
 */
function makeWidget({ renders = "at once" }: { renders?: "at once" | "never" } = {}) {
  const window = makeFakeWindow();
  const createWindow = vi.fn(
    (_options: Electron.BrowserWindowConstructorOptions) =>
      window as unknown as DictationWidgetHostWindow,
  );
  const widget = createDictationWidgetWindow({ createWindow });
  if (renders === "at once") {
    window.onMessage = (message) => {
      if (message?.ackSequence !== undefined) widget.acknowledge(message.ackSequence);
    };
  }
  return { widget, window, createWindow };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dictation phase 6 fence: widget visibility decision", () => {
  it("dictation phase 6 AC3: the widget shows only while the main window is unfocused and something is in progress", () => {
    const decide = (mainWindowFocused: boolean, presence: DictationWidgetPresence | null) =>
      shouldShowDictationWidget({ mainWindowFocused, presence, now: NOW });
    expect(decide(false, recording)).toBe(true);
    expect(decide(false, transcribing)).toBe(true);
    expect(decide(false, { ...nothing, deliveredAt: NOW })).toBe(true);
    expect(decide(true, recording)).toBe(false);
    expect(decide(true, { ...nothing, deliveredAt: NOW })).toBe(false);
    expect(decide(false, nothing)).toBe(false);
    expect(decide(false, null)).toBe(false);
  });

  it("dictation phase 6 AC4: a delivery result counts as fresh for 1.8 seconds", () => {
    expect(DICTATION_WIDGET_RESULT_MS).toBe(1_800);
    const decide = (deliveredAt: number) =>
      shouldShowDictationWidget({
        mainWindowFocused: false,
        presence: { ...nothing, deliveredAt },
        now: NOW,
      });
    expect(decide(NOW - 1_799)).toBe(true);
    expect(decide(NOW - 1_800)).toBe(false);
  });
});

describe("dictation phase 6 fence: widget window", () => {
  it("dictation phase 6 AC3: the widget window is titled for the window rules and cannot take focus", () => {
    const { widget, createWindow } = makeWidget();
    widget.setMainWindowFocused(false);
    widget.update(recording);
    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(createWindow.mock.calls[0]![0]).toMatchObject({
      title: DICTATION_WIDGET_TITLE,
      focusable: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
    });
    expect(DICTATION_WIDGET_TITLE).toBe("mesura-dictation-overlay");
  });

  it("dictation phase 6 AC3: a recording with the main window unfocused shows the widget without activating it", () => {
    const { widget, window } = makeWidget();
    widget.setMainWindowFocused(false);
    widget.update(recording);
    expect(window.showInactive).toHaveBeenCalled();
    expect(window.isVisible()).toBe(true);
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
  });

  it("dictation phase 6 AC3: the widget hides when the main window gains focus and returns when it loses it", () => {
    const { widget, window } = makeWidget();
    widget.setMainWindowFocused(false);
    widget.update(recording);
    widget.setMainWindowFocused(true);
    expect(window.isVisible()).toBe(false);
    widget.setMainWindowFocused(false);
    expect(window.isVisible()).toBe(true);
    expect(window.show).not.toHaveBeenCalled();
  });

  it("dictation phase 6 guard: the widget stays hidden while the main window has focus", () => {
    const { widget, window, createWindow } = makeWidget();
    widget.setMainWindowFocused(true);
    widget.update(recording);
    expect(window.isVisible()).toBe(false);
    expect(window.showInactive).not.toHaveBeenCalled();
    expect(createWindow.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("dictation phase 6 AC3: the widget hides once no recording, transcription or fresh result remains", () => {
    const { widget, window } = makeWidget();
    widget.setMainWindowFocused(false);
    widget.update(transcribing);
    expect(window.isVisible()).toBe(true);
    widget.update(nothing);
    expect(window.isVisible()).toBe(false);
  });

  it("dictation phase 6 AC4: the delivery result shows for 1.8 seconds, then the widget hides", () => {
    const { widget, window } = makeWidget();
    widget.setMainWindowFocused(false);
    widget.update(recording);
    widget.update({ ...nothing, deliveredAt: NOW });
    expect(window.isVisible()).toBe(true);
    vi.advanceTimersByTime(1_799);
    expect(window.isVisible()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(window.isVisible()).toBe(false);
  });

  it("dictation phase 6 AC4: a new recording during the result keeps the widget past 1.8 seconds", () => {
    const { widget, window } = makeWidget();
    widget.setMainWindowFocused(false);
    widget.update({ ...nothing, deliveredAt: NOW });
    vi.advanceTimersByTime(1_000);
    widget.update({ ...recording, deliveredAt: NOW });
    vi.advanceTimersByTime(5_000);
    expect(window.isVisible()).toBe(true);
  });
});

describe("dictation phase 6 regressions: widget window", () => {
  it("dictation phase 6 regression: the widget page cannot replace the window title the rules match", () => {
    const { widget, window } = makeWidget();
    widget.setMainWindowFocused(false);
    widget.update(recording);
    expect(window.titleListeners).toHaveLength(1);
    const preventDefault = vi.fn();
    window.titleListeners[0]!({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("dictation phase 6 regression: every show maps the widget under its rule title", () => {
    const { widget, window } = makeWidget();
    widget.setMainWindowFocused(false);
    widget.update(recording);
    widget.update(nothing);
    widget.update(transcribing);
    // An X11 window maps again with its current title, so each show sets it first.
    expect(window.calls).toEqual([
      `setTitle:${DICTATION_WIDGET_TITLE}`,
      "showInactive",
      `setTitle:${DICTATION_WIDGET_TITLE}`,
      "showInactive",
    ]);
  });

  it("dictation phase 6 regression: the widget never counts as a focused Mesura window", () => {
    const { widget, window } = makeWidget();
    widget.setFocusedWindow(null);
    widget.update(recording);
    expect(window.isVisible()).toBe(true);
    // A compositor without the window rules focuses the widget itself.
    widget.setFocusedWindow(window);
    expect(window.isVisible()).toBe(true);
    widget.update(transcribing);
    expect(window.isVisible()).toBe(true);
    // The user going back to a Mesura window still hides it.
    widget.setFocusedWindow({});
    expect(window.isVisible()).toBe(false);
  });
});

describe("dictation phase 6 fence: a failed transcription", () => {
  const failed: DictationWidgetPresence = { ...nothing, failedAt: NOW - 60_000 };

  it("dictation phase 6 failure: an unseen failure shows while no Mesura window has focus, with no timeout", () => {
    const decide = (input: {
      mainWindowFocused: boolean;
      presence: DictationWidgetPresence;
      dismissedFailureAt?: number | null;
    }) => shouldShowDictationWidget({ now: NOW, ...input });
    // A minute old and still shown: unlike a success it does not time out.
    expect(decide({ mainWindowFocused: false, presence: failed })).toBe(true);
    expect(decide({ mainWindowFocused: true, presence: failed })).toBe(false);
    // Seen in Mesura: no longer shown once the user leaves again.
    expect(
      decide({ mainWindowFocused: false, presence: failed, dismissedFailureAt: NOW - 60_000 }),
    ).toBe(false);
    // A later failure is a new one.
    expect(
      decide({
        mainWindowFocused: false,
        presence: { ...nothing, failedAt: NOW },
        dismissedFailureAt: NOW - 60_000,
      }),
    ).toBe(true);
  });

  it("dictation phase 6 failure: focus on a Mesura window clears the failure for good", () => {
    const { widget, window } = makeWidget();
    widget.setFocusedWindow(null);
    widget.update(failed);
    expect(window.isVisible()).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(window.isVisible()).toBe(true);

    widget.setFocusedWindow({});
    expect(window.isVisible()).toBe(false);
    widget.setFocusedWindow(null);
    expect(window.isVisible()).toBe(false);
    // The widget page is not handed the seen failure either.
    widget.update({ ...failed, transcribing: true });
    expect(window.isVisible()).toBe(true);
    expect(widget.state()).toMatchObject({ transcribing: true, failedAt: null });
  });

  it("dictation phase 6 failure: a failure that arrives while Mesura has focus shows once the user leaves", () => {
    const { widget, window } = makeWidget();
    widget.setFocusedWindow(null);
    widget.setFocusedWindow({});
    // A retry clicked in Mesura that fails at once, before the user leaves.
    widget.update(failed);
    widget.setFocusedWindow(null);
    expect(window.isVisible()).toBe(true);
    // Coming back to Mesura is what dismisses it.
    widget.setFocusedWindow({});
    widget.setFocusedWindow(null);
    expect(window.isVisible()).toBe(false);
  });

  it("dictation phase 6 failure: a new recording replaces the failure", () => {
    const { widget, window } = makeWidget();
    widget.setFocusedWindow(null);
    widget.update(failed);
    // The renderer clears the failure when a recording starts.
    widget.update(recording);
    expect(window.isVisible()).toBe(true);
    expect(widget.state()).toMatchObject({ recording: true });
    widget.update(nothing);
    expect(window.isVisible()).toBe(false);
  });
});

describe("dictation phase 6 rework: a retried job that fails again", () => {
  it("dictation phase 6 rework: a failure after a dismissed one shows again", () => {
    const { widget, window } = makeWidget();
    widget.setFocusedWindow(null);
    widget.update({ ...nothing, failedAt: NOW });
    expect(window.isVisible()).toBe(true);
    // Seen in Mesura, retried there, and the user leaves for another app.
    widget.setFocusedWindow({});
    widget.update(transcribing);
    widget.setFocusedWindow(null);
    expect(window.isVisible()).toBe(true);
    widget.update({ ...nothing, failedAt: NOW + 5_000 });
    expect(window.isVisible()).toBe(true);
    expect(widget.state()).toMatchObject({ failedAt: NOW + 5_000 });
  });
});

describe("dictation phase 6 rework: the widget page sees updates only while it is shown", () => {
  it("dictation phase 6 rework: while Mesura has focus the widget page is sent nothing", () => {
    const { widget, window } = makeWidget();
    widget.setFocusedWindow(null);
    widget.update(recording);
    widget.setFocusedWindow({});
    const sentBefore = window.messages.length;
    for (let sample = 0; sample < 10; sample += 1) {
      widget.update({ ...recording, level: sample / 10 } as DictationWidgetPresence);
    }
    expect(window.messages.length).toBe(sentBefore);
    // Hiding cleared the page, so its waveform does not run off screen.
    expect(window.messages.at(-1)).toBeNull();
  });

  it("dictation phase 6 rework: a shown widget gets each update once", () => {
    const { widget, window } = makeWidget();
    widget.setFocusedWindow(null);
    widget.update(recording);
    const sentBefore = window.messages.length;
    for (let sample = 0; sample < 10; sample += 1) {
      widget.update({ ...recording, level: sample / 10 } as DictationWidgetPresence);
    }
    expect(window.messages.length - sentBefore).toBe(10);
  });

  it("dictation phase 6 rework: each show is preceded by the current snapshot", () => {
    const { widget, window } = makeWidget();
    widget.setFocusedWindow(null);
    widget.update(recording);
    widget.setFocusedWindow({});
    widget.update({ ...recording, level: 0.7 } as DictationWidgetPresence);
    widget.setFocusedWindow(null);
    expect(window.isVisible()).toBe(true);
    expect(window.messages.at(-1)).toMatchObject({ recording: true, level: 0.7 });
  });
});

describe("dictation phase 6 rework: the widget shows only once its page has rendered", () => {
  it("dictation phase 6 rework: the window stays hidden until the page acknowledges the snapshot", () => {
    const { widget, window } = makeWidget({ renders: "never" });
    widget.setFocusedWindow(null);
    widget.update(recording);
    expect(window.showInactive).not.toHaveBeenCalled();
    const asked = window.messages.at(-1)!;
    expect(asked).toMatchObject({ recording: true, ackSequence: expect.any(Number) });
    widget.acknowledge(asked.ackSequence! + 1);
    expect(window.isVisible()).toBe(false);
    widget.acknowledge(asked.ackSequence!);
    expect(window.isVisible()).toBe(true);
  });

  it("dictation phase 6 rework: a recording cancelled while the page renders never shows", () => {
    const { widget, window } = makeWidget({ renders: "never" });
    widget.setFocusedWindow(null);
    widget.update(recording);
    const asked = window.messages.at(-1)!;
    widget.update(nothing);
    widget.acknowledge(asked.ackSequence!);
    expect(window.showInactive).not.toHaveBeenCalled();
    expect(window.messages.at(-1)).toBeNull();
  });

  it("dictation phase 6 rework: focus on Mesura while the page renders keeps the widget hidden", () => {
    const { widget, window } = makeWidget({ renders: "never" });
    widget.setFocusedWindow(null);
    widget.update(recording);
    const asked = window.messages.at(-1)!;
    widget.setFocusedWindow({});
    widget.acknowledge(asked.ackSequence!);
    expect(window.showInactive).not.toHaveBeenCalled();
  });
});
