/**
 * Mesura's dictation outside the main window: the floating widget and the Hyprland session
 * binds. The main window's renderer publishes its dictation state on
 * `PUBLISH_DICTATION_WIDGET_STATE_CHANNEL`; this service relays it to the widget window, shows
 * the widget while no Mesura window has focus, and binds the dictation keys in Hyprland while a
 * session is live. It also listens on the dictation socket, the fast way in for those binds and
 * for a hand-written global bind; a `--dictation …` second launch, their fallback, is forwarded in
 * `DesktopClerk`, where the single-instance lock lives.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { getDesktopUrl } from "../electron/ElectronProtocol.ts";
import {
  DICTATION_COMMAND_LINE_CHANNEL,
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
  dictationSocketCommand,
  listenForDictationCommands,
  processSocketDefaults,
  resolveDictationSocketPath,
} from "./dictationControlSocket.ts";
import { resolveDictationLauncher } from "./dictationLauncher.ts";
import { createHyprlandSessionBinds, executeHyprctl } from "./hyprlandSessionBinds.ts";

const { logWarning } = makeComponentLogger("dictation-widget");

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
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const ipc = yield* DesktopIpc.DesktopIpc;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);

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
  });

  const launcher = resolveDictationLauncher({
    appImagePath: Option.getOrNull(environment.appImagePath),
    isDevelopment: environment.isDevelopment,
    execPath: process.execPath,
    argv: process.argv,
    cwd: process.cwd(),
    env: process.env,
  });
  const socketPath = resolveDictationSocketPath({
    env: process.env,
    isDevelopment: environment.isDevelopment,
    userDataPath: Electron.app.getPath("userData"),
    ...processSocketDefaults(),
  });
  const socket = listenForDictationCommands({
    socketPath,
    onCommand: (command) =>
      runFork(
        Effect.gen(function* () {
          const mainWindow = yield* electronWindow.currentMainOrFirst;
          if (Option.isSome(mainWindow)) {
            mainWindow.value.webContents.send(DICTATION_COMMAND_LINE_CHANNEL, command);
          }
        }),
      ),
    onError: (cause) =>
      runFork(
        logWarning("the dictation socket is not listening; binds fall back to a second launch", {
          socketPath,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      ),
  });

  const binds = createHyprlandSessionBinds({
    env: process.env,
    commandFor: (command) => dictationSocketCommand({ socketPath, launcher, command }),
    execute: executeHyprctl,
    onError: (cause) =>
      runFork(
        logWarning("hyprctl did not apply the dictation binds", {
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      ),
  });

  const apply = (state: PublishedDictationState) => {
    widget.update(state);
    void binds.setSessionActive(state.live);
  };

  // Blur fires before the next window's focus, so read the outcome once both have landed.
  const syncFocus = () =>
    setImmediate(() => widget.setFocusedWindow(Electron.BrowserWindow.getFocusedWindow()));
  yield* electronApp.on("browser-window-focus", syncFocus);
  yield* electronApp.on("browser-window-blur", syncFocus);
  yield* electronApp.on("before-quit", () => {
    void binds.dispose();
    socket.close();
  });

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

  yield* Effect.addFinalizer(() =>
    Effect.promise(() => binds.dispose()).pipe(
      Effect.andThen(Effect.sync(widget.dispose)),
      Effect.andThen(Effect.sync(socket.close)),
    ),
  );

  return DesktopDictationWidget.of({});
});

export const layer = Layer.effect(DesktopDictationWidget, make);
