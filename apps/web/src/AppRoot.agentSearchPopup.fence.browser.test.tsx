import { page, userEvent } from "vite-plus/test/browser";
import { flushBrowserTasks } from "./test/browserTasks";
import { act, type Screen } from "../test/render";
/**
 * Entry point: AppRoot, with a memory router whose root renders the real
 * CommandPalette around the real AppSidebarLayout — and in it the real
 * `Sidebar` — and whose chat layout is the real `_chat.tsx` route component
 * around the real ChatView (`test/appRootFenceApp.tsx`). The key engine is
 * installed on `window` before React renders, as `main.tsx` does. Keys are
 * real `keydown` events dispatched from the focused element.
 *
 * Phase 3 of the search unification cycle ("Build the agent search popup with
 * history, Dots and completion signals"):
 * - Criterion 1: Tab in a non-empty sidebar Search field, or the sparkle
 *   ("Search with the agent"), opens the popup and starts a search
 *   conversation whose first message is the field's text.
 * - Criterion 2: desktop shows the conversation with earlier searches on its
 *   right; at Pixel 7 width the popup fills the screen and the history opens
 *   from a header button.
 * - Criterion 3: choosing an earlier search shows its conversation; deleting
 *   one goes through thread deletion and leaves the history.
 * - Criterion 4: while a search runs, a Dots mark (`role="status"`, named
 *   "Agent search running") sits inside the sidebar Search field and the
 *   popup; it is gone once the search settles.
 * - Criterion 5: Escape and X close the popup without stopping the search; on
 *   settling a toast with Open appears and the sparkle carries an unseen dot
 *   (`data-unseen`) until Open shows the result. The desktop notification is
 *   pinned in `components/ThreadNotificationCoordinator.badge.browser.test.tsx`,
 *   because the coordinator mounts in `routes/__root.tsx`, outside this router.
 * - Criterion 6: a result link in the popup opens the found thread in this
 *   tab, and the popup gets out of the way.
 * - Criterion 7: search threads and the search project appear in no sidebar
 *   list, sidebar search result, project filter or palette row. The settings
 *   lists are pinned in `components/settings/useSettingsProjectGroups.searchProject.browser.test.tsx`.
 * - Criterion 8: the palette offers no way into the old Agent mode, and
 *   `ThreadSearchPicker` and the `AgentThreadSearch*` components are gone.
 *
 * The server is a stub at the command boundary (`useAtomCommand`): a command
 * whose label names a search and whose input is empty is the
 * `startThreadSearchChat` RPC, and the stub answers it by publishing an idle
 * search thread in the hidden project. Any later command that carries that
 * thread's id and the query text is the first message: the stub publishes it
 * with the run running. `settleSearch` publishes the run completed with the
 * agent's answer. A thread delete command, or `useThreadActions` deletion,
 * removes the thread, as the server's deletion would.
 *
 * Boundaries replaced, as in `AppRoot.searchUnification.fence.browser.test.tsx`:
 * the environment, project and thread reads, the server's message search,
 * every RPC command, the chords and unrelated chrome; plus the toast manager's
 * `add`, recorded because the fence's root mounts no toast viewport.
 */
import { describe, expect, it, vi } from "vite-plus/test";

const fenceMocks = vi.hoisted(() => () => import("./test/appRootFenceMocks"));
vi.mock("./state/presentation", async (original) =>
  (await fenceMocks()).mockPresentation(original),
);
vi.mock("./connection/runtime", async () => (await fenceMocks()).mockConnectionRuntime());
vi.mock("@t3tools/client-runtime/state/session", async (original) =>
  (await fenceMocks()).mockRuntimeSession(original),
);
/** What the sidebar lists, as in the phase 1 fence. */
const sidebarLists = vi.hoisted(() => ({
  threads: [] as import("@t3tools/client-runtime/state/models").EnvironmentThreadShell[],
  projects: [] as unknown[],
  listeners: new Set<() => void>(),
}));
/**
 * The command boundary: every command the app runs, the search the stub
 * started, and what the toast manager was asked to show.
 */
const server = vi.hoisted(() => ({
  calls: [] as Array<{ readonly label: string; readonly value: unknown }>,
  deletions: [] as unknown[],
  toasts: [] as Array<Record<string, unknown>>,
  closedToasts: [] as string[],
  /** Answers the start RPC; set by `setup()`. */
  startSearch: (() => ({ threadId: "", projectId: "" })) as () => {
    threadId: string;
    projectId: string;
  },
  /** Reacts to any other command; set by `setup()`. */
  observe: (_value: unknown) => {},
  /** Reacts to a thread deletion; set by `setup()`. */
  deleteThread: (_ref: unknown) => {},
  /** The server's archived threads, by environment. */
  archived: [] as Array<{
    environmentId: string;
    threads: import("@t3tools/contracts").OrchestrationV2ThreadShell[];
  }>,
  unarchived: [] as unknown[],
  /** Reacts to an unarchive; set by `setup()`. */
  unarchive: (_ref: unknown) => {},
}));
vi.mock("./lib/archivedThreadsState", async (original) => ({
  ...(await original<typeof import("./lib/archivedThreadsState")>()),
  useArchivedThreadSnapshots: () => ({
    snapshots: server.archived.map(({ environmentId, threads }) => ({
      environmentId,
      snapshot: { schemaVersion: 1, snapshotSequence: 0, projects: [], threads },
    })),
    error: null,
    isLoading: false,
    refresh: () => undefined,
  }),
}));
/**
 * The environment's shell, as the live server delivers it: one snapshot whose
 * `threads` and `projects` carry the sidebar lists, the hidden search project
 * included. Thread shells and projects are derived from it by the client's own
 * atoms, so `useProjects` runs the app's real path over the live shape.
 */
const fenceShell = vi.hoisted(() => {
  let built: Promise<{
    shells: ReturnType<
      typeof import("@t3tools/client-runtime/state/threads").createEnvironmentThreadShellAtoms
    >;
    projects: ReturnType<
      typeof import("@t3tools/client-runtime/state/projects").createEnvironmentProjectAtoms
    >;
  }> | null = null;
  const build = async () => {
    const mocks = await fenceMocks();
    const { Atom } = await import("effect/reactivity");
    const { createEnvironmentThreadShellAtoms } =
      await import("@t3tools/client-runtime/state/threads");
    const { createEnvironmentProjectAtoms } =
      await import("@t3tools/client-runtime/state/projects");
    const { PrimaryConnectionTarget } = await import("@t3tools/client-runtime/connection");
    const { EnvironmentId } = await import("@t3tools/contracts");
    const Option = await import("effect/Option");
    const environmentId = EnvironmentId.make(mocks.FENCE_ENVIRONMENT_ID);
    const catalogValueAtom = Atom.make({
      isReady: true,
      entries: new Map([
        [
          environmentId,
          {
            enabled: true,
            profile: Option.none(),
            target: new PrimaryConnectionTarget({
              environmentId,
              label: "Agent search fence",
              httpBaseUrl: "https://agent-search-fence.invalid",
              wsBaseUrl: "wss://agent-search-fence.invalid",
            }),
          },
        ],
      ]),
    });
    const snapshotAtom = Atom.family((id: typeof environmentId) =>
      Atom.make((get) => {
        const read = (): import("@t3tools/contracts").OrchestrationV2ShellSnapshot => ({
          schemaVersion: 1,
          snapshotSequence: 0,
          threads: sidebarLists.threads
            .filter((thread) => thread.environmentId === id)
            .map((thread) => thread.source),
          archivedThreads: [],
          projects: sidebarLists.projects.filter(
            (project) => (project as { environmentId?: string }).environmentId === id,
          ) as import("@t3tools/contracts").OrchestrationV2ShellSnapshot["projects"],
        });
        const listener = () => get.setSelf(read());
        sidebarLists.listeners.add(listener);
        get.addFinalizer(() => sidebarLists.listeners.delete(listener));
        return read();
      }).pipe(Atom.setIdleTTL(0)),
    );
    return {
      shells: createEnvironmentThreadShellAtoms({ catalogValueAtom, snapshotAtom }),
      projects: createEnvironmentProjectAtoms({ catalogValueAtom, snapshotAtom }),
    };
  };
  return { build: () => (built ??= build()) };
});
vi.mock("./state/projects", async (original) => ({
  ...(await original<typeof import("./state/projects")>()),
  environmentProjects: (await fenceShell.build()).projects,
}));
vi.mock("./state/entities", async (original) => {
  const mocks = await fenceMocks();
  const actual = await original<typeof import("./state/entities")>();
  const { Atom } = await import("effect/reactivity");
  const { useAtomValue } = await import("@effect/atom-react");
  const { environmentServerConfigsAtom } = await import("./state/server");
  const { shells } = await fenceShell.build();
  const emptyShell = Atom.make(null);
  return {
    ...(await mocks.mockEntities(original)),
    useThreadShells: () => useAtomValue(shells.threadShellsAtom),
    useQuietThreadShells: () => useAtomValue(shells.quietThreadShellsAtom),
    useThreadShell: (ref: import("@t3tools/contracts").ScopedThreadRef | null) =>
      useAtomValue(ref === null ? emptyShell : shells.threadShellAtom(ref)),
    useQuietThreadShell: (ref: import("@t3tools/contracts").ScopedThreadRef | null) =>
      useAtomValue(ref === null ? emptyShell : shells.quietThreadShellAtom(ref)),
    useServerConfigs: () => useAtomValue(environmentServerConfigsAtom),
    // The app's own project lists, over the live-shaped snapshot above.
    useProjects: actual.useProjects,
    readProjects: actual.readProjects,
    // The same shells `useThreadShell` reads, as in the app.
    readThreadShell: (ref: import("@t3tools/contracts").ScopedThreadRef) =>
      sidebarLists.threads.find(
        (thread) => thread.environmentId === ref.environmentId && thread.id === ref.threadId,
      ) ?? null,
  };
});
vi.mock("./state/environments", async (original) =>
  (await fenceMocks()).mockEnvironments(original),
);
vi.mock("./state/query", async (original) => (await fenceMocks()).mockQuery(original));
vi.mock("./state/queries", async (original) => (await fenceMocks()).mockQueries(original));
vi.mock("./state/threads", async (original) => (await fenceMocks()).mockThreads(original));
vi.mock("./state/use-atom-command", async () => ({
  useAtomCommand:
    (command: { readonly label?: string } | null | undefined) => async (value: unknown) => {
      const label = command?.label ?? "";
      server.calls.push({ label, value });
      const input = (value as { readonly input?: unknown } | null)?.input;
      const isStartSearch =
        /search/i.test(label) &&
        typeof input === "object" &&
        input !== null &&
        Object.keys(input).length === 0;
      if (isStartSearch) return { _tag: "Success" as const, value: server.startSearch() };
      if (/thread:delete/.test(label)) server.deleteThread(value);
      else server.observe(value);
      return { _tag: "Success" as const, value: { providers: [] } };
    },
}));
vi.mock("./state/use-atom-query-runner", async () => (await fenceMocks()).mockAtomQueryRunner());
vi.mock("./state/server", async (original) => {
  const mocks = await fenceMocks();
  const { Atom } = await import("effect/reactivity");
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  const [environment] = mocks.appRootFence.environments;
  const configs = new Map([
    [
      environment!.environmentId,
      { ...environment!.serverConfig, settings: DEFAULT_SERVER_SETTINGS },
    ],
  ]);
  return {
    ...(await mocks.mockServer(original)),
    environmentServerConfigsAtom: Atom.make(configs),
  };
});
vi.mock("./hooks/useSettings", async (original) => (await fenceMocks()).mockSettings(original));
vi.mock("./hooks/useHandleNewThread", async () => (await fenceMocks()).mockHandleNewThread());
vi.mock("./hooks/useThreadActions", async () => {
  const actions = (await fenceMocks()).mockThreadActions();
  const success = () => Promise.resolve({ _tag: "Success" as const, value: undefined });
  const recordDeletion = (ref: unknown) => {
    server.deletions.push(ref);
    server.deleteThread(ref);
    return success();
  };
  return {
    ...actions,
    useThreadActions: () => ({
      ...actions.useThreadActions(),
      deleteThread: recordDeletion,
      confirmAndDeleteThread: recordDeletion,
      unarchiveThread: (ref: unknown) => {
        server.unarchived.push(ref);
        server.unarchive(ref);
        return success();
      },
    }),
  };
});
vi.mock("./components/ui/toast", async (original) => {
  const actual = await original<typeof import("./components/ui/toast")>();
  return {
    ...actual,
    toastManager: {
      ...actual.toastManager,
      add: (toast: Record<string, unknown>) => {
        server.toasts.push(toast);
        return `fence-toast-${server.toasts.length}`;
      },
      close: (id: string) => {
        server.closedToasts.push(id);
      },
    },
  };
});
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

import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ProjectId,
  RunId,
  RuntimeRequestId,
  THREAD_SEARCH_PROJECT_ID,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { useAgentSearchPopupStore } from "./components/searches/agentSearchPopupStore";
import { useComposerDraftStore } from "./composerDraftStore";
import { installKeyEngine } from "./keys/keyEngine";
import { readProjects } from "./state/entities";
import { readKeyEngineSnapshot } from "./keys/keyEngineStore";
import { useProjectScopeStore } from "./projectScopeStore";
import {
  addFenceThread,
  fenceEnvironmentId as environmentId,
  makeMessage,
  renderFenceApp,
  type FenceRouter,
} from "./test/appRootFenceApp";
import {
  appRootFence as fixture,
  FENCE_ENVIRONMENT_ID,
  makeFenceSession,
} from "./test/appRootFenceMocks";
import { makeFenceThreadShell } from "./test/fenceThreadShell";

const NOW_MS = Date.parse("2026-10-08T12:00:00.000Z");
const ALPHA_PROJECT_ID = fixture.project.id;
const BETA_PROJECT_ID = "agent-search-fence-beta";
const BETA_TITLE = "Beta workspace";
const OPEN_THREAD_ID = "agent-search-fence-open";
const SEARCH_PROJECT_TITLE = "Thread searches";
const NEW_SEARCH_ID = "agent-search-fence-new";
const QUERY = "the thread where we renamed the sidebar";
const SEARCH_RUN_ID = RunId.make("agent-search-fence-run");

let root: Screen | undefined;
let router: FenceRouter | undefined;
let container: HTMLDivElement;

const betaProject = {
  ...fixture.project,
  id: BETA_PROJECT_ID,
  title: BETA_TITLE,
  workspaceRoot: "/tmp/agent-search-fence-beta",
};
const searchProject = {
  ...fixture.project,
  id: THREAD_SEARCH_PROJECT_ID,
  title: SEARCH_PROJECT_TITLE,
  workspaceRoot: "/tmp/agent-search-fence-state/thread-search-workspace",
};

function minutesAgo(minutes: number): string {
  return new Date(NOW_MS - minutes * 60_000).toISOString();
}

/** A sidebar-only thread shell in `projectId`, last active `minutes` ago. */
function sidebarThread(id: string, title: string, projectId: string, minutes: number) {
  const at = DateTime.makeUnsafe(minutesAgo(minutes));
  return makeFenceThreadShell({
    id: ThreadId.make(id),
    environmentId,
    projectId: ProjectId.make(projectId),
    title,
    createdAt: minutesAgo(minutes),
    overrides: { updatedAt: at, latestUserMessageAt: at },
  });
}

function threadKey(id: string): string {
  return scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));
}

const ordinaryThreads = () => [
  sidebarThread("alpha-rename", "Rename the composer", ALPHA_PROJECT_ID, 30),
  sidebarThread("beta-rename", "Rename the sidebar", BETA_PROJECT_ID, 10),
];

/** Upserts the fixture's copy of `id` into the sidebar's shell list and tells its readers. */
function syncSidebarShell(id: string): void {
  const shell = fixture.threads.get(id);
  sidebarLists.threads = [
    ...sidebarLists.threads.filter((thread) => thread.id !== id),
    ...(shell ? [shell] : []),
  ];
  for (const listener of sidebarLists.listeners) listener();
}

type SearchRunState = "idle" | "running" | "awaiting-approval" | "completed";

function runOverrides(state: SearchRunState, minutes: number): Partial<OrchestrationV2ThreadShell> {
  const at = DateTime.makeUnsafe(minutesAgo(minutes));
  switch (state) {
    case "idle":
      return { status: "idle", updatedAt: at };
    case "running":
      return {
        status: "running",
        latestRunId: SEARCH_RUN_ID,
        activeRunId: SEARCH_RUN_ID,
        latestRunStartedAt: at,
        updatedAt: at,
      };
    case "awaiting-approval":
      return {
        ...runOverrides("running", minutes),
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("agent-search-fence-approval"),
          kind: "command",
          createdAt: at,
        },
      };
    case "completed":
      return {
        status: "completed",
        latestRunId: SEARCH_RUN_ID,
        activeRunId: null,
        latestRunStartedAt: at,
        latestRunCompletedAt: at,
        updatedAt: at,
      };
  }
}

/** Publishes a search thread in the hidden project, as the server's projections would. */
function publishSearch(
  id: string,
  title: string,
  state: SearchRunState,
  messages: ReadonlyArray<ReturnType<typeof makeMessage>>,
  minutes = 0,
): void {
  addFenceThread(id, title, messages, {
    projectId: THREAD_SEARCH_PROJECT_ID,
    createdAt: minutesAgo(minutes),
    overrides: runOverrides(state, minutes),
  });
  syncSidebarShell(id);
}

/** Publishes a sidebar shell, as the server's shell stream does when a thread returns. */
function syncSidebarShellFrom(shell: ReturnType<typeof sidebarThread>): void {
  fixture.threads.set(shell.id, shell);
  for (const listener of fixture.threadListeners) listener();
  syncSidebarShell(shell.id);
}

function removeThread(id: string): void {
  fixture.threads.delete(id);
  fixture.threadStates.delete(id);
  for (const listener of fixture.threadListeners) listener();
  syncSidebarShell(id);
}

const userQuery = () => makeMessage(`${NEW_SEARCH_ID}-user`, "user", QUERY);
const ANSWER =
  "The match is [Rename the sidebar](t3-thread://v1/beta-rename): it renamed the sidebar search.";

/** The search run ends with the agent's answer, which links the found thread. */
async function settleSearch(answer = ANSWER): Promise<void> {
  await act(async () => {
    publishSearch(NEW_SEARCH_ID, "Sidebar rename search", "completed", [
      userQuery(),
      makeMessage(`${NEW_SEARCH_ID}-assistant`, "assistant", answer),
    ]);
  });
  await settle();
}

/** Earlier searches, already finished, from yesterday and the day before. */
function seedEarlierSearches(): void {
  publishSearch(
    "agent-search-fence-earlier-a",
    "Provider settings search",
    "completed",
    [
      makeMessage("earlier-a-user", "user", "where did we change the provider settings"),
      makeMessage("earlier-a-assistant", "assistant", "Earlier answer about provider settings."),
    ],
    24 * 60,
  );
  publishSearch(
    "agent-search-fence-earlier-b",
    "Composer focus search",
    "completed",
    [
      makeMessage("earlier-b-user", "user", "the composer focus bug"),
      makeMessage("earlier-b-assistant", "assistant", "Earlier answer about the composer."),
    ],
    2 * 24 * 60,
  );
}

async function setup() {
  const previousViewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1440, 900);
  installKeyEngine();
  useProjectScopeStore.setState(useProjectScopeStore.getInitialState(), true);
  // The popup's store lives for the page, as the scope store does.
  useAgentSearchPopupStore.setState(useAgentSearchPopupStore.getInitialState(), true);
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  server.calls = [];
  server.deletions = [];
  server.toasts = [];
  server.closedToasts = [];
  server.startSearch = () => {
    publishSearch(NEW_SEARCH_ID, "New search", "idle", []);
    return { threadId: NEW_SEARCH_ID, projectId: THREAD_SEARCH_PROJECT_ID };
  };
  server.observe = (value) => {
    const written = JSON.stringify(value ?? null);
    if (!written.includes(NEW_SEARCH_ID) || !written.includes(QUERY)) return;
    publishSearch(NEW_SEARCH_ID, "Sidebar rename search", "running", [userQuery()]);
  };
  server.archived = [];
  server.unarchived = [];
  server.unarchive = () => {};
  server.deleteThread = (value) => {
    const written = JSON.stringify(value ?? null);
    for (const id of fixture.threads.keys()) {
      if (written.includes(`"${id}"`)) removeThread(id);
    }
  };
  container = document.createElement("div");
  // AppRoot normally mounts in #root, whose CSS gives it a definite height.
  container.style.cssText = "width: 100%; height: 100dvh;";
  document.body.append(container);

  return {
    async [Symbol.asyncDispose]() {
      await act(async () => root?.[Symbol.asyncDispose]());
      root = undefined;
      router = undefined;
      container.remove();
      fixture.threads.clear();
      fixture.threadStates.clear();
      sidebarLists.threads = [];
      sidebarLists.projects = [];
      useProjectScopeStore.setState(useProjectScopeStore.getInitialState(), true);
      useAgentSearchPopupStore.setState(useAgentSearchPopupStore.getInitialState(), true);
      fixture.sessions.set(FENCE_ENVIRONMENT_ID, makeFenceSession());
      window.localStorage.clear();
      vi.unstubAllGlobals();
      await page.viewport(previousViewport.width, previousViewport.height);
    },
  };
}

async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await flushBrowserTasks();
    });
  }
}

/**
 * Mounts the app on an open Alpha thread, with the ordinary threads, the
 * given extra shells and the hidden search project known to the client.
 */
async function mountApp(
  extra: ReadonlyArray<ReturnType<typeof sidebarThread>> = [],
  openThreadAnswer = "Done.",
  options: { readonly vimMode?: boolean } = {},
): Promise<void> {
  const openThreadId = addFenceThread(OPEN_THREAD_ID, "Open thread", [
    makeMessage(`${OPEN_THREAD_ID}-assistant`, "assistant", openThreadAnswer),
  ]);
  sidebarLists.threads = [...fixture.threads.values(), ...ordinaryThreads(), ...extra];
  // The live server lists the search project with the rest; first here, so a
  // consumer that takes the first project would pick it.
  sidebarLists.projects = [searchProject, fixture.project, betaProject];
  ({ root, router } = await renderFenceApp(container, openThreadId, {
    vimMode: options.vimMode ?? false,
  }));
  await settle();
  // The composer takes focus on mount; the developer starts from the sidebar.
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
async function press(chord: Chord): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { ...chord, bubbles: true, cancelable: true });
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
  await settle();
  return event;
}

// Mod is Control in the Linux Chromium test browser.
const THREAD_SEARCH_CHORD: Chord = { key: "k", code: "KeyK", ctrlKey: true, altKey: true };
const PALETTE_CHORD: Chord = { key: "o", code: "KeyO", ctrlKey: true };
const TAB: Chord = { key: "Tab", code: "Tab" };

function sidebarSearchField(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('input[aria-label="Search threads"]');
}

/**
 * The field's box around its input, where the sparkle, Dots and clear X sit:
 * the nearest `div` above the input (the input's own control wraps it in a span).
 */
function sidebarSearchBox(): HTMLElement {
  const field = sidebarSearchField();
  expect(field, "the sidebar Search field").not.toBeNull();
  return field!.parentElement!.closest("div")!;
}

function popup(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"][aria-label="Agent search"]');
}

function requirePopup(): HTMLElement {
  const dialog = popup();
  expect(dialog, "the agent search popup").not.toBeNull();
  return dialog!;
}

function dotsIn(scope: ParentNode): HTMLElement | null {
  return scope.querySelector<HTMLElement>('[role="status"][aria-label="Agent search running"]');
}

function sparkle(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('button[aria-label="Search with the agent"]');
}

/** The earlier-search entries in `scope`, by their visible titles. */
function historyTitles(scope: ParentNode): string[] {
  const list = scope.querySelector<HTMLElement>('[aria-label="Earlier searches"]');
  if (!list) return [];
  return [...list.querySelectorAll<HTMLElement>("[data-search-history-entry]")].map(
    (entry) => entry.textContent?.trim() ?? "",
  );
}

function historyEntry(scope: ParentNode, title: string): HTMLElement {
  const entry = [
    ...scope.querySelectorAll<HTMLElement>(
      '[aria-label="Earlier searches"] [data-search-history-entry]',
    ),
  ].find((candidate) => candidate.textContent?.includes(title));
  expect(entry, `the earlier search ${title}`).toBeDefined();
  return entry!;
}

function listedThreadKeys(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[data-thread-item]")].map(
    (row) => row.dataset.threadItem ?? "",
  );
}

function searchResultKeys(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[data-search-result-key]")].map(
    (row) => row.dataset.searchResultKey ?? "",
  );
}

function paletteOptions(): string[] {
  return [
    ...document.querySelectorAll<HTMLElement>('[data-testid="command-palette"] [role="option"]'),
  ].map((option) => option.textContent?.trim() ?? "");
}

function paletteOpen(): boolean {
  return document.querySelector('[data-testid="command-palette"][data-open]') !== null;
}

async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

async function typeIntoSearch(value: string): Promise<void> {
  const field = sidebarSearchField();
  expect(field, "the sidebar Search field").not.toBeNull();
  await setInputValue(field!, value);
}

async function typeIntoPalette(value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('[data-testid="command-palette"] input');
  expect(input, "the palette's input").not.toBeNull();
  await setInputValue(input!, value);
}

/** The commands that carried the first message: the search thread's id and the query. */
function firstMessageCalls() {
  return server.calls.filter(({ value }) => {
    const written = JSON.stringify(value ?? null);
    return written.includes(NEW_SEARCH_ID) && written.includes(QUERY);
  });
}

function startCalls() {
  return server.calls.filter(({ label, value }) => {
    const input = (value as { readonly input?: unknown } | null)?.input;
    return (
      /search/i.test(label) &&
      typeof input === "object" &&
      input !== null &&
      Object.keys(input).length === 0
    );
  });
}

/** Types the query and presses Tab in the field; the popup opens on a running search. */
async function startSearchWithTab(): Promise<void> {
  await typeIntoSearch(QUERY);
  await press(TAB);
  await vi.waitFor(() => expect(popup(), "the agent search popup").not.toBeNull());
  await vi.waitFor(() => expect(firstMessageCalls().length).toBeGreaterThan(0));
}

describe("agent search popup: Tab and the sparkle start a search", () => {
  it("agent search popup spec: Tab in a non-empty sidebar Search opens the popup and sends the query as the first message", async () => {
    await using _fixture = await setup();
    await mountApp();
    await typeIntoSearch(QUERY);

    const event = await press(TAB);

    expect(event.defaultPrevented, "the popup owns Tab in a non-empty field").toBe(true);
    await vi.waitFor(() => expect(popup(), "the agent search popup").not.toBeNull());
    expect(startCalls(), "one search conversation started").toHaveLength(1);
    await vi.waitFor(() => expect(firstMessageCalls()).toHaveLength(1));
    await vi.waitFor(() => expect(requirePopup().textContent).toContain(QUERY));
  });

  it("agent search popup spec: the sparkle in a non-empty sidebar Search opens the popup and sends the query as the first message", async () => {
    await using _fixture = await setup();
    await mountApp();
    await typeIntoSearch(QUERY);
    const button = sparkle();
    expect(button, "the sparkle inside the field").not.toBeNull();
    expect(sidebarSearchBox().contains(button), "the sparkle sits inside the field").toBe(true);
    const box = button!.getBoundingClientRect();
    expect(Math.min(box.width, box.height), "the sparkle is a 24 px target").toBeGreaterThanOrEqual(
      24,
    );

    await userEvent.click(button!);
    await settle();

    await vi.waitFor(() => expect(popup(), "the agent search popup").not.toBeNull());
    expect(startCalls()).toHaveLength(1);
    await vi.waitFor(() => expect(firstMessageCalls()).toHaveLength(1));
  });
});

describe("agent search popup: layout on desktop and phone", () => {
  it("agent search popup spec: on desktop the conversation sits left and earlier searches sit right", async () => {
    await using _fixture = await setup();
    await mountApp();
    await act(async () => seedEarlierSearches());
    await settle();

    await startSearchWithTab();

    const dialog = requirePopup();
    await vi.waitFor(() =>
      expect(historyTitles(dialog)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Provider settings search"),
          expect.stringContaining("Composer focus search"),
        ]),
      ),
    );
    const composer = dialog.querySelector<HTMLElement>('[aria-label="Message"]');
    expect(composer, "the search conversation's composer in the popup").not.toBeNull();
    const history = dialog.querySelector<HTMLElement>('[aria-label="Earlier searches"]')!;
    expect(history.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      composer!.getBoundingClientRect().right,
    );
  });

  it("agent search popup spec: at Pixel 7 width the popup fills the screen and the history opens from a header button", async () => {
    await using _fixture = await setup();
    await page.viewport(412, 915);
    await mountApp();
    await act(async () => seedEarlierSearches());
    await settle();
    // The phone reaches the field through the drawer, and has no Tab key.
    await press(THREAD_SEARCH_CHORD);
    await vi.waitFor(() => expect(document.activeElement).toBe(sidebarSearchField()));
    await typeIntoSearch(QUERY);
    await userEvent.click(sparkle()!);
    await settle();

    const dialog = await vi.waitFor(() => requirePopup());
    // The popup scales in from 98%; its size is read once the opening transition ends.
    await vi.waitFor(() => {
      const box = dialog.getBoundingClientRect();
      expect(box.width).toBeGreaterThanOrEqual(window.innerWidth - 1);
      expect(box.height).toBeGreaterThanOrEqual(window.innerHeight - 1);
    });
    expect(historyTitles(document), "the history waits behind its button").toEqual([]);

    const showHistory = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Show earlier searches"]',
    );
    expect(showHistory, "the popup header's history button").not.toBeNull();
    await userEvent.click(showHistory!);
    await settle();

    await vi.waitFor(() =>
      expect(historyTitles(document)).toEqual(
        expect.arrayContaining([expect.stringContaining("Provider settings search")]),
      ),
    );
  });
});

// regression: reviewer-1 P1-1 — the phone history sheet opened under the popup,
// which took every touch meant for it.
describe("agent search popup: the phone history sheet", () => {
  it("agent search popup spec: at Pixel 7 width an earlier search in the sheet can be tapped and deleted", async () => {
    await using _fixture = await setup();
    await page.viewport(412, 915);
    await mountApp();
    await act(async () => seedEarlierSearches());
    await settle();
    await press(THREAD_SEARCH_CHORD);
    await vi.waitFor(() => expect(document.activeElement).toBe(sidebarSearchField()));
    await typeIntoSearch(QUERY);
    await userEvent.click(sparkle()!);
    await settle();
    await vi.waitFor(() => requirePopup());
    await userEvent.click(
      document.querySelector<HTMLButtonElement>('button[aria-label="Show earlier searches"]')!,
    );
    await settle();

    const entry = await vi.waitFor(() => historyEntry(document, "Provider settings search"));
    const box = entry.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    expect(entry.contains(hit), "nothing covers the sheet's entry").toBe(true);
    await userEvent.click(entry.querySelector("button")!);
    await settle();
    await vi.waitFor(() =>
      expect(requirePopup().textContent).toContain("Earlier answer about provider settings."),
    );

    await userEvent.click(
      document.querySelector<HTMLButtonElement>('button[aria-label="Show earlier searches"]')!,
    );
    await settle();
    const remove = await vi.waitFor(() => {
      const found = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Delete search Composer focus search"]',
      );
      expect(found, "the sheet's delete button").not.toBeNull();
      return found!;
    });
    await userEvent.click(remove);
    await settle();
    await vi.waitFor(() =>
      expect(fixture.threads.has("agent-search-fence-earlier-b"), "the thread was deleted").toBe(
        false,
      ),
    );
  });
});

// regression: reviewer-1 P2-2 — between 640 and 767 px the history moved behind its
// button while the dialog kept its desktop frame and the controls their offset.
describe("agent search popup: one phone breakpoint", () => {
  it("agent search popup spec: at 700 px the popup is full screen with history behind its button", async () => {
    await using _fixture = await setup();
    await page.viewport(700, 900);
    await mountApp();
    await press(THREAD_SEARCH_CHORD);
    await vi.waitFor(() => expect(document.activeElement).toBe(sidebarSearchField()));
    await typeIntoSearch(QUERY);
    await userEvent.click(sparkle()!);
    await settle();

    const dialog = await vi.waitFor(() => requirePopup());
    expect(
      dialog.querySelector('button[aria-label="Show earlier searches"]'),
      "history behind its button",
    ).not.toBeNull();
    await vi.waitFor(() => {
      const box = dialog.getBoundingClientRect();
      expect(box.width).toBeGreaterThanOrEqual(window.innerWidth - 1);
      expect(box.height).toBeGreaterThanOrEqual(window.innerHeight - 1);
    });
    const column = dialog.querySelector<HTMLElement>("[data-agent-search-conversation]");
    expect(column, "the conversation column").not.toBeNull();
    expect(getComputedStyle(column!).getPropertyValue("--workspace-controls-right").trim()).toBe(
      "0.75rem",
    );
  });
});

describe("agent search popup: earlier searches", () => {
  it("agent search popup spec: choosing an earlier search shows its conversation in the popup", async () => {
    await using _fixture = await setup();
    await mountApp();
    await act(async () => seedEarlierSearches());
    await settle();
    await startSearchWithTab();

    await userEvent.click(historyEntry(requirePopup(), "Provider settings search"));
    await settle();

    await vi.waitFor(() =>
      expect(requirePopup().textContent).toContain("Earlier answer about provider settings."),
    );
    expect(requirePopup().textContent).not.toContain(QUERY);
  });

  it("agent search popup spec: deleting an earlier search deletes its thread and removes it from the history", async () => {
    await using _fixture = await setup();
    await mountApp();
    await act(async () => seedEarlierSearches());
    await settle();
    await startSearchWithTab();
    const deleteButton = requirePopup().querySelector<HTMLButtonElement>(
      'button[aria-label="Delete search Composer focus search"]',
    );
    expect(deleteButton, "the earlier search's delete button").not.toBeNull();

    await userEvent.click(deleteButton!);
    await settle();
    // Thread deletion may ask first, as the sidebar's does.
    const confirm = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
    ].find((button) => button.textContent?.trim() === "Delete");
    if (confirm) {
      await userEvent.click(confirm);
      await settle();
    }

    await vi.waitFor(() =>
      expect(fixture.threads.has("agent-search-fence-earlier-b"), "the thread was deleted").toBe(
        false,
      ),
    );
    await vi.waitFor(() =>
      expect(historyTitles(requirePopup()).join("|")).not.toContain("Composer focus search"),
    );
    expect(historyTitles(requirePopup()).join("|")).toContain("Provider settings search");
  });
});

/** The popup's conversation input: the composer's main surface inside the dialog. */
function popupInput(): HTMLElement | null {
  return requirePopup().querySelector<HTMLElement>('[data-chat-composer-main-surface="true"]');
}

/** The Dots mark sits inside the popup's input, against its right edge. */
async function expectDotsAtRightOfPopupInput(): Promise<void> {
  const input = await vi.waitFor(() => {
    const found = popupInput();
    expect(found, "the popup's conversation input").not.toBeNull();
    return found!;
  });
  const dots = await vi.waitFor(() => {
    const found = dotsIn(input);
    expect(found, "Dots inside the popup's input").not.toBeNull();
    return found!;
  });
  const inputBox = input.getBoundingClientRect();
  const dotsBox = dots.getBoundingClientRect();
  expect(dotsBox.right, "inside the input's right edge").toBeLessThanOrEqual(inputBox.right);
  expect(inputBox.right - dotsBox.right, "against the right edge").toBeLessThanOrEqual(32);
  expect(dotsBox.left, "in the input's right half").toBeGreaterThan(
    inputBox.left + inputBox.width / 2,
  );
  expect(dotsBox.top).toBeGreaterThanOrEqual(inputBox.top);
  expect(dotsBox.bottom).toBeLessThanOrEqual(inputBox.bottom);
}

describe("agent search popup: the Dots mark", () => {
  // Amended after verifier-1: criterion 4 places the popup's Dots at the right
  // inside its conversation input, not anywhere in the popup.
  it("agent search popup spec: while a search runs the Dots mark sits in the sidebar Search field and at the right inside the popup input, and leaves when it settles", async () => {
    await using _fixture = await setup();
    await mountApp();
    await startSearchWithTab();

    await vi.waitFor(() =>
      expect(dotsIn(sidebarSearchBox()), "Dots in the sidebar Search field").not.toBeNull(),
    );
    await expectDotsAtRightOfPopupInput();

    await settleSearch();

    await vi.waitFor(() => expect(dotsIn(sidebarSearchBox())).toBeNull());
    expect(dotsIn(requirePopup())).toBeNull();
  });

  it("agent search popup spec: at Pixel 7 width the Dots mark sits at the right inside the popup input", async () => {
    await using _fixture = await setup();
    await page.viewport(412, 915);
    await mountApp();
    await press(THREAD_SEARCH_CHORD);
    await vi.waitFor(() => expect(document.activeElement).toBe(sidebarSearchField()));
    await typeIntoSearch(QUERY);
    await userEvent.click(sparkle()!);
    await settle();
    await vi.waitFor(() => expect(firstMessageCalls().length).toBeGreaterThan(0));

    await expectDotsAtRightOfPopupInput();
  });
});

describe("agent search popup: closing and completion", () => {
  it("agent search popup spec: Escape closes the popup, the search keeps running, and its end shows a toast with Open and a sparkle dot", async () => {
    await using _fixture = await setup();
    await mountApp();
    await startSearchWithTab();

    await press({ key: "Escape", code: "Escape" });

    await vi.waitFor(() => expect(popup(), "the popup closed").toBeNull());
    expect(
      server.calls.filter(({ label }) => /interrupt|stop-session/.test(label)),
      "closing stops nothing",
    ).toEqual([]);
    expect(dotsIn(sidebarSearchBox()), "the search still runs").not.toBeNull();

    await settleSearch();

    const toast = await vi.waitFor(() => {
      const shown = server.toasts.find(
        (candidate) =>
          (candidate.actionProps as { children?: unknown } | undefined)?.children === "Open",
      );
      expect(shown, "a toast with Open").toBeDefined();
      return shown!;
    });
    expect(toast.timeout, "Open stays reachable past the default 5 s").toBe(15_000);
    await typeIntoSearch("");
    await vi.waitFor(() =>
      expect(sparkle()?.hasAttribute("data-unseen"), "the sparkle carries the unseen dot").toBe(
        true,
      ),
    );

    await act(async () => {
      (toast.actionProps as { onClick: (event: unknown) => void }).onClick(new MouseEvent("click"));
    });
    await settle();

    await vi.waitFor(() => expect(popup(), "Open shows the result").not.toBeNull());
    expect(requirePopup().textContent).toContain("it renamed the sidebar search");
    expect(sparkle()?.hasAttribute("data-unseen") ?? false, "opening clears the dot").toBe(false);
  });

  // regression: verifier-1 — in Vim mode the key engine took Escape in the popup's
  // composer (insert → normal mode) before the dialog could close.
  it.each([
    ["Tab", () => press(TAB)],
    ["the sparkle", () => userEvent.click(sparkle()!)],
  ] as const)(
    "agent search popup spec: in Vim mode one real Escape after %s closes the popup and stops nothing",
    async (_way, open) => {
      await using _fixture = await setup();
      await mountApp([], "Done.", { vimMode: true });
      await typeIntoSearch(QUERY);
      await open();
      await settle();
      await vi.waitFor(() => expect(firstMessageCalls().length).toBeGreaterThan(0));
      await vi.waitFor(() =>
        expect(
          requirePopup().contains(document.activeElement),
          "focus lands inside the popup",
        ).toBe(true),
      );

      await userEvent.keyboard("{Escape}");
      await settle();

      await vi.waitFor(() => expect(popup(), "the popup closed").toBeNull());
      expect(server.calls.filter(({ label }) => /interrupt|stop-session/.test(label))).toEqual([]);
      expect(dotsIn(sidebarSearchBox()), "the search still runs").not.toBeNull();
    },
  );

  // regression: verifier-1 — right after Tab the popup can be open while focus is
  // still in the sidebar Search, whose own Escape cleared the query instead.
  it("agent search popup spec: Escape with focus still in the sidebar Search closes the open popup", async () => {
    await using _fixture = await setup();
    await mountApp();
    await startSearchWithTab();
    await act(async () => sidebarSearchField()!.focus());
    expect(document.activeElement, "focus is back in the field").toBe(sidebarSearchField());

    await press({ key: "Escape", code: "Escape" });

    await vi.waitFor(() => expect(popup(), "the popup closed").toBeNull());
    expect(dotsIn(sidebarSearchBox()), "the search still runs").not.toBeNull();
  });

  // regression: reviewer-1 P1-5 — a run asking for approval read as a finished search.
  it("agent search popup spec: a search waiting for approval is still running and announces nothing", async () => {
    await using _fixture = await setup();
    await mountApp();
    await startSearchWithTab();
    await press({ key: "Escape", code: "Escape" });
    await vi.waitFor(() => expect(popup()).toBeNull());

    await act(async () => {
      publishSearch(NEW_SEARCH_ID, "Sidebar rename search", "awaiting-approval", [userQuery()]);
    });
    await settle();

    expect(server.toasts, "no completion toast").toEqual([]);
    expect(dotsIn(sidebarSearchBox()), "the search still runs").not.toBeNull();

    await settleSearch();

    await vi.waitFor(() => expect(server.toasts).toHaveLength(1));
  });

  // regression: reviewer-1 P1-3 — the popup's composer took the single Vim adapter
  // slot, and closing the popup emptied it under the main composer.
  it("agent search popup spec: in Vim mode the main composer still enters normal mode after the popup closes", async () => {
    await using _fixture = await setup();
    await mountApp([], "Done.", { vimMode: true });
    await startSearchWithTab();
    await settle();
    await userEvent.keyboard("{Escape}");
    await settle();
    await vi.waitFor(() => expect(popup()).toBeNull());
    const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
    expect(editor, "the main composer").not.toBeNull();
    await act(async () => editor!.focus());
    await settle();

    await userEvent.keyboard("{Escape}");
    await settle();

    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "NORMAL" });
    expect(editor!.getAttribute("data-mesura-vim")).toBe("normal");
  });

  // regression: reviewer-1 P1-2 — both ChatViews wrote the palette's one composer
  // handle, and closing the popup left it empty under the main conversation.
  it("agent search popup spec: after the popup closes the palette still hands the keyboard back to the main composer", async () => {
    await using _fixture = await setup();
    await mountApp();
    await startSearchWithTab();
    await press({ key: "Escape", code: "Escape" });
    await vi.waitFor(() => expect(popup()).toBeNull());
    (document.activeElement as HTMLElement | null)?.blur?.();
    await press(PALETTE_CHORD);
    await vi.waitFor(() => expect(paletteOpen()).toBe(true));

    await press({ key: "Escape", code: "Escape" });

    await vi.waitFor(() => expect(paletteOpen()).toBe(false));
    await vi.waitFor(() =>
      expect(
        (document.activeElement as HTMLElement | null)?.closest('[data-testid="composer-editor"]'),
        "the main composer has the keyboard",
      ).not.toBeNull(),
    );
  });

  // regression: reviewer-2 P1-2 — every mounted composer's window shortcuts acted,
  // so Ctrl+S in the popup also stashed and cleared the main conversation's draft.
  it("agent search popup spec: Ctrl+S in the popup stashes its draft and leaves the main draft alone", async () => {
    await using _fixture = await setup();
    await mountApp();
    await startSearchWithTab();
    const mainRef = { environmentId, threadId: ThreadId.make(OPEN_THREAD_ID) };
    const searchRef = { environmentId, threadId: ThreadId.make(NEW_SEARCH_ID) };
    await act(async () => {
      useComposerDraftStore.getState().setPrompt(mainRef, "main draft stays");
      useComposerDraftStore.getState().setPrompt(searchRef, "popup follow-up");
    });
    await settle();
    const popupEditor = await vi.waitFor(() => {
      const found = requirePopup().querySelector<HTMLElement>('[data-testid="composer-editor"]');
      expect(found, "the popup's composer").not.toBeNull();
      return found!;
    });
    await act(async () => popupEditor.focus());
    await settle();

    await press({ key: "s", code: "KeyS", ctrlKey: true });

    await vi.waitFor(() =>
      expect(useComposerDraftStore.getState().getComposerDraft(searchRef)?.prompt ?? "").toBe(""),
    );
    expect(useComposerDraftStore.getState().getComposerDraft(mainRef)?.prompt).toBe(
      "main draft stays",
    );
  });

  // regression: reviewer-2 P1-2 — the palette closed over the popup handed the
  // keyboard to the main composer, behind the modal popup.
  it("agent search popup spec: the palette closed over the open popup leaves the main composer alone", async () => {
    await using _fixture = await setup();
    await mountApp();
    await startSearchWithTab();
    const popupEditor = await vi.waitFor(() => {
      const found = requirePopup().querySelector<HTMLElement>('[data-testid="composer-editor"]');
      expect(found).not.toBeNull();
      return found!;
    });
    await act(async () => popupEditor.focus());
    await press(PALETTE_CHORD);
    await vi.waitFor(() => expect(paletteOpen()).toBe(true));

    await press({ key: "Escape", code: "Escape" });

    await vi.waitFor(() => expect(paletteOpen()).toBe(false));
    await settle();
    const active = document.activeElement as HTMLElement | null;
    expect(
      active?.closest('[data-testid="composer-editor"]') !== null &&
        active?.closest('[role="dialog"]') === null,
      "the keyboard is not in the main composer behind the popup",
    ).toBe(false);
    expect(popup(), "the popup stays open").not.toBeNull();
    await vi.waitFor(() =>
      expect(
        requirePopup().contains(document.activeElement) &&
          document.activeElement?.closest('[data-testid="composer-editor"]') !== null,
        "the keyboard is back in the popup's composer",
      ).toBe(true),
    );
  });

  // regression: verifier-3 — the finished-search toast sat over the open popup's
  // history column and took the clicks meant for it.
  it("agent search popup spec: a search that ends while the popup is open announces itself without a toast", async () => {
    await using _fixture = await setup();
    await mountApp();
    await act(async () => seedEarlierSearches());
    await settle();
    await startSearchWithTab();
    await userEvent.click(historyEntry(requirePopup(), "Provider settings search"));
    await settle();

    await settleSearch();

    expect(server.toasts, "no toast over the open popup").toEqual([]);
    await vi.waitFor(() =>
      expect(useAgentSearchPopupStore.getState().unseenResult?.threadId).toBe(NEW_SEARCH_ID),
    );
  });

  it("agent search popup spec: opening the popup closes the finished search's toast", async () => {
    await using _fixture = await setup();
    await mountApp();
    await startSearchWithTab();
    await press({ key: "Escape", code: "Escape" });
    await vi.waitFor(() => expect(popup()).toBeNull());
    await settleSearch();
    await vi.waitFor(() => expect(server.toasts).toHaveLength(1));
    await typeIntoSearch("");

    await userEvent.click(sparkle()!);
    await settle();

    await vi.waitFor(() => expect(popup()).not.toBeNull());
    expect(server.closedToasts, "the toast no longer covers the popup").toEqual(["fence-toast-1"]);
  });

  it("agent search popup spec: the popup's X closes it without stopping the search", async () => {
    await using _fixture = await setup();
    await mountApp();
    await startSearchWithTab();
    const close = requirePopup().querySelector<HTMLButtonElement>('button[aria-label="Close"]');
    expect(close, "the popup's X").not.toBeNull();

    await userEvent.click(close!);
    await settle();

    await vi.waitFor(() => expect(popup()).toBeNull());
    expect(server.calls.filter(({ label }) => /interrupt|stop-session/.test(label))).toEqual([]);
    expect(dotsIn(sidebarSearchBox())).not.toBeNull();
  });
});

describe("agent search popup: result links", () => {
  it("agent search popup spec: a result link opens the found thread in this tab and the popup gets out of the way", async () => {
    await using _fixture = await setup();
    await mountApp();
    await startSearchWithTab();
    await settleSearch();
    const link = await vi.waitFor(() => {
      const found = requirePopup().querySelector<HTMLAnchorElement>(
        'a[aria-label="Thread, Rename the sidebar"]',
      );
      expect(found, "the result link in the popup").not.toBeNull();
      return found!;
    });
    expect(link.target).not.toBe("_blank");

    // A DOM click: the router's Link decides on the click event, not on pointer delivery.
    await act(async () => link.click());
    await settle();

    await vi.waitFor(() =>
      expect(router!.state.location.pathname).toBe(`/${environmentId}/beta-rename`),
    );
    await vi.waitFor(() => expect(popup(), "the found thread is in view").toBeNull());
  });
});

// regression: reviewer-1 P1-4 — the search returns archived threads, and their
// links led to a route that treats an archived thread as missing.
describe("agent search popup: archived results", () => {
  it("agent search popup spec: an archived result is unarchived and then opened in this tab", async () => {
    await using _fixture = await setup();
    await mountApp();
    const archivedShell = sidebarThread("archived-rename", "Archived rename", BETA_PROJECT_ID, 90);
    server.archived = [
      {
        environmentId,
        threads: [{ ...archivedShell.source, archivedAt: DateTime.makeUnsafe(minutesAgo(60)) }],
      },
    ];
    server.unarchive = () => syncSidebarShellFrom(archivedShell);
    await startSearchWithTab();
    await settleSearch(
      "The match is [Archived rename](t3-thread://v1/archived-rename), archived last week.",
    );
    const link = await vi.waitFor(() => {
      const found = requirePopup().querySelector<HTMLAnchorElement>('a[href$="/archived-rename"]');
      expect(found, "the archived result's link").not.toBeNull();
      return found!;
    });

    await act(async () => link.click());
    await settle();

    expect(server.unarchived).toEqual([
      { environmentId, threadId: ThreadId.make("archived-rename") },
    ]);
    await vi.waitFor(() =>
      expect(router!.state.location.pathname).toBe(`/${environmentId}/archived-rename`),
    );
    await vi.waitFor(() => expect(popup()).toBeNull());
  });
});

describe("agent search popup: search threads stay out of navigation", () => {
  const searchShells = () => [
    sidebarThread("search-hidden-1", "Where is the rename work", THREAD_SEARCH_PROJECT_ID, 5),
  ];

  it("agent search popup spec: search threads are in no sidebar list and the search project is in no project filter", async () => {
    await using _fixture = await setup();
    await mountApp(searchShells());

    const listed = listedThreadKeys();
    expect(listed, "ordinary threads stay listed").toContain(threadKey("beta-rename"));
    expect(listed).not.toContain(threadKey("search-hidden-1"));
    await userEvent.click(
      document.querySelector<HTMLElement>('[aria-label^="Filter threads by project"]')!,
    );
    await settle();
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(
      (option) => option.textContent ?? "",
    );
    expect(options.join("|"), "ordinary projects stay in the filter").toContain(BETA_TITLE);
    expect(options.join("|")).not.toContain(SEARCH_PROJECT_TITLE);
  });

  // regression: verifier-3 — the live server sends the search project in the
  // shell snapshot, and every `useProjects` consumer (the new thread's default
  // project, the palette's "New thread in …") listed it.
  it("agent search popup spec: the app's project list leaves out the search project the server sends", async () => {
    await using _fixture = await setup();
    await mountApp(searchShells());

    const ids = readProjects().map((project) => project.id);

    expect(ids, "ordinary projects stay").toContain(BETA_PROJECT_ID);
    expect(ids).not.toContain(THREAD_SEARCH_PROJECT_ID);
  });

  it("agent search popup spec: the palette offers no new thread in the search project", async () => {
    await using _fixture = await setup();
    await mountApp(searchShells());
    await press(PALETTE_CHORD);
    await vi.waitFor(() => expect(paletteOpen()).toBe(true));

    await typeIntoPalette("new thread");

    expect(paletteOptions().join("|")).not.toContain(SEARCH_PROJECT_TITLE);
  });

  it("agent search popup spec: a sidebar query never returns a search thread", async () => {
    await using _fixture = await setup();
    await mountApp(searchShells());

    await typeIntoSearch("rename");

    expect(searchResultKeys(), "ordinary matches stay").toContain(threadKey("beta-rename"));
    expect(searchResultKeys()).not.toContain(threadKey("search-hidden-1"));
  });

  it("agent search popup spec: the palette lists no search thread and no search project", async () => {
    await using _fixture = await setup();
    await mountApp(searchShells());
    await press(PALETTE_CHORD);
    await vi.waitFor(() => expect(paletteOpen()).toBe(true));

    await typeIntoPalette("Where is the rename work");
    expect(paletteOptions().join("|")).not.toContain("Where is the rename work");
    await typeIntoPalette(SEARCH_PROJECT_TITLE);
    expect(paletteOptions().join("|")).not.toContain(SEARCH_PROJECT_TITLE);
  });
});

describe("agent search popup: the old Agent mode is gone", () => {
  it("agent search popup spec: the palette offers no way into the old Agent mode", async () => {
    await using _fixture = await setup();
    await mountApp();
    await press(PALETTE_CHORD);
    await vi.waitFor(() => expect(paletteOpen()).toBe(true));

    await typeIntoPalette("agent search");

    expect(paletteOptions().join("|")).not.toContain("Search threads with an agent");
  });

  it("agent search popup spec: ThreadSearchPicker and the AgentThreadSearch components are removed", () => {
    const remaining = Object.keys(
      import.meta.glob("./components/threads/{ThreadSearchPicker,AgentThreadSearch*}.tsx"),
    );
    expect(remaining).toEqual([]);
  });
});

// regression: reviewer-1 P2-1 — a read-only connection was offered the agent search.
describe("agent search popup: permission", () => {
  it("agent search popup spec: without the operate grant the field offers no agent search and leaves Tab alone", async () => {
    await using _fixture = await setup();
    fixture.sessions.set(FENCE_ENVIRONMENT_ID, makeFenceSession(["orchestration:read"]));
    await mountApp();
    await typeIntoSearch(QUERY);

    expect(sparkle(), "no sparkle to start a search").toBeNull();
    const event = await press(TAB);

    expect(event.defaultPrevented).toBe(false);
    expect(popup()).toBeNull();
    expect(startCalls()).toEqual([]);
  });
});

describe("agent search popup guards", () => {
  it("agent search popup guard: Tab in an empty sidebar Search opens nothing and leaves Tab to the browser", async () => {
    await using _fixture = await setup();
    await mountApp();
    await act(async () => sidebarSearchField()!.focus());

    const event = await press(TAB);

    expect(event.defaultPrevented).toBe(false);
    expect(popup()).toBeNull();
    expect(startCalls()).toEqual([]);
  });

  it("agent search popup guard: Shift+Tab in a non-empty sidebar Search opens nothing", async () => {
    await using _fixture = await setup();
    await mountApp();
    await typeIntoSearch(QUERY);

    const event = await press({ ...TAB, shiftKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(popup()).toBeNull();
    expect(startCalls()).toEqual([]);
  });

  it("agent search popup guard: an empty sidebar Search with nothing unseen shows no sparkle", async () => {
    await using _fixture = await setup();
    await mountApp();

    expect(sparkle()).toBeNull();
    expect(dotsIn(sidebarSearchBox())).toBeNull();
  });

  it("agent search popup guard: ArrowDown then Enter in the sidebar Search still opens the second result", async () => {
    await using _fixture = await setup();
    await mountApp();
    await typeIntoSearch("rename");
    const [, second] = searchResultKeys();
    expect(second, "two results").toBeDefined();

    await press({ key: "ArrowDown", code: "ArrowDown" });
    await press({ key: "Enter", code: "Enter" });

    const id = second!.split(":").at(-1)!;
    await vi.waitFor(() => expect(router!.state.location.pathname).toBe(`/${environmentId}/${id}`));
    expect(popup()).toBeNull();
  });

  it("agent search popup guard: in a chat a thread link stays in this tab and an external link opens a new one", async () => {
    await using _fixture = await setup();
    await mountApp(
      [],
      "See [Rename the sidebar](t3-thread://v1/beta-rename) and [the docs](https://example.com/docs).",
    );

    const threadLink = await vi.waitFor(() => {
      const found = document.querySelector<HTMLAnchorElement>(
        'a[aria-label="Thread, Rename the sidebar"]',
      );
      expect(found, "the thread link").not.toBeNull();
      return found!;
    });
    const external = document.querySelector<HTMLAnchorElement>(
      'a[href="https://example.com/docs"]',
    );
    expect(external, "the external link").not.toBeNull();
    expect(external!.target).toBe("_blank");
    expect(threadLink.target).not.toBe("_blank");

    await act(async () => threadLink.click());
    await settle();

    await vi.waitFor(() =>
      expect(router!.state.location.pathname).toBe(`/${environmentId}/beta-rename`),
    );
  });

  it("agent search popup guard: Escape in a non-empty sidebar Search still clears it and opens nothing", async () => {
    await using _fixture = await setup();
    await mountApp();
    await typeIntoSearch(QUERY);

    await press({ key: "Escape", code: "Escape" });

    expect(sidebarSearchField()!.value).toBe("");
    expect(popup()).toBeNull();
  });
});
