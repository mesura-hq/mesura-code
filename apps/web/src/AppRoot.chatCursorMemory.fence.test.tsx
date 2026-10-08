// @vitest-environment happy-dom
/**
 * Entry point: AppRoot, with a memory router whose root renders the real
 * CommandPalette around the real AppSidebarLayout, as `routes/__root.tsx`
 * does, and whose chat layout is the real `_chat.tsx` route component (the
 * real KeyEngineHost around the real ChatView). The thread route reads the
 * environment and thread ids from its params, as
 * `routes/_chat.$environmentId.$threadId.tsx` does, so opening another thread
 * is a router navigation that re-renders the same ChatView with new ids. The
 * key engine is installed on `window` before React renders, as `main.tsx`
 * does. Keys are real `keydown` events dispatched from the focused element.
 *
 * Phase 5 of the modal keys production cycle (the chat cursor per thread, and
 * soft breaks read as spaces):
 * - Criterion 1: open thread A, move the cursor, open thread B, return to A:
 *   the cursor is on the same row and offset as before.
 * - Criterion 2, guard: a thread opened for the first time starts at the first
 *   visible line, as today.
 * - Criterion 3, guard: the memory is never written to storage.
 * - Criterion 4 at the app: a Markdown paragraph whose source has a single
 *   newline is one buffer line, and `j` from it lands on the next block.
 * - Criterion 6 at the app: a visual selection across a former soft break,
 *   cited with `<Space>c`, cites the exact rendered text through the real
 *   cite path (the chat cite bus, AssistantSelectionToolbar, the composer).
 *
 * happy-dom has no layout, so the chat surface's first visible line falls
 * back to the last buffer line: that is where a fresh cursor starts here.
 * Every test opens threads with ids no other test uses, because the chat
 * surface's state is module-level and lives for the whole file.
 *
 * Boundaries the fixture replaces, and nothing else: the environment and
 * thread reads (looked up by the thread ref), every RPC command and query,
 * the chords (the shipped defaults), unrelated chrome, the CSS highlight
 * registry happy-dom lacks (recorded instead of painted), the sidebar's
 * thread list, the file manager layer and the virtual list's measurement.
 * The setup follows `AppRoot.vimModeLanding.fence.test.tsx`.
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
import { collectAssistantCitations } from "@t3tools/shared/assistantCitations";
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
    id: "thread-recall-project",
    environmentId: "thread-recall-environment",
    title: "Cursor memory",
    workspaceRoot: "/tmp/thread-recall",
    scripts: [],
    createdAt: "2026-10-08T12:00:00.000Z",
    defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" },
  },
  environments: [
    {
      environmentId: "thread-recall-environment",
      label: "Fence environment",
      connection: { phase: "connected" },
      entry: {
        target: {
          _tag: "PrimaryConnectionTarget",
          label: "Fence environment",
          connectionId: "saved:thread-recall-environment",
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
      routeThreadRef: scope(Env.make("thread-recall-environment"), Thr.make(fixture.openThreadId)),
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
      <li data-thread-item="" data-thread-key="thread-recall-row">
        <div role="button" tabIndex={0} data-testid="sidebar-thread-row">
          Cursor memory
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
import { useComposerDraftStore } from "./composerDraftStore";
import { installKeyEngine } from "./keys/keyEngine";
import { readKeyEngineSnapshot } from "./keys/keyEngineStore";
import { readAssistantText } from "./lib/assistantTextSelection";
import { Route as ChatLayoutRoute } from "./routes/_chat";

const environmentId = EnvironmentId.make("thread-recall-environment");
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
  const id = ThreadId.make(`thread-recall-${label}-${threadSequence}`);
  fixture.threads.set(id, {
    id,
    environmentId,
    projectId: ProjectId.make("thread-recall-project"),
    title: `Cursor memory ${label}`,
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
function addParagraphThread(label: string): ThreadId {
  return addThread(
    label,
    [
      `${label} first paragraph.`,
      `${label} second paragraph.`,
      `${label} third paragraph.`,
      `${label} last paragraph.`,
    ].join("\n\n"),
  );
}

const SOFT_PARAGRAPH = "Cite the first half\nand the second half.";
const SOFT_PARAGRAPH_RENDERED = "Cite the first half and the second half.";

/** A thread whose reply opens with a paragraph that has one soft break. */
function addSoftBreakThread(): ThreadId {
  return addThread("soft", [SOFT_PARAGRAPH, "The next block.", "The closing block."].join("\n\n"));
}

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
const DOLLAR: Chord = { key: "$", code: "Digit4" };
const SPACE: Chord = { key: " ", code: "Space" };

interface PaintedCursor {
  /** The timeline row the cursor is in. */
  readonly rowId: string;
  /** The cursor's offset in that row's projected text. */
  readonly offset: number;
  /** The text node the cursor is painted in, for a readable failure. */
  readonly text: string;
}

/** Where the chat cursor was last painted, as a row and an offset into its text. */
function paintedCursor(): PaintedCursor | null {
  const range = fixture.highlights.get("mesura-chat-cursor")?.[0];
  if (!range) return null;
  const node = range.startContainer;
  const row = node.parentElement?.closest<HTMLElement>("[data-timeline-row-id]");
  expect(row, "the cursor is painted inside a timeline row").toBeTruthy();
  const source = row!.querySelector<HTMLElement>("[data-assistant-citation-source]") ?? row!;
  const chunk = readAssistantText(source).chunks.find((candidate) => candidate.node === node);
  expect(chunk, "the cursor's text node is part of the row's projected text").toBeDefined();
  return {
    rowId: row!.dataset.timelineRowId ?? "",
    offset: chunk!.start + range.startOffset,
    text: node.textContent ?? "",
  };
}

/** The row ids of every timeline row on screen. */
function timelineRowIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[data-timeline-row-id]")].map(
    (row) => row.dataset.timelineRowId ?? "",
  );
}

describe("cursor memory fence: the chat cursor per thread", () => {
  it("cursor memory fence spec: returning to thread A puts the cursor on the row and offset it had", async () => {
    const threadA = addParagraphThread("A");
    const threadB = addParagraphThread("B");
    await mountApp(threadA);
    // Two lines up from where a fresh cursor starts.
    await press(key("k"));
    await press(key("k"));
    const before = paintedCursor();
    expect(before?.text).toBe("A second paragraph.");

    await openThread(threadB);
    await press(key("k"));
    expect(paintedCursor()?.text, "the cursor moved in thread B").toBe("B third paragraph.");

    await openThread(threadA);
    // `h` at the start of a line does not move: it paints where the cursor is.
    await press(key("h"));
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "chat", mode: "NORMAL" });
    expect(paintedCursor()).toEqual(before);
  });

  it("cursor memory fence spec: returning to thread B after thread A puts B's cursor back too", async () => {
    const threadA = addParagraphThread("A");
    const threadB = addParagraphThread("B");
    await mountApp(threadA);
    await press(key("k"));

    await openThread(threadB);
    await press(key("k"));
    await press(key("k"));
    const inB = paintedCursor();
    expect(inB?.text).toBe("B second paragraph.");

    await openThread(threadA);
    await press(key("h"));
    await openThread(threadB);
    await press(key("h"));
    expect(paintedCursor()).toEqual(inB);
  });

  // Review P1-1: a key that leaves the fallback cursor where it is must not
  // replace the remembered position of a row that is not mounted.
  it("cursor memory fence regression: a remembered row that unmounts and mounts again gets its cursor back", async () => {
    const threadA = addParagraphThread("A");
    const threadB = addParagraphThread("B");
    await mountApp(threadA);
    await press(key("k"));
    await press(key("k"));
    const before = paintedCursor();
    expect(before?.text).toBe("A second paragraph.");
    await openThread(threadB);
    await press(key("k"));

    // Thread A comes back without the remembered row: the cursor falls back
    // to the first visible line, and `h` there moves nothing.
    const original = fixture.threads.get(threadA)!;
    fixture.threads.set(threadA, {
      ...original,
      messages: [
        original.messages[0]!,
        makeMessage(`${threadA}-replacement`, "assistant", "A replacement reply."),
      ],
    } as Thread);
    await openThread(threadA);
    await press(key("h"));
    expect(paintedCursor()?.text).toBe("A replacement reply.");

    // The remembered row mounts again.
    fixture.threads.set(threadA, original);
    await act(async () => {
      for (const listener of fixture.threadListeners) listener();
    });
    await settle();
    await press(key("h"));
    expect(paintedCursor()).toEqual(before);
  });

  // Already true at the base, and must stay so: a guard.
  it("cursor memory fence guard: a thread opened for the first time starts at the first visible line", async () => {
    const threadA = addParagraphThread("A");
    const threadC = addParagraphThread("C");
    await mountApp(threadA);
    await press(key("k"));
    await press(key("k"));

    await openThread(threadC);
    await press(key("h"));

    // happy-dom has no layout: the first visible line falls back to the last.
    const cursor = paintedCursor();
    expect(cursor?.rowId).toContain(threadC);
    expect(cursor?.text).toBe("C last paragraph.");
    expect(cursor?.offset).toBe(readAssistantRowText(cursor!.rowId).indexOf("C last paragraph."));
  });

  // Already true at the base (nothing is remembered), and must stay so: a guard.
  it("cursor memory fence guard: remembering the cursor writes nothing to localStorage or sessionStorage", async () => {
    // Node's test globals leave `localStorage` undefined, so both stores are
    // replaced with recording ones: a write to either is seen.
    const writes: string[] = [];
    for (const name of ["localStorage", "sessionStorage"] as const) {
      const store = recordingStorage(name, writes);
      vi.stubGlobal(name, store);
      expect(window[name], `window.${name} is the recording store`).toBe(store);
    }
    window.localStorage.setItem("thread-recall-probe", "1");
    window.sessionStorage.setItem("thread-recall-probe", "1");
    expect(writes).toEqual([
      "localStorage:thread-recall-probe=1",
      "sessionStorage:thread-recall-probe=1",
    ]);
    writes.length = 0;

    const threadA = addParagraphThread("A");
    const threadB = addParagraphThread("B");
    await mountApp(threadA);
    const rowIds = new Set(timelineRowIds());
    await press(key("k"));
    await press(key("k"));
    await openThread(threadB);
    for (const rowId of timelineRowIds()) rowIds.add(rowId);
    await press(key("k"));
    await openThread(threadA);
    await press(key("h"));

    for (const write of writes) {
      expect(write, "a storage write names the chat cursor").not.toMatch(/cursor/i);
      for (const rowId of rowIds) {
        expect(write.includes(rowId), `a storage write holds the row id ${rowId}`).toBe(false);
      }
    }
  });
});

/** A Web Storage that records every write as `<store>:<key>=<value>`. */
function recordingStorage(name: string, writes: string[]): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (storageKey) => items.get(storageKey) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (storageKey) => {
      items.delete(storageKey);
    },
    setItem: (storageKey, value) => {
      writes.push(`${name}:${storageKey}=${value}`);
      items.set(storageKey, String(value));
    },
  };
}

/** A row's projected text, read the way the chat buffer reads it. */
function readAssistantRowText(rowId: string): string {
  const row = document.querySelector<HTMLElement>(`[data-timeline-row-id="${rowId}"]`)!;
  const source = row.querySelector<HTMLElement>("[data-assistant-citation-source]") ?? row;
  return readAssistantText(source).text;
}

// Review P1-2: a separator line mapped back to the row after it, so `k`
// from a row's first line never reached the row before.
describe("cursor memory fence: vertical motion across rows", () => {
  it("cursor memory fence regression: k from a row's first line crosses the separator into the row before, and j comes back", async () => {
    const thread = addParagraphThread("R");
    await mountApp(thread);
    for (let step = 0; step < 3; step += 1) await press(key("k"));
    expect(paintedCursor()?.text).toBe("R first paragraph.");

    // The separator between rows has no character, so nothing is painted.
    await press(key("k"));
    expect(paintedCursor()).toBeNull();
    await press(key("k"));
    // The user row's last line: the time it was sent.
    expect(paintedCursor()?.rowId).toContain("-user");
    await press(key("k"));
    const question = paintedCursor();
    expect(question?.text).toBe("Question for R");
    // The start of that line, after the row's screen-reader author heading.
    expect(question?.offset).toBe(readAssistantRowText(question!.rowId).indexOf("Question for R"));
    await press(key("j"));
    expect(paintedCursor()?.rowId).toContain("-user");

    await press(key("j"));
    expect(paintedCursor()).toBeNull();
    await press(key("j"));
    expect(paintedCursor()?.text).toBe("R first paragraph.");
  });
});

describe("cursor memory fence: soft breaks read as spaces", () => {
  it("cursor memory fence spec: a paragraph with one soft break is one line and j from it lands on the next block", async () => {
    const thread = addSoftBreakThread();
    await mountApp(thread);
    // From the last line, two lines up is the paragraph when it is one line.
    await press(key("k"));
    expect(paintedCursor()?.text).toBe("The next block.");
    await press(key("k"));
    expect(paintedCursor()).toMatchObject({ text: SOFT_PARAGRAPH, offset: 0 });

    await press(key("j"));
    expect(paintedCursor()?.text).toBe("The next block.");
  });

  it("cursor memory fence spec: a visual selection across a soft break cites the exact rendered text", async () => {
    const thread = addSoftBreakThread();
    await mountApp(thread);
    await press(key("k"));
    await press(key("k"));
    // The whole paragraph, across its former soft break.
    await press(key("v"));
    await press(DOLLAR);
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "chat", mode: "VISUAL" });
    await press(SPACE);
    await press(key("c"));

    expect(readKeyEngineSnapshot()).toMatchObject({ notice: "cited into the composer" });
    const prompt =
      useComposerDraftStore.getState().getComposerDraft(scopeThreadRef(environmentId, thread))
        ?.prompt ?? "";
    const citations = collectAssistantCitations(prompt);
    expect(citations, `the prompt carries one citation; prompt: ${prompt}`).toHaveLength(1);
    const { citation } = citations[0]!;
    // A citation compares quotes with each whitespace run collapsed to one
    // space (`findAssistantCitationText`): that is the rendered text.
    expect(citation.text.replace(/\s+/g, " ")).toBe(SOFT_PARAGRAPH_RENDERED);
    expect([citation.start, citation.end]).toEqual([0, SOFT_PARAGRAPH_RENDERED.length]);
  });
});
