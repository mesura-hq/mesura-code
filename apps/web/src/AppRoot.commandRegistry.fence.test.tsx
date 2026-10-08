// @vitest-environment happy-dom
/**
 * Entry point: AppRoot, with a memory router whose root renders the real
 * AppSidebarLayout, a chat layout that mounts the real KeyEngineHost around
 * the real ChatView, as `_chat.tsx` does, and a settings page outside it. The
 * key engine is installed on `window` before React renders, as `main.tsx`
 * does. Keys are real `keydown` events dispatched from
 * the focused element.
 *
 * Phase 3 of the modal keys production cycle (the command registry):
 * - Criterion 2 at the app: a leader sequence runs the owner's own function
 *   and dispatches no synthetic `KeyboardEvent`.
 * - Criterion 6, guards: the chords of the ChatView branches this phase lifts
 *   into named functions (thread.settle, thread.pin, rightPanel.close) keep
 *   their effect with Vim mode off and on, and the sidebar chord keeps what it
 *   does today in each mode.
 * - Review P1-1, regression: leaving the chat layout turns the engine off, so
 *   Space reaches a focused Settings control.
 *
 * Boundaries the fixture replaces, and nothing else: the environment and
 * thread reads, every RPC command, the thread actions (observed as they are
 * called), the chords (the shipped defaults, as a fresh keybindings file
 * resolves them) and unrelated chrome. The setup follows
 * `AppRoot.dictation.fence.test.tsx`.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { Thread } from "./types";
import type { AppRouter } from "./router";

const fixture = vi.hoisted(() => ({
  thread: null as Thread | null,
  vimMode: false,
  empty: [],
  threadListeners: new Set<() => void>(),
  project: {
    id: "registry-fence-project",
    environmentId: "registry-fence-environment",
    title: "Registry fence",
    workspaceRoot: "/tmp/registry-fence",
    scripts: [],
    createdAt: "2026-10-08T12:00:00.000Z",
    defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" },
  },
  threadActions: {
    settleThread: [] as unknown[],
    pinThread: [] as unknown[],
    confirmAndUnpinThread: [] as unknown[],
  },
  environments: [
    {
      environmentId: "registry-fence-environment",
      label: "Fence environment",
      connection: { phase: "connected" },
      serverConfig: {
        environment: { capabilities: { threadSettlement: true, threadPinning: true } },
        providers: [
          {
            instanceId: "codex",
            driver: "codex",
            enabled: true,
            installed: true,
            status: "ready",
            version: null,
            auth: { status: "authenticated" },
            checkedAt: "2026-10-08T12:00:00.000Z",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ],
      },
    },
  ],
}));

const success = () => Promise.resolve({ _tag: "Success" as const, value: { providers: [] } });

vi.mock("./state/entities", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  const useFixtureThread = () =>
    useSyncExternalStore(
      (listener) => {
        fixture.threadListeners.add(listener);
        return () => {
          fixture.threadListeners.delete(listener);
        };
      },
      () => fixture.thread,
    );
  return {
    ...(await importOriginal<typeof import("./state/entities")>()),
    useThread: useFixtureThread,
    readThread: () => fixture.thread,
    useThreadShell: useFixtureThread,
    useThreadRefs: () => fixture.empty,
    useThreadShells: () => fixture.empty,
    useProjects: () => fixture.empty,
    useProject: () => fixture.project,
  };
});
vi.mock("./state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state/environments")>()),
  useEnvironments: () => ({ environments: fixture.environments, isReady: true }),
  usePrimaryEnvironment: () => null,
}));
vi.mock("./state/query", () => ({
  useEnvironmentQuery: () => ({
    data: null,
    error: null,
    isPending: false,
    isSuccess: false,
    refresh: () => undefined,
  }),
}));
vi.mock("./state/threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state/threads")>();
  const { EMPTY_ENVIRONMENT_THREAD_STATE } = await import("@t3tools/client-runtime/state/threads");
  return { ...actual, useEnvironmentThread: () => EMPTY_ENVIRONMENT_THREAD_STATE };
});
vi.mock("./state/use-atom-command", () => ({ useAtomCommand: () => success }));
vi.mock("./state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => success }));
// The chords the app ships, as a keybindings file with no user rules resolves them.
vi.mock("./state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state/server")>();
  const { Atom } = await import("effect/unstable/reactivity");
  const { DEFAULT_RESOLVED_KEYBINDINGS } = await import("@t3tools/shared/keybindings");
  return { ...actual, primaryServerKeybindingsAtom: Atom.make(() => DEFAULT_RESOLVED_KEYBINDINGS) };
});
vi.mock("./hooks/useSettings", async (importOriginal) => {
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts/settings");
  const clientSettings = () => ({ ...DEFAULT_CLIENT_SETTINGS, vimMode: fixture.vimMode });
  return {
    ...(await importOriginal<typeof import("./hooks/useSettings")>()),
    useEnvironmentSettings: () => ({ ...clientSettings(), ...DEFAULT_SERVER_SETTINGS }),
    useClientSettings: (select?: (value: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
      select ? select(clientSettings()) : clientSettings(),
    useClientSettingsHydrated: () => true,
    useLegacySidebarEnabled: () => false,
  };
});
vi.mock("./hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => success }));
vi.mock("./hooks/useThreadActions", () => ({
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
// happy-dom has no layout. Keep routing and timeline projection real, and
// replace only the virtual list's measurement boundary.
vi.mock("@legendapp/list/react", () => ({
  LegendList: ({
    data,
    renderItem,
    ListHeaderComponent,
    ListFooterComponent,
  }: {
    data: Array<{ id: string }>;
    renderItem: (input: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) => (
    <div>
      {ListHeaderComponent}
      {data.map((item) => (
        <div key={item.id}>{renderItem({ item })}</div>
      ))}
      {ListFooterComponent}
    </div>
  ),
}));

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AppRoot } from "./AppRoot";
import { AppSidebarLayout } from "./components/AppSidebarLayout";
import ChatView from "./components/ChatView";
import { installKeyEngine } from "./keys/keyEngine";
import { KeyEngineHost } from "./keys/KeyEngineHost";
import { readKeyEngineSnapshot } from "./keys/keyEngineStore";
import { selectActiveRightPanelSurface, useRightPanelStore } from "./rightPanelStore";

const environmentId = EnvironmentId.make("registry-fence-environment");
const threadId = ThreadId.make("registry-fence-thread");
const threadRef = scopeThreadRef(environmentId, threadId);
const now = "2026-10-08T12:00:00.000Z";
let root: Root | undefined;
let container: HTMLDivElement;

/** Every `keydown` that reaches `window`, seen first, before the key engine. */
const keydownsAtWindow: KeyboardEvent[] = [];
/** The `keydown` events this file dispatched; anything else at `window` is synthetic. */
const pressedByTest = new Set<Event>();

beforeAll(() => {
  // Registered before the engine, so it sees every keydown, consumed or not.
  window.addEventListener("keydown", (event) => keydownsAtWindow.push(event), true);
  installKeyEngine();
});

function makeThread(): Thread {
  return {
    id: threadId,
    environmentId,
    projectId: ProjectId.make("registry-fence-project"),
    title: "Registry fence",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    checkpoints: [],
    pullRequests: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    activities: [],
  } as unknown as Thread;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.thread = makeThread();
  fixture.vimMode = false;
  fixture.threadActions.settleThread.length = 0;
  fixture.threadActions.pinThread.length = 0;
  fixture.threadActions.confirmAndUnpinThread.length = 0;
  keydownsAtWindow.length = 0;
  pressedByTest.clear();
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  useRightPanelStore.getState().removeThread(threadRef);
  vi.unstubAllGlobals();
});

let router: ReturnType<typeof createRouter> | undefined;

async function mountApp(options: { readonly vimMode: boolean }) {
  fixture.vimMode = options.vimMode;
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
    root = createRoot(container);
    root.render(<AppRoot router={router as unknown as AppRouter} />);
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
  await press({ key: " ", code: "Space" });
  for (const key of keys) await press({ key, code: `Key${key.toUpperCase()}` });
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

// Mod is Control here: happy-dom reports a non-Mac platform.
const SETTLE_CHORD: Chord = { key: "S", code: "KeyS", ctrlKey: true, shiftKey: true };
const PIN_CHORD: Chord = { key: "P", code: "KeyP", ctrlKey: true, shiftKey: true };
const CLOSE_PANEL_CHORD: Chord = { key: "w", code: "KeyW", ctrlKey: true };
const SIDEBAR_CHORD: Chord = { key: "b", code: "KeyB", ctrlKey: true };

describe("registry fence: lifted ChatView chords keep their effect", () => {
  for (const vimMode of [false, true]) {
    const label = vimMode ? "Vim mode on" : "Vim mode off";

    it(`registry fence guard: Mod+Shift+S settles the open thread with ${label}`, async () => {
      await mountApp({ vimMode });
      const event = await press(SETTLE_CHORD);
      expect(event.defaultPrevented).toBe(true);
      expect(fixture.threadActions.settleThread).toEqual([threadRef]);
    });

    it(`registry fence guard: Mod+Shift+P pins the open thread with ${label}`, async () => {
      await mountApp({ vimMode });
      const event = await press(PIN_CHORD);
      expect(event.defaultPrevented).toBe(true);
      expect(fixture.threadActions.pinThread).toEqual([threadRef]);
      expect(fixture.threadActions.confirmAndUnpinThread).toEqual([]);
    });

    it(`registry fence guard: Mod+W closes the open panel surface with ${label}`, async () => {
      await mountApp({ vimMode });
      await openFileSurface();
      const event = await press(CLOSE_PANEL_CHORD);
      expect(event.defaultPrevented).toBe(true);
      expect(activeSurface()).toBeNull();
    });

    it(`registry fence guard: Mod+W with no panel open keeps its native meaning with ${label}`, async () => {
      await mountApp({ vimMode });
      expect(activeSurface()).toBeNull();
      const event = await press(CLOSE_PANEL_CHORD);
      expect(event.defaultPrevented).toBe(false);
    });
  }

  it("registry fence guard: Mod+B toggles the sidebar with Vim mode off", async () => {
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
    await mountApp({ vimMode: true });
    await pressLeader("ts");
    expect(fixture.threadActions.settleThread).toEqual([threadRef]);
    expect(syntheticKeydowns()).toEqual([]);
    expect(readKeyEngineSnapshot().notice).toBeNull();
  });

  it("registry fence spec: <leader>tp pins the open thread with no synthetic keydown", async () => {
    await mountApp({ vimMode: true });
    await pressLeader("tp");
    expect(fixture.threadActions.pinThread).toEqual([threadRef]);
    expect(syntheticKeydowns()).toEqual([]);
    expect(readKeyEngineSnapshot().notice).toBeNull();
  });

  it("registry fence spec: <leader>px closes the open panel surface with no synthetic keydown", async () => {
    await mountApp({ vimMode: true });
    await openFileSurface();
    await pressLeader("px");
    expect(activeSurface()).toBeNull();
    expect(syntheticKeydowns()).toEqual([]);
    expect(readKeyEngineSnapshot().notice).toBeNull();
  });

  it("registry fence spec: <leader>b toggles the sidebar with no synthetic keydown", async () => {
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
    await mountApp({ vimMode: true });
    await act(async () => {
      await router!.navigate({ to: "/", search: { rerender: 1 } as never });
    });
    expect((await press({ key: " ", code: "Space" })).defaultPrevented).toBe(true);
    expect(readKeyEngineSnapshot()).toMatchObject({ enabled: true, pending: ["<Space>"] });
  });
});
