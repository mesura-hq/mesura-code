// Entry point: AppRoot through renderFenceApp, with the real chat route,
// ChatView, ChatComposer, right-panel stores, controls and accepted-close handlers.
// Shared fixtures replace provider/backend reads and unrelated chrome only.
// Chromium runs the rendered layout, DOM focus and actual editor interactions.
import { type ReactNode } from "react";
import { act, render, fakeTimers, type Screen } from "../test/render";
import { flushBrowserTasks } from "./test/browserTasks";
import { installKeyEngine } from "./keys/keyEngine";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import {
  AuthPreviewOperateScope,
  AuthTerminalOperateScope,
  EnvironmentId,
  ThreadId,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";

const closeBoundary = vi.hoisted(() => ({ close: vi.fn(), browserAvailable: false }));
const fenceMocks = vi.hoisted(() => () => import("./test/appRootFenceMocks"));
vi.mock("./state/presentation", async (original) =>
  (await fenceMocks()).mockPresentation(original),
);
vi.mock("./connection/runtime", async () => (await fenceMocks()).mockConnectionRuntime());
vi.mock("./components/DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("./state/entities", async (original) => ({
  ...(await (await fenceMocks()).mockEntities(original)),
  // Environment capability is an external read. Enable the real PreviewPanel
  // and PreviewView only in the manual Browser ownership cases below.
  useEnvironmentSupportsServerBrowser: (environmentId: EnvironmentId | null) =>
    environmentId !== null && closeBoundary.browserAvailable,
  readEnvironmentSupportsServerBrowser: () => closeBoundary.browserAvailable,
}));
vi.mock("./state/environments", async (original) =>
  (await fenceMocks()).mockEnvironments(original),
);
vi.mock("./state/query", async (original) => (await fenceMocks()).mockQuery(original));
vi.mock("./state/queries", async (original) => (await fenceMocks()).mockQueries(original));
vi.mock("./state/threads", async (original) => (await fenceMocks()).mockThreads(original));
vi.mock("./state/use-atom-command", async () => {
  const original = (await fenceMocks()).mockAtomCommand();
  return {
    ...original,
    useAtomCommand: (command: unknown) =>
      command === previewEnvironment.close ? closeBoundary.close : original.useAtomCommand(),
  };
});
vi.mock("./state/use-atom-query-runner", async () => (await fenceMocks()).mockAtomQueryRunner());
vi.mock("./state/server", async (original) => (await fenceMocks()).mockServer(original));
vi.mock("./hooks/useSettings", async (original) => (await fenceMocks()).mockSettings(original));
vi.mock("./hooks/useHandleNewThread", async () => (await fenceMocks()).mockHandleNewThread());
vi.mock("./hooks/useThreadActions", async () => (await fenceMocks()).mockThreadActions());
vi.mock("./components/Sidebar", async () => (await fenceMocks()).mockSidebar());
vi.mock("./components/LegacySidebar", async () =>
  (await fenceMocks()).mockRendersNothing("default"),
);
vi.mock("./components/preview/PreviewAutomationHosts", async () =>
  (await fenceMocks()).mockRendersNothing("PreviewAutomationHosts"),
);
vi.mock("./browser/ElectronBrowserHost", async () =>
  (await fenceMocks()).mockRendersNothing("ElectronBrowserHost"),
);
vi.mock("./components/QuitHoldOverlay", async () =>
  (await fenceMocks()).mockRendersNothing("QuitHoldOverlay"),
);
vi.mock("./components/chat/ChatHeader", async () =>
  (await fenceMocks()).mockRendersNothing("ChatHeader"),
);
vi.mock("./components/BranchToolbar", async () =>
  (await fenceMocks()).mockRendersNothing("BranchToolbar"),
);
vi.mock("./components/files/mesuraFileManager/MesuraFileManagerLayer", async () =>
  (await fenceMocks()).mockFileManagerLayer(),
);
vi.mock("./keys/highlights", async () => (await fenceMocks()).mockHighlights());
vi.mock("@legendapp/list/react", async () => (await fenceMocks()).mockLegendList());

vi.mock("@t3tools/client-runtime/state/session", async (original) =>
  (await fenceMocks()).mockRuntimeSession(original),
);

vi.mock("./components/preview/usePreviewSession", () => ({ usePreviewSession: () => {} }));
import { addFenceThread, makeMessage, renderFenceApp } from "./test/appRootFenceApp";
import { appRootFence, FENCE_ENVIRONMENT_ID, makeFenceSession } from "./test/appRootFenceMocks";
import { selectThreadRightPanelState, useRightPanelStore } from "./rightPanelStore";
import {
  readThreadPreviewState,
  reconcilePreviewServerSessions,
  resetPreviewStateForTests,
} from "./previewStateStore";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { applyPreviewDesktopState } from "./previewStateStore";
import { ConfirmDialogHost } from "./components/ConfirmDialogHost";
import { previewEnvironment } from "./state/preview";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { createDeferredPromise } from "./test/threadLinkFixture";
import { resetConfirmDialogForTests } from "./confirmDialog";
import type { FenceRouter } from "./test/appRootFenceApp";

const id = ThreadId.make("thread-link-layout-fence");
const ref = scopeThreadRef(EnvironmentId.make(FENCE_ENVIRONMENT_ID), id);
let root: Screen | undefined;
let router: FenceRouter;
let dialogRoot: Screen | undefined;
let dialogContainer: HTMLDivElement;
let container: HTMLDivElement;
let bridgeDescriptor: PropertyDescriptor | undefined;

async function createLayoutFixture() {
  await using resources = new AsyncDisposableStack();
  const previousViewport = { width: window.innerWidth, height: window.innerHeight };
  resources.defer(() => page.viewport(previousViewport.width, previousViewport.height));
  // useMediaQuery reads native matchMedia, so an innerWidth stub still selects the sheet.
  await page.viewport(1440, 900);
  installKeyEngine();
  await import("./components/files/FilePreviewPanel");
  await import("./components/preview/PreviewPanel");
  // Keep router promises, CSS exits and React scheduling on the browser's clock.
  // Only the scheduled composer-focus handoff needs an explicit frame boundary.
  // oxlint-disable-next-line t3code/no-frame-waits-in-browser-tests -- Advance the production focus callback on a controlled clock, without an elapsed-time wait.
  resources.use(fakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] }));
  resources.defer(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (bridgeDescriptor) Object.defineProperty(window, "desktopBridge", bridgeDescriptor);
    else Reflect.deleteProperty(window, "desktopBridge");
  });
  resetConfirmDialogForTests();
  closeBoundary.browserAvailable = false;
  closeBoundary.close.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  bridgeDescriptor = Object.getOwnPropertyDescriptor(window, "desktopBridge");
  addFenceThread(id, "Link layout", [makeMessage("layout-user", "user", "Review the link.")]);
  appRootFence.vimMode = false;
  appRootFence.sessions.set(ref.environmentId, makeFenceSession());
  useRightPanelStore.setState({
    byThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
    pendingMaximizeThreadKey: null,
  });
  resetPreviewStateForTests();
  reconcilePreviewServerSessions(ref, {
    sessions: [
      {
        threadId: id,
        tabId: "layout-target",
        navStatus: { _tag: "Idle" },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-10-12T00:00:00Z",
      },
    ],
    serverEpoch: "layout-epoch",
    revision: 1,
  });
  useRightPanelStore.getState().openBrowser(ref, "layout-target");
  container = document.createElement("div");
  container.style.cssText = "width: 1440px; height: 900px";
  document.body.append(container);
  dialogContainer = document.createElement("div");
  document.body.append(dialogContainer);
  root = undefined;
  dialogRoot = undefined;
  resources.defer(() => {
    container.remove();
    dialogContainer.remove();
  });
  resources.defer(async () => {
    try {
      await dialogRoot?.[Symbol.asyncDispose]();
    } finally {
      dialogRoot = undefined;
    }
  });
  resources.defer(async () => {
    try {
      await root?.[Symbol.asyncDispose]();
    } finally {
      root = undefined;
    }
  });
  return resources.move();
}
const column = () => container.querySelector<HTMLElement>("[data-chat-column-maximized-away]")!;
const maximized = () => column().dataset.chatColumnMaximizedAway === "true";
async function mount() {
  // Publish grants set after addFenceThread to any session atoms retained between mounts.
  await act(() => {
    for (const listener of appRootFence.threadListeners) listener();
  });
  dialogRoot = await render(<ConfirmDialogHost />, { container: dialogContainer, router: false });
  ({ root, router } = await renderFenceApp(container, id, { vimMode: false }));
  await settleFocus();
}
async function clickControl(label: string) {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button, label).not.toBeNull();
  await act(() => button!.click());
}

it("thread link AppRoot fence: a first request and a reused target both maximize the mounted layout B", async () => {
  await using _fixture = await createLayoutFixture();
  useRightPanelStore.getState().requestMaximize(ref);
  await mount();
  expect(maximized()).toBe(true);
  expect(column().classList.contains("w-0")).toBe(true);
  expect(document.querySelector("[data-testid='sidebar-thread-row']")).not.toBeNull();
  await clickControl("Restore panel size");
  expect(maximized()).toBe(false);
  await act(() => {
    useRightPanelStore.getState().requestMaximize(ref);
  });
  expect(maximized()).toBe(true);
  expect(useRightPanelStore.getState().pendingMaximizeThreadKey).toBeNull();
});

function agentOwnsTarget() {
  applyPreviewDesktopState(ref, "layout-target", {
    hasWebContents: true,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1,
    pictureInPicture: false,
    colorScheme: "system",
    audioMuted: false,
    audible: false,
    controller: "agent",
    favicon: null,
  });
}
async function closeTarget() {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    item.getAttribute("aria-label")?.startsWith("Close Browser"),
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
async function answerConfirmation(label: "Confirm" | "Cancel") {
  const dialog = document.querySelector('[role="alertdialog"]');
  expect(dialog).not.toBeNull();
  const button = [...dialog!.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === label,
  );
  expect(button).toBeDefined();
  await act(() => button!.click());
  await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
}
it("thread link AppRoot guard: cancelling the real agent confirmation preserves the target and maximize", async () => {
  await using _fixture = await createLayoutFixture();
  designateTarget();
  agentOwnsTarget();
  useRightPanelStore.getState().requestMaximize(ref);
  await mount();
  await closeTarget();
  expect(maximized()).toBe(true);
  await answerConfirmation("Cancel");
  const panel = await focusPanel();
  await settleFocus();
  expect(document.activeElement).toBe(panel);
  expect(closeBoundary.close).not.toHaveBeenCalled();
  expect(maximized()).toBe(true);
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
  ).toBe("browser:layout-target");
});

it("thread link AppRoot guard: late accepted old-route confirmation cannot clear the new route maximize", async () => {
  await using _fixture = await createLayoutFixture();
  designateTarget();
  agentOwnsTarget();
  useRightPanelStore.getState().requestMaximize(ref);
  await mount();
  await closeTarget();
  const otherId = ThreadId.make("new-route-link-layout");
  const other = scopeThreadRef(ref.environmentId, otherId);
  await act(() => {
    addFenceThread(otherId, "New route", [
      makeMessage("other-layout-user", "user", "Review another link."),
    ]);
    reconcilePreviewServerSessions(other, {
      sessions: [
        {
          threadId: otherId,
          tabId: "new-target",
          navStatus: { _tag: "Idle" },
          canGoBack: false,
          canGoForward: false,
          updatedAt: "2026-10-12T00:00:00Z",
        },
      ],
      serverEpoch: "new-route-epoch",
      revision: 1,
    });
    useRightPanelStore.getState().openBrowser(other, "new-target");
    useRightPanelStore.getState().requestMaximize(other);
  });
  await act(async () =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ref.environmentId, threadId: otherId },
    }),
  );
  expect(maximized()).toBe(true);
  await answerConfirmation("Confirm");
  const panel = await focusPanel();
  await settleFocus();
  expect(document.activeElement).toBe(panel);
  expect(maximized()).toBe(true);
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, other).activeSurfaceId,
  ).toBe("browser:new-target");
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).surfaces.some(
      (surface) => surface.id === "browser:layout-target",
    ),
  ).toBe(false);
});

it("thread link AppRoot guard: configured web close from panel focus clears layout and preserves a surviving surface", async () => {
  await using _fixture = await createLayoutFixture();
  useRightPanelStore.getState().openFile(ref, "retained.md");
  useRightPanelStore.getState().openBrowser(ref, "layout-target");
  useRightPanelStore.getState().requestMaximize(ref);
  await mount();
  const panel = container.querySelector<HTMLElement>("[data-preview-panel-mode]")!;
  expect(panel).not.toBeNull();
  panel.tabIndex = -1;
  panel.focus();
  const escape = new KeyboardEvent("keydown", {
    key: "Escape",
    code: "Escape",
    bubbles: true,
    cancelable: true,
  });
  await act(() => panel.dispatchEvent(escape));
  expect(maximized()).toBe(true);
  const close = new KeyboardEvent("keydown", {
    key: "w",
    code: "KeyW",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  await act(() => panel.dispatchEvent(close));
  expect(close.defaultPrevented).toBe(true);
  expect(maximized()).toBe(false);
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
  ).toBe("file:retained.md");
});

it("thread link AppRoot guard: forwarded configured close reaches the mounted renderer accepted-close path", async () => {
  await using _fixture = await createLayoutFixture();
  const listeners = new Set<(action: string) => void>();
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      onMenuAction: (listener: (action: string) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  });
  useRightPanelStore.getState().openFile(ref, "retained.md");
  useRightPanelStore.getState().openBrowser(ref, "layout-target");
  useRightPanelStore.getState().requestMaximize(ref);
  await mount();
  expect(maximized()).toBe(true);
  await act(() => {
    for (const listener of listeners) listener("rightPanel.close");
  });
  expect(maximized()).toBe(false);
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
  ).toBe("file:retained.md");
  await root?.[Symbol.asyncDispose]();
  root = undefined;
  expect(listeners.size).toBe(0);
});

it("thread link AppRoot fence: accepted public target close clears maximize while another surface survives", async () => {
  await using _fixture = await createLayoutFixture();
  useRightPanelStore.getState().openFile(ref, "retained.md");
  useRightPanelStore.getState().openBrowser(ref, "layout-target");
  useRightPanelStore.getState().requestMaximize(ref);
  await mount();
  expect(maximized()).toBe(true);
  const close = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.getAttribute("aria-label")?.startsWith("Close Browser"),
  );
  expect(close).toBeDefined();
  await act(() => close!.click());
  expect(maximized()).toBe(false);
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).surfaces.some(
      (surface) => surface.id === "file:retained.md",
    ),
  ).toBe(true);
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).surfaces.some(
      (surface) => surface.id === "browser:layout-target",
    ),
  ).toBe(false);
});

it("thread link AppRoot guard: no eligible panel preserves the configured close key's native meaning", async () => {
  await using _fixture = await createLayoutFixture();
  useRightPanelStore.getState().close(ref);
  await mount();
  const event = new KeyboardEvent("keydown", {
    key: "w",
    code: "KeyW",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  await act(() => {
    document.body.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(false);
  expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).isOpen).toBe(
    false,
  );
});

it("thread link AppRoot guard: terminal focus owns its close chord before the maximized browser", async () => {
  await using _fixture = await createLayoutFixture();
  const session = makeFenceSession();
  appRootFence.sessions.set(
    ref.environmentId,
    makeFenceSession([...(session.permissions ?? []), AuthTerminalOperateScope]),
  );
  useRightPanelStore.getState().requestMaximize(ref);
  await mount();
  // The public terminal focus marker is the keyboard boundary. No terminal
  // process or WASM surface is needed to prove which close command wins.
  const terminal = document.createElement("div");
  terminal.dataset.terminalOwner = "drawer";
  const input = document.createElement("textarea");
  terminal.append(input);
  container.append(terminal);
  try {
    input.focus();
    const event = new KeyboardEvent("keydown", {
      key: "w",
      code: "KeyW",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(() => {
      input.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(maximized()).toBe(true);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
    ).toBe("browser:layout-target");
  } finally {
    terminal.remove();
  }
});

function designateTarget() {
  const state = readThreadPreviewState(ref);
  reconcilePreviewServerSessions(ref, {
    sessions: Object.values(state.sessions).map((snapshot): PreviewSessionSnapshot =>
      snapshot.tabId === "layout-target"
        ? { ...snapshot, purpose: "thread-link", runtime: "server" }
        : snapshot,
    ),
    serverEpoch: "layout-epoch",
    revision: state.serverRevision + 1,
  });
  const session = makeFenceSession();
  appRootFence.sessions.set(
    ref.environmentId,
    makeFenceSession([...(session.permissions ?? []), AuthPreviewOperateScope]),
  );
}
async function settleFocus() {
  // Drain the accepted-close receipt before advancing ChatView's scheduled focus.
  await act(flushBrowserTasks);
  await act(() => vi.advanceTimersToNextFrame());
  await act(flushBrowserTasks);
}
function composerEditor() {
  const editor = container.querySelector<HTMLElement>('[data-testid="composer-editor"]');
  expect(editor, "the actual ChatComposer editor is mounted").not.toBeNull();
  return editor!;
}
async function focusPanel() {
  const panel = container.querySelector<HTMLElement>("[data-preview-panel-mode]")!;
  expect(panel).not.toBeNull();
  panel.tabIndex = -1;
  await act(() => panel.focus());
  expect(document.activeElement).toBe(panel);
  return panel;
}
it.each(["web shortcut", "forwarded command", "public close"] as const)(
  "thread link close focus regression: %s returns to the actual composer after accepted layout restore",
  async (entry) => {
    await using _fixture = await createLayoutFixture();
    const actions = new Set<(action: string) => void>();
    if (entry === "forwarded command")
      Object.defineProperty(window, "desktopBridge", {
        configurable: true,
        value: {
          onMenuAction: (listener: (action: string) => void) => {
            actions.add(listener);
            return () => actions.delete(listener);
          },
        },
      });
    designateTarget();
    useRightPanelStore.getState().openFile(ref, "retained.md");
    useRightPanelStore.getState().openBrowser(ref, "layout-target");
    useRightPanelStore.getState().requestMaximize(ref);
    await mount();
    const editor = composerEditor();
    await act(() => editor.focus());
    expect(
      document.activeElement,
      "the mounted editor accepts real DOM focus before panel entry",
    ).toBe(editor);
    const panel = await focusPanel();
    if (entry === "web shortcut") {
      const event = new KeyboardEvent("keydown", {
        key: "w",
        code: "KeyW",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      await act(() => panel.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
    } else if (entry === "forwarded command") {
      await act(() => {
        for (const listener of actions) listener("rightPanel.close");
      });
    } else await closeTarget();
    expect(maximized()).toBe(false);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
    ).toBe("file:retained.md");
    expect(readThreadPreviewState(ref).sessions["layout-target"]).toBeUndefined();
    await settleFocus();
    expect(document.activeElement).toBe(editor);
  },
);

it("thread link close focus guard: server refusal restores the target without requesting composer focus", async () => {
  await using _fixture = await createLayoutFixture();
  designateTarget();
  closeBoundary.close.mockResolvedValue(
    AsyncResult.failure(Cause.fail(new Error("close refused"))),
  );
  // Keep an ordinary panel owner mounted so unrelated window/BODY focus
  // restoration cannot stand in for the accepted-close focus being tested.
  useRightPanelStore.getState().openFile(ref, "retained.md");
  useRightPanelStore.getState().openBrowser(ref, "layout-target");
  useRightPanelStore.getState().requestMaximize(ref);
  await mount();
  await focusPanel();
  await closeTarget();
  await settleFocus();
  expect(closeBoundary.close).toHaveBeenCalledTimes(1);
  expect(readThreadPreviewState(ref).sessions["layout-target"]?.purpose).toBe("thread-link");
  expect(document.activeElement).not.toBe(composerEditor());
});
it("thread link close focus guard: a nonactive designated close preserves the current file's focus and layout", async () => {
  await using _fixture = await createLayoutFixture();
  designateTarget();
  useRightPanelStore.getState().openFile(ref, "retained.md");
  useRightPanelStore.getState().requestMaximize(ref);
  await mount();
  const panel = await focusPanel();
  await closeTarget();
  await settleFocus();
  expect(maximized()).toBe(true);
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
  ).toBe("file:retained.md");
  expect(readThreadPreviewState(ref).sessions["layout-target"]).toBeUndefined();
  expect(document.activeElement).toBe(panel);
});
it("thread link close focus guard: ordinary manual browser close keeps its surviving panel focus", async () => {
  await using _fixture = await createLayoutFixture();
  useRightPanelStore.getState().openFile(ref, "retained.md");
  useRightPanelStore.getState().openBrowser(ref, "layout-target");
  useRightPanelStore.getState().requestMaximize(ref);
  await mount();
  await focusPanel();
  await closeTarget();
  await settleFocus();
  expect(maximized()).toBe(false);
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
  ).toBe("file:retained.md");
  expect(document.activeElement).not.toBe(composerEditor());
});
it.each(["terminal", "modal", "user focus", "new surface"] as const)(
  "thread link close focus guard: %s ownership during the close receipt cancels focus return",
  async (owner) => {
    await using _fixture = await createLayoutFixture();
    designateTarget();
    const receipt = createDeferredPromise<ReturnType<typeof AsyncResult.success<void>>>();
    closeBoundary.close.mockReturnValue(receipt.promise);
    useRightPanelStore.getState().openFile(ref, "retained.md");
    useRightPanelStore.getState().openBrowser(ref, "layout-target");
    useRightPanelStore.getState().requestMaximize(ref);
    await mount();
    await focusPanel();
    await closeTarget();
    expect(maximized()).toBe(false);
    const newOwner = document.createElement("div");
    const input = document.createElement("textarea");
    if (owner === "terminal") newOwner.dataset.terminalOwner = "drawer";
    if (owner === "modal") {
      newOwner.setAttribute("role", "dialog");
      newOwner.setAttribute("aria-modal", "true");
    }
    newOwner.append(input);
    container.append(newOwner);
    try {
      if (owner === "new surface") {
        await act(() => useRightPanelStore.getState().openFile(ref, "new-owner.md"));
        await settleFocus();
        await focusPanel();
      } else await act(() => input.focus());
      const active = document.activeElement;
      await act(async () => {
        receipt.resolve(AsyncResult.success(undefined));
        await receipt.promise;
      });
      await settleFocus();
      expect(document.activeElement).toBe(active);
      expect(document.activeElement).not.toBe(composerEditor());
      expect(readThreadPreviewState(ref).sessions["layout-target"]).toBeUndefined();
    } finally {
      newOwner.remove();
    }
  },
);

function addManualBrowserSurvivor() {
  const state = readThreadPreviewState(ref);
  reconcilePreviewServerSessions(ref, {
    sessions: [
      ...Object.values(state.sessions),
      {
        threadId: id,
        tabId: "manual-survivor",
        runtime: "desktop",
        navStatus: {
          _tag: "Success",
          url: "https://manual.example.test/original",
          title: "Manual survivor",
        },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-10-12T00:00:00Z",
      },
    ],
    serverEpoch: "layout-epoch",
    revision: state.serverRevision + 1,
  });
  useRightPanelStore.getState().openBrowser(ref, "manual-survivor");
  useRightPanelStore.getState().openBrowser(ref, "layout-target");
}

it.each(["URL editor", "noneditable header"] as const)(
  "thread link close ownership regression: surviving manual Browser %s owns the accepted receipt boundary",
  async (owner) => {
    await using _fixture = await createLayoutFixture();
    closeBoundary.browserAvailable = true;
    designateTarget();
    addManualBrowserSurvivor();
    const receipt = createDeferredPromise<ReturnType<typeof AsyncResult.success<void>>>();
    closeBoundary.close.mockReturnValue(receipt.promise);
    useRightPanelStore.getState().requestMaximize(ref);
    await mount();
    const panel = await focusPanel();
    const close = new KeyboardEvent("keydown", {
      key: "w",
      code: "KeyW",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(() => panel.dispatchEvent(close));
    expect(close.defaultPrevented).toBe(true);
    expect(closeBoundary.close).toHaveBeenCalledTimes(1);
    expect(maximized()).toBe(false);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
    ).toBe("browser:manual-survivor");
    const revision = useRightPanelStore.getState().getUserActionRevision(ref);
    // This is the real PreviewChromeRow controlled input rendered by PreviewView,
    // not a test-owned input inside a panel marker. No navigation is submitted.
    const input = container.querySelector<HTMLInputElement>("[data-preview-url-input]");
    expect(input, "the actual surviving Browser URL editor is mounted").not.toBeNull();
    expect(input!.disabled).toBe(false);
    expect(input!.value).toBe("https://manual.example.test/original");
    const draft = "https://manual.example.test/unsubmitted-draft";
    if (owner === "URL editor") {
      await act(async () => input!.focus());
      await act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          draft,
        );
        input!.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(document.activeElement).toBe(input);
      expect(input!.value).toBe(draft);
    } else {
      const title = container.querySelector<HTMLButtonElement>(
        '[data-right-panel-tabbar] [data-active-tab="true"] button:not([aria-label])',
      );
      expect(title).not.toBeNull();
      await act(() => title!.focus());
      expect(document.activeElement).toBe(title);
    }
    expect(useRightPanelStore.getState().getUserActionRevision(ref)).toBe(revision);
    await act(async () => {
      receipt.resolve(AsyncResult.success(undefined));
      await receipt.promise;
    });
    await settleFocus();
    expect(useRightPanelStore.getState().getUserActionRevision(ref)).toBe(revision);
    expect(readThreadPreviewState(ref).sessions["manual-survivor"]?.navStatus).toEqual({
      _tag: "Success",
      url: "https://manual.example.test/original",
      title: "Manual survivor",
    });
    expect(readThreadPreviewState(ref).sessions["layout-target"]).toBeUndefined();
    if (owner === "URL editor") {
      expect.soft(document.activeElement).toBe(input);
      expect(input!.value).toBe(draft);
    } else {
      expect(document.activeElement).toBe(composerEditor());
      expect(input!.value).toBe("https://manual.example.test/original");
    }
  },
);
