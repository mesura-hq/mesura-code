// @vitest-environment happy-dom
/**
 * Entry point: AppRoot, with a memory router whose root renders the real
 * CommandPalette around the real AppSidebarLayout, as `routes/__root.tsx`
 * does, and whose chat layout is the real `_chat.tsx` route component: the
 * chat route's global shortcuts (pane navigation among them) and the real
 * KeyEngineHost around the real ChatView. The key engine is installed on
 * `window` before React renders, as `main.tsx` does. Keys are real `keydown`
 * events dispatched from the focused element.
 *
 * Phase 4 of the modal keys production cycle (Vim mode on, landing in normal
 * mode):
 * - Criterion 3: the palette opened and closed from the chat in normal mode
 *   leaves the chat scope in NORMAL with the chat cursor where it was.
 * - Criterion 4: the palette returns to the composer in the mode it left.
 * - Criterion 5, guard: a palette row that opens the file manager hands it the
 *   keyboard.
 * - Criterion 6: `Ctrl+K` from the terminal drawer and `Ctrl+L` from the
 *   sidebar land in the chat scope in NORMAL, never in the composer.
 * - Criterion 7, guards: with Vim mode off, closing the palette focuses the
 *   composer and the pane chords enter the composer, as upstream does.
 *
 * Boundaries the fixture replaces, and nothing else: the environment and
 * thread reads, every RPC command and query, the chords (the shipped
 * defaults, as a fresh keybindings file resolves them), unrelated chrome, the
 * CSS highlight registry happy-dom lacks (recorded instead of painted), the
 * sidebar's thread list (one focusable row), the terminal drawer (its root
 * and xterm's helper textarea, which is all the pane code reads), and the
 * file manager layer (its focusable root while the store is open; the vendor
 * app needs a live server). The setup follows
 * `AppRoot.commandRegistry.fence.test.tsx`.
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
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { Thread } from "./types";
import type { AppRouter } from "./router";

const fixture = vi.hoisted(() => ({
  thread: null as Thread | null,
  vimMode: false,
  empty: [],
  threadListeners: new Set<() => void>(),
  /** The ranges the key surfaces last painted, by highlight name. */
  highlights: new Map<string, ReadonlyArray<Range>>(),
  project: {
    id: "vim-landing-project",
    environmentId: "vim-landing-environment",
    title: "Vim landing",
    workspaceRoot: "/tmp/vim-landing",
    scripts: [],
    createdAt: "2026-10-08T12:00:00.000Z",
    defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" },
  },
  environments: [
    {
      environmentId: "vim-landing-environment",
      label: "Fence environment",
      connection: { phase: "connected" },
      entry: {
        target: {
          _tag: "PrimaryConnectionTarget",
          label: "Fence environment",
          connectionId: "saved:vim-landing-environment",
        },
      },
      displayUrl: null,
      relayManaged: false,
      serverConfig: {
        settings: {},
        environment: {
          capabilities: { threadSettlement: true, threadPinning: true },
          platform: { machine: "laptop" },
        },
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
vi.mock("./state/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state/queries")>()),
  useThreadSearch: () => ({ matches: [], isPending: false }),
  useProjectPathSearch: () => ({ entries: [], isPending: false, error: null, truncated: false }),
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
vi.mock("./hooks/useHandleNewThread", async () => {
  const { scopeThreadRef: scope } = await import("@t3tools/client-runtime/environment");
  const { EnvironmentId: Env, ThreadId: Thr } = await import("@t3tools/contracts");
  const routeThreadRef = scope(Env.make("vim-landing-environment"), Thr.make("vim-landing-thread"));
  return {
    useNewThreadHandler: () => success,
    useHandleNewThread: () => ({
      activeDraftThread: null,
      activeThread: fixture.thread,
      defaultProjectRef: null,
      handleNewThread: success,
      routeDraftId: null,
      routeThreadRef,
    }),
  };
});
vi.mock("./hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    settleThread: success,
    pinThread: success,
    confirmAndUnpinThread: success,
  }),
}));
// The sidebar's thread list, reduced to the open thread's row: the element
// pane focus enters the sidebar through.
vi.mock("./components/Sidebar", () => ({
  default: () => (
    <ul>
      <li data-thread-item="" data-thread-key="vim-landing-row">
        <div role="button" tabIndex={0} data-testid="sidebar-thread-row">
          Vim landing
        </div>
      </li>
    </ul>
  ),
}));
vi.mock("./components/LegacySidebar", () => ({ default: () => null }));
vi.mock("./components/preview/PreviewAutomationHosts", () => ({
  PreviewAutomationHosts: () => null,
}));
vi.mock("./browser/ElectronBrowserHost", () => ({ ElectronBrowserHost: () => null }));
vi.mock("./components/QuitHoldOverlay", () => ({ QuitHoldOverlay: () => null }));
vi.mock("./components/chat/ChatHeader", () => ({ ChatHeader: () => null }));
vi.mock("./components/BranchToolbar", () => ({ BranchToolbar: () => null }));
// The file manager layer: its focusable root while the store says open. No
// focus of its own on mount, so only the palette's close can hand it the
// keyboard here.
vi.mock("./components/files/mesuraFileManager/MesuraFileManagerLayer", async () => {
  const { useFileManagerStore } =
    await import("./components/files/mesuraFileManager/fileManagerStore");
  const { FILE_MANAGER_ROOT_ATTRIBUTE } =
    await import("./components/files/mesuraFileManager/isFileManagerOpen");
  return {
    MesuraFileManagerLayer: () => {
      const open = useFileManagerStore((state) => state.open);
      return open ? (
        <div {...{ [FILE_MANAGER_ROOT_ATTRIBUTE]: "" }} tabIndex={-1} data-testid="file-manager" />
      ) : null;
    },
  };
});
// happy-dom has no CSS Custom Highlight API. Record what would be painted.
vi.mock("./keys/highlights", () => ({
  paintHighlight: (name: string, ranges: readonly Range[]) => {
    fixture.highlights.set(
      name,
      ranges.map((range) => range.cloneRange()),
    );
  },
}));
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

import { AppRoot } from "./AppRoot";
import { AppSidebarLayout } from "./components/AppSidebarLayout";
import { CommandPalette } from "./components/CommandPalette";
import ChatView from "./components/ChatView";
import { useFileManagerStore } from "./components/files/mesuraFileManager/fileManagerStore";
import { installKeyEngine } from "./keys/keyEngine";
import { composerEditorElement } from "./keys/focusScope";
import { readKeyEngineSnapshot } from "./keys/keyEngineStore";
import { Route as ChatLayoutRoute } from "./routes/_chat";

const environmentId = EnvironmentId.make("vim-landing-environment");
const threadId = ThreadId.make("vim-landing-thread");
const now = "2026-10-08T12:00:00.000Z";
let root: Root | undefined;
let container: HTMLDivElement;

beforeAll(() => {
  installKeyEngine();
});

function makeMessage(id: string, role: "user" | "assistant", text: string) {
  return {
    id: MessageId.make(id),
    role,
    text,
    turnId: null,
    streaming: false,
    createdAt: now,
    updatedAt: now,
  };
}

function makeThread(): Thread {
  return {
    id: threadId,
    environmentId,
    projectId: ProjectId.make("vim-landing-project"),
    title: "Vim landing",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    // Enough lines that a cursor moved up from the last line is told apart
    // from a fresh cursor, which starts on the last line here: happy-dom
    // reports every line at the top of the screen.
    messages: [
      makeMessage("vim-landing-user", "user", "Fix the build"),
      makeMessage(
        "vim-landing-assistant",
        "assistant",
        "The first paragraph of the answer.\n\nThe second paragraph.\n\nThe third paragraph.\n\nThe last paragraph.",
      ),
    ],
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
  fixture.highlights.clear();
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => useFileManagerStore.getState().setOpen(false));
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  document.querySelector("[data-testid='terminal-drawer']")?.remove();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountApp(options: { readonly vimMode: boolean }) {
  fixture.vimMode = options.vimMode;
  const route = createRootRoute({
    component: () => (
      <CommandPalette>
        <AppSidebarLayout>
          <Outlet />
        </AppSidebarLayout>
      </CommandPalette>
    ),
  });
  // The real chat layout: its global shortcuts and the key engine's host.
  const chatLayout = createRoute({
    getParentRoute: () => route,
    id: "_chat",
    component: ChatLayoutRoute.options.component!,
  });
  const thread = createRoute({
    getParentRoute: () => chatLayout,
    path: "/$environmentId/$threadId",
    component: () => (
      <ChatView environmentId={environmentId} threadId={threadId} routeKind="server" />
    ),
  });
  const router = createRouter({
    routeTree: route.addChildren([chatLayout.addChildren([thread])]),
    history: createMemoryHistory({ initialEntries: [`/${environmentId}/${threadId}`] }),
  });
  await router.load();
  await act(async () => {
    root = createRoot(container);
    root.render(<AppRoot router={router as unknown as AppRouter} />);
  });
  await settle();
  // The chat holds the keyboard: nothing text-editable is focused.
  (document.activeElement as HTMLElement | null)?.blur?.();
}

interface Chord {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
}

/** Dispatches one keydown from the focused element, as the browser does. */
async function press(chord: Chord) {
  const event = new KeyboardEvent("keydown", { ...chord, bubbles: true, cancelable: true });
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
  await settle();
  return event;
}

const key = (letter: string): Chord => ({ key: letter, code: `Key${letter.toUpperCase()}` });
const ESCAPE: Chord = { key: "Escape", code: "Escape" };
// Mod is Control here: happy-dom reports a non-Mac platform.
const PALETTE_CHORD: Chord = { key: "o", code: "KeyO", ctrlKey: true };
const PANE_UP_CHORD: Chord = { key: "k", code: "KeyK", ctrlKey: true };
const PANE_RIGHT_CHORD: Chord = { key: "l", code: "KeyL", ctrlKey: true };

function palette(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="command-palette"]');
}

async function openPalette() {
  await press(PALETTE_CHORD);
  expect(palette(), "the palette chord opened the palette").not.toBeNull();
}

async function closePalette() {
  await press(ESCAPE);
  expect(palette(), "Escape closed the palette").toBeNull();
}

function composer(): HTMLElement {
  const editor = composerEditorElement();
  expect(editor, "the composer editor is mounted").not.toBeNull();
  return editor!;
}

function focusIsInComposer(): boolean {
  return composer().contains(document.activeElement);
}

async function focusComposer() {
  await act(async () => composer().focus());
  await settle();
}

/** Where the chat cursor was last painted: its text node and offset. */
function chatCursor(): { readonly node: Node; readonly offset: number } | null {
  const range = fixture.highlights.get("mesura-chat-cursor")?.[0];
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/** Mounts the terminal drawer's root inside the chat column, with xterm's helper textarea. */
function mountTerminalDrawer(): HTMLTextAreaElement {
  const column = document.querySelector<HTMLElement>("[data-chat-column-maximized-away]");
  expect(column, "the chat column is mounted").not.toBeNull();
  const drawer = document.createElement("div");
  drawer.dataset.terminalOwner = "drawer";
  drawer.dataset.testid = "terminal-drawer";
  const textarea = document.createElement("textarea");
  drawer.append(textarea);
  column!.append(drawer);
  return textarea;
}

function sidebarRow(): HTMLElement {
  const row = document.querySelector<HTMLElement>('[data-testid="sidebar-thread-row"]');
  expect(row, "the sidebar thread row is mounted").not.toBeNull();
  return row!;
}

describe("vim landing fence: the palette returns where it was opened", () => {
  it("vim landing fence spec: palette from the chat in normal mode returns to the chat in NORMAL with the cursor kept", async () => {
    await mountApp({ vimMode: true });
    // Two lines up from where a fresh cursor starts.
    await press(key("k"));
    await press(key("k"));
    const before = chatCursor();
    expect(before, "the chat cursor was painted").not.toBeNull();
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "chat", mode: "NORMAL" });

    await openPalette();
    await closePalette();

    expect(focusIsInComposer()).toBe(false);
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "chat", mode: "NORMAL" });
    // A cursor kept at `before` returns to it after one line down and one up;
    // a fresh cursor, on the last line, would not.
    await press(key("j"));
    await press(key("k"));
    expect(chatCursor()).toEqual(before);
  });

  it("vim landing fence spec: palette from the composer in normal mode returns to the composer in NORMAL", async () => {
    await mountApp({ vimMode: true });
    await focusComposer();
    await press(ESCAPE);
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "NORMAL" });

    await openPalette();
    await closePalette();

    expect(focusIsInComposer()).toBe(true);
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "NORMAL" });
  });

  it("vim landing fence guard: palette from the composer in insert mode returns to the composer in INSERT", async () => {
    await mountApp({ vimMode: true });
    await focusComposer();
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "INSERT" });

    await openPalette();
    await closePalette();

    expect(focusIsInComposer()).toBe(true);
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "INSERT" });
  });
});

describe("vim landing fence: a file manager row keeps the keyboard", () => {
  for (const vimMode of [true, false]) {
    const label = vimMode ? "Vim mode on" : "Vim mode off";

    it(`vim landing fence guard: the Open file manager row hands the file manager the keyboard with ${label}`, async () => {
      await mountApp({ vimMode });
      await openPalette();
      const row = [...palette()!.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
        option.textContent?.includes("Open file manager"),
      );
      expect(row, `the palette offers the row; rendered: ${palette()!.textContent}`).toBeDefined();
      await act(async () => row!.click());
      await settle();

      expect(palette()).toBeNull();
      const fileManager = document.querySelector('[data-testid="file-manager"]');
      expect(fileManager).not.toBeNull();
      expect(document.activeElement).toBe(fileManager);
    });
  }
});

describe("vim landing fence: pane chords into the chat land in normal mode", () => {
  it("vim landing fence spec: Ctrl+K from the terminal drawer lands in the chat scope in NORMAL", async () => {
    await mountApp({ vimMode: true });
    const terminal = mountTerminalDrawer();
    await act(async () => terminal.focus());

    const event = await press(PANE_UP_CHORD);

    expect(event.defaultPrevented).toBe(true);
    expect(focusIsInComposer()).toBe(false);
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "chat", mode: "NORMAL" });
  });

  it("vim landing fence spec: Ctrl+L from the sidebar lands in the chat scope in NORMAL", async () => {
    await mountApp({ vimMode: true });
    await act(async () => sidebarRow().focus());

    const event = await press(PANE_RIGHT_CHORD);

    expect(event.defaultPrevented).toBe(true);
    expect(focusIsInComposer()).toBe(false);
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "chat", mode: "NORMAL" });
  });
});

describe("vim landing fence: review regressions", () => {
  // Review P1-1: the engine consumes Escape and `i`, so a resume armed by the
  // palette's close must not outlive them.
  it("vim landing fence regression: after a palette round trip from composer NORMAL, Escape then i enters the composer in INSERT", async () => {
    await mountApp({ vimMode: true });
    await focusComposer();
    await press(ESCAPE);
    await openPalette();
    await closePalette();
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "NORMAL" });

    await press(ESCAPE);
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "chat", mode: "NORMAL" });
    await press(key("i"));
    expect(focusIsInComposer()).toBe(true);
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "INSERT" });
    // Typing reaches the editor: the engine passes insert-mode keys through.
    expect((await press(key("x"))).defaultPrevented).toBe(false);
  });

  // Review P1-2: entering the chat by a pane chord lands in NORMAL even when
  // the chat was left in VISUAL.
  it("vim landing fence regression: Ctrl+L from the sidebar after leaving the chat in VISUAL lands in NORMAL", async () => {
    await mountApp({ vimMode: true });
    await press(key("v"));
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "chat", mode: "VISUAL" });
    await act(async () => sidebarRow().focus());

    await press(PANE_RIGHT_CHORD);

    expect(focusIsInComposer()).toBe(false);
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "chat", mode: "NORMAL" });
  });

  it("vim landing fence regression: Ctrl+K from the terminal drawer after leaving the chat in VISUAL lands in NORMAL", async () => {
    await mountApp({ vimMode: true });
    await press(key("v"));
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "chat", mode: "VISUAL" });
    const terminal = mountTerminalDrawer();
    await act(async () => terminal.focus());

    await press(PANE_UP_CHORD);

    expect(focusIsInComposer()).toBe(false);
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "chat", mode: "NORMAL" });
  });
});

describe("vim landing fence: Vim mode off behaves as upstream", () => {
  it("vim landing fence guard: closing the palette focuses the composer with Vim mode off", async () => {
    await mountApp({ vimMode: false });
    await openPalette();
    await closePalette();
    expect(focusIsInComposer()).toBe(true);
  });

  it("vim landing fence guard: Ctrl+K from the terminal drawer enters the composer with Vim mode off", async () => {
    await mountApp({ vimMode: false });
    const terminal = mountTerminalDrawer();
    await act(async () => terminal.focus());
    const event = await press(PANE_UP_CHORD);
    expect(event.defaultPrevented).toBe(true);
    expect(focusIsInComposer()).toBe(true);
  });

  it("vim landing fence guard: Ctrl+L from the sidebar enters the composer with Vim mode off", async () => {
    await mountApp({ vimMode: false });
    await act(async () => sidebarRow().focus());
    const event = await press(PANE_RIGHT_CHORD);
    expect(event.defaultPrevented).toBe(true);
    expect(focusIsInComposer()).toBe(true);
  });
});
