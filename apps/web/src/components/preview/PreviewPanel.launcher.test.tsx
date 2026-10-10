// @vitest-environment happy-dom
/**
 * Entry point: PreviewPanel, the component ChatView renders for a Browser tab,
 * with the desktop runtime reported (`isPreviewSupportedInRuntime`) and one
 * loaded tab, and the real launcher store (`lib/panelLauncher.ts`). The native
 * browser view exists only in the Electron window: `BrowserSurfaceSlot` is
 * replaced by a recorder of the `visible` it receives, which is what the slot
 * hands to the desktop bridge (`lease.present`).
 *
 * Phase 4 of the Vim keys round 2 cycle:
 * - Criterion 5: while the launcher shows over a browser tab, the browser slot
 *   is not visible, and it is visible again when the launcher closes, by a
 *   row or by Escape.
 * - Criterion 6, guard: a Browser tab offers no entry of its own, so the
 *   panel's pane entry (`enterPanel`) keeps focus on its tab title.
 *
 * Phase 5 review (P1-1): `RightPanelTabs`, the launcher over a Browser tab
 * with two browser profiles. Choosing a profile from the Browser row's
 * chevron opens the tab in that profile and closes the launcher, as every
 * other row does, so the native browser view shows again.
 *
 * Boundaries replaced, as `PreviewView.test.tsx` replaces them: the preview
 * and history stores, the environment, the RPC commands, the desktop bridge,
 * the browser defaults and recording, and the mini player.
 */
import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  INCOGNITO_BROWSER_PROFILE_ID,
  ThreadId,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const recorded = vi.hoisted(() => ({ slotVisible: [] as boolean[] }));

const STUB_BROWSER_DEFAULTS = {
  viewport: FILL_PREVIEW_VIEWPORT,
  zoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR,
  appearance: DEFAULT_PREVIEW_APPEARANCE,
  autoShowFloatingPreview: true,
  profiles: BUILT_IN_BROWSER_PROFILES,
  profileId: DEFAULT_BROWSER_PROFILE_ID,
};

vi.mock("~/browser/BrowserSurfaceSlot", () => ({
  BrowserSurfaceSlot: (props: { visible: boolean }) => {
    recorded.slotVisible.push(props.visible);
    return <div data-testid="browser-slot" />;
  },
}));
vi.mock("~/browserHistoryStore", () => ({
  recordVisitForThread: vi.fn(),
  setTitleForThreadUrl: vi.fn(),
  removeUrlForThread: vi.fn(),
  BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT: 50,
  useThreadRecentHistory: () => [],
}));
vi.mock("~/browser/browserDefaults", () => ({
  useBrowserDefaults: () => STUB_BROWSER_DEFAULTS,
  getBrowserDefaults: () => STUB_BROWSER_DEFAULTS,
  browserDefaultOpenViewport: () => FILL_PREVIEW_VIEWPORT,
  browserDefaultOpenProfileId: () => DEFAULT_BROWSER_PROFILE_ID,
  browserDefaultTabState: () => ({
    zoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR,
    colorScheme: DEFAULT_PREVIEW_APPEARANCE,
  }),
  browserResponsiveViewportForToggle: () => FILL_PREVIEW_VIEWPORT,
}));
vi.mock("~/previewStateStore", () => ({
  isPreviewSupportedInRuntime: () => true,
  rememberPreviewUrl: vi.fn(),
  updatePreviewServerSnapshot: vi.fn(),
  useThreadPreviewState: () => ({
    activeTabId: "tab-1",
    serverEpoch: null,
    desktopByTabId: {},
    recentlySeenUrls: [],
    sessions: {
      "tab-1": {
        threadId: "thread-1",
        tabId: "tab-1",
        navStatus: { _tag: "Success", url: "http://example.com/", title: "Example" },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-10-08T12:00:00.000Z",
      },
    },
  }),
}));
vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({ label: "Fence" }),
  useEnvironmentHttpBaseUrl: () => "http://fence.invalid:3773",
}));
vi.mock("~/state/preview", () => ({ previewEnvironment: { open: {}, resize: {} } }));
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
vi.mock("./AgentBrowserCursor", () => ({ AgentBrowserCursor: () => null }));

import { closePanelLauncher, dismissPanelLauncher, openPanelLauncher } from "~/lib/panelLauncher";
import { ACTIVE_TAB_TITLE_SELECTOR, enterPanel } from "~/lib/panelSurfaceFocus";
import { RightPanelTabs } from "../RightPanelTabs";
import { PreviewPanel } from "./PreviewPanel";

const THREAD_REF = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
} as const;

let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  recorded.slotVisible.length = 0;
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    () => ({ length: 1 }) as DOMRectList,
  );
});

afterEach(() => {
  act(() => closePanelLauncher());
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Mounts a panel whose active tab is a Browser tab, as `RightPanelTabs` lays one out. */
function mountBrowserTab(): void {
  document.body.innerHTML = `
    <div data-preview-panel-mode="inline">
      <div data-right-panel-tabbar>
        <div data-active-tab="true"><button data-testid="browser-title">Example</button></div>
      </div>
      <div data-right-panel-surface-content data-testid="surface"></div>
    </div>`;
  root = createRoot(document.querySelector('[data-testid="surface"]')!);
  act(() => root!.render(<PreviewPanel mode="embedded" threadRef={THREAD_REF} visible />));
}

const lastSlotVisible = () => recorded.slotVisible.at(-1);

describe("browser slot under the panel launcher", () => {
  it("browser launcher spec: the slot is not visible while the launcher shows, and visible after a row closes it", () => {
    mountBrowserTab();
    expect(lastSlotVisible()).toBe(true);

    act(() => openPanelLauncher());
    expect(lastSlotVisible()).toBe(false);

    act(() => closePanelLauncher());
    expect(lastSlotVisible()).toBe(true);
  });

  it("browser launcher spec: the slot is visible again after Escape dismisses the launcher", () => {
    mountBrowserTab();
    act(() => openPanelLauncher());
    expect(lastSlotVisible()).toBe(false);

    act(() => dismissPanelLauncher());
    expect(lastSlotVisible()).toBe(true);
  });

  it("browser launcher guard: a hidden panel keeps the slot hidden with the launcher closed", () => {
    document.body.innerHTML = `<div data-testid="surface"></div>`;
    root = createRoot(document.querySelector('[data-testid="surface"]')!);
    act(() =>
      root!.render(<PreviewPanel mode="embedded" threadRef={THREAD_REF} visible={false} />),
    );
    expect(lastSlotVisible()).toBe(false);
  });
});

describe("browser tab focus", () => {
  it("browser launcher guard: entering the panel on a Browser tab keeps focus on its tab title", () => {
    mountBrowserTab();
    expect(enterPanel()).toBe(true);
    const title = document.querySelector(ACTIVE_TAB_TITLE_SELECTOR);
    expect(title).not.toBeNull();
    expect(document.activeElement).toBe(title);
  });
});

describe("browser profile choice in the panel launcher", () => {
  it("browser launcher spec: choosing a profile from the open launcher opens it there and closes the launcher", async () => {
    const opened: string[] = [];
    document.body.innerHTML = `<div data-preview-panel-mode="inline" data-testid="panel"></div>`;
    root = createRoot(document.querySelector('[data-testid="panel"]')!);
    act(() =>
      root!.render(
        <RightPanelTabs
          mode="inline"
          surfaces={[{ id: "browser:tab-1", kind: "preview", resourceId: "tab-1" }]}
          environmentId={null}
          activeSurfaceId="browser:tab-1"
          pendingSurfaceIds={new Set()}
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
          onAddBrowserInProfile={(profileId) => opened.push(profileId)}
          onAddTerminal={() => undefined}
          onAddPullRequest={() => undefined}
          onAddPullRequests={() => undefined}
          onAddDiff={() => undefined}
          onAddFiles={() => undefined}
          onAddAgents={() => undefined}
          onAddDevice={() => undefined}
          liveAgentCount={0}
          browserAvailable
          terminalAvailable={false}
          diffAvailable={false}
          filesAvailable={false}
          pullRequestAvailable={false}
          pullRequestsAvailable={false}
          agentsAvailable={false}
          deviceAvailable={false}
        >
          <div>content</div>
        </RightPanelTabs>,
      ),
    );
    const launcher = () => document.querySelector('[aria-label="Open a surface"]');
    act(() => openPanelLauncher());
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
