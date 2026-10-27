import { act, render as renderBrowser, type Screen } from "../../../test/render";
/**
 * `PreviewPanel` for a loaded Browser tab on the desktop runtime, with the real launcher store and
 * `BrowserSurfaceSlot` replaced by a recorder of the `visible` it hands the desktop bridge. While
 * the launcher shows over a browser tab the native view is hidden, and choosing a profile from the
 * Browser row's chevron closes the launcher so the view shows again.
 */
import {
  AuthPreviewOperateScope,
  AuthOrchestrationOperateScope,
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  INCOGNITO_BROWSER_PROFILE_ID,
  ThreadId,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import type { ThreadPreviewState } from "~/previewStateStore";

import { describe, expect, it, vi } from "vite-plus/test";

const recorded = vi.hoisted(() => ({ slotVisible: [] as boolean[] }));

const STUB_BROWSER_DEFAULTS = {
  viewport: FILL_PREVIEW_VIEWPORT,
  zoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR,
  appearance: DEFAULT_PREVIEW_APPEARANCE,
  autoShowFloatingPreview: true,
  profiles: BUILT_IN_BROWSER_PROFILES,
  profileId: DEFAULT_BROWSER_PROFILE_ID,
};
const STUB_BROWSER_SNAPSHOT = {
  threadId: "thread-1",
  tabId: "tab-1",
  runtime: "desktop",
  navStatus: { _tag: "Success", url: "http://example.com/", title: "Example" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-10-08T12:00:00.000Z",
} satisfies PreviewSessionSnapshot;
const STUB_PREVIEW_STATE = {
  snapshot: STUB_BROWSER_SNAPSHOT,
  activeTabId: STUB_BROWSER_SNAPSHOT.tabId,
  serverEpoch: null,
  serverRevision: 0,
  listLoaded: true,
  suppressedTabIds: new Set<string>(),
  desktopOverlay: null,
  desktopByTabId: {},
  recentlySeenUrls: [],
  sessions: { [STUB_BROWSER_SNAPSHOT.tabId]: STUB_BROWSER_SNAPSHOT },
} satisfies ThreadPreviewState;

vi.mock("~/browser/BrowserSurfaceSlot", () => ({
  BrowserSurfaceSlot: (props: { visible: boolean }) => {
    recorded.slotVisible.push(props.visible);
    return <div data-testid="browser-slot" />;
  },
}));
vi.mock("~/browserHistoryStore", async (original) => ({
  ...(await original<typeof import("~/browserHistoryStore")>()),
  recordVisitForThread: vi.fn(),
  setTitleForThreadUrl: vi.fn(),
  removeUrlForThread: vi.fn(),
  BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT: 50,
  useThreadRecentHistory: () => [],
}));
vi.mock("~/browser/browserDefaults", async (original) => ({
  ...(await original<typeof import("~/browser/browserDefaults")>()),
  useBrowserDefaults: () => STUB_BROWSER_DEFAULTS,
  getBrowserDefaults: () => STUB_BROWSER_DEFAULTS,
  resolveBrowserDefaults: async () => STUB_BROWSER_DEFAULTS,
  browserDefaultOpenViewport: () => FILL_PREVIEW_VIEWPORT,
  browserDefaultOpenProfileId: () => DEFAULT_BROWSER_PROFILE_ID,
  browserDefaultTabState: () => ({
    zoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR,
    colorScheme: DEFAULT_PREVIEW_APPEARANCE,
  }),
  browserResponsiveViewportForToggle: () => FILL_PREVIEW_VIEWPORT,
}));
vi.mock("~/previewStateStore", async (original) => ({
  ...(await original<typeof import("~/previewStateStore")>()),
  isPreviewSupportedInRuntime: () => true,
  rememberPreviewUrl: vi.fn(),
  updatePreviewServerSnapshot: vi.fn(),
  useThreadPreviewState: () => STUB_PREVIEW_STATE,
}));
vi.mock("@t3tools/client-runtime/state/session", async (original) =>
  (await import("../../test/appRootFenceMocks")).mockRuntimeSession(original),
);
vi.mock("~/connection/runtime", async () =>
  (await import("../../test/appRootFenceMocks")).mockConnectionRuntime(),
);
vi.mock("~/state/environments", async (original) => ({
  ...(await original<typeof import("~/state/environments")>()),
  useEnvironment: () => ({ label: "Fence" }),
  useEnvironmentHttpBaseUrl: () => "http://fence.invalid:3773",
  usePrimaryEnvironmentId: () => THREAD_REF.environmentId,
}));
vi.mock("~/state/entities", async (original) => ({
  ...(await original<typeof import("~/state/entities")>()),
  useEnvironmentSupportsServerBrowser: () => false,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/browser/browserRecording", () => ({
  findActiveBrowserRecordingRuntimeTabId: vi.fn(() => null),
  isBrowserRecordingStartCancelledError: vi.fn(() => false),
  startBrowserRecording: vi.fn(),
  stopBrowserRecording: vi.fn(),
  useActiveBrowserRecordingTabIds: () => new Set(),
}));
vi.mock("~/browser/browserSurfaceStore", () => ({
  useBrowserSurfaceStore: (select: (state: { byTabId: Record<string, unknown> }) => unknown) =>
    select({ byTabId: {} }),
}));
vi.mock("~/previewMiniPlayerStore", () => ({
  browserMiniPlayerSource: (tabId: string) => ({ kind: "browser", tabId }),
  selectThreadPreviewMiniPlayerTabId: () => null,
  usePreviewMiniPlayerStore: Object.assign(
    (select: (state: unknown) => unknown) => select({ byThreadKey: {} }),
    { getState: () => ({ open: vi.fn(), close: vi.fn() }) },
  ),
}));
vi.mock("./previewBridge", () => ({
  previewBridge: {
    navigate: vi.fn(async () => undefined),
    pickElement: vi.fn(),
    pictureInPicture: { open: vi.fn(async () => undefined), close: vi.fn(async () => undefined) },
  },
}));
vi.mock("./usePreviewSession", () => ({ usePreviewSession: vi.fn() }));
vi.mock("./AgentBrowserCursor", async (original) => ({
  ...(await original<typeof import("./AgentBrowserCursor")>()),
  AgentBrowserCursor: () => null,
}));

import { appRootFence, makeFenceSession } from "../../test/appRootFenceMocks";

import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { closePanelLauncher, dismissPanelLauncher, openPanelLauncher } from "~/lib/panelLauncher";
import { ACTIVE_TAB_TITLE_SELECTOR, enterPanel } from "~/lib/panelSurfaceFocus";

const { PreviewPanel } = await import("./PreviewPanel");
const { RightPanelTabs } = await import("../RightPanelTabs");

const THREAD_REF = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
} as const;

let root: Screen | undefined;

async function setupBrowserFixture0() {
  appRootFence.sessions.set(
    THREAD_REF.environmentId,
    makeFenceSession([AuthPreviewOperateScope, AuthOrchestrationOperateScope]),
  );

  recorded.slotVisible.length = 0;
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    () => ({ length: 1 }) as DOMRectList,
  );

  return {
    async [Symbol.asyncDispose]() {
      await act(() => closePanelLauncher());
      await root?.[Symbol.asyncDispose]();
      root = undefined;
      document.body.innerHTML = "";
      appRootFence.sessions.delete(THREAD_REF.environmentId);
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    },
  };
}

/** Mounts a panel whose active tab is a Browser tab, as `RightPanelTabs` lays one out. */
async function mountBrowserTab(): Promise<void> {
  document.body.innerHTML = `
    <div data-preview-panel-mode="inline">
      <div data-right-panel-tabbar>
        <div data-active-tab="true"><button data-testid="browser-title">Example</button></div>
      </div>
      <div data-right-panel-surface-content data-testid="surface"></div>
    </div>`;
  root = await renderBrowser(null, {
    container: document.querySelector('[data-testid="surface"]')!,
    router: false,
  });
  await act(
    async () =>
      await root!.rerender(<PreviewPanel mode="embedded" threadRef={THREAD_REF} visible />),
  );
}

const lastSlotVisible = () => recorded.slotVisible.at(-1);

describe("browser slot under the panel launcher", () => {
  it("browser launcher spec: the slot is not visible while the launcher shows, and visible after a row closes it", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountBrowserTab();
    expect(lastSlotVisible()).toBe(true);

    await act(() => openPanelLauncher());
    expect(lastSlotVisible()).toBe(false);

    await act(() => closePanelLauncher());
    expect(lastSlotVisible()).toBe(true);
  });

  it("browser launcher spec: the slot is visible again after Escape dismisses the launcher", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountBrowserTab();
    await act(() => openPanelLauncher());
    expect(lastSlotVisible()).toBe(false);

    await act(() => dismissPanelLauncher());
    expect(lastSlotVisible()).toBe(true);
  });

  it("browser launcher guard: a hidden panel keeps the slot hidden with the launcher closed", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    document.body.innerHTML = `<div data-testid="surface"></div>`;
    root = await renderBrowser(null, {
      container: document.querySelector('[data-testid="surface"]')!,
      router: false,
    });
    await act(
      async () =>
        await root!.rerender(
          <PreviewPanel mode="embedded" threadRef={THREAD_REF} visible={false} />,
        ),
    );
    expect(lastSlotVisible()).toBe(false);
  });
});

describe("browser tab focus", () => {
  it("browser launcher guard: entering the panel on a Browser tab keeps focus on its tab title", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountBrowserTab();
    expect(enterPanel()).toBe(true);
    const title = document.querySelector(ACTIVE_TAB_TITLE_SELECTOR);
    expect(title).not.toBeNull();
    expect(document.activeElement).toBe(title);
  });
});

async function renderBrowserPanel(
  onAddBrowserInProfile: (profileId: string) => void = () => undefined,
): Promise<void> {
  await act(
    async () =>
      await root!.rerender(
        <RightPanelTabs
          mode="inline"
          keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
          getShortcutContext={() => ({
            terminalFocus: false,
            terminalOpen: false,
            previewFocus: false,
            previewOpen: false,
            isWeb: false,
            isDesktop: true,
          })}
          surfaces={[{ id: "browser:tab-1", kind: "preview", resourceId: "tab-1" }]}
          environmentId={null}
          activeSurfaceId="browser:tab-1"
          pendingProjectKey={null}
          previewSessions={{}}
          desktopByTabId={{}}
          terminalLabelsById={new Map()}
          onActivate={() => undefined}
          onCloseSurface={() => undefined}
          onCloseOtherSurfaces={() => undefined}
          onCloseSurfacesToRight={() => undefined}
          onCloseAllSurfaces={() => undefined}
          onCopyFilePath={() => undefined}
          onAddBrowser={() => undefined}
          onAddBrowserInProfile={onAddBrowserInProfile}
          onAddTerminal={() => undefined}
          onAddPullRequest={() => undefined}
          onAddPullRequests={() => undefined}
          onAddDiff={() => undefined}
          onAddFiles={() => undefined}
          onAddDevice={() => undefined}
          browserAvailable
          terminalAvailable={false}
          diffAvailable={false}
          filesAvailable={false}
          pullRequestAvailable={false}
          pullRequestsAvailable={false}
          deviceAvailable={false}
        >
          <PreviewPanel mode="embedded" threadRef={THREAD_REF} visible />
        </RightPanelTabs>,
      ),
  );
}

describe("browser profile choice in the panel launcher", () => {
  it("browser launcher spec: choosing a profile from the open launcher opens it there and closes the launcher", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const opened: string[] = [];
    document.body.innerHTML = `<div data-preview-panel-mode="inline" data-testid="panel"></div>`;
    root = await renderBrowser(null, {
      container: document.querySelector('[data-testid="panel"]')!,
      router: false,
    });
    await renderBrowserPanel((profileId) => opened.push(profileId));
    const launcher = () => document.querySelector('[aria-label="Open a surface"]');
    await act(() => openPanelLauncher());
    expect(launcher()).not.toBeNull();

    const chevron = document.querySelector<HTMLElement>('[aria-label="Open browser in a profile"]');
    expect(chevron).not.toBeNull();
    await act(async () => {
      chevron!.click();
    });
    const incognito = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === "Incognito",
    );
    expect(incognito).toBeDefined();
    await act(async () => {
      incognito!.click();
    });

    expect(opened).toEqual([INCOGNITO_BROWSER_PROFILE_ID]);
    expect(launcher()).toBeNull();
  });
});

describe("browser panel launcher route disposal", () => {
  it("browser launcher P1-2: route unmount clears the overlay so a fresh Browser panel restores its native slot", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    document.body.innerHTML = '<div data-testid="panel"></div>';
    root = await renderBrowser(null, {
      container: document.querySelector('[data-testid="panel"]')!,
      router: false,
    });
    await renderBrowserPanel();
    expect(lastSlotVisible()).toBe(true);
    await act(() => openPanelLauncher());
    expect(lastSlotVisible()).toBe(false);
    expect(document.querySelector('[aria-label="Open a surface"]')).not.toBeNull();
    await act(async () => await root!.rerender(null));
    await renderBrowserPanel();
    expect(document.querySelector('[aria-label="Open a surface"]')).toBeNull();
    expect(lastSlotVisible()).toBe(true);
  });
});
