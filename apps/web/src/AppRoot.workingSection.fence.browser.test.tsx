import { page, userEvent } from "vite-plus/test/browser";
import { flushBrowserTasks } from "./test/browserTasks";
import { act, type Screen } from "../test/render";
// Mesura's Working section under Search (components/sidebar/workingSection.ts), through AppRoot,
// the real Sidebar over two projects, CommandPalette and ChatView. Chords are the shipped
// defaults. The setup is `AppRoot.searchUnification.fence.browser.test.tsx`'s.
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
  /** What `useLegacySidebarEnabled` answers. */
  legacySidebar: false,
  /** Every active reorder the sidebar asked for. */
  activeReorders: [] as unknown[],
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
    useThreadShell: (ref: import("@t3tools/contracts").ScopedThreadRef | null) =>
      useAtomValue(ref === null ? emptyShell : shells.threadShellAtom(ref)),
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
      ? { matches: sidebarLists.messageHits, query: query.trim(), isPending: false }
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
  const { serverConfig } = environment!;
  // Snooze and both reorders on, so every shelf and drag the sidebar offers is live.
  const capabilities = {
    ...serverConfig.environment.capabilities,
    threadSnooze: true,
    threadPinReorder: true,
    threadActiveReorder: true,
  };
  const configs = new Map([
    [
      environment!.environmentId,
      {
        ...serverConfig,
        environment: { ...serverConfig.environment, capabilities },
        settings: DEFAULT_SERVER_SETTINGS,
      },
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
vi.mock("./hooks/useThreadActions", async () => {
  const actions = (await fenceMocks()).mockThreadActions();
  return {
    ...actions,
    useThreadActions: () => ({
      ...actions.useThreadActions(),
      reorderActiveThread: async (...args: unknown[]) => {
        sidebarLists.activeReorders.push(args);
        return { _tag: "Success" as const, value: undefined };
      },
    }),
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
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { THREAD_CONTEXT_DROP_EVENT } from "./components/chat/threadContextDrag";
import { WORKING_SECTION_EXPANDED_KEY } from "./components/sidebar/workingSection";
import { installKeyEngine } from "./keys/keyEngine";
import { readViewportThreadKeys } from "./lib/sidebarThreadViewport";
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
const BETA_PROJECT_ID = "working-fence-beta";
const OPEN_THREAD_ID = "working-fence-open";

let root: Screen | undefined;
let router: FenceRouter | undefined;
let container: HTMLDivElement;

async function setupBrowserFixture0() {
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
      sidebarLists.activeReorders = [];
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
  title: "Beta workspace",
  workspaceRoot: "/tmp/working-fence-beta",
};

function minutesAgo(minutes: number): DateTime.Utc {
  return DateTime.makeUnsafe(new Date(NOW_MS - minutes * 60_000).toISOString());
}

type Shell = ReturnType<typeof makeFenceThreadShell>;
type ShellSource = Shell["source"];

/** A sidebar-only thread shell, last active `minutes` ago. */
function idleThread(
  id: string,
  title: string,
  minutes: number,
  projectId: string = ALPHA_PROJECT_ID,
  overrides: Partial<ShellSource> = {},
): Shell {
  const at = minutesAgo(minutes);
  return makeFenceThreadShell({
    id: ThreadId.make(id),
    environmentId,
    projectId: ProjectId.make(projectId),
    title,
    createdAt: DateTime.formatIso(minutesAgo(minutes + 60)),
    overrides: { updatedAt: at, latestUserMessageAt: at, ...overrides },
  });
}

/** A thread whose turn started `minutes` ago and is still running. */
function workingThread(
  id: string,
  title: string,
  minutes: number,
  projectId: string = ALPHA_PROJECT_ID,
): Shell {
  const runId = RunId.make(`${id}-run`);
  const at = minutesAgo(minutes);
  return idleThread(id, title, minutes, projectId, {
    latestRunId: runId,
    activeRunId: runId,
    status: "running",
    latestRunRequestedAt: at,
    latestRunStartedAt: at,
    latestUserAuthoredMessageAt: at,
  });
}

/** A Software Factory coordinator: its own turn ended, its run goes on. */
function factoryThread(id: string, title: string, minutes: number, phaseIndex = 2): Shell {
  const at = minutesAgo(minutes);
  return idleThread(id, title, minutes, ALPHA_PROJECT_ID, {
    latestRunId: RunId.make(`${id}-run`),
    activeRunId: null,
    status: "completed",
    latestRunRequestedAt: at,
    latestRunStartedAt: at,
    latestRunCompletedAt: minutesAgo(minutes - 1),
    latestUserAuthoredMessageAt: at,
    factoryRun: { status: "running", phaseIndex, phaseCount: 7, node: "implement" },
  });
}

function threadKey(id: string): string {
  return scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));
}

/** The id of an open thread that is working. Its own id: the sidebar's working tracker is module
 * state with a 2 s exit grace, so a shared id would carry Working into the next test. */
const OPEN_WORKING_ID = "working-fence-open-working";

/**
 * Mounts the app on the open thread with `extra` beside it; `openWorking` opens a working thread
 * instead of the idle one.
 */
async function mountWithThreads(
  extra: ReadonlyArray<Shell>,
  options: {
    readonly vimMode?: boolean;
    readonly expanded?: boolean;
    readonly openWorking?: boolean;
  } = {},
): Promise<void> {
  if (options.expanded !== undefined) {
    window.localStorage.setItem(WORKING_SECTION_EXPANDED_KEY, JSON.stringify(options.expanded));
  }
  const openId = options.openWorking ? OPEN_WORKING_ID : OPEN_THREAD_ID;
  const openThreadId = addFenceThread(openId, "Open thread", [
    makeMessage(`${openId}-assistant`, "assistant", "Done."),
  ]);
  if (options.openWorking) {
    fixture.threads.set(openThreadId, workingThread(openId, "Open thread", 3));
  }
  sidebarLists.threads = [...fixture.threads.values(), ...extra];
  sidebarLists.projects = [fixture.project, betaProject];
  ({ root, router } = await renderFenceApp(container, openThreadId, {
    vimMode: options.vimMode ?? false,
  }));
  await settle();
  // The composer takes focus on mount and claims some chords for itself.
  (document.activeElement as HTMLElement | null)?.blur?.();
}

/** Replaces one listed shell, as a server push does. */
async function publish(shell: Shell): Promise<void> {
  sidebarLists.threads = sidebarLists.threads.map((thread) =>
    thread.id === shell.id ? shell : thread,
  );
  await act(async () => {
    for (const listener of sidebarLists.listeners) listener();
  });
  await settle();
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

const TOGGLE_WORKING_CHORD: Chord = { key: "z", code: "KeyZ", altKey: true };
const PALETTE_CHORD: Chord = { key: "o", code: "KeyO", ctrlKey: true };
const DOWN: Chord = { key: "ArrowDown", code: "ArrowDown" };
const UP: Chord = { key: "ArrowUp", code: "ArrowUp" };

function section(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-working-section]");
}

function header(): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>("[data-working-section-header]");
  expect(found, "the Working header").not.toBeNull();
  return found!;
}

function headerExpanded(): boolean {
  return header().getAttribute("aria-expanded") === "true";
}

function sectionRowKeys(): string[] {
  return [...(section()?.querySelectorAll<HTMLElement>("[data-thread-item]") ?? [])].map(
    (row) => row.dataset.threadItem ?? "",
  );
}

function rowCard(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-mesura-thread-key="${threadKey(id)}"]`);
  expect(found, `the row of ${id}`).not.toBeNull();
  return found!;
}

function sidebarSearchField(): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>('input[aria-label="Search threads"]');
  expect(found, "the sidebar Search field").not.toBeNull();
  return found!;
}

function describeFocus(): string {
  const active = document.activeElement as HTMLElement | null;
  if (!active) return "nothing";
  return `${active.tagName.toLowerCase()}[aria-label=${active.getAttribute("aria-label")}][key=${active.dataset.mesuraThreadKey ?? ""}]`;
}

/**
 * The sidebar top to bottom, one entry per landmark: Search, the Working header, a thread row (by
 * id), and the Snoozed and Settled headers.
 */
function sidebarLandmarks(): string[] {
  const selector = [
    "[data-mesura-thread-search]",
    "[data-working-section-header]",
    "[data-thread-item]",
    '[data-testid="sidebar-snoozed-header"]',
    '[data-testid="sidebar-settled-header"]',
  ].join(", ");
  return [...document.querySelectorAll<HTMLElement>(selector)].map((element) => {
    if (element.matches("[data-mesura-thread-search]")) return "Search";
    if (element.matches("[data-working-section-header]")) return "Working";
    if (element.dataset.threadItem) return element.dataset.threadItem.split(":").at(-1)!;
    return element.dataset.testid === "sidebar-snoozed-header" ? "Snoozed" : "Settled";
  });
}

/** Picks a project in the sidebar's own filter, as a pointer user does. */
async function chooseProjectInFilter(title: string): Promise<void> {
  const trigger = document.querySelector<HTMLElement>('[aria-label^="Filter threads by project"]');
  expect(trigger, "the sidebar's project filter trigger").not.toBeNull();
  await userEvent.click(trigger!);
  const option = await vi.waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((candidate) =>
      candidate.textContent?.includes(title),
    );
    expect(found, `the ${title} option in the project filter`).toBeDefined();
    return found!;
  });
  await userEvent.click(option);
  await settle();
}

const FAR_FUTURE = DateTime.makeUnsafe("2099-01-01T00:00:00.000Z");

describe("working section: place and order", () => {
  it("working section spec: Search, Working, every other thread, Snoozed, then Settled, top to bottom", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads(
      [
        idleThread("idle-a", "Idle A", 10),
        workingThread("working-old", "Started first", 30),
        idleThread("idle-b", "Idle B", 20),
        workingThread("working-new", "Started last", 5),
        idleThread("snoozed", "Snoozed one", 15, ALPHA_PROJECT_ID, {
          snoozedAt: minutesAgo(15),
          snoozedUntil: FAR_FUTURE,
        }),
        idleThread("settled", "Settled one", 40, ALPHA_PROJECT_ID, {
          settledOverride: "settled",
          settledAt: minutesAgo(40),
        }),
      ],
      { expanded: true },
    );
    await vi.waitFor(() => expect(section()).not.toBeNull());
    const landmarks = sidebarLandmarks().filter((entry) => !entry.startsWith(OPEN_THREAD_ID));
    expect(landmarks.slice(0, 4), "Search, Working, newest start first").toEqual([
      "Search",
      "Working",
      "working-new",
      "working-old",
    ]);
    expect(landmarks.indexOf("Snoozed")).toBeGreaterThan(landmarks.indexOf("idle-b"));
    expect(landmarks.indexOf("Snoozed")).toBeGreaterThan(landmarks.indexOf("idle-a"));
    expect(landmarks.indexOf("Settled")).toBeGreaterThan(landmarks.indexOf("Snoozed"));
    expect(landmarks.filter((entry) => entry.startsWith("working-"))).toHaveLength(2);
  });

  it("working section spec: the header shows at zero working threads, and the section starts collapsed", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads([idleThread("idle-a", "Idle A", 10)]);

    expect(header().textContent).toContain("Working");
    expect(header().textContent).toContain("0");
    expect(headerExpanded(), "collapsed on a device that never chose").toBe(false);
    expect(sidebarLandmarks().slice(0, 2)).toEqual(["Search", "Working"]);
  });

  it("working section spec: collapsed, the open thread still shows under the header and the others do not", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads([workingThread("working-other", "Other work", 1)], {
      openWorking: true,
    });

    expect(headerExpanded()).toBe(false);
    expect(header().textContent).toContain("2");
    expect(sectionRowKeys()).toEqual([threadKey(OPEN_WORKING_ID)]);
  });

  it("working section spec: a label change never moves a row, and a running Factory run counts as working", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads(
      [
        factoryThread("factory", "Factory coordinator", 20),
        workingThread("working-new", "Started last", 5),
        workingThread("working-old", "Started first", 40),
      ],
      { expanded: true },
    );
    const before = sectionRowKeys();
    expect(before).toEqual([
      threadKey("working-new"),
      threadKey("factory"),
      threadKey("working-old"),
    ]);
    expect(rowCard("factory").textContent).toContain("2/7");

    await publish(factoryThread("factory", "Factory coordinator", 20, 3));

    expect(rowCard("factory").textContent).toContain("3/7");
    expect(sectionRowKeys(), "the next phase changes the label only").toEqual(before);
  });

  it("working section spec: the project filter applies to the section and its count", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads(
      [
        workingThread("alpha-working", "Alpha work", 5),
        workingThread("beta-working", "Beta work", 2, BETA_PROJECT_ID),
      ],
      { expanded: true },
    );
    expect(sectionRowKeys()).toHaveLength(2);

    await chooseProjectInFilter(ALPHA_TITLE);

    expect(sectionRowKeys()).toEqual([threadKey("alpha-working")]);
    expect(header().textContent).toContain("1");
    expect(header().textContent).not.toContain("2");
  });
});

describe("working section: the ways in and out", () => {
  it("working section spec: Alt+Z expands and collapses the section, and the choice persists on the device", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads([workingThread("working-a", "Work A", 5)]);
    expect(headerExpanded()).toBe(false);

    const event = await press(TOGGLE_WORKING_CHORD);

    expect(event.defaultPrevented, "the app took the chord").toBe(true);
    await vi.waitFor(() => expect(headerExpanded()).toBe(true));
    expect(sectionRowKeys()).toEqual([threadKey("working-a")]);
    expect(window.localStorage.getItem(WORKING_SECTION_EXPANDED_KEY)).toBe("true");

    await press(TOGGLE_WORKING_CHORD);
    await vi.waitFor(() => expect(headerExpanded()).toBe(false));
    expect(sectionRowKeys()).toEqual([]);
  });

  it("working section spec: <leader>tw in Vim mode toggles the section", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads([workingThread("working-a", "Work A", 5)], { vimMode: true });

    await press({ key: " ", code: "Space" });
    await press({ key: "t", code: "KeyT" });
    await press({ key: "w", code: "KeyW" });

    await vi.waitFor(() => expect(headerExpanded()).toBe(true));
  });

  it("working section spec: the palette's Toggle Working section row toggles it", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads([workingThread("working-a", "Work A", 5)]);
    await press(PALETTE_CHORD);
    const row = await vi.waitFor(() => {
      const found = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-testid="command-palette"] [role="option"]',
        ),
      ].find((candidate) => candidate.textContent?.includes("Toggle Working section"));
      expect(found, "the palette row").toBeDefined();
      return found!;
    });

    await userEvent.click(row);
    await settle();

    await vi.waitFor(() => expect(headerExpanded()).toBe(true));
  });

  it("working section spec: Down from the empty Search reaches the header, then its rows, and Enter opens a row", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads(
      [workingThread("working-a", "Work A", 5), idleThread("idle-a", "Idle A", 10)],
      { expanded: true },
    );
    await act(async () => sidebarSearchField().focus());

    await press(DOWN);
    expect(document.activeElement, `focus is on ${describeFocus()}`).toBe(header());
    await press(DOWN);
    expect(document.activeElement, `focus is on ${describeFocus()}`).toBe(rowCard("working-a"));
    await press(UP);
    expect(document.activeElement, `focus is on ${describeFocus()}`).toBe(header());
    await press(UP);
    expect(document.activeElement, "Up from the header returns to Search").toBe(
      sidebarSearchField(),
    );

    await press(DOWN);
    await press(DOWN);
    await press({ key: "Enter", code: "Enter" });
    await vi.waitFor(() =>
      expect(router!.state.location.pathname).toBe(`/${environmentId}/working-a`),
    );
  });

  it("working section spec: Left and Right on the header collapse and expand, and collapsing moves focus off a hidden row", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads([workingThread("working-a", "Work A", 5)], { expanded: true });
    await act(async () => header().focus());

    await press({ key: "ArrowLeft", code: "ArrowLeft" });
    await vi.waitFor(() => expect(headerExpanded()).toBe(false));
    await press({ key: "ArrowRight", code: "ArrowRight" });
    await vi.waitFor(() => expect(headerExpanded()).toBe(true));

    await act(async () => rowCard("working-a").focus());
    await press(TOGGLE_WORKING_CHORD);

    await vi.waitFor(() => expect(headerExpanded()).toBe(false));
    expect(document.activeElement, `focus is on ${describeFocus()}`).toBe(header());
  });

  it("working section guard: the open thread's row keeps focus when the section collapses", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads([workingThread("working-a", "Work A", 5)], {
      expanded: true,
      openWorking: true,
    });
    await act(async () => rowCard(OPEN_WORKING_ID).focus());

    await press(TOGGLE_WORKING_CHORD);

    await vi.waitFor(() => expect(headerExpanded()).toBe(false));
    expect(document.activeElement, `focus is on ${describeFocus()}`).toBe(rowCard(OPEN_WORKING_ID));
  });

  it("working section spec: at Pixel 7 width a tap on the header toggles the section", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await page.viewport(412, 915);
    await mountWithThreads([workingThread("working-a", "Work A", 5)]);
    // At phone width the sidebar is a drawer; the toggle chord opens it, as a keyboard would.
    await press({ key: "b", code: "KeyB", ctrlKey: true });
    await vi.waitFor(() => expect(section()).not.toBeNull());

    await userEvent.click(header());
    await vi.waitFor(() => expect(headerExpanded()).toBe(true));
    expect(sectionRowKeys()).toEqual([threadKey("working-a")]);
    const box = header().getBoundingClientRect();
    expect(box.width, "the header spans the drawer").toBeGreaterThan(200);

    await userEvent.click(header());
    await vi.waitFor(() => expect(headerExpanded()).toBe(false));
  });
});

describe("working section: the list below", () => {
  it("working section spec: Ctrl+number jumps follow the rows on screen, the section's first", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads(
      [workingThread("working-a", "Work A", 5), idleThread("idle-a", "Idle A", 10)],
      { expanded: true },
    );

    const onScreen = readViewportThreadKeys();

    expect(onScreen?.[0]).toBe(threadKey("working-a"));
    expect(onScreen).toContain(threadKey("idle-a"));
  });

  it("working section spec: dragging a row of the list below still reorders it", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads(
      [
        workingThread("working-a", "Work A", 5),
        idleThread("idle-a", "Idle A", 10),
        idleThread("idle-b", "Idle B", 20),
      ],
      { expanded: true },
    );
    const keysBelow = () =>
      [...document.querySelectorAll<HTMLElement>("[data-thread-item]")]
        .filter((row) => section()?.contains(row) !== true)
        .map((row) => row.dataset.threadItem ?? "");
    const order = keysBelow();
    const last = order.at(-1)!;
    const first = order[0]!;

    await userEvent.dragAndDrop(
      document.querySelector<HTMLElement>(`[data-mesura-thread-key="${last}"]`)!,
      document.querySelector<HTMLElement>(`[data-mesura-thread-key="${first}"]`)!,
    );
    await settle();

    expect(sidebarLists.activeReorders.length, "the drop asked for a reorder").toBeGreaterThan(0);
  });

  it("working section spec: the band runs only while the section is open, as finite crossings", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads(
      [workingThread("working-a", "Work A", 5), idleThread("idle-a", "Idle A", 10)],
      { expanded: true },
    );
    await vi.waitFor(() => expect(section()!.dataset.workingSweepTick).toMatch(/^[ab]$/));
    const animations = section()!.getAnimations({ subtree: true });
    expect(animations.length, "one crossing on the label: window and bright copy").toBe(2);
    for (const animation of animations) {
      expect(animation.effect?.getComputedTiming().iterations, "finite, never a loop").toBe(1);
    }
    const label = rowCard("working-a").querySelector<HTMLElement>("[data-working-sweep]")!;
    expect(label.textContent).toContain("Working");
    expect(getComputedStyle(label).color, "the azure working label").not.toBe(
      getComputedStyle(rowCard("idle-a")).color,
    );

    await press(TOGGLE_WORKING_CHORD);
    await vi.waitFor(() => expect(section()!.dataset.workingSweepTick).toBeUndefined());
  });
});

describe("working section: what the rows keep", () => {
  it("working section guard: a Working row still drags into a message as a thread reference", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await mountWithThreads([workingThread("working-a", "Work A", 5)], { expanded: true });
    const dropTarget = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-thread-context-drop]");
      expect(found, "the composer's reference drop target").not.toBeNull();
      return found!;
    });
    const dropped: unknown[] = [];
    const onDrop = (event: Event) => dropped.push(...(event as CustomEvent<unknown[]>).detail);
    dropTarget.addEventListener(THREAD_CONTEXT_DROP_EVENT, onDrop);
    try {
      await userEvent.dragAndDrop(rowCard("working-a"), dropTarget);
      await settle();
    } finally {
      dropTarget.removeEventListener(THREAD_CONTEXT_DROP_EVENT, onDrop);
    }

    expect(dropped).toEqual([{ environmentId, threadId: ThreadId.make("working-a") }]);
  });

  it("working section spec: switching reduced motion on stops the band and switching it off restarts it", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    const reduce = { matches: false, listeners: new Set<() => void>() };
    const realMatchMedia = window.matchMedia.bind(window);
    vi.stubGlobal("matchMedia", (query: string) =>
      query.includes("prefers-reduced-motion")
        ? {
            media: query,
            get matches() {
              return reduce.matches;
            },
            onchange: null,
            addEventListener: (_type: string, listener: () => void) =>
              reduce.listeners.add(listener),
            removeEventListener: (_type: string, listener: () => void) =>
              reduce.listeners.delete(listener),
            addListener: (listener: () => void) => reduce.listeners.add(listener),
            removeListener: (listener: () => void) => reduce.listeners.delete(listener),
            dispatchEvent: () => true,
          }
        : realMatchMedia(query),
    );
    const flip = async (matches: boolean) => {
      reduce.matches = matches;
      await act(async () => {
        for (const listener of reduce.listeners) listener();
      });
      await settle();
    };
    await mountWithThreads([workingThread("working-a", "Work A", 5)], { expanded: true });
    await vi.waitFor(() => expect(section()!.dataset.workingSweepTick).toMatch(/^[ab]$/));

    await flip(true);
    expect(section()!.dataset.workingSweepTick, "no tick under reduced motion").toBeUndefined();

    await flip(false);
    await vi.waitFor(() => expect(section()!.dataset.workingSweepTick).toMatch(/^[ab]$/));
  });

  it("working section spec: a hidden tab stops the band and showing it again restarts it", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    let visibility: DocumentVisibilityState = "visible";
    using _visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
    const setVisibility = async (next: DocumentVisibilityState) => {
      visibility = next;
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await settle();
    };
    await mountWithThreads([workingThread("working-a", "Work A", 5)], { expanded: true });
    await vi.waitFor(() => expect(section()!.dataset.workingSweepTick).toMatch(/^[ab]$/));

    await setVisibility("hidden");
    expect(section()!.dataset.workingSweepTick, "no tick in a hidden tab").toBeUndefined();

    await setVisibility("visible");
    await vi.waitFor(() => expect(section()!.dataset.workingSweepTick).toMatch(/^[ab]$/));
  });
});
