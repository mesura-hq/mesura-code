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
  MessageId,
  NodeId,
  OrchestrationV2TurnItem,
  PreviewTabId,
  ProviderInstanceId,
  ServerSettingsError,
  ThreadId,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Fiber from "effect/Fiber";
import { constVoid } from "effect/Function";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { BrowserContext, Page } from "playwright-core";
import { beforeEach, expect, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as PreviewHandlers from "../mcp/toolkits/preview/handlers.ts";
import { PreviewStandardToolkit } from "../mcp/toolkits/preview/tools.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as BrowserTakeoverRequests from "./BrowserTakeoverRequests.ts";
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
    async openPage(
      profileId: string,
      isolationKey: string | undefined,
      prepare: (context: BrowserContext) => Promise<void>,
    ) {
      const context = await this.contextFor(profileId, isolationKey);
      await prepare(context);
      return context.newPage();
    }
    async importCookies(
      profileId: string,
      cookies: ReadonlyArray<{ readonly url: string }>,
      paymentDomains: ReadonlyArray<string>,
    ) {
      cookieImports.push({ profileId, cookies, paymentDomains });
      return { imported: cookies.length, skipped: 0, skippedDomains: [] };
    }
    async scratchPage() {
      return makeEncoderPage() as unknown as Page;
    }
    async connectDesktopPage(endpoint: string) {
      const context = makeContext(undefined, desktopPageUrl);
      context.page.viewportSize.mockReturnValue(null);
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

function makeSession(
  frame: ReturnType<typeof makeFrame> | undefined,
  viewport: { width: number; height: number },
) {
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
    emitAsync: (name: string, ...args: unknown[]) =>
      Promise.all(events.listeners(name).map((listener) => listener(...args))),
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
          executionContextId:
            (input as { worldName?: string }).worldName === "t3-preview-viewport"
              ? 9
              : (input as { worldName?: string }).worldName === "t3-preview"
                ? 1
                : 7,
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
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 9)
        return desktopSizeAnswer?.() ?? { result: { value: { ...viewport } } };
      return { result: { value: "evaluated" } };
    }),
  };
  return session;
}

function fileChooserElement(accept: string) {
  return {
    getAttribute: async () => accept,
    evaluate: (probe: (element: { ownerDocument: unknown }) => boolean) =>
      Promise.resolve(
        probe({
          ownerDocument: (globalThis as typeof globalThis & { document?: unknown }).document,
        }),
      ),
  };
}

function makeContext(onClose?: (context: BrowserContext) => void, initialUrl = "about:blank") {
  const events = new NodeEvents.EventEmitter();
  const nativeFileChooser = vi.fn();
  const setChooserFiles = vi.fn(async (_files: unknown) => {});
  const sessions: Array<ReturnType<typeof makeSession> & { readonly target: unknown }> = [];
  let url = initialUrl;
  let viewport: ReturnType<Page["viewportSize"]> = { width: 1280, height: 800 };
  const cssViewport = { width: 1920, height: 1080 };
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
          element: () => fileChooserElement(".csv"),
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
    viewportSize: vi.fn(() => viewport),
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
    cssViewport,
    newPage: async () => page as unknown as Page,
    grantPermissions: vi.fn(async () => {}),
    newCDPSession: async (target: unknown) => {
      const session = Object.assign(
        makeSession(
          target === page ? undefined : (target as ReturnType<typeof makeFrame>),
          cssViewport,
        ),
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
const cookieImports: Array<{
  profileId: string;
  cookies: ReadonlyArray<{ readonly url: string }>;
  paymentDomains: ReadonlyArray<string>;
}> = [];
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
let desktopPageUrl = "about:blank";
/** Replaces the answer to the desktop page's size reads. */
let desktopSizeAnswer: (() => Promise<Record<string, unknown>>) | null = null;
const desktopDetaches = new NodeEvents.EventEmitter();
let desktopDetachReady = Promise.withResolvers<void>();
let desktopReleased = Promise.withResolvers<void>();
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
            desktopDetachReady.resolve();
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
          Effect.sync(() => {
            releasedDesktopTabs.push(key.tabId);
            desktopReleased.resolve();
          }),
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
/** Fills a viewer's output with frames; resolves once every one of them is acknowledged. */
const stallViewer = (viewer: ServerBrowser.ServerBrowserViewer) => {
  const output = viewer.output as unknown as Queue.Queue<ServerBrowser.ServerBrowserViewerOutput>;
  const acked = Promise.withResolvers<void>();
  let unacked = 0;
  const ack = Effect.sync(() => {
    if (--unacked === 0) acked.resolve();
  });
  while (Queue.offerUnsafe(output, { _tag: "frame", data: Buffer.alloc(0), ack })) unacked++;
  return Effect.promise(() => acked.promise);
};
const viewportSizes = (items: ReadonlyArray<ServerBrowser.ServerBrowserViewerOutput>) =>
  items.flatMap((item) => (item._tag === "viewport" ? [`${item.width}x${item.height}`] : []));
const openDesktopViewer = Effect.gen(function* () {
  const browser = yield* ServerBrowser.ServerBrowser;
  const manager = yield* Manager.PreviewManager;
  desktopRendersNext = true;
  const { tabId } = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
  const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
  const context = desktopConnections[0]!.context;
  const cdp = context.sessions[0]!;
  const resize = (width: number, height: number) => {
    Object.assign(context.cssViewport, { width, height });
    return Effect.promise(() => cdp.emitAsync("Page.frameResized"));
  };
  return { tabId, viewer, context, cdp, resize };
});

beforeEach(() => {
  contexts.length = 0;
  encoderStreams.length = 0;
  contextRequests.length = 0;
  cookieImports.length = 0;
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
  desktopPageUrl = "about:blank";
  desktopSizeAnswer = null;
  desktopDetachReady = Promise.withResolvers<void>();
  desktopReleased = Promise.withResolvers<void>();
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

it.effect("a tab the desktop does not draw is marked headless, so the desktop streams it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      desktopRendersNext = true;
      const desktopTab = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      const headlessOf = (id: string | null) =>
        sessions.find((session) => session.tabId === id)?.headless;

      expect(headlessOf(tabId)).toBe(true);
      expect(headlessOf(desktopTab.tabId)).toBeUndefined();
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a desktop page that loaded before the server attached reports its loaded title", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const events = yield* manager.subscribeEvents;
      desktopRendersNext = true;
      desktopPageUrl = "https://example.com/loaded";
      const opened = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { url: desktopPageUrl, reuseExistingTab: false, show: false },
      });
      let event = yield* PubSub.take(events);
      while (event.type !== "navigated" || event.tabId !== opened.tabId) {
        event = yield* PubSub.take(events);
      }

      expect(event.snapshot.navStatus).toEqual({
        _tag: "Success",
        url: "https://example.com/loaded",
        title: "test page",
      });
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
        const reportProfiles = yield* browser.profileReporter;
        for (const recordingFrameRate of reports) {
          yield* reportProfiles({
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

it.effect("a navigation that fails while a load reads its title keeps its failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const events = yield* manager.subscribeEvents;
      const page = contexts[0]!.page;
      const heldTitle = Promise.withResolvers<string>();
      page.title.mockImplementationOnce(() => heldTitle.promise);
      yield* Effect.promise(() => page.goto("https://example.com/first"));
      const failing = {
        url: () => "https://example.com/missing",
        method: () => "GET",
        isNavigationRequest: () => true,
        frame: () => page,
        failure: () => ({ errorText: "net::ERR_NAME_NOT_RESOLVED" }),
      };
      page.emit("request", failing);
      page.emit("requestfailed", failing);
      heldTitle.resolve("Held");
      // A load at the same await depth reports after the held one, so its Success marks the end.
      page.emit("load");

      const statuses: Array<string> = [];
      while (!statuses.at(-1)?.startsWith("Success")) {
        const event = yield* PubSub.take(events);
        if (event.type === "failed" && event.tabId === tabId) {
          statuses.push(`LoadFailed ${event.url}`);
        } else if (event.type === "navigated" && event.tabId === tabId) {
          const status = event.snapshot.navStatus;
          if (status._tag === "Success") statuses.push(`Success ${status.title}`);
          else if (status._tag === "Loading") statuses.push(`Loading ${status.url}`);
        }
      }
      expect(statuses).toEqual([
        "Loading https://example.com/missing",
        "LoadFailed https://example.com/missing",
        "Success test page",
      ]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect.each([
  {
    name: "hover burst before a click",
    inputs: [
      ...Array.from({ length: 120 }, (_, x) => ({
        type: "mouse",
        action: "move",
        x,
        buttons: 0,
        button: "none",
      })),
      { type: "mouse", action: "down", x: 119, buttons: 1, button: "left" },
      { type: "mouse", action: "up", x: 119, buttons: 0, button: "left" },
    ],
    expected: [
      { type: "mouseMoved", x: -1 },
      { type: "mouseMoved", x: 119 },
      { type: "mousePressed", x: 119 },
      { type: "mouseReleased", x: 119 },
    ],
  },
  {
    name: "modifier changes and drag points",
    inputs: [
      { type: "mouse", action: "move", x: 1, buttons: 0, button: "none" },
      { type: "mouse", action: "move", x: 2, buttons: 0, button: "none", modifiers: 2 },
      { type: "mouse", action: "move", x: 3, buttons: 0, button: "none", modifiers: 2 },
      { type: "mouse", action: "down", x: 3, buttons: 1, button: "left" },
      { type: "mouse", action: "move", x: 4, buttons: 1, button: "left" },
      { type: "mouse", action: "move", x: 5, buttons: 1, button: "left" },
      { type: "mouse", action: "up", x: 5, buttons: 0, button: "left" },
    ],
    expected: [
      { type: "mouseMoved", x: -1 },
      { type: "mouseMoved", x: 1, modifiers: 0 },
      { type: "mouseMoved", x: 3, modifiers: 2 },
      { type: "mousePressed", x: 3 },
      { type: "mouseMoved", x: 4 },
      { type: "mouseMoved", x: 5 },
      { type: "mouseReleased", x: 5 },
    ],
  },
  {
    name: "wheel and keyboard boundaries",
    inputs: [
      { type: "mouse", action: "move", x: 1, buttons: 0, button: "none" },
      { type: "wheel", x: 1, deltaY: 20 },
      { type: "wheel", x: 1, deltaY: 30 },
      { type: "mouse", action: "move", x: 2, buttons: 0, button: "none" },
      { type: "key", action: "down", key: "a", code: "KeyA", text: "a" },
      { type: "mouse", action: "move", x: 3, buttons: 0, button: "none" },
    ],
    expected: [
      { type: "mouseMoved", x: -1 },
      { type: "mouseMoved", x: 1 },
      { type: "mouseWheel", deltaY: 20 },
      { type: "mouseWheel", deltaY: 30 },
      { type: "mouseMoved", x: 2 },
      { type: "keyDown", key: "a" },
      { type: "mouseMoved", x: 3 },
    ],
  },
  {
    name: "text, navigation and resize boundaries",
    inputs: [
      { type: "mouse", action: "move", x: 1, buttons: 0, button: "none" },
      { type: "text", text: "typed" },
      { type: "mouse", action: "move", x: 2, buttons: 0, button: "none" },
      { type: "navigate", url: "http://localhost:5173/next" },
      { type: "mouse", action: "move", x: 3, buttons: 0, button: "none" },
      { type: "resize", width: 640, height: 480 },
      { type: "mouse", action: "move", x: 4, buttons: 0, button: "none" },
    ],
    expected: [
      { type: "mouseMoved", x: -1 },
      { type: "mouseMoved", x: 1 },
      { text: "typed" },
      { type: "mouseMoved", x: 2 },
      { type: "mouseMoved", x: 3 },
      { type: "mouseMoved", x: 4 },
    ],
  },
  {
    name: "ambiguous button fields",
    inputs: [
      { type: "mouse", action: "move", x: 1, button: "none" },
      { type: "mouse", action: "move", x: 2, button: "none" },
      { type: "mouse", action: "move", x: 3, buttons: 0 },
      { type: "mouse", action: "move", x: 4, buttons: 0 },
    ],
    expected: [-1, 1, 2, 3, 4].map((x) => ({ type: "mouseMoved", x })),
  },
])("orders streamed input correctly for $name", (testCase) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const session = contexts[0]!.sessions.at(-1)!;
      const send = session.send.getMockImplementation()!;
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      yield* Effect.addFinalizer(() => Effect.sync(() => finish.resolve()));
      session.send.mockClear();
      session.send.mockImplementationOnce(async (method, input) => {
        started.resolve();
        await finish.promise;
        return send(method, input);
      });
      const running = yield* viewer
        .input({ type: "mouse", action: "move", x: -1, button: "none", buttons: 0 })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Effect.promise(() => started.promise);
      const waiting = yield* Effect.forEach(testCase.inputs, (input) =>
        viewer.input(input).pipe(Effect.forkScoped({ startImmediately: true })),
      );
      finish.resolve();
      yield* Effect.forEach([running, ...waiting], Fiber.join);
      const dispatched = session.send.mock.calls.flatMap(([method, input]) =>
        method.startsWith("Input.") ? [input] : [],
      );
      expect(dispatched).toHaveLength(testCase.expected.length);
      expect(dispatched).toMatchObject(testCase.expected);
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

it.effect("a tab showing a data: page reports its URL without the content", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const sibling = yield* broker.invoke<PreviewAutomationStatus>({
        scope: asSession("agent-b"),
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      yield* Effect.promise(() => contexts[1]!.page.goto("data:text/html,<p>SIBLING-SECRET</p>"));
      const manager = yield* Manager.PreviewManager;
      const events = yield* manager.subscribeEvents;
      yield* Effect.promise(() => contexts[0]!.page.goto("data:text/html,<p>SECRET-KEY</p>"));
      let event = yield* PubSub.take(events);
      while (
        event.type !== "navigated" ||
        event.tabId !== tabId ||
        event.snapshot.navStatus._tag !== "Success"
      ) {
        event = yield* PubSub.take(events);
      }
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(event.snapshot.navStatus).toMatchObject({ url: "data:text/html,…" });
      expect(status.url).toBe("data:text/html,…");
      expect(status.tabs?.find((entry) => entry.tabId === tabId)?.url).toBe("data:text/html,…");
      expect(status.tabs?.find((entry) => entry.tabId === sibling.tabId)?.url).toBe(
        "data:text/html,…",
      );
      expect(JSON.stringify([event, status])).not.toContain("SECRET-KEY");
      expect(JSON.stringify([event, status])).not.toContain("SIBLING-SECRET");
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

it.live("a restarted server removes the previous run's downloads and keeps its profiles", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const previousTab = path.join(stateDir, "server-browser", "downloads", "previous-tab");
      const profile = path.join(stateDir, "server-browser", "profiles", "default");
      yield* fs.makeDirectory(previousTab, { recursive: true });
      yield* fs.makeDirectory(profile, { recursive: true });
      yield* fs.writeFileString(path.join(previousTab, "report.csv"), "a,b");
      yield* fs.writeFileString(path.join(profile, "Preferences"), "{}");

      yield* Layer.build(ServerBrowser.layer);

      expect(yield* fs.exists(previousTab)).toBe(false);
      expect(yield* fs.readFileString(path.join(profile, "Preferences"))).toBe("{}");
    }),
  ).pipe(Effect.provide(dependenciesAt({ prefix: "t3-server-browser-restart-" }))),
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
        element: () => fileChooserElement(".csv"),
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

it.live("overlapping file pickers keep the newer offer answerable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const accept = Promise.withResolvers<string | null>();
      const firstFiles = vi.fn(async (_files: unknown) => {});
      const secondFiles = vi.fn(async (_files: unknown) => {});
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({ ...fileChooserElement(""), getAttribute: () => accept.promise }),
        setFiles: firstFiles,
      });
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => fileChooserElement(".csv"),
        setFiles: secondFiles,
      });
      accept.resolve(".txt");
      let first = yield* Queue.take(viewer.output);
      while (first._tag !== "fileChooser") first = yield* Queue.take(viewer.output);
      let second = yield* Queue.take(viewer.output);
      while (second._tag !== "fileChooser") second = yield* Queue.take(viewer.output);
      expect(second.accept).toBe(".csv");
      expect(
        yield* browser.answerFileChooser({
          threadId: scope.thread.threadId,
          tabId,
          chooserId: second.id,
          files: [{ name: "a.csv", mimeType: "text/csv", buffer: Buffer.from("a") }],
        }),
      ).toBe(true);
      expect(firstFiles).not.toHaveBeenCalled();
      expect(secondFiles).toHaveBeenCalledOnce();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a detached file picker stays open across same-document navigation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const pageDocument = {};
      vi.stubGlobal("document", pageDocument);
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllGlobals()));
      const detachedInput = { isConnected: false, ownerDocument: pageDocument };
      const navigationProbe = Promise.withResolvers<boolean>();
      const navigationProbeStarted = Promise.withResolvers<void>();
      const navigationProbeFinished = Promise.withResolvers<void>();
      let probeCount = 0;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({
          getAttribute: async () => "",
          evaluate: (probe: (element: typeof detachedInput) => boolean) => {
            probeCount++;
            if (probeCount === 1) return Promise.resolve(probe(detachedInput));
            navigationProbeStarted.resolve();
            return navigationProbe.promise.then((current) => {
              const result = probe(detachedInput);
              navigationProbeFinished.resolve();
              return current && result;
            });
          },
        }),
        setFiles: vi.fn(async (_files: unknown) => {}),
      });
      let offered = yield* Queue.take(viewer.output);
      while (offered._tag !== "fileChooser") offered = yield* Queue.take(viewer.output);

      page.emit("framenavigated", page);
      yield* Effect.promise(() => navigationProbeStarted.promise);
      navigationProbe.resolve(true);
      yield* Effect.promise(() => navigationProbeFinished.promise);
      yield* viewer.input({ type: "releaseControl" });
      let closedAfterNavigation = false;
      let control = yield* Queue.take(viewer.output);
      while (control._tag !== "control" || control.controller === "you") {
        if (control._tag === "fileChooserClosed") closedAfterNavigation = true;
        control = yield* Queue.take(viewer.output);
      }
      expect(closedAfterNavigation).toBe(false);
      yield* viewer.input({ type: "takeControl" });
      let restoredControl = yield* Queue.take(viewer.output);
      while (restoredControl._tag !== "control" || restoredControl.controller !== "you") {
        restoredControl = yield* Queue.take(viewer.output);
      }

      expect(
        yield* browser.answerFileChooser({
          threadId: scope.thread.threadId,
          tabId,
          chooserId: offered.id,
          files: [{ name: "a.csv", mimeType: "text/csv", buffer: Buffer.from("a") }],
        }),
      ).toBe(true);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each(["main", "iframe"])(
  "a file picker closes at %s document commit before DOMContentLoaded",
  (frame) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, tabId } = yield* ready;
        const page = contexts[0]!.page;
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        yield* viewer.input({ type: "takeControl" });
        const setFiles = vi.fn(async (_files: unknown) => {});
        const probeStarted = Promise.withResolvers<void>();
        const probeSettled = Promise.withResolvers<void>();
        let probeCount = 0;
        page.emit("filechooser", {
          isMultiple: () => false,
          element: () => ({
            getAttribute: async () => "",
            evaluate: () => {
              probeCount++;
              if (probeCount === 1) return Promise.resolve(true);
              probeStarted.resolve();
              return Promise.reject(new Error("Execution context was destroyed")).finally(() =>
                probeSettled.resolve(),
              );
            },
          }),
          setFiles,
        });
        let offered = yield* Queue.take(viewer.output);
        while (offered._tag !== "fileChooser") offered = yield* Queue.take(viewer.output);

        page.emit("framenavigated", frame === "main" ? page : makeFrame());
        yield* Effect.promise(() => probeStarted.promise);
        yield* Effect.promise(() => probeSettled.promise);
        let closed = yield* Queue.take(viewer.output);
        while (closed._tag !== "fileChooserClosed") closed = yield* Queue.take(viewer.output);
        expect(closed.id).toBe(offered.id);
        expect(
          yield* browser.answerFileChooser({
            threadId: scope.thread.threadId,
            tabId,
            chooserId: offered.id,
            files: [{ name: "a.csv", mimeType: "text/csv", buffer: Buffer.from("a") }],
          }),
        ).toBe(false);
        expect(setFiles).not.toHaveBeenCalled();
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("a file picker closes when its page is replaced while control changes hands", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const first = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* first.input({ type: "takeControl" });
      const current = Promise.withResolvers<boolean>();
      const probeStarted = Promise.withResolvers<void>();
      let probeCount = 0;
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({
          getAttribute: async () => "",
          evaluate: () => {
            probeCount++;
            if (probeCount === 1) return Promise.resolve(true);
            probeStarted.resolve();
            return current.promise;
          },
        }),
        setFiles: vi.fn(async (_files: unknown) => {}),
      });
      let offered = yield* Queue.take(first.output);
      while (offered._tag !== "fileChooser") offered = yield* Queue.take(first.output);

      page.emit("framenavigated", page);
      yield* Effect.promise(() => probeStarted.promise);
      const second = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* first.input({ type: "releaseControl" });
      yield* second.input({ type: "takeControl" });
      let reoffered = yield* Queue.take(second.output);
      while (reoffered._tag !== "fileChooser") reoffered = yield* Queue.take(second.output);
      current.resolve(false);
      let closed = yield* Queue.take(second.output);
      while (closed._tag !== "fileChooserClosed") closed = yield* Queue.take(second.output);
      expect(closed.id).toBe(reoffered.id);
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.fileChooser).toBeNull();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a file picker is not offered after its document changes while reading accept", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const accept = Promise.withResolvers<string | null>();
      const acceptRead = Promise.withResolvers<void>();
      const current = Promise.withResolvers<boolean>();
      const probeStarted = Promise.withResolvers<void>();
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({
          getAttribute: () => {
            acceptRead.resolve();
            return accept.promise;
          },
          evaluate: () => {
            probeStarted.resolve();
            return current.promise;
          },
        }),
        setFiles: vi.fn(async (_files: unknown) => {}),
      });

      yield* Effect.promise(() => acceptRead.promise);
      page.emit("framenavigated", page);
      accept.resolve("");
      yield* Effect.promise(() => accept.promise);
      yield* Effect.promise(() => probeStarted.promise);
      current.resolve(false);
      yield* Effect.promise(() => current.promise);
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.fileChooser).toBeNull();
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
        element: () => fileChooserElement(""),
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

it.effect(
  "desktop viewers get the page's CSS size and keep the last one a read cannot measure",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Each page size read waits here for its answer.
        const reads = yield* Queue.unbounded<PromiseWithResolvers<Record<string, unknown>>>();
        const deferReads = () => {
          desktopSizeAnswer = () => {
            const read = Promise.withResolvers<Record<string, unknown>>();
            Queue.offerUnsafe(reads, read);
            return read.promise;
          };
        };
        deferReads();
        const { viewer, cdp, context } = yield* openDesktopViewer;
        const answer = (width: number, height: number) => ({
          result: { value: { width, height } },
        });
        const resized = () => cdp.emitAsync("Page.frameResized");
        // The read on attach never answers and gives up with no size to send.
        const blocked = yield* Queue.take(reads);
        yield* TestClock.adjust("1 second");
        // The next page load measures again.
        desktopSizeAnswer = null;
        yield* Effect.promise(() => cdp.emitAsync("Page.loadEventFired"));
        expect(viewportSizes(yield* Queue.takeAll(viewer.output))).toEqual(["1920x1080"]);
        // While a dialog is open nothing reads. The host closing it clears it, and since
        // closing resizes nothing, the close itself remeasures.
        deferReads();
        context.page.emit("dialog", {
          type: () => "alert",
          message: () => "",
          defaultValue: () => "",
        });
        yield* Effect.promise(resized);
        expect(yield* Queue.size(reads)).toBe(0);
        desktopSizeAnswer = null;
        yield* Effect.promise(() => cdp.emitAsync("Page.javascriptDialogClosed"));
        expect(viewportSizes(yield* Queue.takeAll(viewer.output))).toEqual([
          "1920x1080",
          "1920x1080",
        ]);
        // The late answer, a read a navigation breaks and a hidden webview keep the last size.
        blocked.resolve(answer(100, 100));
        deferReads();
        const navigated = resized();
        (yield* Queue.take(reads)).reject(new Error("Cannot find context with specified id"));
        yield* Effect.promise(() => navigated);
        const hidden = resized();
        (yield* Queue.take(reads)).resolve(answer(0, 0));
        yield* Effect.promise(() => hidden);
        expect(viewportSizes(yield* Queue.takeAll(viewer.output))).toEqual([
          "1920x1080",
          "1920x1080",
        ]);
        // Resizes during a read share one more read, so the newest size arrives last.
        const first = resized();
        const firstRead = yield* Queue.take(reads);
        const burst = Promise.all([resized(), resized()]);
        firstRead.resolve(answer(800, 500));
        (yield* Queue.take(reads)).resolve(answer(1000, 600));
        expect(yield* Queue.size(reads)).toBe(0);
        yield* Effect.promise(() => Promise.all([first, burst]));
        expect(viewportSizes(yield* Queue.takeAll(viewer.output))).toEqual([
          "800x500",
          "1000x600",
          "1000x600",
        ]);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("a stalled desktop viewer still gets its size, control and reconnect", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { tabId, viewer, context, resize } = yield* openDesktopViewer;
      const output =
        viewer.output as unknown as Queue.Queue<ServerBrowser.ServerBrowserViewerOutput>;
      // Ready once the sizes measured on attach and on a first resize both arrived.
      yield* resize(1920, 1080);
      expect(viewportSizes(yield* Queue.takeAll(viewer.output))).toEqual([
        "1920x1080",
        "1920x1080",
      ]);
      yield* Effect.promise(() => desktopDetachReady.promise);
      yield* viewer.input({ type: "takeControl" });
      context.page.emit("filechooser", {
        isMultiple: () => false,
        element: () => fileChooserElement(".csv"),
        setFiles: vi.fn(async () => {}),
      });
      let chooser = yield* Queue.take(viewer.output);
      while (chooser._tag !== "fileChooser") chooser = yield* Queue.take(viewer.output);
      yield* Queue.clear(viewer.output);
      // A resize compacts a full backlog but keeps control, the open picker and
      // one-time notifications in order.
      yield* viewer.input({ type: "takeControl" });
      const notifications: Array<ServerBrowser.ServerBrowserViewerOutput> = [
        { _tag: "fileChooserClosed", id: "chooser-0" },
        { _tag: "popup", tabId: "popup-1" },
        { _tag: "download", id: "download-1", fileName: "report.csv", sizeBytes: 3 },
        { _tag: "clipboard", text: "copied" },
      ];
      for (const item of notifications) Queue.offerUnsafe(output, item);
      let acked = stallViewer(viewer);
      yield* resize(1000, 600);
      expect(yield* Queue.takeAll(viewer.output)).toEqual([
        chooser,
        ...notifications,
        expect.objectContaining({ _tag: "control", controller: "you" }),
        { _tag: "viewport", width: 1000, height: 600 },
      ]);
      yield* acked;
      // A control change keeps only the newest size.
      yield* resize(900, 500);
      yield* resize(1200, 700);
      acked = stallViewer(viewer);
      yield* viewer.input({ type: "releaseControl" });
      expect(yield* Queue.takeAll(viewer.output)).toEqual([
        expect.objectContaining({ _tag: "control", controller: "unclaimed" }),
        { _tag: "viewport", width: 1200, height: 700 },
      ]);
      yield* acked;
      // Notifications that no longer fit go oldest first, never the size.
      let copies = 0;
      while (Queue.offerUnsafe(output, { _tag: "clipboard", text: `copy ${copies}` })) copies++;
      yield* resize(1000, 600);
      const compacted = yield* Queue.takeAll(viewer.output);
      expect(compacted.at(0)).toEqual({ _tag: "clipboard", text: "copy 1" });
      expect(compacted.at(-1)).toEqual({ _tag: "viewport", width: 1000, height: 600 });
      // The desktop takes the page back; a resize after it cannot bury the reconnect.
      acked = stallViewer(viewer);
      desktopDetaches.emit("detach", { threadId: scope.thread.threadId, tabId });
      yield* Effect.promise(() => desktopReleased.promise);
      yield* resize(1000, 600);
      expect(yield* Queue.takeAll(viewer.output)).toEqual([{ _tag: "reconnect" }]);
      yield* acked;
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
        const reportProfiles = yield* browser.profileReporter;
        yield* reportProfiles({
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
  yield* (yield* browser.profileReporter)({
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
          const browser = yield* ServerBrowser.ServerBrowser;
          yield* Effect.yieldNow;
          // One client, so its second report replaces its first.
          const report = yield* browser.profileReporter;
          yield* report({
            profiles: [{ id: "profile-work", name: "Work", kind: "persistent" }],
            defaultProfileId: "profile-work",
          });
          yield* report({
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

const cookieToImport = {
  url: "https://github.com/",
  name: "session",
  value: "abc",
  domain: ".github.com",
  path: "/",
  secure: true,
  httpOnly: true,
  expirationDate: 1_800_000_000,
  sameSite: "lax",
} as const;

it.live("importCookies writes into a reported persistent profile with the payment list", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* Effect.yieldNow;
      yield* settings.updateSettings({ browserPaymentDomains: ["shop.example.test"] });
      yield* (yield* browser.profileReporter)({
        profiles: [{ id: "profile-work", name: "Work", kind: "persistent" }],
        defaultProfileId: "profile-work",
      });
      const result = yield* browser.importCookies({
        profileId: "profile-work",
        cookies: [cookieToImport],
      });
      expect(result).toEqual({ imported: 1, skipped: 0, skippedDomains: [] });
      expect(cookieImports).toEqual([
        {
          profileId: "profile-work",
          cookies: [cookieToImport],
          paymentDomains: ["shop.example.test"],
        },
      ]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("importCookies refuses the incognito profile and unknown profile ids by reason", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      yield* Effect.yieldNow;
      const incognito = yield* browser
        .importCookies({ profileId: "incognito", cookies: [cookieToImport] })
        .pipe(Effect.flip);
      expect(incognito).toMatchObject({
        _tag: "PreviewImportCookiesError",
        profileId: "incognito",
        reason: "incognitoProfile",
      });
      const unknown = yield* browser
        .importCookies({ profileId: "profile-gone", cookies: [cookieToImport] })
        .pipe(Effect.flip);
      expect(unknown).toMatchObject({
        _tag: "PreviewImportCookiesError",
        profileId: "profile-gone",
        reason: "unknownProfile",
      });
      expect(cookieImports).toEqual([]);
    }),
  ).pipe(Effect.provide(layer)),
);

// Entry point: `preview_request_takeover` through `PreviewStandardToolkit.handle` and the
// production handlers, over this file's Chromium fakes; a viewer's input is the human.
// The thread service fake decodes each card with `OrchestrationV2TurnItem`; the
// orchestrator's side of the record command is pinned in `push/PushDispatcher.test.ts`.
const TAKEOVER_TOOL_NAME = "preview_request_takeover";
const TAKEOVER_REASON = "The bank asks for a 2FA code";
const TAKEOVER_EPOCH = DateTime.makeUnsafe("2026-11-01T12:00:00.000Z");
const decodeTakeoverTurnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
type TakeoverStatus = "pending" | "done" | "declined" | "cancelled";

const makeTakeoverThreads = Effect.gen(function* () {
  const shell = liveThreadShell(scope.thread.threadId);
  const runId = shell.activeRunId!;
  const records: Array<Record<string, unknown>> = [];
  const items = new Map<string, OrchestrationV2TurnItem>();
  const pendingRecorded = yield* Deferred.make<Record<string, unknown>>();
  const pendingPolled = yield* Deferred.make<void>();
  let runStatus: "running" | "completed" = "running";
  const run = () => ({
    id: runId,
    threadId: scope.thread.threadId,
    ordinal: 1,
    providerInstanceId: scope.thread.providerInstanceId,
    modelSelection: { instanceId: scope.thread.providerInstanceId, model: "gpt-5.4" },
    providerThreadId: null,
    userMessageId: MessageId.make("message:takeover"),
    rootNodeId: NodeId.make("node:takeover"),
    activeAttemptId: null,
    status: runStatus,
    requestedAt: TAKEOVER_EPOCH,
    startedAt: TAKEOVER_EPOCH,
    completedAt: runStatus === "running" ? null : TAKEOVER_EPOCH,
    checkpointId: null,
    contextHandoffId: null,
  });
  const projection = () => ({
    ...idleThreadProjection(shell),
    runs: [run()],
    turnItems: [...items.values()],
  });
  const storeCard = (command: Record<string, unknown>) => {
    const { type: _type, commandId: _commandId, turnItemId, ...fields } = command;
    // As the orchestrator does, a card keeps its first answer.
    const existing = items.get(String(turnItemId));
    if (existing?.type === "browser_takeover_request" && existing.takeoverStatus !== "pending")
      return;
    const pending = command.takeoverStatus === "pending";
    items.set(
      String(turnItemId),
      decodeTakeoverTurnItem({
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: items.size + 1,
        title: null,
        startedAt: TAKEOVER_EPOCH,
        updatedAt: TAKEOVER_EPOCH,
        ...fields,
        id: turnItemId,
        type: "browser_takeover_request",
        status: pending ? "waiting" : "completed",
        completedAt: pending ? null : TAKEOVER_EPOCH,
      }),
    );
  };
  const layer = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: () =>
      Effect.succeed({ ...shell, activeRunId: runStatus === "running" ? runId : null }),
    getThreadProjection: () => Effect.sync(projection),
    getThreadRecords: (() =>
      Effect.sync(projection).pipe(
        Effect.tap((current) =>
          current.turnItems.some(
            (item) => item.type === "browser_takeover_request" && item.takeoverStatus === "pending",
          )
            ? Deferred.succeed(pendingPolled, undefined)
            : Effect.void,
        ),
      )) as never,
    dispatch: (command) =>
      Effect.gen(function* () {
        const recorded = command as unknown as Record<string, unknown>;
        records.push(recorded);
        storeCard(recorded);
        if (recorded.takeoverStatus === "pending")
          yield* Deferred.succeed(pendingRecorded, recorded);
        return {} as never;
      }),
  });
  /** Re-records the card with the operator's answer, as the answer RPC does. */
  const answer = (
    pending: Record<string, unknown>,
    takeoverStatus: Exclude<TakeoverStatus, "pending">,
  ) => Effect.sync(() => storeCard({ ...pending, takeoverStatus }));
  const endRun = Effect.sync(() => {
    runStatus = "completed";
  });
  return {
    layer,
    records,
    pendingRecorded: Deferred.await(pendingRecorded),
    /** Once a read has seen the card pending: the next card poll is a poll interval away. */
    pendingPolled: Deferred.await(pendingPolled),
    answer,
    endRun,
  };
});

const callTakeover = (
  threads: Layer.Layer<ThreadManagementService.ThreadManagementService>,
  params: { readonly tabId?: PreviewTabId; readonly reason: string; readonly timeoutMs?: number },
  caller: typeof scope = scope,
) =>
  Effect.gen(function* () {
    // Built once, so the handlers and the call share one takeover service.
    const context = yield* Layer.build(
      BrowserTakeoverRequests.layer.pipe(Layer.provideMerge(threads)),
    );
    const toolkit = yield* PreviewStandardToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(PreviewHandlers.layerStandard)),
      Effect.provide(context),
    );
    const chunk = yield* toolkit
      .handle(TAKEOVER_TOOL_NAME, params)
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(context));
    return chunk.at(-1)!.result as unknown as Record<string, unknown>;
  }).pipe(Effect.scoped, Effect.provideService(McpInvocationContext.McpInvocationContext, caller));

/** The pending card, or the tool's own end when it ends without recording one. */
const untilPending = <A, E>(
  threads: Effect.Success<typeof makeTakeoverThreads>,
  call: Fiber.Fiber<A, E>,
) =>
  Effect.raceFirst(
    threads.pendingRecorded,
    Fiber.join(call).pipe(
      Effect.flatMap((result) =>
        Effect.die(`The tool returned before recording a pending card: ${JSON.stringify(result)}`),
      ),
    ),
  );

/** The `preview_status` the tool returns, wherever the result carries it. */
const returnedPreviewStatus = (result: Record<string, unknown>, tabId: PreviewTabId) =>
  Object.values(result).find(
    (value): value is PreviewAutomationStatus =>
      typeof value === "object" &&
      value !== null &&
      (value as { tabId?: unknown }).tabId === tabId &&
      "control" in value,
  );

const takeoverCards = (records: ReadonlyArray<Record<string, unknown>>) =>
  records.filter((record) => record.type === "browser_takeover_request.record");

it.live(
  "takeover phase AC1: preview_request_takeover on the agent's own server tab reveals it and records a pending card",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { tabId } = yield* ready;
        const manager = yield* Manager.PreviewManager;
        const threads = yield* makeTakeoverThreads;
        const call = yield* callTakeover(threads.layer, { tabId, reason: TAKEOVER_REASON }).pipe(
          Effect.forkScoped,
        );
        const pending = yield* untilPending(threads, call);
        expect(pending).toMatchObject({
          type: "browser_takeover_request.record",
          threadId: scope.thread.threadId,
          tabId,
          reason: TAKEOVER_REASON,
          takeoverStatus: "pending",
        });
        const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
        expect(sessions.find((session) => session.tabId === tabId)).toMatchObject({
          revealRequest: { force: true },
        });
      }),
    ).pipe(Effect.provide(layer)),
);

it.live(
  "takeover phase AC3: preview_request_takeover returns done with a fresh preview_status after a human takes and releases the tab",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker, tabId } = yield* ready;
        const before = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        const threads = yield* makeTakeoverThreads;
        const call = yield* callTakeover(threads.layer, { tabId, reason: TAKEOVER_REASON }).pipe(
          Effect.forkScoped,
        );
        yield* untilPending(threads, call);
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        yield* viewer.input({ type: "takeControl" });
        yield* viewer.input({ type: "releaseControl" });
        const result = yield* Fiber.join(call);
        expect(result.status).toBe("done");
        const status = returnedPreviewStatus(result, tabId);
        expect(status?.control?.owner).toBe("agent");
        expect(status!.control!.generation).toBeGreaterThan(before.control!.generation);
        expect(takeoverCards(threads.records).at(-1)).toMatchObject({ takeoverStatus: "done" });
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each(["done", "declined"] as const)(
  "takeover phase AC4: preview_request_takeover returns %s when the operator answers the card",
  (answer) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { tabId } = yield* ready;
        const threads = yield* makeTakeoverThreads;
        const call = yield* callTakeover(threads.layer, { tabId, reason: TAKEOVER_REASON }).pipe(
          Effect.forkScoped,
        );
        yield* threads.answer(yield* untilPending(threads, call), answer);
        const result = yield* Fiber.join(call);
        expect(result.status).toBe(answer);
        expect(returnedPreviewStatus(result, tabId)?.tabId).toBe(tabId);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each(["timeout", "run end"] as const)(
  "takeover phase AC5: preview_request_takeover returns cancelled after its %s and closes the card",
  (ending) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { tabId } = yield* ready;
        const threads = yield* makeTakeoverThreads;
        const call = yield* callTakeover(threads.layer, {
          tabId,
          reason: TAKEOVER_REASON,
          ...(ending === "timeout" ? { timeoutMs: 1 } : {}),
        }).pipe(Effect.forkScoped);
        // A 1 ms timeout can end the call before a race would see its pending card.
        if (ending === "run end") {
          yield* untilPending(threads, call);
          yield* threads.endRun;
        }
        const result = yield* Fiber.join(call);
        expect(result.status).toBe("cancelled");
        expect(takeoverCards(threads.records).map((record) => record.takeoverStatus)).toEqual([
          "pending",
          "cancelled",
        ]);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live(
  "takeover phase AC6: preview_request_takeover on a tab another agent owns fails and records no card",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* Broker.PreviewAutomationBroker;
        yield* ServerBrowser.ServerBrowser;
        yield* Effect.yieldNow;
        const others = yield* broker.invoke<PreviewAutomationStatus>({
          scope: asSession("agent-b"),
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        });
        const tabId = PreviewTabId.make(others.tabId!);
        const threads = yield* makeTakeoverThreads;
        const outcome = yield* callTakeover(threads.layer, { tabId, reason: TAKEOVER_REASON }).pipe(
          Effect.exit,
        );
        expect(outcome._tag).toBe("Failure");
        expect(String(outcome)).toMatch(/another agent/i);
        expect(threads.records).toEqual([]);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live(
  "takeover guard: a human take and release on an agent's server tab returns control to the agent with a newer generation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker, tabId } = yield* ready;
        const status = () =>
          broker.invoke<PreviewAutomationStatus>({ scope, tabId, operation: "status", input: {} });
        const before = yield* status();
        expect(before.control).toMatchObject({ owner: "agent", ownedByCaller: true });
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        yield* viewer.input({ type: "takeControl" });
        const held = yield* status();
        expect(held.control).toMatchObject({ owner: "human", ownedByCaller: true });
        const refused = yield* broker
          .invoke<void>({ scope, tabId, operation: "evaluate", input: { expression: "held()" } })
          .pipe(Effect.flip);
        expect(refused).toMatchObject({ reason: "humanControl" });
        yield* viewer.input({ type: "releaseControl" });
        const after = yield* status();
        expect(after.control).toMatchObject({ owner: "agent", ownedByCaller: true });
        expect(after.control!.generation).toBeGreaterThan(held.control!.generation);
        expect(held.control!.generation).toBeGreaterThan(before.control!.generation);
        expect(
          yield* broker.invoke({
            scope,
            tabId,
            operation: "evaluate",
            input: { expression: "released()" },
          }),
        ).toBe("evaluated");
      }),
    ).pipe(Effect.provide(layer)),
);

it.live(
  "takeover rework: an operator who answers Cannot and then releases the tab gets declined back, not done",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, tabId } = yield* ready;
        const threads = yield* makeTakeoverThreads;
        const call = yield* callTakeover(threads.layer, { tabId, reason: TAKEOVER_REASON }).pipe(
          Effect.forkScoped,
        );
        const pending = yield* untilPending(threads, call);
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        yield* viewer.input({ type: "takeControl" });
        yield* threads.answer(pending, "declined");
        // The release ends the control cycle before the next card poll can see the answer.
        yield* viewer.input({ type: "releaseControl" });
        const result = yield* Fiber.join(call);
        expect(result.status).toBe("declined");
      }),
    ).pipe(Effect.provide(layer)),
);

it.live(
  "takeover rework: an operator who answers Done just before the timeout gets done back, not cancelled",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { tabId } = yield* ready;
        const threads = yield* makeTakeoverThreads;
        // Shorter than the card poll, so the timeout fires before any poll sees the answer.
        const call = yield* callTakeover(threads.layer, {
          tabId,
          reason: TAKEOVER_REASON,
          timeoutMs: 300,
        }).pipe(Effect.forkScoped);
        const pending = yield* untilPending(threads, call);
        yield* threads.pendingPolled;
        yield* threads.answer(pending, "done");
        const result = yield* Fiber.join(call);
        expect(result.status).toBe("done");
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("profiles reported by one client survive another client's report", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, broker } = yield* ready;
      contextRequests.length = 0;
      const work = { id: "profile-work", name: "Work", kind: "persistent" } as const;
      const shared = { id: "profile-shared", name: "Shared", kind: "persistent" } as const;
      const openWork = () =>
        broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false, profileId: work.id },
        });
      const reportFromA = yield* browser.profileReporter;
      const clientB = yield* Scope.make();
      const reportFromB = yield* browser.profileReporter.pipe(
        Effect.provideService(Scope.Scope, clientB),
      );
      yield* reportFromA({ profiles: [work, shared], defaultProfileId: work.id });
      yield* reportFromB({ profiles: [shared], defaultProfileId: shared.id });
      expect(yield* openWork()).toMatchObject({
        defaultProfileId: shared.id,
        profiles: [
          { id: "default", name: "Default" },
          { id: "incognito", name: "Incognito", incognito: true },
          { id: work.id, name: work.name },
          { id: shared.id, name: shared.name },
        ],
      });
      expect(contextRequests).toEqual([{ profileId: work.id, isolated: false }]);
      yield* Scope.close(clientB, Exit.void);
      expect(yield* openWork()).toMatchObject({ defaultProfileId: work.id });
      yield* reportFromA({ profiles: [shared], defaultProfileId: shared.id });
      const removed = yield* openWork().pipe(Effect.flip);
      expect(removed).toMatchObject({
        _tag: "PreviewAutomationExecutionError",
        reason:
          'No browser profile is named "profile-work". Use one of: Default (id default), Incognito (id incognito), Shared (id profile-shared).',
      });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each([
  { budget: "agent", limit: 8 },
  { budget: "server", limit: 32 },
])("opens and popups reserve the $budget budget before session creation", ({ budget, limit }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, browser, tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const open = (target = scope) =>
        broker.invoke<PreviewAutomationStatus>({
          scope: target,
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        });
      for (let index = 1; index < limit - 3; index++) {
        yield* open(budget === "agent" ? scope : asSession(`other-${Math.floor(index / 8)}`));
      }

      const sessionGate = Promise.withResolvers<void>();
      const launchGate = (contextGate = Promise.withResolvers<void>());
      const sessionStarted = Promise.withResolvers<void>();
      const realOpen = manager.open;
      const delayedOpen = vi.spyOn(manager, "open").mockImplementation((input) =>
        Effect.promise(() => {
          sessionStarted.resolve();
          return sessionGate.promise;
        }).pipe(Effect.andThen(realOpen(input))),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          sessionGate.resolve();
          launchGate.resolve();
          delayedOpen.mockRestore();
        }),
      );
      const events = yield* manager.subscribeEvents;
      const first = yield* open().pipe(Effect.result, Effect.forkScoped);
      yield* Effect.promise(() => sessionStarted.promise);
      const popup = makeContext();
      const resized = Promise.withResolvers<void>();
      const setViewportSize = popup.page.setViewportSize;
      popup.page.setViewportSize = vi.fn(async (size) => {
        await setViewportSize(size);
        if (size?.width === 900) resized.resolve();
      });
      const newCDPSession = popup.newCDPSession;
      popup.newCDPSession = async (target) => {
        await launchGate.promise;
        return newCDPSession(target);
      };
      contexts[0]!.page.emit("popup", popup.page);
      const last = yield* open().pipe(Effect.result, Effect.forkScoped);
      const overflow = yield* open().pipe(Effect.result, Effect.forkScoped);
      // The host processes this after the opens, while manager creation is blocked.
      const reused = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "open",
        input: { show: false },
      });
      expect(reused.tabId).toBe(tabId);
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toHaveLength(
        limit - 3,
      );

      sessionGate.resolve();
      for (let count = 0; count < 3; count++) {
        let event = yield* PubSub.take(events);
        while (event.type !== "opened") event = yield* PubSub.take(events);
        yield* manager.resize({
          threadId: scope.thread.threadId,
          tabId: event.tabId,
          viewport: { _tag: "freeform", width: 900, height: 700 },
        });
      }
      // The same slots must stay reserved after publication, while pages are still opening.
      const duringLaunch = yield* open().pipe(Effect.result, Effect.forkScoped);
      const rejectedPopup = makeContext();
      contexts[0]!.page.emit("popup", rejectedPopup.page);
      yield* broker.invoke({ scope, tabId, operation: "status", input: {} });
      launchGate.resolve();

      expect((yield* Fiber.join(first))._tag).toBe("Success");
      expect((yield* Fiber.join(last))._tag).toBe("Success");
      for (const fiber of [overflow, duringLaunch]) {
        expect(yield* Fiber.join(fiber)).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "PreviewAutomationControlInterruptedError", reason: "tabLimit" },
        });
      }
      yield* Effect.promise(() => resized.promise);
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      for (const session of sessions)
        yield* browser.attachViewer(viewerInput(session.tabId, false));
      expect(sessions).toHaveLength(limit);
      expect(popup.page.isClosed()).toBe(false);
      expect(rejectedPopup.page.isClosed()).toBe(true);
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.tabs).toHaveLength(limit);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("failed session and browser launches release capacity, as does closing a tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const open = broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      for (let count = 1; count < 7; count++) yield* open;
      const failSession = vi
        .spyOn(manager, "open")
        .mockImplementationOnce(() => Effect.die(new Error("session creation failed")));
      yield* Effect.addFinalizer(() => Effect.sync(() => failSession.mockRestore()));
      expect(yield* open.pipe(Effect.result)).toMatchObject({ _tag: "Failure" });
      failSession.mockRestore();
      const events = yield* manager.subscribeEvents;
      contextFailure = new Error("Chromium launch failed");
      expect(yield* open.pipe(Effect.result)).toMatchObject({ _tag: "Failure" });
      let failedSession = yield* PubSub.take(events);
      while (failedSession.type !== "opened") failedSession = yield* PubSub.take(events);
      // A failed launch must not leave a session a viewer can relaunch past the budget.
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toHaveLength(7);
      contextFailure = null;
      expect((yield* open).available).toBe(true);
      expect(yield* open.pipe(Effect.flip)).toMatchObject({ reason: "tabLimit" });
      expect(
        yield* broker
          .invoke<PreviewAutomationStatus>({
            scope,
            tabId: PreviewTabId.make(failedSession.tabId),
            operation: "open",
            input: { show: false },
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "PreviewAutomationTabNotFoundError" });
      const browser = yield* ServerBrowser.ServerBrowser;
      expect(
        yield* browser.attachViewer(viewerInput(failedSession.tabId, false)).pipe(Effect.flip),
      ).toMatchObject({ _tag: "ServerBrowserTabNotFoundError" });
      yield* broker.invoke({ scope, tabId, operation: "close", input: {} });
      expect((yield* open).available).toBe(true);
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "status",
        input: {},
      });
      expect(status.tabs).toHaveLength(8);
    }),
  ).pipe(Effect.provide(layer)),
);
