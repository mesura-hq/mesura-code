// @vitest-environment happy-dom
/**
 * Entry point: AppRoot, with a memory router whose root renders the real
 * CommandPalette around the real AppSidebarLayout, as `routes/__root.tsx`
 * does, and whose chat layout is the real `_chat.tsx` route component (the
 * real KeyEngineHost around the real ChatView, and in it the real
 * ChatComposer, which registers the real Vim adapter). The thread route reads
 * the environment and thread ids from its params, as
 * `routes/_chat.$environmentId.$threadId.tsx` does, so opening another thread
 * is a router navigation. The key engine is installed on `window` before
 * React renders, as `main.tsx` does. Keys are real `keydown` events
 * dispatched from the focused element.
 *
 * Phase 6 of the modal keys production cycle (composer undo spans normal-mode
 * sessions), through the real composer and its adapter:
 * - Criterion 1: an insert session is one undo step.
 * - Criterion 3: `Ctrl+R` redoes it.
 * - Criterion 5: sending the prompt, and switching thread, start a fresh
 *   history for the new draft; returning to a thread walks back its own.
 * - Criterion 6: a mention and a citation survive undo and redo as the same
 *   tokens, and the editor draws them as chips again.
 * - The palette round trip (`resumeComposerNormalOnFocus`) pushes no step and
 *   the history survives it.
 * - Guard: `u` inside one normal-mode session undoes the last change.
 * `keys/composer/composerUndo.test.ts` covers every criterion at the surface.
 *
 * Typing is the one input this file does not drive by keys: happy-dom gives
 * Lexical no text input. A typed insert session is the draft's prompt
 * changing while the composer is in INSERT, which is what the editor's own
 * typing does to the draft.
 *
 * Boundaries the fixture replaces, and nothing else: the environment and
 * thread reads (looked up by the thread ref), every RPC command and query,
 * the chords (the shipped defaults), unrelated chrome, the CSS highlight
 * registry happy-dom lacks (recorded instead of painted), the sidebar's
 * thread list, the file manager layer and the virtual list's measurement.
 * The setup follows `AppRoot.chatCursorMemory.fence.test.tsx`.
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
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { Thread } from "./types";
import type { AppRouter } from "./router";

const fixture = vi.hoisted(() => ({
  threads: new Map<string, Thread>(),
  openThreadId: "",
  vimMode: false,
  empty: [],
  threadListeners: new Set<() => void>(),
  /** The ranges the key surfaces last painted, by highlight name. */
  highlights: new Map<string, ReadonlyArray<Range>>(),
  project: {
    id: "composer-undo-project",
    environmentId: "composer-undo-environment",
    title: "Composer undo",
    workspaceRoot: "/tmp/composer-undo",
    scripts: [],
    createdAt: "2026-10-08T12:00:00.000Z",
    defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" },
  },
  environments: [
    {
      environmentId: "composer-undo-environment",
      label: "Fence environment",
      connection: { phase: "connected" },
      entry: {
        target: {
          _tag: "PrimaryConnectionTarget",
          label: "Fence environment",
          connectionId: "saved:composer-undo-environment",
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
  const threadFor = (ref: { readonly threadId: string } | null | undefined) =>
    (ref ? fixture.threads.get(ref.threadId) : undefined) ?? null;
  const useFixtureThread = (ref: { readonly threadId: string } | null | undefined) =>
    useSyncExternalStore(
      (listener) => {
        fixture.threadListeners.add(listener);
        return () => {
          fixture.threadListeners.delete(listener);
        };
      },
      () => threadFor(ref),
    );
  return {
    ...(await importOriginal<typeof import("./state/entities")>()),
    useThread: useFixtureThread,
    readThread: threadFor,
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
  return {
    useNewThreadHandler: () => success,
    useHandleNewThread: () => ({
      activeDraftThread: null,
      activeThread: fixture.threads.get(fixture.openThreadId) ?? null,
      defaultProjectRef: null,
      handleNewThread: success,
      routeDraftId: null,
      routeThreadRef: scope(Env.make("composer-undo-environment"), Thr.make(fixture.openThreadId)),
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
      <li data-thread-item="" data-thread-key="composer-undo-row">
        <div role="button" tabIndex={0} data-testid="sidebar-thread-row">
          Composer undo
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
import { splitPromptIntoComposerSegments } from "./composer-editor-mentions";
import { useComposerDraftStore } from "./composerDraftStore";
import { composerEditorElement } from "./keys/focusScope";
import { installKeyEngine } from "./keys/keyEngine";
import { readKeyEngineSnapshot } from "./keys/keyEngineStore";
import { Route as ChatLayoutRoute } from "./routes/_chat";

const environmentId = EnvironmentId.make("composer-undo-environment");
const now = "2026-10-08T12:00:00.000Z";
let root: Root | undefined;
let router: ReturnType<typeof createFixtureRouter> | undefined;
let container: HTMLDivElement;
let threadSequence = 0;

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

/** Registers a thread with an id no other test uses, and returns that id. */
function addThread(label: string, assistantText: string): ThreadId {
  threadSequence += 1;
  const id = ThreadId.make(`composer-undo-${label}-${threadSequence}`);
  fixture.threads.set(id, {
    id,
    environmentId,
    projectId: ProjectId.make("composer-undo-project"),
    title: `Composer undo ${label}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [
      makeMessage(`${id}-user`, "user", `Question for ${label}`),
      makeMessage(`${id}-assistant`, "assistant", assistantText),
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
  } as unknown as Thread);
  return id;
}

/**
 * A thread whose assistant reply has four one-line paragraphs, so a cursor
 * moved up from the last line is told apart from a fresh one.
 */
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.vimMode = false;
  fixture.highlights.clear();
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  router = undefined;
  container.remove();
  fixture.threads.clear();
  fixture.environments[0]!.connection.phase = "connected";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function createFixtureRouter(firstThreadId: ThreadId) {
  const route = createRootRoute({
    component: () => (
      <CommandPalette>
        <AppSidebarLayout>
          <Outlet />
        </AppSidebarLayout>
      </CommandPalette>
    ),
  });
  const chatLayout = createRoute({
    getParentRoute: () => route,
    id: "_chat",
    component: ChatLayoutRoute.options.component!,
  });
  const thread = createRoute({
    getParentRoute: () => chatLayout,
    path: "/$environmentId/$threadId",
    component: function FixtureThreadRoute() {
      const params = thread.useParams();
      return (
        <ChatView
          environmentId={EnvironmentId.make(params.environmentId)}
          threadId={ThreadId.make(params.threadId)}
          routeKind="server"
        />
      );
    },
  });
  return createRouter({
    routeTree: route.addChildren([chatLayout.addChildren([thread])]),
    history: createMemoryHistory({ initialEntries: [`/${environmentId}/${firstThreadId}`] }),
  });
}

/** Mounts the app on `threadId` with Vim mode on, the chat holding the keyboard. */
async function mountApp(threadId: ThreadId) {
  fixture.vimMode = true;
  fixture.openThreadId = threadId;
  router = createFixtureRouter(threadId);
  await router.load();
  await act(async () => {
    root = createRoot(container);
    root.render(<AppRoot router={router as unknown as AppRouter} />);
  });
  await settle();
  (document.activeElement as HTMLElement | null)?.blur?.();
}

/** Opens another thread the way the sidebar does: a navigation to its route. */
async function openThread(threadId: ThreadId) {
  fixture.openThreadId = threadId;
  await act(async () => {
    await router!.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
    } as never);
  });
  await settle();
  (document.activeElement as HTMLElement | null)?.blur?.();
  expect(
    document.querySelector(`[data-timeline-row-id*="${threadId}"]`),
    `thread ${threadId} is on screen`,
  ).not.toBeNull();
}

interface Chord {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey?: boolean;
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

const key = (letter: string): Chord => ({
  key: letter,
  code: /^\d$/.test(letter) ? `Digit${letter}` : `Key${letter.toUpperCase()}`,
});

const ESCAPE: Chord = { key: "Escape", code: "Escape" };
const REDO: Chord = { key: "r", code: "KeyR", ctrlKey: true };
// Mod is Control here: happy-dom reports a non-Mac platform.
const PALETTE_CHORD: Chord = { key: "o", code: "KeyO", ctrlKey: true };

const citationSource = serializeAssistantCitation({
  version: 1,
  environmentId,
  threadId: ThreadId.make("composer-undo-cited-thread"),
  messageId: MessageId.make("composer-undo-cited-message"),
  text: "Run the migration first",
  start: 0,
  end: 23,
  prefix: "",
  suffix: "",
});

function draftOf(threadId: ThreadId) {
  return scopeThreadRef(environmentId, threadId);
}

/** The prompt the draft store holds for a thread: what the composer shows and sends. */
function promptOf(threadId: ThreadId): string {
  return useComposerDraftStore.getState().getComposerDraft(draftOf(threadId))?.prompt ?? "";
}

function composer(): HTMLElement {
  const editor = composerEditorElement();
  expect(editor, "the composer editor is mounted").not.toBeNull();
  return editor!;
}

async function focusComposer() {
  await act(async () => composer().focus());
  await settle();
  expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "INSERT" });
}

/** Sets a thread's draft before the composer is focused: text already in it. */
async function seedDraft(threadId: ThreadId, prompt: string) {
  await act(async () => useComposerDraftStore.getState().setPrompt(draftOf(threadId), prompt));
  await settle();
}

/**
 * An insert session's typing: the draft changes while the composer is in INSERT.
 * The editor's caret does not follow a draft written this way, so a spec moves
 * the normal-mode cursor with a motion before it edits.
 */
async function typeInComposer(threadId: ThreadId, prompt: string) {
  expect(readKeyEngineSnapshot(), "typing happens in insert mode").toMatchObject({
    scope: "composer",
    mode: "INSERT",
  });
  await seedDraft(threadId, prompt);
}

async function pressKeys(...letters: string[]) {
  for (const letter of letters) await press(key(letter));
}

/** Ends a normal-mode session and starts an empty insert session: `i` then Escape. */
async function emptyInsertSession() {
  await press(key("i"));
  expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "INSERT" });
  await press(ESCAPE);
  expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "NORMAL" });
}

/** Sends the draft the way the send button does: a submit of the composer's form. */
async function sendPrompt() {
  const form = composer().closest("form");
  expect(form, "the composer is inside its form").not.toBeNull();
  await act(async () => form!.requestSubmit());
  await settle();
}

function palette(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="command-palette"]');
}

/** The non-editable elements the editor draws for inline tokens' chips. */
function composerChipCount(): number {
  return composer().querySelectorAll('[contenteditable="false"]').length;
}

describe("composer undo app fence: one history per draft", () => {
  it("composer undo app fence spec: an insert session in the real composer is one undo step, and Ctrl+R redoes it", async () => {
    const thread = addThread("insert", "An answer.");
    await mountApp(thread);
    await seedDraft(thread, "Fix the");
    await focusComposer();
    await typeInComposer(thread, "Fix the build please");
    await press(ESCAPE);
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "NORMAL" });

    await press(key("u"));
    expect(promptOf(thread)).toBe("Fix the");
    await press(REDO);
    expect(promptOf(thread)).toBe("Fix the build please");
  });

  it("composer undo app fence spec: sending the prompt starts a fresh history for the next draft", async () => {
    const thread = addThread("send", "An answer.");
    await mountApp(thread);
    await focusComposer();
    await typeInComposer(thread, "first message");
    await press(ESCAPE);
    await pressKeys("$", "x");
    expect(promptOf(thread)).toBe("first messag");
    await press(key("a"));
    await sendPrompt();
    expect(promptOf(thread), "the send cleared the draft").toBe("");

    await focusComposer();
    await typeInComposer(thread, "second");
    await press(ESCAPE);
    await press(key("u"));
    expect(promptOf(thread)).toBe("");
    await press(key("u"));
    expect(promptOf(thread), "the sent text never comes back").toBe("");
  });

  it("composer undo app fence spec: switching thread starts a fresh history for the other thread's draft", async () => {
    const threadA = addThread("switch-a", "Answer A.");
    const threadB = addThread("switch-b", "Answer B.");
    await mountApp(threadA);
    await focusComposer();
    await typeInComposer(threadA, "alpha");
    await press(ESCAPE);
    await pressKeys("$", "x");
    expect(promptOf(threadA)).toBe("alph");

    await openThread(threadB);
    await focusComposer();
    await typeInComposer(threadB, "beta");
    await press(ESCAPE);
    await press(key("u"));
    expect(promptOf(threadB)).toBe("");
    await press(key("u"));
    expect(promptOf(threadB), "thread A's history never reaches thread B's draft").toBe("");
    expect(promptOf(threadA)).toBe("alph");
  });

  it("composer undo app fence spec: returning to a thread walks back that thread's own history", async () => {
    const threadA = addThread("return-a", "Answer A.");
    const threadB = addThread("return-b", "Answer B.");
    await mountApp(threadA);
    await focusComposer();
    await typeInComposer(threadA, "alpha");
    await press(ESCAPE);
    await pressKeys("$", "x");
    expect(promptOf(threadA)).toBe("alph");

    await openThread(threadB);
    await focusComposer();
    await typeInComposer(threadB, "beta");
    await press(ESCAPE);

    await openThread(threadA);
    await focusComposer();
    await press(ESCAPE);
    await press(key("u"));
    expect(promptOf(threadA)).toBe("alpha");
    await press(key("u"));
    expect(promptOf(threadA)).toBe("");
    expect(promptOf(threadB)).toBe("beta");
  });

  it("composer undo app fence spec: a palette round trip pushes no undo step and keeps the history", async () => {
    const thread = addThread("palette", "An answer.");
    await mountApp(thread);
    await focusComposer();
    await typeInComposer(thread, "alpha");
    await press(ESCAPE);
    await pressKeys("$", "x");
    expect(promptOf(thread)).toBe("alph");

    await press(PALETTE_CHORD);
    expect(palette(), "the palette chord opened the palette").not.toBeNull();
    await press(ESCAPE);
    expect(palette(), "Escape closed the palette").toBeNull();
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "NORMAL" });

    await press(key("u"));
    expect(promptOf(thread)).toBe("alpha");
    await press(key("u"));
    expect(promptOf(thread)).toBe("");
  });
});

describe("composer undo app fence: inline tokens", () => {
  it("composer undo app fence spec: a mention and a citation come back as the same tokens and chips after undo and redo", async () => {
    const thread = addThread("tokens", "An answer.");
    const prompt = `@AGENTS.md ${citationSource} tail`;
    await mountApp(thread);
    await seedDraft(thread, prompt);
    await focusComposer();
    const chips = composerChipCount();
    expect(chips, "the editor draws the mention and the citation as chips").toBeGreaterThan(0);
    await press(ESCAPE);
    await pressKeys("0", "x");
    expect(promptOf(thread)).toBe(` ${citationSource} tail`);
    await emptyInsertSession();

    await press(key("u"));
    expect(promptOf(thread)).toBe(prompt);
    expect(composerChipCount()).toBe(chips);
    await press(REDO);
    expect(promptOf(thread)).toBe(` ${citationSource} tail`);
    await press(key("u"));
    expect(promptOf(thread)).toBe(prompt);
    expect(splitPromptIntoComposerSegments(promptOf(thread))).toEqual(
      splitPromptIntoComposerSegments(prompt),
    );
    expect(composerChipCount()).toBe(chips);
  });
});

describe("composer undo app fence: guards", () => {
  it("composer undo app fence guard: u inside one normal-mode session undoes the last change in the real composer", async () => {
    const thread = addThread("guard", "An answer.");
    await mountApp(thread);
    await seedDraft(thread, "hello world");
    await focusComposer();
    await press(ESCAPE);
    await pressKeys("0", "d", "w");
    expect(promptOf(thread)).toBe("world");

    await press(key("u"));
    expect(promptOf(thread)).toBe("hello world");
    await press(REDO);
    expect(promptOf(thread)).toBe("world");
  });
});

// Review finding P1-1 on the first implementation: the history was cleared as
// soon as the send was dispatched, even when the send kept the draft.
describe("composer undo app fence: review regressions", () => {
  it("composer undo app fence regression: a send refused while the environment reconnects keeps the draft's history", async () => {
    fixture.environments[0]!.connection.phase = "reconnecting";
    const thread = addThread("refused", "An answer.");
    await mountApp(thread);
    await focusComposer();
    await typeInComposer(thread, "alpha");
    await press(ESCAPE);
    await pressKeys("$", "x");
    expect(promptOf(thread)).toBe("alph");
    await press(key("a"));
    await sendPrompt();
    expect(promptOf(thread), "the refused send kept the draft").toBe("alph");

    await press(ESCAPE);
    await press(key("u"));
    expect(promptOf(thread)).toBe("alpha");
    await press(key("u"));
    expect(promptOf(thread)).toBe("");
  });
});
