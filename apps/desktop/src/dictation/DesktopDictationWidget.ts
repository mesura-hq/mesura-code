/**
 * Mesura's dictation outside the main window: the floating widget, its Hyprland window rules,
 * and the Hyprland session binds. The main window's renderer publishes its dictation state on
 * `PUBLISH_DICTATION_WIDGET_STATE_CHANNEL`; this service relays it to the widget window, shows
 * the widget while no Mesura window has focus, and binds the dictation keys in Hyprland while a
 * session is live. Those binds reach this process over the session's command socket; the
 * `--dictation …` command line of a second launch is forwarded in `DesktopClerk`, where the
 * single-instance lock lives, through the same `forwardDictationCommand`.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import { getDesktopUrl } from "../electron/ElectronProtocol.ts";
import {
  DICTATION_WIDGET_RENDERED_CHANNEL,
  GET_DICTATION_WIDGET_STATE_CHANNEL,
  PUBLISH_DICTATION_WIDGET_STATE_CHANNEL,
} from "../ipc/channels.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import {
  createDictationWidgetWindow,
  type DictationWidgetPresence,
} from "./DictationWidgetWindow.ts";
import {
  dictationCommandSocketPath,
  makeDictationCommandSocket,
} from "./dictationCommandSocket.ts";
import { resolveDictationLauncher } from "./dictationLauncher.ts";
import { createDictationSessionKeys } from "./dictationSessionKeys.ts";
import { executeHyprctl } from "./hyprctl.ts";
import { createHyprlandSessionBinds, resolveCommandPath } from "./hyprlandSessionBinds.ts";
import { createHyprlandWidgetRules } from "./hyprlandWidgetRules.ts";

const { logWarning } = makeComponentLogger("dictation-widget");

const causeMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** The query the web bundle's entry reads to draw the widget instead of the app. */
const WIDGET_PAGE_QUERY = "?window=dictation-widget";

/** The published state, as far as this process reads it; the widget page reads the rest. */
type PublishedDictationState = DictationWidgetPresence & {
  /** A recording, or the last stopped job still transcribing: the dictation keys apply. */
  readonly live: boolean;
};

const NOTHING: PublishedDictationState = {
  recording: false,
  transcribing: false,
  deliveredAt: null,
  live: false,
};

function parsePublishedState(raw: unknown): PublishedDictationState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { recording, transcribing, deliveredAt, live } = raw as Record<string, unknown>;
  if (typeof recording !== "boolean" || typeof transcribing !== "boolean") return null;
  if (typeof live !== "boolean") return null;
  if (deliveredAt !== null && typeof deliveredAt !== "number") return null;
  const { failedAt } = raw as Record<string, unknown>;
  if (failedAt !== undefined && failedAt !== null && typeof failedAt !== "number") return null;
  return raw as PublishedDictationState;
}

export class DesktopDictationWidget extends Context.Service<DesktopDictationWidget, {}>()(
  "@t3tools/desktop/dictation/DesktopDictationWidget",
) {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const ipc = yield* DesktopIpc.DesktopIpc;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);

  const widgetRules = createHyprlandWidgetRules({
    env: process.env,
    execute: executeHyprctl,
    onError: (cause) =>
      runFork(
        logWarning("hyprctl did not apply the dictation widget rules", {
          message: causeMessage(cause),
        }),
      ),
  });

  const widgetUrl = `${getDesktopUrl(environment.isDevelopment)}${WIDGET_PAGE_QUERY}`;
  const widget = createDictationWidgetWindow({
    createWindow: (options) => {
      const window = new Electron.BrowserWindow({
        ...options,
        webPreferences: {
          preload: environment.preloadPath,
          backgroundThrottling: false,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      window.setIgnoreMouseEvents(true);
      void window.loadURL(widgetUrl).catch(() => undefined);
      return window;
    },
    workArea: () =>
      Electron.screen.getDisplayNearestPoint(Electron.screen.getCursorScreenPoint()).workArea,
    beforeFirstShow: widgetRules.apply,
  });

  const launcher = resolveDictationLauncher({
    appImagePath: Option.getOrNull(environment.appImagePath),
    isDevelopment: environment.isDevelopment,
    execPath: process.execPath,
    argv: process.argv,
    cwd: process.cwd(),
    env: process.env,
  });
  const socketPath = dictationCommandSocketPath({
    env: process.env,
    pid: process.pid,
    userDataPath: Electron.app.getPath("userData"),
  });
  // Closed with the session, and by this layer's scope on quit.
  const commandSocket = yield* makeDictationCommandSocket({ socketPath });
  const binds = createHyprlandSessionBinds({
    env: process.env,
    launcher,
    socketPath,
    resolveCommand: resolveCommandPath,
    execute: executeHyprctl,
    onError: (cause) =>
      runFork(
        logWarning("hyprctl did not apply the dictation binds", {
          message: causeMessage(cause),
        }),
      ),
  });

  const runPromise = Effect.runPromiseWith(context);
  const sessionKeys = createDictationSessionKeys({
    binds,
    setSocketActive: (active) => runPromise(commandSocket.setSessionActive(active)),
    onError: (cause) =>
      runFork(
        logWarning("the dictation keys did not follow the session", {
          message: causeMessage(cause),
        }),
      ),
  });

  const apply = (state: PublishedDictationState) => {
    widget.update(state);
    sessionKeys.setLive(state.live);
  };

  // Blur fires before the next window's focus, so read the outcome once both have landed.
  const syncFocus = () =>
    setImmediate(() => widget.setFocusedWindow(Electron.BrowserWindow.getFocusedWindow()));
  yield* electronApp.on("browser-window-focus", syncFocus);
  yield* electronApp.on("browser-window-blur", syncFocus);
  yield* electronApp.on("before-quit", () => void sessionKeys.dispose());

  /** The renderer that publishes; when it goes away its dictation goes with it. */
  const publishers = new Set<number>();

  yield* ipc.handle({
    channel: PUBLISH_DICTATION_WIDGET_STATE_CHANNEL,
    handler: (raw, event) =>
      Effect.sync(() => {
        const state = parsePublishedState(raw);
        if (state === null) return;
        const senderId = event?.sender.id;
        if (senderId !== undefined && !publishers.has(senderId)) {
          publishers.add(senderId);
          Electron.webContents.fromId(senderId)?.once("destroyed", () => {
            publishers.delete(senderId);
            apply(NOTHING);
            // A hidden widget would otherwise keep the app alive after its last window closed.
            widget.dispose();
          });
        }
        apply(state);
      }),
  });

  yield* ipc.handle({
    channel: DICTATION_WIDGET_RENDERED_CHANNEL,
    handler: (raw) =>
      Effect.sync(() => {
        if (typeof raw === "number") widget.acknowledge(raw);
      }),
  });

  // The widget page pulls the latest state when it starts listening.
  yield* ipc.handle({
    channel: GET_DICTATION_WIDGET_STATE_CHANNEL,
    handler: () => Effect.sync(() => widget.state()),
  });

  // Runs before the socket's own finalizer, which was registered first: the binds are restored
  // and the socket closed in order, after any start still running.
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => sessionKeys.dispose()).pipe(Effect.andThen(Effect.sync(widget.dispose))),
  );

  return DesktopDictationWidget.of({});
});

export const layer = Layer.effect(DesktopDictationWidget, make);
