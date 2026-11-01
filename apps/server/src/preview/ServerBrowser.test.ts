import * as NodeEvents from "node:events";
import * as NodeVM from "node:vm";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Playwright download mocks perform real file operations outside the Effect runtime.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { it } from "@effect/vitest";
import {
  type BrowserRecordingFrameRate,
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ServerSettingsError,
  ThreadId,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { constVoid } from "effect/Function";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { BrowserContext, Page } from "playwright-core";
import { beforeEach, expect, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";

vi.mock("./ServerBrowserContexts.ts", () => ({
  presentAsChrome: async () => {},
  ServerBrowserContexts: class {
    private readonly onClose: ((context: BrowserContext) => void) | undefined;
    constructor(options: { onContextClose?: (context: BrowserContext) => void }) {
      this.onClose = options.onContextClose;
    }
    async contextFor(profileId: string, isolationKey?: string) {
      contextRequests.push({ profileId, isolated: isolationKey !== undefined });
      if (contextFailure) throw contextFailure;
      await contextGate?.promise;
      const context = makeContext(this.onClose);
      contexts.push(context);
      return context as unknown as BrowserContext;
    }
    async scratchPage() {
      return makeEncoderPage() as unknown as Page;
    }
    async connectDesktopPage(endpoint: string) {
      const context = makeContext();
      desktopConnections.push({ endpoint, context });
      return { browser: { close: async () => {} }, page: context.page as unknown as Page };
    }
    async close() {
      for (const context of contexts) await context.close();
    }
  },
}));

function makeFrame() {
  const frame = {
    copy: "",
    detached: false,
    isDetached: () => frame.detached,
    recording: Promise.withResolvers<void>(),
  };
  return frame;
}

const PNG_HEADER = (() => {
  const header = Buffer.alloc(24);
  header.write("IHDR", 12);
  header.writeUInt32BE(1280, 16);
  header.writeUInt32BE(800, 20);
  return header.toString("base64");
})();

type FetchDecision = "Fetch.continueRequest" | "Fetch.failRequest";

const globMatches = (pattern: string, url: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`).test(url);

function makeSession(frame?: ReturnType<typeof makeFrame>) {
  const events = new NodeEvents.EventEmitter();
  const pausedRequests = new Map<
    string,
    { readonly url: string; readonly decision: PromiseWithResolvers<FetchDecision> }
  >();
  let pauseCount = 0;
  const session = {
    on: vi.fn((name: string, listener: Parameters<NodeEvents.EventEmitter["on"]>[1]) =>
      events.on(name, listener),
    ),
    emit: (name: string, ...args: unknown[]) => events.emit(name, ...args),
    detach: vi.fn(async () => {}),
    fetchPatterns: null as ReadonlyArray<Record<string, unknown>> | null,
    fetchDecisions: [] as Array<{ url: string; method: FetchDecision; errorReason?: unknown }>,
    // Stands in for Chrome pausing a main-frame document request at the request stage.
    pausesDocumentRequest: (url: string) =>
      (session.fetchPatterns ?? []).some(
        (pattern) =>
          (pattern.requestStage ?? "Request") === "Request" &&
          (pattern.resourceType ?? "Document") === "Document" &&
          globMatches(String(pattern.urlPattern ?? "*"), url),
      ),
    pauseDocument: (url: string, frameId = "main") => {
      const requestId = `request-${++pauseCount}`;
      const decision = Promise.withResolvers<FetchDecision>();
      pausedRequests.set(requestId, { url, decision });
      events.emit("Fetch.requestPaused", {
        requestId,
        request: { url, method: "GET", headers: {} },
        frameId,
        resourceType: "Document",
      });
      return decision.promise;
    },
    send: vi.fn(async (method: string, input?: unknown): Promise<Record<string, unknown>> => {
      if (method === "Fetch.enable") {
        session.fetchPatterns =
          (input as { patterns?: Array<Record<string, unknown>> }).patterns ?? [];
        fetchCommandListener?.(method, input);
        return {};
      }
      if (method === "Fetch.continueRequest" || method === "Fetch.failRequest") {
        const { requestId, errorReason } = input as { requestId: string; errorReason?: unknown };
        const paused = pausedRequests.get(requestId);
        // Chrome answers each paused request once and rejects a second answer.
        if (!paused) throw new Error("Invalid InterceptionId.");
        pausedRequests.delete(requestId);
        session.fetchDecisions.push({
          url: paused.url,
          method,
          ...(errorReason === undefined ? {} : { errorReason }),
        });
        paused.decision.resolve(method);
        fetchCommandListener?.(method, input);
        return {};
      }
      if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{}] };
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0 } };
      if (method === "Page.captureScreenshot") {
        // A snapshot sizes its screenshot from the PNG header; viewers get JPEG frames as-is.
        return { data: (input as { format: string }).format === "png" ? PNG_HEADER : "ZnJhbWU=" };
      }
      // Snapshots shrink their screenshot in the page; the header stands in for the result.
      if (method === "Runtime.callFunctionOn") return { result: { value: PNG_HEADER } };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") {
        return {
          executionContextId: (input as { worldName?: string }).worldName === "t3-preview" ? 1 : 7,
        };
      }
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 1) {
        return { result: { value: [] } };
      }
      if (method === "Page.addScriptToEvaluateOnNewDocument") frame?.recording.resolve();
      if (method === "Input.dispatchKeyEvent" && (input as { commands?: unknown }).commands) {
        if (focusedFrame) focusedFrame.copy = keyCopy || focusedFrame.copy;
        else pageCopy = keyCopy || pageCopy;
      }
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 7) {
        const value = frame ? frame.copy : pageCopy;
        if (frame) frame.copy = "";
        else pageCopy = "";
        return { result: { value } };
      }
      return { result: { value: "evaluated" } };
    }),
  };
  return session;
}

function makeContext(onClose?: (context: BrowserContext) => void) {
  const events = new NodeEvents.EventEmitter();
  const nativeFileChooser = vi.fn();
  const setChooserFiles = vi.fn(async (_files: unknown) => {});
  const sessions: Array<ReturnType<typeof makeSession> & { readonly target: unknown }> = [];
  let url = "about:blank";
  let viewport = { width: 1280, height: 800 };
  let closed = false;
  let contextClosed = false;
  const page = {
    on: (name: string, callback: (...args: unknown[]) => void) => events.on(name, callback),
    once: (name: string, callback: (...args: unknown[]) => void) => events.once(name, callback),
    off: (name: string, callback: (...args: unknown[]) => void) => events.off(name, callback),
    emit: (name: string, ...args: unknown[]) => events.emit(name, ...args),
    nativeFileChooser,
    setChooserFiles,
    openFileChooser: () => {
      if (
        !events.emit("filechooser", {
          isMultiple: () => false,
          element: () => ({ getAttribute: async () => ".csv" }),
          setFiles: setChooserFiles,
        })
      ) {
        nativeFileChooser();
      }
    },
    emitAsync: (name: string, ...args: unknown[]) =>
      Promise.all(events.listeners(name).map((listener) => listener(...args))),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    context: () => context,
    mainFrame: () => page,
    frames: () => [page],
    url: () => url,
    title: vi.fn(async () => "test page"),
    viewportSize: () => viewport,
    setViewportSize: vi.fn(async (size: typeof viewport) => {
      viewport = size;
    }),
    // Every session intercepting a document gets it in turn, as Chrome chains them.
    loadDocument: async (next: string, frameId = "main") => {
      for (const session of sessions) {
        if (session.target !== page || !session.pausesDocumentRequest(next)) continue;
        if ((await session.pauseDocument(next, frameId)) === "Fetch.failRequest") {
          throw new Error(`page.goto: net::ERR_BLOCKED_BY_CLIENT at ${next}`);
        }
      }
    },
    mouse: {
      click: vi.fn(async () => {
        await mouseClick?.();
      }),
    },
    goto: vi.fn(async (next: string) => {
      await page.loadDocument(next);
      url = next;
      events.emit("load");
      const pending = initialNavigation;
      initialNavigation = null;
      await pending?.();
    }),
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    emulateMedia: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    evaluate: vi.fn(async () => ({
      url,
      title: "test page",
      loading: false,
      visibleText: "delete",
      interactiveElements: [],
    })),
    ariaSnapshot: vi.fn(async () => '- button "delete" [ref=e1]'),
    locator: vi.fn(() => {
      throw new Error("Unexpected locator action");
    }),
    isClosed: () => closed,
    close: vi.fn(async () => {
      if (!closed) {
        closed = true;
        events.emit("close");
      }
    }),
  };
  const context = {
    page,
    sessions,
    newPage: async () => page as unknown as Page,
    grantPermissions: vi.fn(async () => {}),
    newCDPSession: async (target: unknown) => {
      const session = Object.assign(
        makeSession(target === page ? undefined : (target as ReturnType<typeof makeFrame>)),
        { target },
      );
      sessions.push(session);
      return session;
    },
    close: vi.fn(async () => {
      if (contextClosed) return;
      contextClosed = true;
      await page.close();
      onClose?.(context as unknown as BrowserContext);
    }),
  };
  return context;
}

// Runs the real encoder script against fake canvas and MediaRecorder globals.
function makeEncoderPage() {
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {}, fillRect() {} }),
    captureStream: (frameRate?: number) => ({ frameRate, getTracks: () => [] }),
  };
  class FakeMediaRecorder {
    static isTypeSupported = (type: string) => type === "video/webm";
    onstart: (() => void) | null = null;
    constructor(stream: { frameRate?: number }, options: { videoBitsPerSecond: number }) {
      encoderStreams.push({
        frameRate: stream.frameRate,
        bitsPerSecond: options.videoBitsPerSecond,
      });
    }
    start() {
      this.onstart?.();
    }
  }
  const sandbox: Record<string, unknown> = {
    document: { createElement: () => canvas },
    Path2D: function Path2D() {},
    MediaRecorder: FakeMediaRecorder,
    createImageBitmap: async () => ({ width: 1280, height: 800, close() {} }),
    atob,
    Blob,
    performance,
  };
  sandbox.window = sandbox;
  const context = NodeVM.createContext(sandbox);
  return {
    ...makeContext().page,
    evaluate: vi.fn(async (script: string | ((arg: unknown) => unknown), arg?: unknown) =>
      typeof script === "string"
        ? NodeVM.runInContext(script, context)
        : NodeVM.runInContext(`(${script.toString()})`, context)(arg),
    ),
  };
}

const contexts: ReturnType<typeof makeContext>[] = [];
const encoderStreams: Array<{ frameRate: number | undefined; bitsPerSecond: number }> = [];
const contextRequests: Array<{ profileId: string; isolated: boolean }> = [];
let contextGate: PromiseWithResolvers<void> | null = null;
let pageCopy = "";
let keyCopy = "";
let focusedFrame: ReturnType<typeof makeFrame> | null = null;
let contextFailure: Error | null = null;
let initialNavigation: (() => Promise<void>) | null = null;
let mouseClick: (() => Promise<void>) | null = null;
// Sees each Fetch command after the fake applied it, so tests await the guard without polling.
let fetchCommandListener: ((method: string, input: unknown) => void) | null = null;
let settingsReadFails = false;
let desktopRendersNext = false;
const desktopDetaches = new NodeEvents.EventEmitter();
const desktopTabs = new Set<string>();
const desktopRenders = (tabId: string) => {
  if (desktopRendersNext) {
    desktopRendersNext = false;
    desktopTabs.add(tabId);
  }
  return desktopTabs.has(tabId);
};
const releasedDesktopTabs: Array<string> = [];
const desktopTurns = new NodeEvents.EventEmitter();
const desktopConnections: Array<{ endpoint: string; context: ReturnType<typeof makeContext> }> = [];
const testThread = {
  threadId: ThreadId.make("browser-test-thread"),
  providerSessionId: "agent-a",
  providerInstanceId: ProviderInstanceId.make("codex"),
};
const scope = {
  environmentId: EnvironmentId.make("browser-test-environment"),
  thread: testThread,
  client: undefined,
  requestNamespace: "browser-test",
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const asSession = (providerSessionId: string) => ({
  ...scope,
  thread: { ...testThread, providerSessionId },
});
// Settings reads fail while `settingsReadFails` is set; writes keep working.
const failingSettingsLayer = Layer.effect(
  ServerSettings.ServerSettingsService,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    return ServerSettings.ServerSettingsService.of({
      ...settings,
      getSettings: Effect.suspend(() =>
        settingsReadFails
          ? Effect.fail(
              new ServerSettingsError({ settingsPath: "settings.json", operation: "read-secret" }),
            )
          : settings.getSettings,
      ),
    });
  }),
).pipe(Layer.provide(ServerSettings.ServerSettingsService.layerTest()));
const dependenciesAt = (baseDirOrPrefix: string | { readonly prefix: string }) =>
  Layer.mergeAll(
    Broker.layer,
    Manager.layer,
    Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(scope.environmentId),
      getDescriptor: Effect.die("unused descriptor"),
    }),
    Layer.succeed(PreviewBrowser.PreviewBrowser, {
      executable: Effect.die("mock Chromium does not need an executable"),
      installed: Effect.die("mock Chromium does not need an executable"),
    }),
    Layer.succeed(DesktopChannel.DesktopBrowserChannel, {
      available: true,
      awaitAttached: (key) => Effect.sync(() => desktopRenders(key.tabId)),
      detached: Stream.callback<{ threadId: string; tabId: string }>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const onDetach = (key: { threadId: string; tabId: string }) =>
              Queue.offerUnsafe(queue, key);
            desktopDetaches.on("detach", onDetach);
            return onDetach;
          }),
          (onDetach) => Effect.sync(() => desktopDetaches.off("detach", onDetach)),
        ),
      ),
      attached: Stream.callback<{ threadId: string; tabId: string }>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const onAttach = (key: { threadId: string; tabId: string }) =>
              Queue.offerUnsafe(queue, key);
            desktopDetaches.on("attach", onAttach);
            return onAttach;
          }),
          (onAttach) => Effect.sync(() => desktopDetaches.off("attach", onAttach)),
        ),
      ),
      isAttached: (key) => Effect.sync(() => desktopRenders(key.tabId)),
      endpoint: (key) =>
        Effect.acquireRelease(Effect.succeed(`ws://desktop/${key.tabId}`), () =>
          Effect.sync(() => releasedDesktopTabs.push(key.tabId)),
        ),
      pointer: () => Effect.void,
      turn: (threadId, active) => Effect.sync(() => desktopTurns.emit("turn", threadId, active)),
    }),
    PreviewAgentActivity.layer,
    failingSettingsLayer,
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDirOrPrefix)),
    Layer.provideMerge(NodeServices.layer),
  );
// A fixed base directory stands in for one server's state across restarts.
const layerAt = (baseDirOrPrefix: string | { readonly prefix: string }) =>
  ServerBrowser.layer.pipe(Layer.provideMerge(dependenciesAt(baseDirOrPrefix)));
const layer = layerAt({ prefix: "t3-server-browser-" });
const ready = Effect.gen(function* () {
  const browser = yield* ServerBrowser.ServerBrowser;
  const broker = yield* Broker.PreviewAutomationBroker;
  yield* Effect.yieldNow;
  const opened = yield* broker.invoke<PreviewAutomationStatus>({
    scope,
    operation: "open",
    input: { reuseExistingTab: false, show: false },
  });
  const tabId = PreviewTabId.make(opened.tabId!);
  return { browser, broker, tabId };
});
const viewerInput = (tabId: string, canOperate: boolean) => ({
  threadId: scope.thread.threadId,
  tabId,
  canOperate,
  maxWidth: 1280,
  maxHeight: 800,
  quality: 70,
});

beforeEach(() => {
  contexts.length = 0;
  encoderStreams.length = 0;
  contextRequests.length = 0;
  contextGate = null;
  contextFailure = null;
  initialNavigation = null;
  mouseClick = null;
  fetchCommandListener = null;
  settingsReadFails = false;
  pageCopy = "";
  keyCopy = "";
  focusedFrame = null;
  desktopTabs.clear();
  desktopRendersNext = false;
  releasedDesktopTabs.length = 0;
  desktopConnections.length = 0;
});

it.live("tells the desktop once per thread when its agent turns start and end", () =>
  Effect.gen(function* () {
    yield* ServerBrowser.ServerBrowser;
    const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
    const threadId = scope.thread.threadId;
    const turns = yield* Queue.unbounded<readonly [string, boolean]>();
    const record = (id: string, active: boolean) => Queue.offerUnsafe(turns, [id, active]);
    desktopTurns.on("turn", record);
    yield* Effect.addFinalizer(() => Effect.sync(() => desktopTurns.off("turn", record)));
    const endFirst = yield* activity.begin(threadId);
    // An overlapping turn on the same thread neither starts nor ends focus on its own.
    const endSecond = yield* activity.begin(threadId);
    expect(yield* Queue.take(turns)).toEqual([threadId, true]);
    yield* endFirst;
    yield* endFirst;
    expect(yield* activity.active(threadId)).toBe(true);
    yield* endSecond;
    expect(yield* Queue.take(turns)).toEqual([threadId, false]);
    expect(yield* Queue.size(turns)).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("preview_open reports its navigation timeout instead of the request budget", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker } = yield* ready;
      initialNavigation = async () => {
        throw Object.assign(new Error("page.goto: Timeout 15000ms exceeded."), {
          name: "TimeoutError",
        });
      };

      const error = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: {
            url: "http://localhost:1337/",
            reuseExistingTab: false,
            show: false,
          },
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "PreviewAutomationTimeoutError",
        timeoutMs: 15_000,
      });
      expect(error.message).toBe("Preview automation open timed out after 15000ms.");
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each(["desktop" as const, undefined])(
  "explicit desktop targets ($0 runtime) fail without creating a server tab",
  (runtime) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        const manager = yield* Manager.PreviewManager;
        const desktop = yield* manager.open({
          threadId: scope.thread.threadId,
          url: "https://example.com/original",
          ...(runtime === undefined ? {} : { runtime }),
        });
        const before = yield* manager.list({ threadId: scope.thread.threadId });
        const error = yield* broker
          .invoke<PreviewAutomationStatus>({
            scope,
            tabId: PreviewTabId.make(desktop.tabId),
            operation: "open",
            input: { url: "https://example.com/replacement", open: true },
          })
          .pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "PreviewAutomationExecutionError" });
        expect(error.message).toContain("desktop runtime");
        expect(error.message).toContain("cannot control");
        expect(yield* manager.list({ threadId: scope.thread.threadId })).toEqual(before);
        expect(contexts).toHaveLength(1);
        const reused = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { open: false },
        });
        expect(reused.tabId).toBe(tabId);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each([
  { method: "goto" as const, message: { type: "navigate", url: "http://10.255.255.1/" } },
  { method: "goBack" as const, message: { type: "history", delta: -1 } },
  { method: "goForward" as const, message: { type: "history", delta: 1 } },
  { method: "reload" as const, message: { type: "reload" } },
])("a pending viewer $method allows a corrected URL and text input", ({ method, message }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const started = Promise.withResolvers<void>();
      const committed = Promise.withResolvers<void>();
      const page = contexts[0]!.page;
      page[method].mockImplementationOnce(() => {
        started.resolve();
        return committed.promise;
      });
      const navigation = yield* viewer.input(message).pipe(Effect.forkScoped);
      yield* Effect.promise(() => started.promise);
      const cdp = contexts[0]!.sessions.at(-1)!;
      const send = cdp.send.getMockImplementation()!;
      const typed = Promise.withResolvers<void>();
      cdp.send.mockImplementation(async (operation, input) => {
        if (operation === "Input.insertText") typed.resolve();
        return send(operation, input);
      });
      const correction = yield* Effect.gen(function* () {
        yield* viewer.input({ type: "navigate", url: "http://localhost:5173/fixed" });
        yield* viewer.input({ type: "text", text: "hello" });
      }).pipe(Effect.forkScoped);
      yield* Effect.addFinalizer(() => Effect.sync(() => committed.resolve()));
      // The text reaches the page while the first navigation is still uncommitted.
      yield* Effect.promise(() => typed.promise);
      expect(page.goto).toHaveBeenLastCalledWith(
        "http://localhost:5173/fixed",
        expect.objectContaining({ waitUntil: "commit" }),
      );
      expect(contexts[0]!.sessions.at(-1)!.send).toHaveBeenCalledWith("Input.insertText", {
        text: "hello",
      });
      committed.resolve();
      yield* Fiber.join(navigation);
      yield* Fiber.join(correction);
    }),
  ).pipe(Effect.provide(layer)),
);

// The fake encoder decodes every frame at 1280x800, so 30 fps hits the bitrate floor.
it.live.each([
  { reports: [], frameRate: 30, bitsPerSecond: 2.5e6 },
  { reports: [30], frameRate: 30, bitsPerSecond: 2.5e6 },
  { reports: [60], frameRate: 60, bitsPerSecond: 1280 * 800 * 60 * 0.05 },
  { reports: [60, undefined], frameRate: 60, bitsPerSecond: 1280 * 800 * 60 * 0.05 },
  { reports: [60, 30], frameRate: 30, bitsPerSecond: 2.5e6 },
] satisfies ReadonlyArray<{
  reports: ReadonlyArray<BrowserRecordingFrameRate | undefined>;
  frameRate: number;
  bitsPerSecond: number;
}>)(
  "agent recordings encode at the last reported frame rate ($reports)",
  ({ reports, frameRate, bitsPerSecond }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker, tabId } = yield* ready;
        for (const recordingFrameRate of reports) {
          yield* browser.reportProfiles({
            profiles: [],
            defaultProfileId: "default",
            ...(recordingFrameRate === undefined ? {} : { recordingFrameRate }),
          });
        }
        yield* broker.invoke({ scope, tabId, operation: "recordingStart", input: {} });
        expect(encoderStreams).toEqual([{ frameRate, bitsPerSecond }]);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("enforces provider ownership and explicit targets when a session has multiple tabs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const foreign = yield* broker
        .invoke<void>({
          scope: asSession("agent-b"),
          tabId,
          operation: "navigate",
          input: { url: "http://localhost:5173/foreign" },
        })
        .pipe(Effect.flip);
      expect(foreign).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "agentMismatch",
      });
      expect(contexts[0]!.page.goto).not.toHaveBeenCalledWith(
        "http://localhost:5173/foreign",
        expect.anything(),
      );
      yield* broker.invoke<PreviewAutomationSnapshot>({
        scope: asSession("agent-b"),
        tabId,
        operation: "snapshot",
        input: {},
      });
      const foreignEvaluate = yield* broker
        .invoke<void>({
          scope: asSession("agent-b"),
          tabId,
          operation: "evaluate",
          input: { expression: "read()" },
        })
        .pipe(Effect.flip);
      expect(foreignEvaluate).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "agentMismatch",
      });
      yield* broker.invoke({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const ambiguous = yield* broker
        .invoke<void>({ scope, operation: "evaluate", input: { expression: "ambiguous()" } })
        .pipe(Effect.flip);
      expect(ambiguous).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "tabRequired",
      });
      const ambiguousStop = yield* broker
        .invoke<void>({ scope, operation: "recordingStop", input: {} })
        .pipe(Effect.flip);
      expect(ambiguousStop).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "tabRequired",
      });
      const explicitStop = yield* broker
        .invoke<void>({ scope, tabId, operation: "recordingStop", input: {} })
        .pipe(Effect.flip);
      expect(explicitStop).toMatchObject({
        _tag: "PreviewAutomationExecutionError",
        cause: { _tag: "PreviewAutomationRecordingNotActiveError" },
      });
      const result = yield* broker.invoke({
        scope,
        tabId,
        operation: "evaluate",
        input: { expression: "owned()" },
      });
      expect(result).toBe("evaluated");
      expect(contexts).toHaveLength(2);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("streams to a read-only viewer without allowing takeover, input, or viewport changes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, false));
      const page = contexts[0]!.page;
      page.setViewportSize.mockClear();
      const session = contexts[0]!.sessions.at(-1)!;
      session.send.mockClear();
      for (const message of [
        { type: "takeControl" },
        { type: "key", action: "down", key: "a", text: "a" },
        { type: "resize", width: 390, height: 844 },
        { type: "viewport", setting: { _tag: "freeform", width: 390, height: 844 } },
      ])
        yield* viewer.input(message);
      expect(page.setViewportSize).not.toHaveBeenCalled();
      expect(session.send.mock.calls.some(([method]) => method.startsWith("Input."))).toBe(false);
      const outputs = yield* Queue.takeAll(viewer.output);
      expect(outputs).toContainEqual(
        expect.objectContaining({ _tag: "frame", data: Buffer.from("frame") }),
      );
      expect(outputs).toContainEqual(expect.objectContaining({ _tag: "viewport" }));
      expect(outputs).toContainEqual(
        expect.objectContaining({ _tag: "control", canOperate: false, controller: "agent" }),
      );
      const operator = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* operator.input({ type: "takeControl" });
      yield* operator.input({ type: "text", text: "typed" });
      yield* operator.input({ type: "resize", width: 390, height: 844 });
      expect(contexts[0]!.sessions.at(-1)!.send).toHaveBeenCalledWith("Input.insertText", {
        text: "typed",
      });
      expect(page.setViewportSize).toHaveBeenCalledWith({ width: 390, height: 844 });
      yield* operator.input({ type: "releaseControl" });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "takeover waits for the running agent and revokes snapshot refs before returning control",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker, tabId } = yield* ready;
        const snapshot = yield* broker.invoke<PreviewAutomationSnapshot>({
          scope,
          tabId,
          operation: "snapshot",
          input: {},
        });
        const ref = /\[ref=([^\]]+)\]/.exec(String(snapshot.accessibilityTree))![1]!;
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        const started = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<Record<string, unknown>>();
        const session = contexts[0]!.sessions[0]!;
        session.send.mockImplementationOnce(async () => {
          started.resolve();
          return finish.promise;
        });
        const running = yield* broker
          .invoke({ scope, tabId, operation: "evaluate", input: { expression: "pending()" } })
          .pipe(Effect.forkScoped);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => finish.resolve({ result: { value: "finished" } })),
        );
        yield* Effect.promise(() => started.promise);
        const takeover = yield* viewer.input({ type: "takeControl" }).pipe(Effect.forkScoped);
        let control = yield* Queue.take(viewer.output);
        while (control._tag !== "control" || control.controller !== "you") {
          control = yield* Queue.take(viewer.output);
        }
        const rejected = yield* broker
          .invoke<void>({ scope, tabId, operation: "evaluate", input: { expression: "racing()" } })
          .pipe(Effect.flip);
        expect(rejected).toMatchObject({
          _tag: "PreviewAutomationControlInterruptedError",
          reason: "humanControl",
        });
        finish.resolve({ result: { value: "finished" } });
        expect(yield* Fiber.join(running)).toBe("finished");
        yield* Fiber.join(takeover);
        yield* viewer.input({ type: "releaseControl" });
        const stale = yield* broker
          .invoke<void>({ scope, tabId, operation: "click", input: { locator: `aria-ref=${ref}` } })
          .pipe(Effect.flip);
        expect(stale._tag).toBe("PreviewAutomationInvalidSelectorError");
        expect(contexts[0]!.page.locator).not.toHaveBeenCalled();
        expect(
          yield* broker.invoke({
            scope,
            tabId,
            operation: "evaluate",
            input: { expression: "resumed()" },
          }),
        ).toBe("evaluated");
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("reports a pending dialog without evaluating the page and resolves it explicitly", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      yield* broker.invoke({
        scope,
        tabId,
        operation: "navigate",
        input: { url: "http://localhost:5173" },
      });
      const started = Promise.withResolvers<void>();
      const resolvedEvaluation = Promise.withResolvers<Record<string, unknown>>();
      const session = contexts[0]!.sessions[0]!;
      const send = session.send.getMockImplementation()!;
      session.send.mockImplementation(async (method, input) => {
        if (method !== "Runtime.evaluate") return send(method, input);
        started.resolve();
        return resolvedEvaluation.promise;
      });
      const blockedAction = yield* broker
        .invoke({
          scope,
          tabId,
          operation: "evaluate",
          input: { expression: 'confirm("Delete row?")' },
        })
        .pipe(Effect.forkScoped);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => resolvedEvaluation.resolve({ result: { value: true } })),
      );
      yield* Effect.promise(() => started.promise);
      const dialog = {
        type: () => "confirm",
        message: () => "Delete row?",
        defaultValue: () => "",
        accept: vi.fn(async () => {
          resolvedEvaluation.resolve({ result: { value: true } });
        }),
        dismiss: vi.fn(async () => {}),
      };
      page.emit("dialog", dialog);
      page.title.mockClear();
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.dialog).toMatchObject({ type: "confirm", message: "Delete row?" });
      expect(page.title).not.toHaveBeenCalled();
      expect(dialog.dismiss).not.toHaveBeenCalled();
      const reuse = yield* broker
        .invoke<void>({
          scope,
          tabId,
          operation: "open",
          input: { url: "http://localhost:5173/other" },
        })
        .pipe(Effect.flip);
      expect(reuse).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "dialogPending",
      });
      expect(page.goto).toHaveBeenCalledTimes(1);
      yield* broker.invoke({ scope, tabId, operation: "dialog", input: { accept: true } });
      expect(yield* Fiber.join(blockedAction)).toBe(true);
      expect(dialog.accept).toHaveBeenCalledTimes(1);
      const resolved = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(resolved.dialog).toBeNull();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a tab opened to a file the browser cannot show reports the file to download", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      const events = yield* manager.subscribeEvents;
      yield* Effect.yieldNow;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      const viewer = yield* browser.attachViewer(viewerInput(opened.tabId, true));
      const page = contexts[0]!.page;
      const pdf = "https://example.com/paper.pdf";
      const request = { url: () => pdf, method: () => "GET", isNavigationRequest: () => true };
      page.emit("requestfailed", {
        ...request,
        frame: () => page,
        failure: () => ({ errorText: "net::ERR_ABORTED" }),
      });
      const saved = yield* Queue.unbounded<string>();
      const written = Promise.withResolvers<void>();
      page.emit("download", {
        failure: async () => null,
        delete: async () => {
          // A new navigation during cleanup must not erase the settled download status.
          page.emit("request", {
            url: () => "https://example.com/next",
            method: () => "GET",
            isNavigationRequest: () => true,
            frame: () => page,
          });
        },
        saveAs: (path: string) => {
          Queue.offerUnsafe(saved, path);
          return written.promise;
        },
        suggestedFilename: () => "paper.pdf",
        url: () => pdf,
      });
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(yield* Queue.take(saved), "%PDF");
      written.resolve();
      const received = [];
      let status;
      do {
        status = yield* PubSub.take(events);
        received.push(status);
      } while (
        status.type !== "navigated" ||
        status.snapshot.navStatus._tag !== "Loading" ||
        status.snapshot.navStatus.url !== "https://example.com/next"
      );
      expect(received).toContainEqual(
        expect.objectContaining({
          type: "failed",
          url: pdf,
          download: { id: expect.any(String), fileName: "paper.pdf" },
        }),
      );
      expect((yield* Queue.clear(viewer.output)).some((item) => item._tag === "download")).toBe(
        false,
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "a late failure from a request that predates tracking leaves a newer navigation loading",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        const page = contexts[0]!.page;
        const navigation = (url: string) => ({
          url: () => url,
          method: () => "GET",
          isNavigationRequest: () => true,
          frame: () => page,
          failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" }),
        });
        page.emit("request", navigation("https://example.com/next"));
        // A popup's first request can start before the tab listens for requests.
        page.emit("requestfailed", navigation("https://example.com/first"));
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(status.loading).toBe(true);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("only the controlling viewer's copy and cut keys reach its clipboard", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const watcher = yield* browser.attachViewer(viewerInput(tabId, false));
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const clipboard = (queue: typeof viewer.output) =>
        Queue.clear(queue).pipe(
          Effect.map((items) => items.filter((item) => item._tag === "clipboard")),
        );
      pageCopy = "unprompted";
      yield* viewer.input({ type: "mouse", action: "move", x: 10, y: 10 });
      yield* viewer.input({ type: "wheel", x: 10, y: 10, deltaY: 40 });
      yield* viewer.input({ type: "key", action: "down", key: "v", code: "KeyV", modifiers: 4 });
      yield* viewer.input({ type: "unknown" });
      expect(yield* clipboard(viewer.output)).toEqual([]);
      keyCopy = "copied";
      yield* viewer.input({ type: "key", action: "down", key: "c", code: "KeyC", modifiers: 4 });
      const cdp = contexts[0]!.sessions.at(-1)!;
      expect(cdp.send).toHaveBeenCalledWith(
        "Input.dispatchKeyEvent",
        expect.objectContaining({ key: "c", commands: ["copy"] }),
      );
      expect(yield* clipboard(viewer.output)).toEqual([{ _tag: "clipboard", text: "copied" }]);
      keyCopy = "cut";
      yield* viewer.input({ type: "key", action: "down", key: "x", code: "KeyX", modifiers: 2 });
      expect(yield* clipboard(viewer.output)).toEqual([{ _tag: "clipboard", text: "cut" }]);
      pageCopy = "left over";
      keyCopy = "";
      yield* viewer.input({ type: "key", action: "down", key: "c", code: "KeyC", modifiers: 4 });
      expect(yield* clipboard(viewer.output)).toEqual([]);
      expect(yield* clipboard(watcher.output)).toEqual([]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each([false, true])(
  "a page download is saved, offered to the controller, and listed for the agent (delete fails: %s)",
  (deleteFails) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker, tabId } = yield* ready;
        const page = contexts[0]!.page;
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        yield* viewer.input({ type: "takeControl" });
        yield* Queue.clear(viewer.output);
        const fs = yield* FileSystem.FileSystem;
        const original = `${yield* fs.makeTempDirectoryScoped()}/chromium-download`;
        yield* fs.writeFileString(original, "a,b");
        const released = Promise.withResolvers<void>();
        page.emit("download", {
          failure: async () => null,
          delete: async () => {
            try {
              if (deleteFails) throw new Error("context closed");
              await NodeFSP.rm(original);
            } finally {
              released.resolve();
            }
          },
          saveAs: (path: string) => NodeFSP.copyFile(original, path),
          suggestedFilename: () => "report.csv",
          url: () => 'data:text/csv;charset="a,b",a b\'c',
        });
        let offered = yield* Queue.take(viewer.output);
        while (offered._tag !== "download") offered = yield* Queue.take(viewer.output);
        expect(offered).toMatchObject({ _tag: "download", fileName: "report.csv", sizeBytes: 3 });
        yield* Effect.promise(() => released.promise);
        expect(yield* fs.exists(original)).toBe(deleteFails);
        const file = yield* browser.openDownload({
          threadId: scope.thread.threadId,
          tabId,
          downloadId: offered.id,
        });
        expect(Option.isSome(file) && file.value.fileName).toBe("report.csv");
        expect(yield* fs.readFileString(Option.getOrThrow(file).path)).toBe("a,b");
        if ((yield* HostProcess.Platform) !== "win32") {
          expect((yield* fs.stat(Option.getOrThrow(file).path)).mode & 0o777).toBe(0o600);
        }
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(status.downloads).toEqual([
          expect.objectContaining({
            fileName: "report.csv",
            sizeBytes: 3,
            url: "data:text/csv,…",
          }),
        ]);
        expect(
          Option.isNone(
            yield* browser.openDownload({
              threadId: scope.thread.threadId,
              tabId,
              downloadId: "guess",
            }),
          ),
        ).toBe(true);
        if ((yield* HostProcess.Platform) !== "win32") {
          const folder = (yield* Path.Path).dirname(Option.getOrThrow(file).path);
          yield* fs.chmod(folder, 0o755);
          page.emit("download", {
            failure: async () => null,
            delete: async () => {},
            saveAs: (path: string) => NodeFSP.writeFile(path, "c"),
            suggestedFilename: () => "again.csv",
            url: () => "https://example.test/again.csv",
          });
          let again = yield* Queue.take(viewer.output);
          while (again._tag !== "download") again = yield* Queue.take(viewer.output);
          expect((yield* fs.stat(folder)).mode & 0o777).toBe(0o700);
        }
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each(["save failed", "oversized"])(
  "a rejected download releases the original and keeps no saved copy (%s)",
  (outcome) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        const fs = yield* FileSystem.FileSystem;
        const original = `${yield* fs.makeTempDirectoryScoped()}/chromium-download`;
        yield* fs.writeFileString(original, "a,b");
        let savedPath: string | undefined;
        const released = Promise.withResolvers<void>();
        contexts[0]!.page.emit("download", {
          failure: async () => null,
          delete: async () => {
            await NodeFSP.rm(original);
            released.resolve();
          },
          saveAs: async (path: string) => {
            savedPath = path;
            await NodeFSP.copyFile(original, path);
            if (outcome === "save failed") throw new Error("save interrupted");
            // A sparse file exercises the size limit without writing a GiB of data.
            await NodeFSP.truncate(path, 1024 ** 3 + 1);
          },
          suggestedFilename: () => "report.csv",
          url: () => "blob:http://localhost:5173/1",
        });
        yield* Effect.promise(() => released.promise);
        expect(yield* fs.exists(original)).toBe(false);
        if (savedPath !== undefined) expect(yield* fs.exists(savedPath)).toBe(false);
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(status.downloads).toEqual([]);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("a page's file picker goes to the controller and takes its uploaded files", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const setFiles = vi.fn(async (_files: unknown) => {});
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({ getAttribute: async () => ".csv" }),
        setFiles,
      });
      let offered = yield* Queue.take(viewer.output);
      while (offered._tag !== "fileChooser") offered = yield* Queue.take(viewer.output);
      expect(offered).toMatchObject({ multiple: false, accept: ".csv" });
      const file = (name: string) => ({ name, mimeType: "text/csv", buffer: Buffer.from(name) });
      const answer = (chooserId: string) =>
        browser.answerFileChooser({
          threadId: scope.thread.threadId,
          tabId,
          chooserId,
          files: [file("a.csv"), file("b.csv")],
        });
      expect(yield* answer("other")).toBe(false);
      expect(yield* answer(offered.id)).toBe(true);
      expect(setFiles).toHaveBeenCalledExactlyOnceWith([file("a.csv")]);
      let closed = yield* Queue.take(viewer.output);
      while (closed._tag !== "fileChooserClosed") closed = yield* Queue.take(viewer.output);
      expect(closed.id).toBe(offered.id);
      expect(yield* answer(offered.id)).toBe(false);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("only the current controller can answer a file picker", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const first = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* first.input({ type: "takeControl" });
      const setFiles = vi.fn(async (_files: unknown) => {});
      contexts[0]!.page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({ getAttribute: async () => "" }),
        setFiles,
      });
      let offered = yield* Queue.take(first.output);
      while (offered._tag !== "fileChooser") offered = yield* Queue.take(first.output);
      const second = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* first.input({ type: "releaseControl" });
      yield* second.input({ type: "takeControl" });
      const answered = yield* browser.answerFileChooser({
        threadId: scope.thread.threadId,
        tabId,
        chooserId: offered.id,
        files: [{ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a") }],
      });
      expect(answered).toBe(false);
      expect(setFiles).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("agents read a human's tab with no arguments and act on it only while nobody drives", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const broker = yield* Broker.PreviewAutomationBroker;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      const opened = yield* manager.open({
        threadId: scope.thread.threadId,
        url: "http://localhost:5173/mine",
        runtime: "server",
      });
      const tabId = PreviewTabId.make(opened.tabId);
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "status",
        input: {},
      });
      expect(status).toMatchObject({
        tabId,
        control: { owner: "human", ownedByCaller: false },
      });
      expect(status.tabs).toEqual([
        expect.objectContaining({ tabId, owner: "human", ownedByCaller: false, visible: true }),
      ]);
      const evaluated = yield* broker
        .invoke<void>({ scope, operation: "evaluate", input: { expression: "read()" } })
        .pipe(Effect.flip);
      expect(evaluated).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "humanControl",
      });
      yield* broker.invoke<PreviewAutomationSnapshot>({
        scope,
        tabId,
        operation: "snapshot",
        input: {},
      });
      const refused = yield* broker
        .invoke<void>({
          scope,
          tabId,
          operation: "navigate",
          input: { url: "http://localhost:5173/agent" },
        })
        .pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "humanControl",
      });
      yield* viewer.input({ type: "releaseControl" });
      const released = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(released.control).toMatchObject({ owner: "unclaimed", ownedByCaller: false });
      yield* broker.invoke({
        scope,
        tabId,
        operation: "navigate",
        input: { url: "http://localhost:5173/agent" },
      });
      expect(contexts[0]!.page.goto).toHaveBeenCalledWith(
        "http://localhost:5173/agent",
        expect.anything(),
      );
      yield* viewer.input({ type: "takeControl" });
      const retaken = yield* broker
        .invoke<void>({ scope, tabId, operation: "press", input: { key: "Enter" } })
        .pipe(Effect.flip);
      expect(retaken).toMatchObject({ reason: "humanControl" });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a session's own tab stays its default while other sessions' tabs are listed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const other = yield* broker.invoke<PreviewAutomationStatus>({
        scope: asSession("agent-b"),
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "status",
        input: {},
      });
      expect(status.tabId).toBe(tabId);
      expect(status.tabs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ tabId, owner: "agent", ownedByCaller: true }),
          expect.objectContaining({ tabId: other.tabId, owner: "agent", ownedByCaller: false }),
        ]),
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "preview_open picks a reported profile by id or name and defaults to the reported one",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* ServerBrowser.ServerBrowser;
        const broker = yield* Broker.PreviewAutomationBroker;
        const manager = yield* Manager.PreviewManager;
        yield* Effect.yieldNow;
        yield* browser.reportProfiles({
          profiles: [{ id: "profile-work", name: "Work", kind: "persistent" }],
          defaultProfileId: "profile-work",
        });
        const openWith = (profileId?: string) =>
          broker.invoke<PreviewAutomationStatus>({
            scope,
            operation: "open",
            input: {
              reuseExistingTab: false,
              show: false,
              ...(profileId === undefined ? {} : { profileId }),
            },
          });
        const byDefault = yield* openWith();
        const byName = yield* openWith("WORK");
        const byId = yield* openWith("incognito");
        const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
        const profileOf = (tabId: string | null) =>
          sessions.find((session) => session.tabId === tabId)?.profileId;
        expect(profileOf(byDefault.tabId)).toBe("profile-work");
        expect(profileOf(byName.tabId)).toBe("profile-work");
        expect(profileOf(byId.tabId)).toBe("incognito");
        expect(contextRequests).toEqual([
          { profileId: "profile-work", isolated: false },
          { profileId: "profile-work", isolated: false },
          { profileId: "incognito", isolated: true },
        ]);
        expect(byDefault).toMatchObject({
          defaultProfileId: "profile-work",
          profiles: [
            { id: "default", name: "Default" },
            { id: "incognito", name: "Incognito", incognito: true },
            { id: "profile-work", name: "Work" },
          ],
        });
        const unknown = yield* openWith("Personal").pipe(Effect.flip);
        expect(unknown).toMatchObject({
          _tag: "PreviewAutomationExecutionError",
          reason:
            'No browser profile is named "Personal". Use one of: Default (id default), Incognito (id incognito), Work (id profile-work).',
        });
      }),
    ).pipe(Effect.provide(layer)),
);

// Phase "remember profiles, block agent payments": every spec below drives the
// PreviewAutomationBroker, the entry point the preview MCP tools call, or a
// viewer's input, the entry point a human's browser pane uses.
const openAgentTab = (input: { readonly profileId?: string } = {}) =>
  Effect.gen(function* () {
    const broker = yield* Broker.PreviewAutomationBroker;
    yield* ServerBrowser.ServerBrowser;
    yield* Effect.yieldNow;
    return yield* broker.invoke<PreviewAutomationStatus>({
      scope,
      operation: "open",
      input: { reuseExistingTab: false, show: false, ...input },
    });
  });
const reportWorkProfile = Effect.gen(function* () {
  const browser = yield* ServerBrowser.ServerBrowser;
  yield* Effect.yieldNow;
  yield* browser.reportProfiles({
    profiles: [{ id: "profile-work", name: "Work", kind: "persistent" }],
    defaultProfileId: "profile-work",
  });
});
const withRestartableState = <A, E, R>(use: (baseDir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3-server-browser-restart-" }),
    );
    return yield* use(baseDir);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
const fetchPatterns = () => contexts[0]!.sessions.flatMap((session) => session.fetchPatterns ?? []);
const fetchDecisions = () => contexts[0]!.sessions.flatMap((session) => session.fetchDecisions);
const navigateAgent = (tabId: PreviewTabId, url: string) =>
  Effect.gen(function* () {
    const broker = yield* Broker.PreviewAutomationBroker;
    return yield* broker.invoke<PreviewAutomationStatus>({
      scope,
      tabId,
      operation: "navigate",
      input: { url },
    });
  });

it.live(
  "after a restart with no client report, preview_open uses the last reported default profile",
  () =>
    withRestartableState((baseDir) =>
      Effect.gen(function* () {
        yield* reportWorkProfile.pipe(Effect.scoped, Effect.provide(layerAt(baseDir)));
        contextRequests.length = 0;
        yield* openAgentTab().pipe(Effect.scoped, Effect.provide(layerAt(baseDir)));
        expect(contextRequests).toEqual([{ profileId: "profile-work", isolated: false }]);
      }),
    ),
);

it.live(
  "a later client report replaces the saved profile list, and the replacement survives a restart",
  () =>
    withRestartableState((baseDir) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          yield* reportWorkProfile;
          const browser = yield* ServerBrowser.ServerBrowser;
          yield* browser.reportProfiles({
            profiles: [{ id: "profile-personal", name: "Personal", kind: "persistent" }],
            defaultProfileId: "profile-personal",
          });
        }).pipe(Effect.scoped, Effect.provide(layerAt(baseDir)));
        contextRequests.length = 0;
        const opened = yield* openAgentTab().pipe(Effect.scoped, Effect.provide(layerAt(baseDir)));
        expect(opened.defaultProfileId).toBe("profile-personal");
        expect(opened.profiles?.map((profile) => profile.id)).toEqual([
          "default",
          "incognito",
          "profile-personal",
        ]);
        expect(contextRequests).toEqual([{ profileId: "profile-personal", isolated: false }]);
      }),
    ),
);

it.live(
  "with no saved profile list and no report, agent tabs open the persistent default profile",
  () =>
    Effect.gen(function* () {
      yield* openAgentTab();
      expect(contextRequests).toEqual([{ profileId: "default", isolated: false }]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live.each([
  { url: "https://paypal.com/checkoutnow", domain: "paypal.com" },
  { url: "https://www.PayPal.com/signin", domain: "paypal.com" },
  { url: "https://checkout.stripe.com/c/pay/cs_test_1", domain: "checkout.stripe.com" },
  { url: "https://www.mercadopago.com.ar/checkout", domain: "mercadopago.com.ar" },
])(
  "an agent document navigation to the payment page $url fails and names $domain",
  ({ url, domain }) =>
    Effect.gen(function* () {
      const { tabId } = yield* ready;
      const error = yield* navigateAgent(tabId, url).pipe(Effect.flip);
      expect(error.message.toLowerCase()).toContain(domain);
      expect(contexts[0]!.page.url()).not.toBe(url);
      expect(contexts[0]!.page.goto).not.toHaveBeenCalledWith(url, expect.anything());
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("a human holding control reaches a payment page the guard would refuse an agent", () =>
  Effect.gen(function* () {
    const { browser, tabId } = yield* ready;
    const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
    yield* viewer.input({ type: "takeControl" });
    const url = "https://www.paypal.com/checkoutnow";
    yield* viewer.input({ type: "navigate", url });
    expect(contexts[0]!.page.url()).toBe(url);
    expect(fetchDecisions()).toEqual([{ url, method: "Fetch.continueRequest" }]);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("the payment guard pauses only document requests and lets other sites through", () =>
  Effect.gen(function* () {
    const { tabId } = yield* ready;
    const requestStage = fetchPatterns().filter(
      (pattern) => (pattern.requestStage ?? "Request") === "Request",
    );
    expect(requestStage).toEqual([{ resourceType: "Document", requestStage: "Request" }]);
    const urls = [
      "https://notpaypal.com/",
      "https://paypal.com.example.test/",
      "http://localhost:5173/app",
    ];
    for (const url of urls) yield* navigateAgent(tabId, url);
    expect(contexts[0]!.page.url()).toBe(urls.at(-1));
    expect(fetchDecisions()).toEqual(urls.map((url) => ({ url, method: "Fetch.continueRequest" })));
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("a patched browserPaymentDomains list applies to the next agent navigation", () =>
  Effect.gen(function* () {
    const { tabId } = yield* ready;
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({ browserPaymentDomains: ["shop.example.test"] });
    const error = yield* navigateAgent(tabId, "https://cart.shop.example.test/pay").pipe(
      Effect.flip,
    );
    expect(error.message).toContain("shop.example.test");
    yield* navigateAgent(tabId, "https://paypal.com/");
    expect(contexts[0]!.page.url()).toBe("https://paypal.com/");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

// Guards: behaviour this phase must keep.
it.live("with nothing reported, an explicit profile still resolves by id or by name", () =>
  Effect.gen(function* () {
    yield* openAgentTab({ profileId: "default" });
    yield* openAgentTab({ profileId: "DEFAULT" });
    expect(contextRequests).toEqual([
      { profileId: "default", isolated: false },
      { profileId: "default", isolated: false },
    ]);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("with nothing reported, the incognito profile still opens an isolated context", () =>
  Effect.gen(function* () {
    yield* openAgentTab({ profileId: "incognito" });
    yield* openAgentTab({ profileId: "Incognito" });
    expect(contextRequests).toEqual([
      { profileId: "incognito", isolated: true },
      { profileId: "incognito", isolated: true },
    ]);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live(
  "with nothing reported, an unknown profile is still refused with the built-in choices",
  () =>
    Effect.gen(function* () {
      const refused = yield* openAgentTab({ profileId: "Personal" }).pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "PreviewAutomationExecutionError",
        reason:
          'No browser profile is named "Personal". Use one of: Default (id default), Incognito (id incognito).',
      });
      expect(contextRequests).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("a human holding control still navigates an ordinary site without an error", () =>
  Effect.gen(function* () {
    const { browser, tabId } = yield* ready;
    const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
    yield* viewer.input({ type: "takeControl" });
    yield* viewer.input({ type: "navigate", url: "http://localhost:5173/mine" });
    expect(contexts[0]!.page.goto).toHaveBeenLastCalledWith(
      "http://localhost:5173/mine",
      expect.anything(),
    );
    expect(contexts[0]!.page.url()).toBe("http://localhost:5173/mine");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("agent tabs keep the PDF asset interception at the response stage", () =>
  Effect.gen(function* () {
    yield* ready;
    expect(fetchPatterns()).toContainEqual({
      urlPattern: "*/api/assets/*",
      resourceType: "Document",
      requestStage: "Response",
    });
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

// Review rework: the guard and the pre-check hold for every agent path.
const TAKEOVER_TOOL = "preview_request_takeover";

it.live(
  "an agent reusing a released operator tab through preview_open cannot open a payment page",
  () =>
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const broker = yield* Broker.PreviewAutomationBroker;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      const opened = yield* manager.open({
        threadId: scope.thread.threadId,
        url: "http://localhost:5173/mine",
        runtime: "server",
      });
      const tabId = PreviewTabId.make(opened.tabId);
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      yield* viewer.input({ type: "releaseControl" });
      const url = "https://www.paypal.com/checkoutnow";
      const error = yield* broker
        .invoke<PreviewAutomationStatus>({ scope, tabId, operation: "open", input: { url } })
        .pipe(Effect.flip);
      expect(error.message).toContain("paypal.com");
      expect(error.message).toContain(TAKEOVER_TOOL);
      expect(contexts[0]!.page.goto).not.toHaveBeenCalledWith(url, expect.anything());
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("a page navigation in an operator tab nobody controls is refused at a payment site", () =>
  Effect.gen(function* () {
    const browser = yield* ServerBrowser.ServerBrowser;
    const manager = yield* Manager.PreviewManager;
    yield* Effect.yieldNow;
    const opened = yield* manager.open({
      threadId: scope.thread.threadId,
      url: "http://localhost:5173/mine",
      runtime: "server",
    });
    // A read-only viewer: an operating one takes control of an operator tab on attach.
    yield* browser.attachViewer(viewerInput(PreviewTabId.make(opened.tabId), false));
    // Stands in for the page's own script redirecting while no human holds the tab.
    const url = "https://checkout.stripe.com/c/pay/cs_test_2";
    const failure = yield* Effect.promise(() =>
      contexts[0]!.page.goto(url).then(
        () => null,
        (cause: Error) => cause.message,
      ),
    );
    expect(failure).toContain("ERR_BLOCKED_BY_CLIENT");
    expect(fetchDecisions().at(-1)).toEqual({
      url,
      method: "Fetch.failRequest",
      errorReason: "BlockedByClient",
    });
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("a settings read failure keeps the last payment list the guard read", () =>
  Effect.gen(function* () {
    const { tabId } = yield* ready;
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({ browserPaymentDomains: ["shop.example.test"] });
    yield* navigateAgent(tabId, "https://example.test/");
    settingsReadFails = true;
    const error = yield* navigateAgent(tabId, "https://cart.shop.example.test/pay").pipe(
      Effect.flip,
    );
    expect(error.message).toContain("shop.example.test");
    expect(contexts[0]!.page.url()).toBe("https://example.test/");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("with no payment list read yet, a settings read failure refuses agent navigation", () =>
  Effect.gen(function* () {
    const { tabId } = yield* ready;
    settingsReadFails = true;
    const error = yield* navigateAgent(tabId, "https://example.test/").pipe(Effect.flip);
    expect(error.message).toContain("settings could not be read");
    expect(contexts[0]!.page.goto).not.toHaveBeenCalledWith(
      "https://example.test/",
      expect.anything(),
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("preview_navigate without a readiness wait refuses a payment page before navigating", () =>
  Effect.gen(function* () {
    const { broker, tabId } = yield* ready;
    const url = "https://www.paypal.com/checkoutnow";
    const error = yield* broker
      .invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "navigate",
        input: { url, readiness: "none" },
      })
      .pipe(Effect.flip);
    expect(error.message).toContain("paypal.com");
    expect(error.message).toContain(TAKEOVER_TOOL);
    expect(contexts[0]!.page.goto).not.toHaveBeenCalledWith(url, expect.anything());
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("a preview_click that loads a payment iframe fails and names the payment domain", () =>
  Effect.gen(function* () {
    const { broker, tabId } = yield* ready;
    const frameUrl = "https://pay.google.com/gp/p/ui/pay";
    mouseClick = () => contexts[0]!.page.loadDocument(frameUrl, "checkout-frame").catch(constVoid);
    const error = yield* broker
      .invoke<void>({ scope, tabId, operation: "click", input: { x: 20, y: 20 } })
      .pipe(Effect.flip);
    expect(error.message).toContain("pay.google.com");
    expect(error.message).toContain(TAKEOVER_TOOL);
    expect(fetchDecisions().at(-1)).toMatchObject({ url: frameUrl, method: "Fetch.failRequest" });
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

// Regression: what phase 1 learned beyond its acceptance specs.
const fetchCommands = Effect.gen(function* () {
  const commands = yield* Queue.unbounded<{ readonly method: string; readonly input: unknown }>();
  fetchCommandListener = (method, input) => Queue.offerUnsafe(commands, { method, input });
  return commands;
});
const takeFetchCommand = (
  commands: Queue.Queue<{ readonly method: string; readonly input: unknown }>,
  matches: (command: { readonly method: string; readonly input: unknown }) => boolean,
) =>
  Effect.gen(function* () {
    while (true) {
      const command = yield* Queue.take(commands);
      if (matches(command)) return command;
    }
  });
const pausesDocumentsAtRequest = (input: unknown) =>
  ((input as { patterns?: ReadonlyArray<Record<string, unknown>> }).patterns ?? []).some(
    (pattern) => (pattern.requestStage ?? "Request") === "Request",
  );

it.live("a corrupt saved profile file is ignored and agent tabs open the default profile", () =>
  withRestartableState((baseDir) =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(config.stateDir, "server-browser", "reported-profiles.json");
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, '{"profiles": [');
      }).pipe(Effect.scoped, Effect.provide(layerAt(baseDir)));
      contextRequests.length = 0;
      const opened = yield* openAgentTab().pipe(Effect.scoped, Effect.provide(layerAt(baseDir)));
      expect(contextRequests).toEqual([{ profileId: "default", isolated: false }]);
      expect(opened.defaultProfileId).toBeUndefined();
    }),
  ),
);

it.live("a payment document the guard refuses is recorded in the action timeline by domain", () =>
  Effect.gen(function* () {
    const { broker, tabId } = yield* ready;
    mouseClick = () =>
      contexts[0]!.page.loadDocument("https://www.paypal.com/checkoutnow").catch(constVoid);
    yield* broker
      .invoke<void>({ scope, tabId, operation: "click", input: { x: 5, y: 5 } })
      .pipe(Effect.flip);
    const snapshot = yield* broker.invoke<PreviewAutomationSnapshot>({
      scope,
      tabId,
      operation: "snapshot",
      input: {},
    });
    expect(snapshot.actionTimeline).toContainEqual(
      expect.objectContaining({
        action: "blockPaymentNavigation",
        status: "failed",
        error: "Blocked paypal.com, a payment site.",
      }),
    );
    expect(snapshot.actionTimeline.find((event) => event.action === "click")).toMatchObject({
      action: "click",
      status: "failed",
      error: expect.stringContaining("preview_request_takeover"),
    });
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("a desktop-rendered tab gets no payment guard on the desktop's page", () =>
  Effect.gen(function* () {
    desktopRendersNext = true;
    yield* openAgentTab();
    expect(desktopConnections).toHaveLength(1);
    const patterns = desktopConnections[0]!.context.sessions.flatMap(
      (session) => session.fetchPatterns ?? [],
    );
    expect(patterns.filter((pattern) => (pattern.requestStage ?? "Request") === "Request")).toEqual(
      [],
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("a popup an agent's page opens becomes a tab with its own payment guard", () =>
  Effect.gen(function* () {
    yield* ready;
    const commands = yield* fetchCommands;
    const popup = makeContext();
    contexts[0]!.page.emit("popup", popup.page);
    yield* takeFetchCommand(
      commands,
      ({ method, input }) => method === "Fetch.enable" && pausesDocumentsAtRequest(input),
    );
    const guard = popup.sessions.find((session) =>
      pausesDocumentsAtRequest({ patterns: session.fetchPatterns ?? [] }),
    );
    expect(guard?.fetchPatterns).toEqual([{ resourceType: "Document", requestStage: "Request" }]);
    const url = "https://pay.google.com/gp/p/ui/pay";
    const failure = yield* Effect.promise(() =>
      popup.page.goto(url).then(
        () => null,
        (cause: Error) => cause.message,
      ),
    );
    expect(failure).toContain("ERR_BLOCKED_BY_CLIENT");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("an operator tab's first payment load is refused until a human takes control", () =>
  Effect.gen(function* () {
    const browser = yield* ServerBrowser.ServerBrowser;
    const manager = yield* Manager.PreviewManager;
    yield* Effect.yieldNow;
    const commands = yield* fetchCommands;
    const url = "https://www.paypal.com/checkoutnow";
    const opened = yield* manager.open({ threadId: scope.thread.threadId, url, runtime: "server" });
    const tabId = PreviewTabId.make(opened.tabId);
    yield* browser.attachViewer(viewerInput(tabId, false));
    yield* takeFetchCommand(commands, ({ method }) => method === "Fetch.failRequest");
    expect(contexts[0]!.page.url()).not.toBe(url);
    // An operating viewer on an operator tab takes control as it attaches.
    const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
    yield* viewer.input({ type: "navigate", url });
    expect(contexts[0]!.page.url()).toBe(url);
    expect(fetchDecisions().map((decision) => decision.method)).toEqual([
      "Fetch.failRequest",
      "Fetch.continueRequest",
    ]);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
