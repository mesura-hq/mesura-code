import { flushSync } from "react-dom";
import { page, userEvent } from "vite-plus/test/browser";
import { flushBrowserTasks } from "./test/browserTasks";
import { act, type Screen } from "../test/render";
// Sidebar Search as the one thread search, project filter on keys (search unification phase 1),
// through AppRoot, the real Sidebar over two projects, CommandPalette and ChatView. Message search
// (`useThreadSearch`) answers from the fixture; chords are the shipped defaults. The setup follows
// `AppRoot.editorKeySidebarCost.fence.browser.test.tsx`, without its editor.
import { describe, expect, it, vi } from "vite-plus/test";

const fenceMocks = vi.hoisted(() => () => import("./test/appRootFenceMocks"));
vi.mock("./state/presentation", async (original) =>
  (await fenceMocks()).mockPresentation(original),
);
vi.mock("./connection/runtime", async () => (await fenceMocks()).mockConnectionRuntime());
vi.mock("@t3tools/client-runtime/state/session", async (original) =>
  (await fenceMocks()).mockRuntimeSession(original),
);
/**
 * What the sidebar lists. The shared fixture lists nothing, because its
 * sidebar is a stub; this fence fills both lists before mounting. `messageHits`
 * is what the server's message search answers for any query of two or more
 * characters.
 */
const sidebarLists = vi.hoisted(() => ({
  threads: [] as import("@t3tools/client-runtime/state/models").EnvironmentThreadShell[],
  projects: [] as unknown[],
  messageHits:
    [] as import("@t3tools/client-runtime/state/thread-search").EnvironmentThreadSearchMatch[],
  listeners: new Set<() => void>(),
  shellReads: new Map<string, number>(),
  messageSearchPending: false,
  /** What `useLegacySidebarEnabled` answers. */
  legacySidebar: false,
}));
vi.mock("./state/entities", async (original) => {
  const mocks = await fenceMocks();
  const { Atom } = await import("effect/reactivity");
  const { useAtomValue } = await import("@effect/atom-react");
  const { createEnvironmentThreadShellAtoms } =
    await import("@t3tools/client-runtime/state/threads");
  const { PrimaryConnectionTarget } = await import("@t3tools/client-runtime/connection");
  const { EnvironmentId } = await import("@t3tools/contracts");
  const Option = await import("effect/Option");
  const { environmentServerConfigsAtom } = await import("./state/server");
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
            label: "Search fence",
            httpBaseUrl: "https://search-fence.invalid",
            wsBaseUrl: "wss://search-fence.invalid",
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
        projects: [],
      });
      const listener = () => get.setSelf(read());
      sidebarLists.listeners.add(listener);
      get.addFinalizer(() => sidebarLists.listeners.delete(listener));
      return read();
    }).pipe(Atom.setIdleTTL(0)),
  );
  const shells = createEnvironmentThreadShellAtoms({ catalogValueAtom, snapshotAtom });
  const emptyShell = Atom.make(null);
  return {
    ...(await mocks.mockEntities(original)),
    useThreadShells: () => useAtomValue(shells.threadShellsAtom),
    useQuietThreadShells: () => useAtomValue(shells.quietThreadShellsAtom),
    useThreadShell: (ref: import("@t3tools/contracts").ScopedThreadRef | null) => {
      if (ref)
        sidebarLists.shellReads.set(
          ref.threadId,
          (sidebarLists.shellReads.get(ref.threadId) ?? 0) + 1,
        );
      return useAtomValue(ref === null ? emptyShell : shells.threadShellAtom(ref));
    },
    useQuietThreadShell: (ref: import("@t3tools/contracts").ScopedThreadRef | null) =>
      useAtomValue(ref === null ? emptyShell : shells.quietThreadShellAtom(ref)),
    useServerConfigs: () => useAtomValue(environmentServerConfigsAtom),
    useProjects: () => sidebarLists.projects,
  };
});
vi.mock("./state/environments", async (original) =>
  (await fenceMocks()).mockEnvironments(original),
);
vi.mock("./state/query", async (original) => (await fenceMocks()).mockQuery(original));
vi.mock("./state/queries", async (original) => ({
  ...(await (await fenceMocks()).mockQueries(original)),
  useThreadSearch: (_environmentIds: unknown, query: string) =>
    query.trim().length >= 2
      ? {
          matches: sidebarLists.messageHits,
          query: query.trim(),
          isPending: sidebarLists.messageSearchPending,
        }
      : { matches: [], query: "", isPending: false },
}));
vi.mock("./state/threads", async (original) => (await fenceMocks()).mockThreads(original));
vi.mock("./state/use-atom-command", async () => (await fenceMocks()).mockAtomCommand());
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
vi.mock("./hooks/useSettings", async (original) => ({
  ...(await (await fenceMocks()).mockSettings(original)),
  useLegacySidebarEnabled: () => sidebarLists.legacySidebar,
}));
vi.mock("./hooks/useHandleNewThread", async () => (await fenceMocks()).mockHandleNewThread());
vi.mock("./hooks/useThreadActions", async () => (await fenceMocks()).mockThreadActions());
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
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { startMainAppLocationTracking } from "./components/sidebar/mainAppLocation";
import { installKeyEngine } from "./keys/keyEngine";
import { useProjectScopeStore } from "./projectScopeStore";
import {
  addFenceThread,
  fenceEnvironmentId as environmentId,
  makeMessage,
  renderFenceApp,
  type FenceRouter,
} from "./test/appRootFenceApp";
import { appRootFence as fixture } from "./test/appRootFenceMocks";
import { makeFenceThreadShell } from "./test/fenceThreadShell";

const NOW_MS = Date.parse("2026-10-08T12:00:00.000Z");
const ALPHA_PROJECT_ID = fixture.project.id;
const ALPHA_TITLE = fixture.project.title;
const BETA_PROJECT_ID = "search-fence-beta";
const BETA_TITLE = "Beta workspace";
const OPEN_THREAD_ID = "search-fence-open";

let root: Screen | undefined;
let router: FenceRouter | undefined;
let stopLocationTracking: (() => void) | undefined;
let container: HTMLDivElement;

async function setupBrowserFixture0() {
  sidebarLists.shellReads.clear();
  sidebarLists.messageSearchPending = false;
  const previousViewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1440, 900);
  installKeyEngine();
  useProjectScopeStore.setState(useProjectScopeStore.getInitialState(), true);
  container = document.createElement("div");
  // AppRoot normally mounts in #root, whose CSS gives it a definite height.
  container.style.cssText = "width: 100%; height: 100dvh;";
  document.body.append(container);

  return {
    async [Symbol.asyncDispose]() {
      stopLocationTracking?.();
      stopLocationTracking = undefined;
      await act(async () => root?.[Symbol.asyncDispose]());
      root = undefined;
      router = undefined;
      container.remove();
      fixture.threads.clear();
      fixture.threadStates.clear();
      sidebarLists.threads = [];
      sidebarLists.projects = [];
      sidebarLists.messageHits = [];
      sidebarLists.legacySidebar = false;
      useProjectScopeStore.setState(useProjectScopeStore.getInitialState(), true);
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

const betaProject = {
  ...fixture.project,
  id: BETA_PROJECT_ID,
  title: BETA_TITLE,
  workspaceRoot: "/tmp/search-fence-beta",
};

function minutesAgo(minutes: number): string {
  return new Date(NOW_MS - minutes * 60_000).toISOString();
}

/** A sidebar-only thread shell in `projectId`, last active `minutes` ago. */
function sidebarThread(
  id: string,
  title: string,
  projectId: string,
  minutes: number,
  branch: string | null = null,
) {
  const at = DateTime.makeUnsafe(minutesAgo(minutes));
  return makeFenceThreadShell({
    id: ThreadId.make(id),
    environmentId,
    projectId: ProjectId.make(projectId),
    title,
    branch,
    createdAt: minutesAgo(minutes),
    overrides: { updatedAt: at, latestUserMessageAt: at },
  });
}

function threadKey(id: string): string {
  return scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));
}

/**
 * Mounts the app on an open Alpha thread, with the given extra threads in the
 * sidebar beside it, at the current viewport.
 */
async function mountWithThreads(
  extra: ReadonlyArray<ReturnType<typeof sidebarThread>>,
  options: { readonly vimMode?: boolean } = {},
): Promise<void> {
  const openThreadId = addFenceThread(OPEN_THREAD_ID, "Open thread", [
    makeMessage(`${OPEN_THREAD_ID}-assistant`, "assistant", "Done."),
  ]);
  sidebarLists.threads = [...fixture.threads.values(), ...extra];
  sidebarLists.projects = [fixture.project, betaProject];
  ({ root, router } = await renderFenceApp(container, openThreadId, {
    vimMode: options.vimMode ?? false,
  }));
  // `appInit` starts this in the app: it is where closing the Settings modal returns to.
  stopLocationTracking = startMainAppLocationTracking(router);
  await settle();
  // The composer takes focus on mount and claims some chords for itself; a
  // chord under test starts from the page, as the sidebar fences do.
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

/** Presses a leader sequence such as `<Space>ft`, one key per character after the leader. */
async function pressLeader(keys: string): Promise<void> {
  await press({ key: " ", code: "Space" });
  for (const key of keys) await press({ key, code: `Key${key.toUpperCase()}` });
}

// Mod is Control in the Linux Chromium test browser.
const THREAD_SEARCH_CHORD: Chord = { key: "k", code: "KeyK", ctrlKey: true, altKey: true };
const PROJECT_SCOPE_CHORD: Chord = { key: "F", code: "KeyF", ctrlKey: true, shiftKey: true };
const TOGGLE_ALL_CHORD: Chord = { key: "p", code: "KeyP", ctrlKey: true, altKey: true };
const PALETTE_CHORD: Chord = { key: "o", code: "KeyO", ctrlKey: true };

/** The sidebar's Search field. At phone width it lives in the drawer, portaled to the body. */
function sidebarSearchField(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('input[aria-label="Search threads"]');
}

function projectSearchInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('input[aria-label="Search projects"]');
}

function projectFilterTrigger(): HTMLElement {
  const trigger = document.querySelector<HTMLElement>('[aria-label^="Filter threads by project"]');
  expect(trigger, "the sidebar's project filter trigger").not.toBeNull();
  return trigger!;
}

function mobileDrawerOpen(): boolean {
  return document.querySelector('[data-mobile="true"][data-slot="sidebar"]') !== null;
}

function paletteOpen(): boolean {
  return document.querySelector('[data-testid="command-palette"][data-open]') !== null;
}

function describeFocus(): string {
  const active = document.activeElement as HTMLElement | null;
  if (!active) return "nothing";
  return `${active.tagName.toLowerCase()}[aria-label=${active.getAttribute("aria-label")}]`;
}

/** The thread keys of the sidebar's list rows, top to bottom. */
function listedThreadKeys(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[data-thread-item]")].map(
    (row) => row.dataset.threadItem ?? "",
  );
}

/** The thread keys of the sidebar's search results, top to bottom. */
function searchResultKeys(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[data-search-result-key]")].map(
    (row) => row.dataset.searchResultKey ?? "",
  );
}

async function typeIntoSearch(value: string): Promise<void> {
  const field = sidebarSearchField();
  expect(field, "the sidebar Search field").not.toBeNull();
  await act(async () => {
    field!.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

/** Picks a project in the sidebar's own filter, as a pointer user does. */
async function chooseProjectInFilter(title: string): Promise<void> {
  await userEvent.click(projectFilterTrigger());
  // The options open in a popup that can mount after one settle on a loaded runner.
  const option = await vi.waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((candidate) =>
      candidate.textContent?.includes(title),
    );
    expect(found, `the ${title} option in the project filter`).toBeDefined();
    return found!;
  });
  await userEvent.click(option);
  await settle();
  expect(projectFilterTrigger().getAttribute("aria-label")).toBe(
    `Filter threads by project: ${title}`,
  );
}

const crossProjectThreads = () => [
  sidebarThread("alpha-rename", "Rename the composer", ALPHA_PROJECT_ID, 30),
  sidebarThread("beta-rename", "Rename the sidebar", BETA_PROJECT_ID, 10),
  sidebarThread("beta-unrelated", "Provider settings", BETA_PROJECT_ID, 20),
];

// Keep this target below the old first result so a stale Enter cannot pass.
function addPendingSearchTarget() {
  const at = DateTime.makeUnsafe(minutesAgo(60));
  return addFenceThread(
    "pending-target",
    "Rename target thread",
    [makeMessage("pending-target-assistant", "assistant", "Done.")],
    { createdAt: minutesAgo(60), overrides: { updatedAt: at, latestUserMessageAt: at } },
  );
}

describe("search unification: the sidebar Search reaches every project", () => {
  it("keeps unchanged title rows mounted without rendering them again when the query gains whitespace", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads(crossProjectThreads());
    await typeIntoSearch("rename");
    const before = sidebarLists.shellReads.get("beta-rename");
    expect(before).toBeGreaterThan(0);
    await typeIntoSearch("rename ");
    expect(searchResultKeys()).toEqual([threadKey("beta-rename"), threadKey("alpha-rename")]);
    expect(sidebarLists.shellReads.get("beta-rename")).toBe(before);
  });

  it("keeps the pull request badge on field matches for number and URL queries", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    const thread = sidebarThread("pr-match", "Rename sidebar", ALPHA_PROJECT_ID, 5);
    const url = "https://github.com/acme/app/pull/57";
    await mountWithThreads([
      makeFenceThreadShell({
        environmentId,
        id: thread.id,
        projectId: thread.projectId,
        overrides: {
          ...thread.source,
          linkedPullRequest: {
            projectId: thread.projectId,
            repository: "acme/app",
            number: 57,
            url,
          },
        },
      }),
    ]);
    for (const query of ["#57", "57", url]) {
      await typeIntoSearch(query);
      expect(searchResultKeys()).toEqual([threadKey("pr-match")]);
      const row = document.querySelector<HTMLElement>("[data-search-result-key]")!;
      expect(row.querySelector('[aria-label="PR #57, status pending"]')).not.toBeNull();
    }
  });

  it("search unification spec: with a project filter active a query lists matching threads from every project", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads(crossProjectThreads());
    await chooseProjectInFilter(ALPHA_TITLE);
    expect(listedThreadKeys()).not.toContain(threadKey("beta-rename"));

    await typeIntoSearch("rename");

    expect(searchResultKeys()).toEqual([threadKey("beta-rename"), threadKey("alpha-rename")]);
  });

  it("search unification spec: clearing the query shows only the filtered project again", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads(crossProjectThreads());
    await chooseProjectInFilter(ALPHA_TITLE);
    await typeIntoSearch("rename");
    expect(searchResultKeys()).toContain(threadKey("beta-rename"));

    await typeIntoSearch("");

    const listed = listedThreadKeys();
    expect(listed).toContain(threadKey("alpha-rename"));
    expect(listed).not.toContain(threadKey("beta-rename"));
    expect(listed).not.toContain(threadKey("beta-unrelated"));
    expect(projectFilterTrigger().getAttribute("aria-label")).toBe(
      `Filter threads by project: ${ALPHA_TITLE}`,
    );
  });

  it("search unification spec: field matches from both projects keep the sidebar's order and message matches follow", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    const fiftyEightDays = 58 * 24 * 60;
    await mountWithThreads([
      // One word in the title, the other in the branch: the former word score
      // ranked a title hit above a branch hit, so it put the older thread first.
      sidebarThread("beta-new", "Sidebar polish", BETA_PROJECT_ID, 60, "rename-flow"),
      sidebarThread("alpha-58-days", "Sidebar rename", ALPHA_PROJECT_ID, fiftyEightDays),
      sidebarThread("beta-message-hit", "Composer focus", BETA_PROJECT_ID, 5),
      sidebarThread("alpha-message-hit", "Provider settings", ALPHA_PROJECT_ID, 15),
    ]);
    // The sidebar's own order, read from its list with every project shown.
    const sidebarOrder = listedThreadKeys();
    sidebarLists.messageHits = ["beta-message-hit", "alpha-message-hit"].map((id) => ({
      environmentId,
      threadId: ThreadId.make(id),
      projectId: ProjectId.make(id.startsWith("beta") ? BETA_PROJECT_ID : ALPHA_PROJECT_ID),
      source: "user" as const,
      snippet: "the sidebar rename again",
      messageCreatedAt: null,
    }));
    await chooseProjectInFilter(ALPHA_TITLE);

    await typeIntoSearch("sidebar rename");

    expect(searchResultKeys().slice(0, 2)).toEqual([
      threadKey("beta-new"),
      threadKey("alpha-58-days"),
    ]);
    const inSidebarOrder = (ids: ReadonlyArray<string>) =>
      ids.map(threadKey).toSorted((a, b) => sidebarOrder.indexOf(a) - sidebarOrder.indexOf(b));
    expect(searchResultKeys()).toEqual([
      ...inSidebarOrder(["beta-new", "alpha-58-days"]),
      ...inSidebarOrder(["beta-message-hit", "alpha-message-hit"]),
    ]);
  });
});

describe("search unification: the thread-search command lands in the sidebar Search", () => {
  it("search unification spec: Mod+Alt+K focuses the sidebar Search field and opens no palette", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads(crossProjectThreads());

    await press(THREAD_SEARCH_CHORD);

    await vi.waitFor(() =>
      expect(document.activeElement, `focus is on ${describeFocus()}`).toBe(sidebarSearchField()),
    );
    expect(paletteOpen(), "the thread-search picker no longer opens").toBe(false);
  });

  it("search unification spec: Mod+Alt+K at Pixel 7 width opens the closed drawer and focuses its Search field", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await page.viewport(412, 915);
    await mountWithThreads(crossProjectThreads());
    expect(mobileDrawerOpen(), "the drawer starts closed").toBe(false);

    await press(THREAD_SEARCH_CHORD);

    await vi.waitFor(() => expect(mobileDrawerOpen(), "the drawer opened").toBe(true));
    await vi.waitFor(() =>
      expect(document.activeElement, `focus is on ${describeFocus()}`).toBe(sidebarSearchField()),
    );
    expect(paletteOpen()).toBe(false);
  });

  it("search unification spec: <leader>ft in Vim mode focuses the sidebar Search field", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads(crossProjectThreads(), { vimMode: true });

    await pressLeader("ft");

    await vi.waitFor(() =>
      expect(document.activeElement, `focus is on ${describeFocus()}`).toBe(sidebarSearchField()),
    );
    expect(paletteOpen()).toBe(false);
  });

  it("search unification spec: the palette's Search threads row closes the palette and focuses the sidebar Search field", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads(crossProjectThreads());
    await press(PALETTE_CHORD);
    await vi.waitFor(() => expect(paletteOpen()).toBe(true));
    const row = [
      ...document.querySelectorAll<HTMLElement>('[data-testid="command-palette"] [role="option"]'),
    ].find((candidate) => candidate.textContent?.trim().startsWith("Search threads"));
    expect(row, "the palette's Search threads row").toBeDefined();

    await userEvent.click(row!);
    await settle();

    await vi.waitFor(() => expect(paletteOpen(), "the palette closed").toBe(false));
    await vi.waitFor(() =>
      expect(document.activeElement, `focus is on ${describeFocus()}`).toBe(sidebarSearchField()),
    );
  });
});

describe("search unification: the project-scope command opens the sidebar's project filter", () => {
  it("search unification spec: Mod+Shift+F opens the sidebar project filter with its search input focused", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads(crossProjectThreads());

    await press(PROJECT_SCOPE_CHORD);

    await vi.waitFor(() =>
      expect(projectSearchInput(), "the filter's search input").not.toBeNull(),
    );
    await vi.waitFor(() =>
      expect(document.activeElement, `focus is on ${describeFocus()}`).toBe(projectSearchInput()),
    );
    expect(paletteOpen(), "the palette's project scope picker no longer opens").toBe(false);
  });

  it("search unification spec: <leader>fp in Vim mode opens the sidebar project filter with its search input focused", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads(crossProjectThreads(), { vimMode: true });

    await pressLeader("fp");

    await vi.waitFor(() =>
      expect(document.activeElement, `focus is on ${describeFocus()}`).toBe(projectSearchInput()),
    );
    expect(paletteOpen()).toBe(false);
  });

  it("search unification spec: Mod+Shift+F at Pixel 7 width opens the drawer and then the project filter", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await page.viewport(412, 915);
    await mountWithThreads(crossProjectThreads());

    await press(PROJECT_SCOPE_CHORD);

    await vi.waitFor(() => expect(mobileDrawerOpen(), "the drawer opened").toBe(true));
    await vi.waitFor(() =>
      expect(document.activeElement, `focus is on ${describeFocus()}`).toBe(projectSearchInput()),
    );
  });
});

describe("search unification: Mod+Alt+P toggles All projects and the last project", () => {
  it("search unification spec: Mod+Alt+P switches to All projects and pressed again returns to the last project", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads(crossProjectThreads());
    await chooseProjectInFilter(BETA_TITLE);

    await press(TOGGLE_ALL_CHORD);
    expect(projectFilterTrigger().getAttribute("aria-label")).toBe("Filter threads by project");
    expect(listedThreadKeys()).toContain(threadKey("alpha-rename"));

    await press(TOGGLE_ALL_CHORD);
    expect(projectFilterTrigger().getAttribute("aria-label")).toBe(
      `Filter threads by project: ${BETA_TITLE}`,
    );
    expect(listedThreadKeys()).not.toContain(threadKey("alpha-rename"));
  });

  it("search unification spec: Mod+Alt+P with no last project leaves All projects and claims the key", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads(crossProjectThreads());

    const event = await press(TOGGLE_ALL_CHORD);

    expect(event.defaultPrevented, "the toggle owns the chord").toBe(true);
    expect(projectFilterTrigger().getAttribute("aria-label")).toBe("Filter threads by project");
  });
});

describe("search unification guards", () => {
  it("search unification guard: a freshly loaded project scope store starts on All projects after a filter was chosen", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads(crossProjectThreads());
    await chooseProjectInFilter(BETA_TITLE);

    // A reload evaluates the module again against the same localStorage. In
    // browser mode `vi.resetModules` keeps the evaluated module, so a query
    // string makes Vite serve a second, freshly evaluated instance.
    const reloaded = (await import(
      /* @vite-ignore */ `${new URL("./projectScopeStore.ts", import.meta.url).pathname}?reload`
    )) as typeof import("./projectScopeStore");

    expect(reloaded.useProjectScopeStore.getState().projectScopeKey).toBe(null);
    for (const value of Object.values(window.localStorage)) {
      expect(value).not.toContain(BETA_PROJECT_ID);
    }
  });

  it("search unification guard: a Mod+O palette thread row still opens its thread", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads(crossProjectThreads());
    await press(PALETTE_CHORD);
    await vi.waitFor(() => expect(paletteOpen()).toBe(true));
    const input = document.querySelector<HTMLInputElement>('[data-testid="command-palette"] input');
    expect(input, "the palette's input").not.toBeNull();
    await act(async () => {
      input!.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "Rename the sidebar",
      );
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    const row = await vi.waitFor(() => {
      const match = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-testid="command-palette"] [role="option"]',
        ),
      ].find((candidate) => candidate.textContent?.includes("Rename the sidebar"));
      expect(match, "the palette's thread row").toBeDefined();
      return match!;
    });

    await userEvent.click(row);
    await settle();

    await vi.waitFor(() =>
      expect(router!.state.location.pathname).toBe(`/${environmentId}/beta-rename`),
    );
  });
});

function paletteMode(): string | null {
  return (
    document
      .querySelector('[data-testid="command-palette"][data-open]')
      ?.getAttribute("data-palette-mode") ?? null
  );
}

async function openPalette(): Promise<void> {
  await press(PALETTE_CHORD);
  await vi.waitFor(() => expect(paletteMode()).toBe("command"));
}

describe("search unification regression: the commands on Settings and with the legacy sidebar", () => {
  it("search unification regression: Mod+Alt+K on Settings returns to the thread and focuses the sidebar Search field", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads(crossProjectThreads());
    await act(async () => {
      await router!.navigate({ to: "/settings" });
    });
    await settle();
    expect(document.querySelector("[data-app-modal]"), "the Settings modal").not.toBeNull();
    document.querySelector<HTMLElement>('[data-testid="settings-control"]')?.focus();

    await press(THREAD_SEARCH_CHORD);

    await vi.waitFor(() =>
      expect(router!.state.location.pathname).toBe(`/${environmentId}/${OPEN_THREAD_ID}`),
    );
    await vi.waitFor(() =>
      expect(document.activeElement, `focus is on ${describeFocus()}`).toBe(sidebarSearchField()),
    );
  });

  it("search unification regression: Mod+Shift+F on Settings returns to the thread and opens the project filter", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads(crossProjectThreads());
    await act(async () => {
      await router!.navigate({ to: "/settings" });
    });
    await settle();
    document.querySelector<HTMLElement>('[data-testid="settings-control"]')?.focus();

    await press(PROJECT_SCOPE_CHORD);

    await vi.waitFor(() =>
      expect(router!.state.location.pathname).toBe(`/${environmentId}/${OPEN_THREAD_ID}`),
    );
    await vi.waitFor(() =>
      expect(document.activeElement, `focus is on ${describeFocus()}`).toBe(projectSearchInput()),
    );
  });

  it("search unification regression: Mod+Alt+P on Settings still flips the project scope", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads(crossProjectThreads());
    await chooseProjectInFilter(BETA_TITLE);
    const betaKey = useProjectScopeStore.getState().projectScopeKey;
    await act(async () => {
      await router!.navigate({ to: "/settings" });
    });
    await settle();

    await press(TOGGLE_ALL_CHORD);
    expect(useProjectScopeStore.getState().projectScopeKey).toBe(null);
    await press(TOGGLE_ALL_CHORD);
    expect(useProjectScopeStore.getState().projectScopeKey).toBe(betaKey);
  });

  it("search unification regression: with the legacy sidebar Mod+Alt+K and Mod+Shift+F open the command palette", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    sidebarLists.legacySidebar = true;
    await mountWithThreads(crossProjectThreads());

    await press(THREAD_SEARCH_CHORD);
    await vi.waitFor(() => expect(paletteMode()).toBe("command"));
    await press({ key: "Escape", code: "Escape" });
    await vi.waitFor(() => expect(paletteOpen()).toBe(false));
    (document.activeElement as HTMLElement | null)?.blur?.();

    await press(PROJECT_SCOPE_CHORD);
    await vi.waitFor(() => expect(paletteMode()).toBe("command"));
  });

  it("search unification regression: with the legacy sidebar Mod+Alt+P still flips the project scope store", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    sidebarLists.legacySidebar = true;
    await mountWithThreads(crossProjectThreads());
    useProjectScopeStore.getState().setProjectScopeKey("legacy-fence-scope");

    await press(TOGGLE_ALL_CHORD);
    expect(useProjectScopeStore.getState().projectScopeKey).toBe(null);
    await press(TOGGLE_ALL_CHORD);
    expect(useProjectScopeStore.getState().projectScopeKey).toBe("legacy-fence-scope");
  });
});

describe("search unification regression: a focus chord over the open palette", () => {
  it("search unification regression: Mod+Alt+K over the open palette closes it and focuses the sidebar Search field", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads(crossProjectThreads());
    await openPalette();

    await press(THREAD_SEARCH_CHORD);

    await vi.waitFor(() => expect(paletteOpen(), "the palette closed").toBe(false));
    await vi.waitFor(() =>
      expect(document.activeElement, `focus is on ${describeFocus()}`).toBe(sidebarSearchField()),
    );
  });

  it("search unification regression: Mod+Shift+F over the open palette closes it and opens the project filter", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads(crossProjectThreads());
    await openPalette();

    await press(PROJECT_SCOPE_CHORD);

    await vi.waitFor(() => expect(paletteOpen(), "the palette closed").toBe(false));
    await vi.waitFor(() =>
      expect(document.activeElement, `focus is on ${describeFocus()}`).toBe(projectSearchInput()),
    );
  });

  it("search unification regression: Mod+Alt+K over the open palette at Pixel 7 opens the closed drawer and focuses its Search field", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await page.viewport(412, 915);
    await mountWithThreads(crossProjectThreads());
    await openPalette();
    expect(mobileDrawerOpen(), "the drawer starts closed").toBe(false);

    await press(THREAD_SEARCH_CHORD);

    await vi.waitFor(() => expect(paletteOpen(), "the palette closed").toBe(false));
    await vi.waitFor(() => expect(mobileDrawerOpen(), "the drawer opened").toBe(true));
    await vi.waitFor(() =>
      expect(document.activeElement, `focus is on ${describeFocus()}`).toBe(sidebarSearchField()),
    );
  });
});

describe("search unification regression: the chat keeps its own focus after a search", () => {
  it.each(["Enter", "pointer"])(
    "keeps a %s selection made before the current query commits",
    async (method) => {
      await using _browserFixture0 = await setupBrowserFixture0();
      const targetId = addPendingSearchTarget();
      await mountWithThreads(crossProjectThreads());
      await typeIntoSearch("rename");
      expect(searchResultKeys()).toContain(threadKey(targetId));
      expect(searchResultKeys()[0]).not.toBe(threadKey(targetId));
      const field = sidebarSearchField()!;
      const target = [...document.querySelectorAll<HTMLElement>("[data-search-result-key]")].find(
        (row) => row.dataset.searchResultKey === threadKey(targetId),
      )!;

      // One event task: the input is ahead of the result transition when the pick arrives.
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          field,
          "target thread",
        );
        field.dispatchEvent(new Event("input", { bubbles: true }));
        expect(searchResultKeys().length).toBeGreaterThan(1);
        if (method === "Enter") {
          field.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Enter",
              code: "Enter",
              bubbles: true,
              cancelable: true,
            }),
          );
        } else {
          target.click();
        }
      });
      await vi.waitFor(() =>
        expect(router!.state.location.pathname).toBe(`/${environmentId}/${targetId}`),
      );
      expect(sidebarSearchField()!.value).toBe("");
    },
  );

  it("does not open a stale pointer row absent from the committed query", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    const targetId = addPendingSearchTarget();
    await mountWithThreads(crossProjectThreads());
    await typeIntoSearch("rename");
    const before = router!.state.location.pathname;
    const field = sidebarSearchField()!;
    const stale = [...document.querySelectorAll<HTMLElement>("[data-search-result-key]")].find(
      (row) => row.dataset.searchResultKey === threadKey("alpha-rename"),
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        field,
        "target thread",
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
      stale.click();
    });
    await vi.waitFor(() => expect(searchResultKeys()).toEqual([threadKey(targetId)]));
    expect(router!.state.location.pathname).toBe(before);
    expect(sidebarSearchField()!.value).toBe("target thread");
  });

  it.each(["Escape", "button", "native"])(
    "enters the restored list when Down follows %s before clear commits",
    async (method) => {
      await using _browserFixture0 = await setupBrowserFixture0();
      await mountWithThreads(crossProjectThreads());
      await typeIntoSearch("rename");
      const field = sidebarSearchField()!;
      await act(async () => {
        flushSync(() => {
          if (method === "Escape") {
            field.dispatchEvent(
              new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
            );
          } else if (method === "button") {
            document.querySelector<HTMLElement>('[aria-label="Clear thread search"]')!.click();
          } else {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
              field,
              "",
            );
            field.dispatchEvent(new Event("input", { bubbles: true }));
          }
        });
        expect(field.value).toBe("");
        expect(searchResultKeys().length).toBeGreaterThan(0);
        field.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
        );
      });
      await vi.waitFor(() =>
        expect(document.activeElement).toBe(
          document.querySelector("[data-mesura-nav-stop], [data-mesura-thread-key]"),
        ),
      );
      expect(field.value).toBe("");
    },
  );

  it.each([
    { keys: ["ArrowDown", "ArrowUp"], opens: false },
    { keys: ["ArrowDown", "ArrowDown", "ArrowDown", "Enter"], opens: true },
  ])("keeps cleared-list $keys in order", async ({ keys, opens }) => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads(crossProjectThreads());
    const secondKey = document.querySelectorAll<HTMLElement>("[data-mesura-thread-key]")[1]!.dataset
      .mesuraThreadKey;
    const before = router!.state.location.pathname;
    await typeIntoSearch("rename");
    const field = sidebarSearchField()!;
    await act(async () => {
      flushSync(() => {
        field.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
      });
      expect(field.value).toBe("");
      expect(searchResultKeys().length).toBeGreaterThan(0);
      for (const key of keys)
        field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
    if (opens) {
      await vi.waitFor(() =>
        expect(router!.state.location.pathname).toBe(`/${secondKey!.replace(":", "/")}`),
      );
    } else {
      await vi.waitFor(() => expect(listedThreadKeys().length).toBe(4));
      expect(document.activeElement).toBe(field);
      expect(router!.state.location.pathname).toBe(before);
    }
  });

  it("does not move focus back after a pending clear and Down when focus leaves Search", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads(crossProjectThreads());
    await typeIntoSearch("rename");
    const field = sidebarSearchField()!;
    const outside = projectFilterTrigger();
    await act(async () => {
      flushSync(() => {
        field.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
      });
      expect(field.value).toBe("");
      expect(searchResultKeys().length).toBeGreaterThan(0);
      field.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
      outside.focus();
    });
    await vi.waitFor(() => expect(listedThreadKeys().length).toBe(4));
    expect(document.activeElement).toBe(outside);
  });

  it.each([
    { keys: ["ArrowDown"], expected: "alpha-rename" },
    { keys: ["ArrowUp"], expected: "pending-target" },
    { keys: ["ArrowDown", "ArrowDown"], expected: "pending-target" },
    { keys: ["Enter", "ArrowDown"], expected: "beta-rename" },
    { keys: ["Enter", "ArrowUp"], expected: "beta-rename" },
  ])("preserves pending $keys navigation order", async ({ keys, expected }) => {
    await using _browserFixture0 = await setupBrowserFixture0();
    addPendingSearchTarget();
    await mountWithThreads(crossProjectThreads());
    await typeIntoSearch("provider");
    expect(searchResultKeys()).toEqual([threadKey("beta-unrelated")]);
    const field = sidebarSearchField()!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        field,
        "rename",
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
      for (const key of [...keys, "Enter"]) {
        field.dispatchEvent(
          new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }),
        );
      }
    });
    await vi.waitFor(() =>
      expect(router!.state.location.pathname).toBe(`/${environmentId}/${expected}`),
    );
  });

  it("keeps a pending arrow highlight when Enter follows the committed query", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads(crossProjectThreads());
    await typeIntoSearch("provider");
    const field = sidebarSearchField()!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        field,
        "rename",
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          code: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await press({ key: "Enter", code: "Enter" });
    await vi.waitFor(() =>
      expect(router!.state.location.pathname).toBe(`/${environmentId}/alpha-rename`),
    );
  });

  it("does not keep an Enter intent until a late remote result arrives", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    const targetId = addPendingSearchTarget();
    await mountWithThreads(crossProjectThreads());
    await typeIntoSearch("rename");
    const before = router!.state.location.pathname;
    const field = sidebarSearchField()!;
    sidebarLists.messageSearchPending = true;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        field,
        "needle",
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(searchResultKeys()).toEqual([]);
    await act(async () => {
      sidebarLists.messageSearchPending = false;
      sidebarLists.messageHits = [
        {
          environmentId,
          threadId: targetId,
          projectId: ProjectId.make(ALPHA_PROJECT_ID),
          source: "user",
          snippet: "needle",
          messageCreatedAt: null,
        },
      ];
      // A shell update makes the late server fixture visible through the app entry point.
      sidebarLists.threads = [
        ...sidebarLists.threads,
        sidebarThread("late-refresh", "Other thread", ALPHA_PROJECT_ID, 5),
      ];
      for (const listener of sidebarLists.listeners) listener();
    });
    await vi.waitFor(() => expect(searchResultKeys()).toEqual([threadKey(targetId)]));
    expect(router!.state.location.pathname).toBe(before);
    expect(sidebarSearchField()!.value).toBe("needle");
  });

  it("search unification regression: Enter on a sidebar search result opens it and hands the keyboard to the composer", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    const targetId = addFenceThread("search-fence-target", "Rename target thread", [
      makeMessage("search-fence-target-assistant", "assistant", "Done."),
    ]);
    await mountWithThreads(crossProjectThreads());
    await press(THREAD_SEARCH_CHORD);
    await vi.waitFor(() => expect(document.activeElement).toBe(sidebarSearchField()));
    await typeIntoSearch("target thread");
    expect(searchResultKeys()).toEqual([threadKey(targetId)]);

    await press({ key: "Enter", code: "Enter" });

    await vi.waitFor(() =>
      expect(router!.state.location.pathname).toBe(`/${environmentId}/${targetId}`),
    );
    await vi.waitFor(() =>
      expect(
        (document.activeElement as HTMLElement | null)?.getAttribute("aria-label"),
        `focus is on ${describeFocus()}`,
      ).toBe("Message Rename target thread"),
    );
  });
});
