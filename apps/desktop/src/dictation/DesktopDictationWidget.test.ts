// Entry point: DesktopDictationWidget.layer handles the renderer's dictation state and window focus.
import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { expect, vi } from "vite-plus/test";

import { MESURA_DESKTOP_CHANNEL_IDENTITY } from "../../../../scripts/lib/brand-assets.ts";
import { DesktopEnvironment } from "../app/DesktopEnvironment.ts";
import type { MesuraDesktopChannelIdentity } from "../app/mesuraChannel.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { PUBLISH_DICTATION_WIDGET_STATE_CHANNEL } from "../ipc/channels.ts";
import {
  DesktopIpc,
  type DesktopIpcHandleListener,
  make as makeDesktopIpc,
} from "../ipc/DesktopIpc.ts";
import { DesktopDictationWidget, layer as dictationWidgetLayer } from "./DesktopDictationWidget.ts";

const { executeHyprctl, appEvents } = vi.hoisted(() => ({
  appEvents: new Map<string, () => void>(),
  executeHyprctl: vi.fn(async (_file: string, args: ReadonlyArray<string>) =>
    args[0] === "-j"
      ? { stdout: args[1] === "status" ? '{"configProvider":"lua"}' : "[]" }
      : { stdout: "ok" },
  ),
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => "/fixture/userData",
    on: (event: string, listener: () => void) => appEvents.set(event, listener),
    removeListener: (event: string) => appEvents.delete(event),
  },
  webContents: { fromId: () => undefined },
  BrowserWindow: class {
    static getFocusedWindow() {
      return null;
    }
    readonly webContents = { send: () => undefined };
    setIgnoreMouseEvents() {}
    loadURL() {
      return Promise.resolve();
    }
    on() {}
    isDestroyed() {
      return false;
    }
    isVisible() {
      return false;
    }
    destroy() {}
  },
}));

vi.mock(import("./hyprctl.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  executeHyprctl,
}));
vi.mock("./hyprlandConfigReloads.ts", () => ({
  watchHyprlandConfigReloads: () => () => undefined,
}));
vi.mock("./dictationCommandSocket.ts", () => ({
  dictationCommandSocketPath: () => "/fixture/dictation.sock",
  makeDictationCommandSocket: () =>
    Effect.succeed({ setSessionActive: () => Effect.succeed(false) }),
}));

const SESSION_START = Date.parse("2026-11-23T00:00:00Z");

const publishDictationSession = Effect.fn("test.publishDictationSession")(function* (
  channel: MesuraDesktopChannelIdentity["channel"],
) {
  const handlers = new Map<string, DesktopIpcHandleListener>();
  const ipc = makeDesktopIpc(
    {
      handle: (name, listener) => {
        handlers.set(name, listener);
      },
      removeHandler: (name) => {
        handlers.delete(name);
      },
      removeAllListeners: () => undefined,
      on: () => undefined,
    },
    () => Effect.succeed(true),
  );
  const environment = DesktopEnvironment.of({
    platform: "linux",
    isDevelopment: false,
    isPackaged: true,
    mesuraChannel: MESURA_DESKTOP_CHANNEL_IDENTITY[channel],
    appImagePath: Option.some(`/Applications/Mesura-Code-${channel}.AppImage`),
    preloadPath: "/fixture/preload.cjs",
  } as DesktopEnvironment["Service"]);

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      executeHyprctl.mockClear();
      appEvents.clear();
      vi.stubEnv("HYPRLAND_INSTANCE_SIGNATURE", "fence_1792696316_1571868373");
      vi.useFakeTimers({ toFake: ["setImmediate", "Date"] });
      vi.setSystemTime(SESSION_START);
    }),
    () =>
      Effect.sync(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
      }),
  );

  yield* Effect.scoped(
    Effect.gen(function* () {
      yield* DesktopDictationWidget;
      yield* Effect.promise(async () => {
        const publish = handlers.get(PUBLISH_DICTATION_WIDGET_STATE_CHANNEL);
        expect(publish).toBeDefined();
        await publish!(
          { sender: { id: 1 } },
          {
            recording: true,
            transcribing: false,
            deliveredAt: null,
            live: true,
          },
        );
        appEvents.get("browser-window-blur")!();
        await vi.runAllTimersAsync();
      });
    }).pipe(
      Effect.provide(
        dictationWidgetLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(DesktopEnvironment, environment),
              Layer.succeed(DesktopIpc, ipc),
              ElectronApp.layer,
              ElectronWindow.layer.pipe(
                Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
              ),
              FileSystem.layerNoop({}),
              Path.layer,
            ),
          ),
        ),
      ),
    ),
  );

  return executeHyprctl.mock.calls.map(([, args]) => args).filter(([command]) => command !== "-j");
});

it.effect.each(["dev", "lab"] as const)(
  "desktop channels AC3: packaged %s leaves the running compositor's dictation binds and widget rules alone",
  (channel) =>
    Effect.gen(function* () {
      expect(yield* publishDictationSession(channel)).toHaveLength(0);
    }),
);

it.effect(
  "desktop channels guard: stable publishes dictation rules and owns its live Hyprland binds",
  () =>
    Effect.gen(function* () {
      const writes = yield* publishDictationSession("stable");
      const lua = writes.filter(([command]) => command === "eval").map(([, text]) => text);
      expect(lua).toEqual(
        expect.arrayContaining([
          expect.stringContaining('hl.bind("ALT + S", '),
          expect.stringContaining(
            'hl.window_rule({ match = { title = "^(mesura-dictation-overlay)$" }',
          ),
          expect.stringContaining("pcall(handle.remove, handle)"),
        ]),
      );
    }),
);
