// Entry points: the public useOpenLink button and mounted production PreviewView.
// Actual atoms, registry, Surface and stream client run in Chromium. IPC,
// sockets, resize delivery and unrelated chrome are controlled boundaries.
import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
  type DesktopPreviewTabState,
} from "@t3tools/contracts";
import { StrictMode, type ReactNode } from "react";
import { act, render, fakeTimers, type Screen } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";

const streamAccess = vi.hoisted(() => ({
  httpBase: "https://fixture.invalid/api/preview-stream",
  wsBase: "wss://fixture.invalid/api/preview-stream",
  query: {},
  credentials: true,
}));
const boundary = vi.hoisted(() => ({
  native: true,
  streamAccess: false,
  surfaceWidth: 800,
  allocate: vi.fn(),
  external: vi.fn(),
  visit: vi.fn(),
  navigate: vi.fn(async (_id: string, _url: string) => {}),
  listeners: new Set<(id: string, state: DesktopPreviewTabState) => void>(),
  history: [] as never[],
  recording: new Set<string>(),
}));
vi.mock("~/assets/assetUrls", () => ({ resolveAssetUrl: vi.fn() }));
vi.mock("~/localApi", () => ({
  ensureLocalApi: () => null,
  readLocalApi: () => ({ shell: { openExternal: boundary.external } }),
}));
vi.mock("~/hooks/useSettings", async () => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts/settings");
  return {
    ensureClientSettingsHydrated: async () => {},
    getClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  };
});
vi.mock("~/state/server", async () => ({
  environmentServerConfigsAtom: (await import("~/test/threadLinkFixture")).threadLinkFixture
    .configs,
}));
vi.mock("~/connection/catalog", async () => {
  const f = (await import("~/test/threadLinkFixture")).threadLinkFixture;
  return { environmentCatalog: { catalogValueAtom: f.catalog, stateAtom: f.connection } };
});
vi.mock("~/state/session", async () => {
  const f = (await import("~/test/threadLinkFixture")).threadLinkFixture;
  const { appAtomRegistry } = await import("~/rpc/atomRegistry");
  const Option = await import("effect/Option");
  return {
    environmentSession: { preparedConnectionValueAtom: f.prepared },
    readPreparedConnection: (id: EnvironmentId) =>
      Option.getOrNull(appAtomRegistry.get(f.prepared(id))),
    readEnvironmentScope: () => true,
    useEnvironmentScope: () => true,
  };
});
vi.mock("~/state/entities", () => ({ useEnvironmentSupportsServerBrowser: () => true }));
vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({ label: "Fixture" }),
  useEnvironmentHttpBaseUrl: () => "https://fixture.invalid",
  usePrimaryEnvironmentId: () => EnvironmentId.make("view-lease-env"),
}));
vi.mock("~/state/preview", async () => ({
  previewEnvironment: {
    open: {},
    close: {},
    resize: {},
    adjust: {},
    openLinkTarget: {
      permissionAtom: (await import("~/test/threadLinkFixture")).threadLinkFixture.permission,
    },
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command !== null && typeof command === "object" && "permissionAtom" in command
      ? boundary.allocate
      : vi.fn(),
}));
vi.mock("~/state/previewStream", () => ({
  usePreviewStreamAccess: () => (boundary.streamAccess ? streamAccess : null),
  refreshPreviewStreamAccess: vi.fn(),
}));
vi.mock("~/browser/previewRuntime", () => ({
  useRendersServerTabNatively: () => boundary.native,
  alternatePreviewRuntime: () => null,
  isPreviewAvailableFor: () => true,
  previewRuntimeFor: () => "server",
}));
vi.mock("~/browser/browserDefaults", () => ({
  useBrowserDefaults: () => ({
    viewport: FILL_PREVIEW_VIEWPORT,
    zoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR,
    appearance: DEFAULT_PREVIEW_APPEARANCE,
    autoShowFloatingPreview: true,
    profiles: BUILT_IN_BROWSER_PROFILES,
    profileId: DEFAULT_BROWSER_PROFILE_ID,
  }),
  resolveBrowserDefaults: async () => ({
    profileId: DEFAULT_BROWSER_PROFILE_ID,
    viewport: FILL_PREVIEW_VIEWPORT,
  }),
  browserDefaultOpenProfileId: () => DEFAULT_BROWSER_PROFILE_ID,
  browserDefaultOpenViewport: () => FILL_PREVIEW_VIEWPORT,
  browserResponsiveViewportForToggle: vi.fn(),
}));
vi.mock("~/browserHistoryStore", () => ({
  BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT: 50,
  useThreadRecentHistory: () => boundary.history,
  recordVisitForThread: boundary.visit,
  removeUrlForThread: vi.fn(),
  setTitleForThreadUrl: vi.fn(),
}));
vi.mock("~/browser/browserRecording", () => ({
  findActiveBrowserRecordingRuntimeTabId: () => null,
  useActiveBrowserRecordingTabIds: () => boundary.recording,
  isBrowserRecordingStartCancelledError: () => false,
  startBrowserRecording: vi.fn(),
  stopBrowserRecording: vi.fn(),
}));
vi.mock("./usePreviewSession", () => ({ usePreviewSession: () => {} }));
vi.mock("./PreviewChromeRow", () => ({ PreviewChromeRow: () => null }));
vi.mock("./PreviewEmptyState", () => ({ PreviewEmptyState: () => <div>Ready for a URL</div> }));
vi.mock("./PreviewMoreMenu", () => ({ PreviewMoreMenu: () => null }));
vi.mock("~/browser/BrowserSurfaceSlot", () => ({ BrowserSurfaceSlot: () => null }));
vi.mock("./previewBridge", () => ({
  previewBridge: {
    navigate: boundary.navigate,
    onStateChange: (listener: (id: string, state: DesktopPreviewTabState) => void) => {
      boundary.listeners.add(listener);
      return () => boundary.listeners.delete(listener);
    },
  },
}));

import { AsyncResult } from "effect/reactivity";
import { useOpenLink } from "~/browser/useOpenLink";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import {
  applyPreviewDesktopState,
  applyPreviewServerEvent,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
  resetPreviewStateForTests,
} from "~/previewStateStore";
import {
  linkEnvelope,
  installThreadLinkEnvironment,
  ThreadLinkTestSocket,
} from "~/test/threadLinkFixture";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { navigateThreadLink, ThreadLinkCancelled } from "~/browser/threadLinkNavigation";
import { PreviewView } from "./PreviewView";

const ref = {
  environmentId: EnvironmentId.make("view-lease-env"),
  threadId: ThreadId.make("view-lease-thread"),
};
const target = { threadRef: ref, serverEpoch: "epoch-1", tabId: "shared-target" };
const runtimeId = previewRuntimeTabId(ref, target.serverEpoch, target.tabId);
const url = "https://example.com/first-load";
const desktop: DesktopPreviewTabState = {
  tabId: target.tabId,
  webContentsId: 42,
  navStatus: { kind: "Loading", url, title: "" },
  canGoBack: false,
  canGoForward: false,
  zoomFactor: 1,
  pictureInPicture: false,
  colorScheme: "system",
  audioMuted: false,
  audible: false,
  controller: "none",
  updatedAt: "2026-10-12T00:00:01Z",
};
let root: Screen | undefined;
let container: HTMLDivElement;
let owner: AbortController;
let publicOpening: Promise<void> | undefined;
async function createPreviewFixture() {
  await using resources = new AsyncDisposableStack();
  resources.defer(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  boundary.native = true;
  boundary.streamAccess = false;
  boundary.surfaceWidth = 800;
  publicOpening = undefined;
  ThreadLinkTestSocket.instances = [];
  boundary.allocate.mockReset().mockResolvedValue(AsyncResult.success(linkEnvelope(ref)));
  boundary.external.mockReset().mockResolvedValue(undefined);
  boundary.visit.mockReset();
  useRightPanelStore.setState({
    byThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
    pendingMaximizeThreadKey: null,
  });
  installThreadLinkEnvironment(ref);
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  resetPreviewStateForTests();
  reconcilePreviewServerSessions(ref, linkEnvelope(ref));
  boundary.navigate.mockReset().mockResolvedValue(undefined);
  boundary.listeners.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = undefined;
  owner = new AbortController();
  resources.defer(async () => {
    owner.abort();
    try {
      await root?.[Symbol.asyncDispose]();
      root = undefined;
      await publicOpening;
    } finally {
      root = undefined;
      container.remove();
    }
  });
  return resources.move();
}
async function renderView(ui: ReactNode) {
  if (root) await root.rerender(ui);
  else root = await render(ui, { container, router: false });
}
async function mount() {
  await renderView(
    <AppAtomRegistryProvider>
      <PreviewView threadRef={ref} tabId={target.tabId} visible />
    </AppAtomRegistryProvider>,
  );
}

it("thread link PreviewView fence: mounted Idle waits for its native lease and accepts only fresh exact-tab navigation", async () => {
  await using _fixture = await createPreviewFixture();
  await mount();
  expect(container.textContent).toContain("Ready for a URL");
  let accepted = false;
  const opening = navigateThreadLink(target, url, owner.signal).then(() => {
    accepted = true;
  });
  // The assertion can fail before the await. Teardown still aborts the waiter
  // without creating an unrelated unhandled rejection; the await keeps errors.
  void opening.catch(() => {});
  expect(boundary.navigate).not.toHaveBeenCalled();
  await act(() => {
    applyPreviewDesktopState(ref, target.tabId, {
      ...desktop,
      hasWebContents: true,
      loading: true,
      favicon: null,
    });
  });
  expect(boundary.navigate).toHaveBeenCalledExactlyOnceWith(runtimeId, url);
  expect(accepted).toBe(false);
  for (const listener of boundary.listeners) listener("unrelated-runtime", desktop);
  expect(accepted).toBe(false);
  for (const listener of boundary.listeners) listener(runtimeId, desktop);
  await opening;
  expect(accepted).toBe(true);
  const repeat = navigateThreadLink(target, url, owner.signal);
  expect(boundary.navigate).toHaveBeenCalledTimes(2);
  for (const listener of boundary.listeners) listener(runtimeId, desktop);
  await repeat;
});

it("thread link PreviewView guard: unmount disposes an Idle attachment waiter without navigation", async () => {
  await using _fixture = await createPreviewFixture();
  await mount();
  const opening = navigateThreadLink(target, url, owner.signal);
  const cancelled = expect(opening).rejects.toBeInstanceOf(ThreadLinkCancelled);
  await root?.unmount();
  await cancelled;
  applyPreviewDesktopState(ref, target.tabId, {
    ...desktop,
    hasWebContents: true,
    loading: true,
    favicon: null,
  });
  expect(boundary.navigate).not.toHaveBeenCalled();
  expect(boundary.listeners.size).toBe(0);
});

it("thread link PreviewView guard: streamed Idle keeps the real Surface mounted and disposes its unready lease", async () => {
  await using _fixture = await createPreviewFixture();
  boundary.native = false;
  await mount();
  expect(container.textContent).toContain("Ready for a URL");
  expect(container.querySelector("canvas")).not.toBeNull();
  const opening = navigateThreadLink(target, url, owner.signal);
  const cancelled = expect(opening).rejects.toBeInstanceOf(ThreadLinkCancelled);
  expect(boundary.navigate).not.toHaveBeenCalled();
  await root?.unmount();
  await cancelled;
  expect(boundary.navigate).not.toHaveBeenCalled();
});

function PublicLinkEntry() {
  const open = useOpenLink(ref);
  const visible = useRightPanelStore(
    (state) => selectThreadRightPanelState(state.byThreadKey, ref).isOpen,
  );
  return (
    <>
      <button
        onClick={() => {
          publicOpening = open(url, { explicitApp: true });
          void publicOpening.catch(() => {});
        }}
      >
        Open integrated link
      </button>
      {visible ? <PreviewView threadRef={ref} tabId={target.tabId} visible /> : null}
    </>
  );
}
async function activateStrictLink() {
  await renderView(
    <StrictMode>
      <AppAtomRegistryProvider>
        <PublicLinkEntry />
      </AppAtomRegistryProvider>
    </StrictMode>,
  );
  await act(() => container.querySelector("button")!.click());
  expect(boundary.allocate).toHaveBeenCalledOnce();
  expect(boundary.external).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Ready for a URL");
}
function freshLoading() {
  const state = readThreadPreviewState(ref);
  applyPreviewServerEvent(ref, {
    type: "navigated",
    threadId: ref.threadId,
    tabId: target.tabId,
    createdAt: "2026-10-12T00:00:02Z",
    serverEpoch: target.serverEpoch,
    revision: state.serverRevision + 1,
    snapshot: {
      ...state.sessions[target.tabId]!,
      updatedAt: "2026-10-12T00:00:02Z",
      navStatus: { _tag: "Loading", url, title: "" },
    },
  });
}
it("thread link StrictMode regression: public first activation survives the actual Idle PreviewView effect replay", async () => {
  await using _fixture = await createPreviewFixture();
  await activateStrictLink();
  expect(boundary.navigate).not.toHaveBeenCalled();
  await act(() =>
    applyPreviewDesktopState(ref, target.tabId, {
      ...desktop,
      hasWebContents: true,
      loading: false,
      favicon: null,
    }),
  );
  expect(boundary.navigate).toHaveBeenCalledExactlyOnceWith(runtimeId, url);
  expect(boundary.visit).not.toHaveBeenCalled();
  await act(async () => {
    for (const listener of boundary.listeners) listener(runtimeId, desktop);
    await publicOpening;
  });
  expect(boundary.visit).toHaveBeenCalledExactlyOnceWith(ref, url);
  expect(boundary.external).not.toHaveBeenCalled();
});

// Controlled resize delivery selects the measured sizes and cap-reconnect
// milestones. The actual observeResize batching and Surface effects run intact.
class SurfaceResizeObserver implements ResizeObserver {
  static instances = new Set<SurfaceResizeObserver>();
  readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    SurfaceResizeObserver.instances.add(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    SurfaceResizeObserver.instances.delete(this);
  }
  static deliver() {
    for (const observer of SurfaceResizeObserver.instances) {
      observer.callback(
        [...observer.targets].map((target) => ({
          target,
          contentRect: target.getBoundingClientRect(),
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        })),
        observer,
      );
    }
  }
}
async function activateStreamLink() {
  boundary.native = false;
  boundary.streamAccess = true;
  vi.stubGlobal("WebSocket", ThreadLinkTestSocket);
  vi.stubGlobal("ResizeObserver", SurfaceResizeObserver);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, boundary.surfaceWidth, 600),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  await activateStrictLink();
  await act(async () => {
    SurfaceResizeObserver.deliver();
    // Execute the production zero-delay first measure/cap timers. Fake timers
    // place a nested zero-delay timer at the next millisecond.
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(container.querySelector("canvas")).not.toBeNull();
  expect(ThreadLinkTestSocket.instances).toHaveLength(1);
  const socket = ThreadLinkTestSocket.current;
  await act(() => socket.dispatchEvent(new Event("open")));
  return socket;
}
const navigations = (socket: ThreadLinkTestSocket) =>
  socket.sent.map((value) => JSON.parse(value)).filter((input) => input.type === "navigate");
async function growSurface() {
  boundary.surfaceWidth = 1200;
  await act(async () => {
    SurfaceResizeObserver.deliver();
    // Production schedules measure after 150 ms, then cap growth after 300 ms.
    // Advance those exact timers, not an invented readiness delay.
    await vi.advanceTimersByTimeAsync(450);
  });
  expect(ThreadLinkTestSocket.instances).toHaveLength(2);
  return ThreadLinkTestSocket.current;
}
async function grantStream(socket: ThreadLinkTestSocket) {
  await act(() =>
    socket.control({ canOperate: true, controller: "you", generation: 1, dialog: null }),
  );
}
it("thread link Surface regression: planned cap growth before first grant preserves the public StrictMode link", async () => {
  using _timers = fakeTimers();
  await using _fixture = await createPreviewFixture();
  const first = await activateStreamLink();
  expect(navigations(first)).toEqual([]);
  const replacement = await growSurface();
  expect(first.readyState).toBe(3);
  expect(replacement).not.toBe(first);
  await act(() => replacement.dispatchEvent(new Event("open")));
  await grantStream(replacement);
  expect(navigations(first)).toEqual([]);
  expect(navigations(replacement)).toEqual([{ type: "navigate", url }]);
  expect(boundary.visit).not.toHaveBeenCalled();
  await act(async () => {
    freshLoading();
    await publicOpening;
  });
  expect(boundary.visit).toHaveBeenCalledExactlyOnceWith(ref, url);
  expect(boundary.external).not.toHaveBeenCalled();
});
it("thread link Surface guard: real socket loss before grant remains sticky across automatic reconnect", async () => {
  using _timers = fakeTimers();
  await using _fixture = await createPreviewFixture();
  const first = await activateStreamLink();
  let completed = false;
  const opening = publicOpening!.then(() => {
    completed = true;
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(completed).toBe(false);
  await act(() =>
    first.dispatchEvent(Object.assign(new Event("close"), { code: 1000, reason: "" })),
  );
  await opening;
  expect(completed).toBe(true);
  // The real stream client reconnects after its existing first retry interval.
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(ThreadLinkTestSocket.instances).toHaveLength(2);
  const replacement = ThreadLinkTestSocket.current;
  await act(() => replacement.dispatchEvent(new Event("open")));
  await grantStream(replacement);
  await act(() => freshLoading());
  expect(navigations(first)).toEqual([]);
  expect(navigations(replacement)).toEqual([]);
  expect(boundary.visit).not.toHaveBeenCalled();
  expect(boundary.external).not.toHaveBeenCalled();
});
it("thread link Surface guard: cap reconnect after submission cancels before a late Loading can record a visit", async () => {
  using _timers = fakeTimers();
  await using _fixture = await createPreviewFixture();
  const first = await activateStreamLink();
  await grantStream(first);
  expect(navigations(first)).toEqual([{ type: "navigate", url }]);
  expect(boundary.visit).not.toHaveBeenCalled();
  const replacement = await growSurface();
  await publicOpening;
  await act(() => replacement.dispatchEvent(new Event("open")));
  await grantStream(replacement);
  await act(() => freshLoading());
  expect(navigations(first)).toEqual([{ type: "navigate", url }]);
  expect(navigations(replacement)).toEqual([]);
  expect(boundary.visit).not.toHaveBeenCalled();
  expect(boundary.external).not.toHaveBeenCalled();
});
