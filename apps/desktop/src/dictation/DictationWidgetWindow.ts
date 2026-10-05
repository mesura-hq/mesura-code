// @effect-diagnostics globalTimers:off globalDate:off -- The result timer runs from IPC callbacks outside any Effect fiber.
import type * as Electron from "electron";

import { DICTATION_WIDGET_STATE_CHANNEL } from "../ipc/channels.ts";

/**
 * The small window that shows a dictation while another app has focus. It is drawn by the web
 * bundle's widget page from the state the main window's renderer publishes; this module decides
 * when it is on screen and relays that state to it.
 *
 * The title is what the user's Hyprland window rules match (see the composer guide): without
 * them Hyprland focuses the window and keeps it on one workspace.
 */
export const DICTATION_WIDGET_TITLE = "mesura-dictation-overlay";
/** How long the delivery result stays on screen. */
export const DICTATION_WIDGET_RESULT_MS = 1_800;

const WIDGET_WIDTH = 440;
const WIDGET_HEIGHT = 64;
const WIDGET_BOTTOM_MARGIN = 24;

/** What the renderer publishes, as far as the main process reads it. */
export interface DictationWidgetPresence {
  readonly recording: boolean;
  readonly transcribing: boolean;
  /** When the last transcript was delivered, in epoch milliseconds. */
  readonly deliveredAt: number | null;
  /**
   * When this device's last job failed. A failure stays on screen until a Mesura window has
   * focus or a new recording starts (the renderer then clears it): unlike a success it does not
   * time out, because the user in another app would otherwise assume the message went out.
   */
  readonly failedAt?: number | null;
}

export type DictationWidgetHostWindow = Pick<
  Electron.BrowserWindow,
  | "showInactive"
  | "hide"
  | "isVisible"
  | "isDestroyed"
  | "destroy"
  | "loadURL"
  | "setBounds"
  | "setTitle"
> & {
  readonly webContents: Pick<Electron.WebContents, "send">;
  readonly on: (
    event: "page-title-updated",
    listener: (event: { preventDefault: () => void }) => void,
  ) => unknown;
};

/** A failure the user has not seen in Mesura yet. */
export function isUnseenDictationFailure(
  presence: DictationWidgetPresence | null,
  dismissedFailureAt: number | null,
): boolean {
  const failedAt = presence?.failedAt ?? null;
  return failedAt !== null && failedAt !== dismissedFailureAt;
}

export function shouldShowDictationWidget(input: {
  readonly mainWindowFocused: boolean;
  readonly presence: DictationWidgetPresence | null;
  readonly now: number;
  /** The failure that was on record while a Mesura window had focus: the user has seen it. */
  readonly dismissedFailureAt?: number | null;
}): boolean {
  const { presence } = input;
  if (input.mainWindowFocused || presence === null) return false;
  return (
    presence.recording ||
    presence.transcribing ||
    isUnseenDictationFailure(presence, input.dismissedFailureAt ?? null) ||
    (presence.deliveredAt !== null && input.now - presence.deliveredAt < DICTATION_WIDGET_RESULT_MS)
  );
}

export const DICTATION_WIDGET_WINDOW_OPTIONS = {
  title: DICTATION_WIDGET_TITLE,
  width: WIDGET_WIDTH,
  height: WIDGET_HEIGHT,
  alwaysOnTop: true,
  backgroundColor: "#00000000",
  focusable: false,
  frame: false,
  hasShadow: false,
  resizable: false,
  show: false,
  skipTaskbar: true,
  transparent: true,
} satisfies Electron.BrowserWindowConstructorOptions;

/** Bottom centre of a display's work area. */
export function dictationWidgetBounds(workArea: Electron.Rectangle): Electron.Rectangle {
  return {
    x: Math.round(workArea.x + (workArea.width - WIDGET_WIDTH) / 2),
    y: workArea.y + workArea.height - WIDGET_HEIGHT - WIDGET_BOTTOM_MARGIN,
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
  };
}

/**
 * What the widget page is sent: the state to draw, or `null` to draw nothing while hidden (so its
 * waveform stops). `ackSequence` asks the page to acknowledge once it has rendered this state:
 * the window is shown only then, never over the page's boot splash.
 */
export type DictationWidgetMessage =
  | (DictationWidgetPresence & { readonly ackSequence?: number })
  | null;

export function createDictationWidgetWindow(input: {
  /** Creates the window with `options` and starts loading the widget page into it. */
  readonly createWindow: (
    options: Electron.BrowserWindowConstructorOptions,
  ) => DictationWidgetHostWindow;
  /** The work area of the display the user is on; the window is placed when it shows. */
  readonly workArea?: () => Electron.Rectangle;
}): {
  readonly update: (state: DictationWidgetPresence) => void;
  /** The last message sent to the page, for a widget page that just loaded. */
  readonly state: () => DictationWidgetMessage;
  /** The page rendered the message carrying `sequence`. */
  readonly acknowledge: (sequence: number) => void;
  readonly setMainWindowFocused: (focused: boolean) => void;
  /**
   * The window Electron reports focused, or `null`. The widget itself never counts: a compositor
   * without the window rules focuses it, and that must not read as the user being in Mesura.
   */
  readonly setFocusedWindow: (focused: object | null) => void;
  readonly dispose: () => void;
} {
  let window: DictationWidgetHostWindow | null = null;
  let state: DictationWidgetPresence | null = null;
  // Until the main window reports otherwise, assume the user is in it.
  let mainWindowFocused = true;
  let resultTimer: ReturnType<typeof setTimeout> | null = null;
  let dismissedFailureAt: number | null = null;
  let lastSent: DictationWidgetMessage = null;
  let sequence = 0;
  /** The show waiting for the page to render `pendingSequence`. */
  let pendingSequence: number | null = null;

  /** What the widget page draws: a failure the user has seen in Mesura is left out. */
  const widgetState = (): DictationWidgetPresence | null =>
    state !== null &&
    (state.failedAt ?? null) !== null &&
    !isUnseenDictationFailure(state, dismissedFailureAt)
      ? ({ ...state, failedAt: null, failed: null } as DictationWidgetPresence)
      : state;

  const liveWindow = () => {
    if (window === null || window.isDestroyed()) {
      const created = input.createWindow(DICTATION_WIDGET_WINDOW_OPTIONS);
      // The page's <title> would replace the window title, and the window rules match the title.
      created.on("page-title-updated", (event) => event.preventDefault());
      window = created;
    }
    return window;
  };

  const existingWindow = () => (window !== null && !window.isDestroyed() ? window : null);

  const send = (target: DictationWidgetHostWindow, message: DictationWidgetMessage) => {
    lastSent = message;
    target.webContents.send(DICTATION_WIDGET_STATE_CHANNEL, message);
  };

  const shouldShow = (now: number) => {
    return shouldShowDictationWidget({
      mainWindowFocused,
      presence: state,
      now,
      dismissedFailureAt,
    });
  };

  const reconcile = () => {
    if (resultTimer !== null) clearTimeout(resultTimer);
    resultTimer = null;
    const now = Date.now();
    const show = shouldShow(now);
    const deliveredAt = state?.deliveredAt ?? null;
    if (deliveredAt !== null && now - deliveredAt < DICTATION_WIDGET_RESULT_MS) {
      resultTimer = setTimeout(reconcile, deliveredAt + DICTATION_WIDGET_RESULT_MS - now);
    }
    if (!show) {
      pendingSequence = null;
      const target = existingWindow();
      if (target === null) return;
      if (target.isVisible()) target.hide();
      // Cleared rather than left drawn: a hidden page runs no waveform and gets no updates.
      if (lastSent !== null) send(target, null);
      return;
    }
    const target = liveWindow();
    if (target.isVisible()) {
      send(target, widgetState());
      return;
    }
    // Not on screen yet: hand the page the current state and show once it has rendered it.
    pendingSequence ??= ++sequence;
    const current = widgetState();
    send(target, current === null ? null : { ...current, ackSequence: pendingSequence });
  };

  /**
   * The user coming back to Mesura is what counts as seeing a failure: the decision is "until a
   * Mesura window gains focus". A failure that lands while Mesura already has focus (a retry
   * that fails at once) stays news, and shows once the user leaves.
   */
  const setMesuraFocused = (focused: boolean) => {
    if (focused && !mainWindowFocused) dismissedFailureAt = state?.failedAt ?? dismissedFailureAt;
    mainWindowFocused = focused;
    reconcile();
  };

  const acknowledge = (acknowledged: number) => {
    if (acknowledged !== pendingSequence) return;
    pendingSequence = null;
    const target = existingWindow();
    // Focus and the session may have moved on while the page rendered.
    if (target === null || target.isVisible() || !shouldShow(Date.now())) return;
    if (input.workArea) target.setBounds(dictationWidgetBounds(input.workArea()));
    // An X11 window maps again with its current title, which the rules must still match.
    target.setTitle(DICTATION_WIDGET_TITLE);
    target.showInactive();
  };

  return {
    update: (next) => {
      state = next;
      reconcile();
    },
    state: () => lastSent,
    acknowledge,
    setMainWindowFocused: setMesuraFocused,
    setFocusedWindow: (focused) => setMesuraFocused(focused !== null && focused !== window),
    dispose: () => {
      if (resultTimer !== null) clearTimeout(resultTimer);
      resultTimer = null;
      pendingSequence = null;
      lastSent = null;
      if (window !== null && !window.isDestroyed()) window.destroy();
      window = null;
    },
  };
}
