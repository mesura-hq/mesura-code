import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

const { createClerkBridgeMock, storageAdapter, storageMock } = vi.hoisted(() => ({
  createClerkBridgeMock: vi.fn(),
  storageAdapter: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
  storageMock: vi.fn(),
}));

vi.mock("@clerk/electron", () => ({
  createClerkBridge: createClerkBridgeMock,
}));

vi.mock("@clerk/electron/storage", () => ({
  storage: storageMock,
}));

import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { DICTATION_COMMAND_LINE_CHANNEL } from "../ipc/channels.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { resolveDesktopUserDataIdentity } from "../../../../scripts/lib/brand-assets.ts";

const makeDesktopClerkLayer = (isDevelopment = true, events: string[] = []) => {
  const environment = DesktopEnvironment.DesktopEnvironment.of({
    stateDir: "/tmp/t3-state",
    isDevelopment,
    appDataDirectory: "/tmp/app-data",
    ...resolveDesktopUserDataIdentity(isDevelopment),
    path: { join: (...parts: ReadonlyArray<string>) => parts.join("/") },
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

  const electronApp = {
    setPath: (name: string, value: string) =>
      Effect.sync(() => {
        events.push(`setPath:${name}:${value}`);
      }),
  } as unknown as ElectronApp.ElectronApp["Service"];

  return DesktopClerk.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
        Layer.succeed(ElectronApp.ElectronApp, electronApp),
        FileSystem.layerNoop({ exists: () => Effect.succeed(false) }),
      ),
    ),
  );
};

describe("DesktopClerk", () => {
  beforeEach(() => {
    createClerkBridgeMock.mockReset();
    storageMock.mockReset();
  });

  it.effect("acquires and releases the SDK bridge with the layer", () => {
    const cleanup = vi.fn();
    const events: string[] = [];
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockImplementation(() => {
      events.push("createClerkBridge");
      return { cleanup, isPrimaryInstance: true };
    });

    return Effect.gen(function* () {
      yield* Effect.scoped(Layer.build(makeDesktopClerkLayer(true, events)));

      assert.deepEqual(createClerkBridgeMock.mock.calls, [
        [
          {
            storage: storageAdapter,
            passkeys: true,
            renderer: { scheme: "t3code-dev", host: "app" },
          },
        ],
      ]);
      assert.equal(cleanup.mock.calls.length, 1);
      // The bridge acquires Electron's single-instance lock at creation, and
      // the lock both lives in and creates the userData directory — so the
      // real path must be set before the bridge exists.
      // Literal on purpose. The fixture above is built from the resolver, so
      // deriving this expectation from the same call would assert nothing.
      assert.deepEqual(events, [
        "setPath:userData:/tmp/app-data/mesura-code-dev",
        "createClerkBridge",
      ]);
      storageMock.mockClear();
      createClerkBridgeMock.mockClear();
    });
  });

  it.effect("preserves bridge initialization failures", () => {
    const cause = new Error("bridge initialization failed");
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockImplementationOnce(() => {
      throw cause;
    });

    return Effect.gen(function* () {
      const error = yield* Effect.scoped(Layer.build(makeDesktopClerkLayer())).pipe(Effect.flip);

      assert.instanceOf(error, DesktopClerk.DesktopClerkBridgeInitializationError);
      assert.equal(error.stateDir, "/tmp/t3-state");
      assert.equal(error.isDevelopment, true);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        'Failed to initialize the desktop Clerk bridge for state directory "/tmp/t3-state" (development: true).',
      );
    });
  });

  it.effect("preserves bridge cleanup failures", () => {
    const cause = new Error("bridge cleanup failed");
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({
      cleanup: () => {
        throw cause;
      },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(Effect.scoped(Layer.build(makeDesktopClerkLayer(false))));

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, DesktopClerk.DesktopClerkBridgeCleanupError);
        assert.equal(error.stateDir, "/tmp/t3-state");
        assert.equal(error.isDevelopment, false);
        assert.strictEqual(error.cause, cause);
        assert.equal(
          error.message,
          'Failed to clean up the desktop Clerk bridge for state directory "/tmp/t3-state" (development: false).',
        );
      }
    });
  });

  it.effect("registers the second-instance handler in the primary instance", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const quit = vi.fn();
    const registeredEvents: string[] = [];
    const electronApp = {
      quit: Effect.sync(quit),
      on: (eventName: string) =>
        Effect.sync(() => {
          registeredEvents.push(eventName);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {} as ElectronWindow.ElectronWindow["Service"];

    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      const exit = yield* Effect.exit(Effect.scoped(clerk.configure));

      assert.isTrue(Exit.isSuccess(exit));
      assert.equal(quit.mock.calls.length, 0);
      assert.deepEqual(registeredEvents, ["second-instance"]);
    }).pipe(
      Effect.provide(makeDesktopClerkLayer()),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
    );
  });

  it.effect("quits and interrupts startup in a secondary instance", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: false });
    const quit = vi.fn();
    const registeredEvents: string[] = [];
    const electronApp = {
      quit: Effect.sync(quit),
      on: (eventName: string) =>
        Effect.sync(() => {
          registeredEvents.push(eventName);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {} as ElectronWindow.ElectronWindow["Service"];

    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      const exit = yield* Effect.exit(Effect.scoped(clerk.configure));

      assert.isTrue(Exit.hasInterrupts(exit));
      assert.equal(quit.mock.calls.length, 1);
      assert.deepEqual(registeredEvents, []);
    }).pipe(
      Effect.provide(makeDesktopClerkLayer()),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
    );
  });
});

/**
 * Entry point: the `second-instance` listener `DesktopClerk.configure` registers,
 * called with the argv Electron forwards from a second launch of the binary.
 *
 * STT redesign, phase 6, criteria 1 and 2.
 */
describe("dictation phase 6 fence: second instance", () => {
  const runSecondInstance = (argv: ReadonlyArray<string>) => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const listeners = new Map<string, (...args: ReadonlyArray<unknown>) => void>();
    const electronApp = {
      quit: Effect.void,
      on: (eventName: string, listener: (...args: ReadonlyArray<unknown>) => void) =>
        Effect.sync(() => {
          listeners.set(eventName, listener);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    // The listener runs its effect as a detached promise; it settles on a send or a reveal.
    let handled: () => void = () => undefined;
    const handledOnce = new Promise<void>((resolve) => {
      handled = resolve;
    });
    const sent: Array<ReadonlyArray<unknown>> = [];
    const send = (...args: ReadonlyArray<unknown>) => {
      sent.push(args);
      handled();
    };
    const mainWindow = { isDestroyed: () => false, webContents: { send } };
    const reveal = vi.fn((_window: unknown) => handled());
    const electronWindow = {
      main: Effect.succeed(Option.some(mainWindow)),
      currentMainOrFirst: Effect.succeed(Option.some(mainWindow)),
      focusedMainOrFirst: Effect.succeed(Option.some(mainWindow)),
      reveal: (window: unknown) => Effect.sync(() => reveal(window)),
      sendAll: (...args: ReadonlyArray<unknown>) => Effect.sync(() => send(...args)),
    } as unknown as ElectronWindow.ElectronWindow["Service"];

    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      yield* Effect.scoped(clerk.configure);
      const listener = listeners.get("second-instance");
      assert.isDefined(listener);
      listener!({}, argv, "/home/dev");
      yield* Effect.promise(() => handledOnce);
      return { sent, reveal, mainWindow };
    }).pipe(
      Effect.provide(makeDesktopClerkLayer()),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
    );
  };

  it.effect(
    "dictation phase 6 AC1: --dictation toggle in a second instance reaches the renderer and opens no window",
    () =>
      Effect.gen(function* () {
        const { sent, reveal } = yield* runSecondInstance([
          "/opt/mesura-code/mesura-code",
          "--dictation",
          "toggle",
        ]);
        assert.deepEqual(sent, [[DICTATION_COMMAND_LINE_CHANNEL, "dictation.toggle"]]);
        assert.equal(reveal.mock.calls.length, 0);
      }),
  );

  it.effect(
    "dictation phase 6 AC2: --dictation mode inject in a second instance reaches the renderer the same way",
    () =>
      Effect.gen(function* () {
        const { sent, reveal } = yield* runSecondInstance([
          "/opt/mesura-code/mesura-code",
          "--dictation",
          "mode",
          "inject",
        ]);
        assert.deepEqual(sent, [[DICTATION_COMMAND_LINE_CHANNEL, "dictation.mode.inject"]]);
        assert.equal(reveal.mock.calls.length, 0);
      }),
  );

  it.effect(
    "dictation phase 6 guard: a second instance without a dictation command still reveals the window",
    () =>
      Effect.gen(function* () {
        const { sent, reveal, mainWindow } = yield* runSecondInstance([
          "/opt/mesura-code/mesura-code",
        ]);
        assert.deepEqual(sent, []);
        assert.deepEqual(reveal.mock.calls, [[mainWindow]]);
      }),
  );

  it.effect(
    "dictation phase 6 guard: a malformed dictation command reveals the window and sends nothing",
    () =>
      Effect.gen(function* () {
        const { sent, reveal } = yield* runSecondInstance([
          "/opt/mesura-code/mesura-code",
          "--dictation",
          "mode",
          "shout",
        ]);
        assert.deepEqual(sent, []);
        assert.equal(reveal.mock.calls.length, 1);
      }),
  );
});
