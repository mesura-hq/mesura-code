import { page } from "vite-plus/test/browser";
import { act, render as renderBrowser, type Screen } from "../test/render";
// Command registry (modal keys phase 3) through AppRoot, KeyEngineHost and ChatView, plus a
// settings page outside the chat layout. A leader sequence must run the owner's own function and
// dispatch no synthetic `KeyboardEvent`. Regression (review P1-1): leaving the chat layout turns
// the engine off.

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { makeFenceThreadProjection, makeFenceThreadShell } from "./test/fenceThreadShell";
import {
  appRootFence,
  FENCE_ENVIRONMENT_ID,
  FENCE_PROJECT_ID,
  installFenceFontEvents,
} from "./test/appRootFenceMocks";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@t3tools/client-runtime/state/threads";
import * as Option from "effect/Option";
import type { AppRouter } from "./router";

const fixture = vi.hoisted(() => ({
  threadActions: {
    settleThread: [] as unknown[],
    pinThread: [] as unknown[],
    confirmAndUnpinThread: [] as unknown[],
  },
}));
const fenceMocks = vi.hoisted(() => () => import("./test/appRootFenceMocks"));
vi.mock("./state/presentation", async (original) =>
  (await fenceMocks()).mockPresentation(original),
);
vi.mock("./connection/runtime", async () => (await fenceMocks()).mockConnectionRuntime());
vi.mock("@t3tools/client-runtime/state/session", async (original) =>
  (await fenceMocks()).mockRuntimeSession(original),
);
const success = () => Promise.resolve({ _tag: "Success" as const, value: { providers: [] } });

vi.mock("./state/entities", async (original) => (await fenceMocks()).mockEntities(original));
vi.mock("./state/environments", async (original) =>
  (await fenceMocks()).mockEnvironments(original),
);
vi.mock("./state/query", async (original) => (await fenceMocks()).mockQuery(original));
vi.mock("./state/threads", async (original) => (await fenceMocks()).mockThreads(original));
vi.mock("./state/use-atom-command", async () => (await fenceMocks()).mockAtomCommand());
vi.mock("./state/use-atom-query-runner", async () => (await fenceMocks()).mockAtomQueryRunner());
vi.mock("./state/server", async (original) => (await fenceMocks()).mockServer(original));
vi.mock("./hooks/useSettings", async (original) => (await fenceMocks()).mockSettings(original));
vi.mock("./hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => success }));
vi.mock("./hooks/useThreadActions", () => ({
  useAcknowledgeThreadWoke: () => success,
  useThreadActions: () => ({
    settleThread: (ref: unknown) => {
      fixture.threadActions.settleThread.push(ref);
      return success();
    },
    pinThread: (ref: unknown) => {
      fixture.threadActions.pinThread.push(ref);
      return success();
    },
    confirmAndUnpinThread: (ref: unknown) => {
      fixture.threadActions.confirmAndUnpinThread.push(ref);
      return success();
    },
  }),
}));
vi.mock("./components/Sidebar", () => ({ default: () => null }));
vi.mock("./components/LegacySidebar", () => ({ default: () => null }));
vi.mock("./components/preview/PreviewAutomationHosts", () => ({
  PreviewAutomationHosts: () => null,
}));
vi.mock("./browser/ElectronBrowserHost", () => ({ ElectronBrowserHost: () => null }));
vi.mock("./components/QuitHoldOverlay", () => ({ QuitHoldOverlay: () => null }));
vi.mock("./components/chat/ChatHeader", () => ({ ChatHeader: () => null }));
vi.mock("./components/BranchToolbar", () => ({ BranchToolbar: () => null }));
// Keep routing and timeline projection real, and replace only the virtual
// list's measurement boundary.
vi.mock("@legendapp/list/react", async () => (await fenceMocks()).mockLegendList());

import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import { installKeyEngine } from "./keys/keyEngine";

import { readKeyEngineSnapshot } from "./keys/keyEngineStore";
import { runRegisteredCommand } from "./commands/commandRegistry";
import {
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "./rightPanelStore";

const { Outlet } = await import("@tanstack/react-router");
const { AppRoot } = await import("./AppRoot");
const { AppSidebarLayout } = await import("./components/AppSidebarLayout");
const { default: ChatView } = await import("./components/ChatView");
const { KeyEngineHost } = await import("./keys/KeyEngineHost");

const environmentId = EnvironmentId.make(FENCE_ENVIRONMENT_ID);
const threadId = ThreadId.make("registry-fence-thread");
const threadRef = scopeThreadRef(environmentId, threadId);
const now = "2026-10-08T12:00:00.000Z";
let root: Screen | undefined;
let container: HTMLDivElement;

/** Every `keydown` that reaches `window`, seen first, before the key engine. */
const keydownsAtWindow: KeyboardEvent[] = [];
/** The `keydown` events this file dispatched; anything else at `window` is synthetic. */
const pressedByTest = new Set<Event>();

async function setupBrowserFixture0() {
  const previousViewport = { width: window.innerWidth, height: window.innerHeight };
  const environment = appRootFence.environments[0]!.serverConfig.environment;
  const previousCapabilities = { ...environment.capabilities };
  // Native matchMedia must select the desktop sidebar and inline right panel.
  await page.viewport(1440, 900);
  // Registered before the engine, so it sees every keydown, consumed or not.
  window.addEventListener("keydown", (event) => keydownsAtWindow.push(event), true);
  installKeyEngine();

  installFenceFontEvents();
  const shell = makeThread();
  appRootFence.threads.set(threadId, shell);
  appRootFence.threadStates.set(threadId, {
    ...EMPTY_ENVIRONMENT_THREAD_STATE,
    status: "live",
    data: Option.some(makeFenceThreadProjection(shell)),
  });
  appRootFence.vimMode = false;
  fixture.threadActions.settleThread.length = 0;
  fixture.threadActions.pinThread.length = 0;
  fixture.threadActions.confirmAndUnpinThread.length = 0;
  keydownsAtWindow.length = 0;
  pressedByTest.clear();
  container = document.createElement("div");
  document.body.append(container);

  return {
    async [Symbol.asyncDispose]() {
      await act(async () => root?.[Symbol.asyncDispose]());
      root = undefined;
      container.remove();
      useRightPanelStore.getState().removeThread(threadRef);
      environment.capabilities = previousCapabilities;
      appRootFence.threads.clear();
      appRootFence.threadStates.clear();
      vi.unstubAllGlobals();
      await page.viewport(previousViewport.width, previousViewport.height);
    },
  };
}

function makeThread() {
  return makeFenceThreadShell({
    id: threadId,
    environmentId,
    projectId: ProjectId.make(FENCE_PROJECT_ID),
    title: "Registry fence",
    createdAt: now,
  });
}

let router: ReturnType<typeof createRouter> | undefined;

async function mountApp(options: { readonly vimMode: boolean }) {
  appRootFence.vimMode = options.vimMode;
  const route = createRootRoute({
    component: () => (
      <AppSidebarLayout>
        <Outlet />
      </AppSidebarLayout>
    ),
  });
  // The chat layout owns the key engine's host, as `_chat.tsx` does; the
  // settings page sits outside it.
  const chatLayout = createRoute({
    getParentRoute: () => route,
    id: "_chat",
    component: () => (
      <>
        <KeyEngineHost />
        <Outlet />
      </>
    ),
  });
  const index = createRoute({
    getParentRoute: () => chatLayout,
    path: "/",
    component: () => (
      <ChatView environmentId={environmentId} threadId={threadId} routeKind="server" />
    ),
  });
  const settings = createRoute({
    getParentRoute: () => route,
    path: "/settings",
    component: () => <button data-testid="settings-control">Save</button>,
  });
  router = createRouter({
    routeTree: route.addChildren([chatLayout.addChildren([index]), settings]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  await act(async () => {
    root = await renderBrowser(null, { container: container, router: false });
    await root.rerender(<AppRoot router={router as unknown as AppRouter} />);
  });
  // The chat holds the keyboard: nothing text-editable is focused.
  (document.activeElement as HTMLElement | null)?.blur?.();
}

interface Chord {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
}

/** Dispatches one keydown from the focused element, as the browser does. */
async function press(chord: Chord) {
  const event = new KeyboardEvent("keydown", { ...chord, bubbles: true, cancelable: true });
  pressedByTest.add(event);
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
  return event;
}

/** Presses a leader sequence such as `<Space>tp`, one key per character after the leader. */
async function pressLeader(keys: string) {
  const leader = await press({ key: " ", code: "Space" });
  expect(leader.defaultPrevented, "the key engine consumes the leader").toBe(true);
  for (const key of keys) {
    const event = await press({ key, code: `Key${key.toUpperCase()}` });
    expect(event.defaultPrevented, `the key engine consumes ${key} after the leader`).toBe(true);
  }
}

/** The keydowns no test dispatched, described as `Ctrl+Shift+P` for a readable failure. */
function syntheticKeydowns() {
  return keydownsAtWindow
    .filter((event) => !pressedByTest.has(event))
    .map((event) =>
      [
        event.ctrlKey && "Ctrl",
        event.metaKey && "Meta",
        event.altKey && "Alt",
        event.shiftKey && "Shift",
        event.key,
      ]
        .filter(Boolean)
        .join("+"),
    );
}

function activeSurface() {
  return selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef);
}

async function openFileSurface() {
  await act(async () => useRightPanelStore.getState().openFile(threadRef, "README.md"));
  expect(activeSurface()).not.toBeNull();
}

function sidebarState() {
  return container.querySelector<HTMLElement>('[data-slot="sidebar"][data-state]')?.dataset.state;
}

// Mod is Control in the Linux Chromium test browser.
const SETTLE_CHORD: Chord = { key: "S", code: "KeyS", ctrlKey: true, shiftKey: true };
const PIN_CHORD: Chord = { key: "P", code: "KeyP", ctrlKey: true, shiftKey: true };
const CLOSE_PANEL_CHORD: Chord = { key: "w", code: "KeyW", ctrlKey: true };
const SIDEBAR_CHORD: Chord = { key: "b", code: "KeyB", ctrlKey: true };

describe("registry fence: lifted ChatView chords keep their effect", () => {
  const vimModeCases = [false, true].map((vimMode) => ({
    vimMode,
    label: vimMode ? "Vim mode on" : "Vim mode off",
  }));

  it.each(vimModeCases)(
    "registry fence regression: Alt+A and the attachment command reach the real file input with $label",
    async ({ vimMode }) => {
      await using _browserFixture0 = await setupBrowserFixture0();
      Object.assign(appRootFence.environments[0]!.serverConfig.environment.capabilities, {
        attachmentUploads: true,
        fileAttachments: { maxUploadBytes: 1_048_576 },
      });
      await mountApp({ vimMode });
      const input = container.querySelector<HTMLInputElement>('input[type="file"]');
      expect(input, "the composer mounts its real attachment input").not.toBeNull();
      using click = vi.spyOn(input!, "click").mockImplementation(() => {});
      const event = await press({ key: "a", code: "KeyA", altKey: true });
      expect(event.defaultPrevented).toBe(true);
      expect(click).toHaveBeenCalledTimes(1);
      await act(async () => {
        expect(runRegisteredCommand("composer.attachFiles")).toBe(true);
      });
      expect(click).toHaveBeenCalledTimes(2);
    },
  );

  it.each(vimModeCases)(
    "registry fence regression: unavailable attachments leave Alt+A unclaimed with $label",
    async ({ vimMode }) => {
      await using _browserFixture0 = await setupBrowserFixture0();
      await mountApp({ vimMode });
      expect(container.querySelector('input[type="file"]')).toBeNull();
      const event = await press({ key: "a", code: "KeyA", altKey: true });
      expect(event.defaultPrevented).toBe(false);
    },
  );

  it.each(vimModeCases)(
    "registry fence regression: registered diff.toggle opens and closes the diff with $label",
    async ({ vimMode }) => {
      await using _browserFixture0 = await setupBrowserFixture0();
      await mountApp({ vimMode });
      await act(async () => {
        expect(runRegisteredCommand("diff.toggle")).toBe(true);
      });
      expect(activeSurface()?.kind).toBe("diff");
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).isOpen,
      ).toBe(true);
      await act(async () => {
        expect(runRegisteredCommand("diff.toggle")).toBe(true);
      });
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).isOpen,
      ).toBe(false);
    },
  );

  it.each(vimModeCases)(
    "registry fence guard: Mod+Shift+S settles the open thread with $label",
    async ({ vimMode }) => {
      await using _browserFixture0 = await setupBrowserFixture0();

      await mountApp({ vimMode });
      const event = await press(SETTLE_CHORD);
      expect(event.defaultPrevented).toBe(true);
      expect(fixture.threadActions.settleThread).toEqual([threadRef]);
    },
  );

  it.each(vimModeCases)(
    "registry fence guard: Mod+Shift+P pins the open thread with $label",
    async ({ vimMode }) => {
      await using _browserFixture0 = await setupBrowserFixture0();

      await mountApp({ vimMode });
      const event = await press(PIN_CHORD);
      expect(event.defaultPrevented).toBe(true);
      expect(fixture.threadActions.pinThread).toEqual([threadRef]);
      expect(fixture.threadActions.confirmAndUnpinThread).toEqual([]);
    },
  );

  it.each(vimModeCases)(
    "registry fence guard: Mod+W closes the open panel surface with $label",
    async ({ vimMode }) => {
      await using _browserFixture0 = await setupBrowserFixture0();

      await mountApp({ vimMode });
      await openFileSurface();
      const event = await press(CLOSE_PANEL_CHORD);
      expect(event.defaultPrevented).toBe(true);
      expect(activeSurface()).toBeNull();
    },
  );

  it.each(vimModeCases)(
    "registry fence guard: Mod+W with no panel open keeps its native meaning with $label",
    async ({ vimMode }) => {
      await using _browserFixture0 = await setupBrowserFixture0();

      await mountApp({ vimMode });
      expect(activeSurface()).toBeNull();
      const event = await press(CLOSE_PANEL_CHORD);
      expect(event.defaultPrevented).toBe(false);
    },
  );

  it("registry fence guard: Mod+B toggles the sidebar with Vim mode off", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountApp({ vimMode: false });
    const before = sidebarState();
    expect(before).toBeDefined();
    await press(SIDEBAR_CHORD);
    expect(sidebarState()).not.toBe(before);
  });

  // Not a regression to fix here: in Vim mode the chat buffer owns Ctrl+B as
  // Vim's page back (`chat/chatSurface.ts`, SCROLL_KEYS), so the chord never
  // reaches the sidebar from the chat. `<leader>b` is the way there.
  it("registry fence guard: Mod+B in the chat stays the buffer's page back with Vim mode on", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountApp({ vimMode: true });
    const before = sidebarState();
    expect(before).toBeDefined();
    const event = await press(SIDEBAR_CHORD);
    expect(event.defaultPrevented).toBe(true);
    expect(sidebarState()).toBe(before);
  });
});

describe("registry fence: leader rows run the owner's function at the app", () => {
  it("registry fence spec: <leader>ts settles the open thread with no synthetic keydown", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountApp({ vimMode: true });
    await pressLeader("ts");
    expect(fixture.threadActions.settleThread).toEqual([threadRef]);
    expect(syntheticKeydowns()).toEqual([]);
    expect(readKeyEngineSnapshot().notice).toBeNull();
  });

  it("registry fence spec: <leader>tp pins the open thread with no synthetic keydown", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountApp({ vimMode: true });
    await pressLeader("tp");
    expect(fixture.threadActions.pinThread).toEqual([threadRef]);
    expect(syntheticKeydowns()).toEqual([]);
    expect(readKeyEngineSnapshot().notice).toBeNull();
  });

  it("registry fence spec: <leader>px closes the open panel surface with no synthetic keydown", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountApp({ vimMode: true });
    await openFileSurface();
    await pressLeader("px");
    expect(activeSurface()).toBeNull();
    expect(syntheticKeydowns()).toEqual([]);
    expect(readKeyEngineSnapshot().notice).toBeNull();
  });

  it("registry fence spec: <leader>b toggles the sidebar with no synthetic keydown", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountApp({ vimMode: true });
    const before = sidebarState();
    expect(before).toBeDefined();
    await pressLeader("b");
    expect(sidebarState()).not.toBe(before);
    expect(syntheticKeydowns()).toEqual([]);
    expect(readKeyEngineSnapshot().notice).toBeNull();
  });
});

describe("registry fence: the key engine leaves with the chat", () => {
  it("registry fence regression: Space reaches a focused Settings control after leaving a Vim chat", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountApp({ vimMode: true });
    // The engine is on in the chat: Space starts a leader sequence.
    expect((await press({ key: " ", code: "Space" })).defaultPrevented).toBe(true);
    await press({ key: "Escape", code: "Escape" });

    await act(async () => {
      await router!.navigate({ to: "/settings" });
    });
    const control = container.querySelector<HTMLButtonElement>('[data-testid="settings-control"]');
    expect(control).not.toBeNull();
    control!.focus();

    const space = await press({ key: " ", code: "Space" });
    expect(space.defaultPrevented).toBe(false);
    expect(readKeyEngineSnapshot().pending).toEqual([]);
  });

  it("registry fence regression: the engine stays on while the chat host re-renders with Vim mode on", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountApp({ vimMode: true });
    await act(async () => {
      await router!.navigate({ to: "/", search: { rerender: 1 } as never });
    });
    expect((await press({ key: " ", code: "Space" })).defaultPrevented).toBe(true);
    expect(readKeyEngineSnapshot()).toMatchObject({ enabled: true, pending: ["<Space>"] });
  });
});
