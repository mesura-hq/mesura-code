// @vitest-environment happy-dom
/**
 * Phase 8 fence on the web: acceptance criteria 1, 3 and 6, through the run
 * card a `factory.run` activity renders in the timeline. Phase 9 fence on the
 * web: acceptance criteria 1 (Open lands on the Run tab, maximized), 5 (every
 * turn's file opens in the files panel), 6 (the run stream is subscribed only
 * while the Run tab is visible) and 7 (the floor on screen), through the same
 * card's Open and the Factory pane it opens.
 *
 * Entry point: AppRoot with its memory router and the real ChatView,
 * MessagesTimeline and FactoryRunCard, mounted as `FactoryPlanApproval.test.tsx`
 * mounts them. The thread and its activities are fixtures; a new activity with
 * the run's id replaces the old one, as the server's run tracker does. The
 * `subscribeFactoryRun` stream is the `factoryEnvironment.factoryRun` atom
 * family, replaced by one atom per run that records when the registry builds
 * it (a subscription opened) and finalizes it (the subscription ended). What
 * only a browser shows: the tones' colours, the phase marks' shapes, and the
 * card's layout on a narrow pane.
 */
/// <reference types="vite-plus/client" />
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  factoryRunActivityId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import {
  makeFactoryRouteProviders,
  makeFactoryRunActivity,
  makeFactoryRunState,
  makeFactoryRunSummary,
  withoutFactoryRunMarks,
  type FactoryRunFixturePoint,
} from "@t3tools/client-runtime/factory/testing";
import type { Thread } from "../types";
import type { AppRouter } from "../router";

const fixture = vi.hoisted(() => ({
  thread: null as Thread | null,
  commands: new Map<unknown, unknown>(),
  noopCommand: vi.fn(async () => ({ _tag: "Success", value: undefined })),
  refresh: vi.fn(),
  empty: [],
  threadListeners: new Set<() => void>(),
  factorySnapshots: {} as Record<string, string>,
  factorySnapshotAtoms: new Map<string, unknown>(),
  factoryRunItem: null as unknown,
  factoryRunAtoms: new Map<string, unknown>(),
  factoryRunInputs: [] as unknown[],
  factoryRunOpened: 0,
  factoryRunEnded: 0,
  environments: [
    {
      environmentId: "factory-run-environment",
      label: "Factory run environment",
      connection: { phase: "connected" },
      serverConfig: {
        environment: {
          capabilities: {
            questionAttachments: true,
            attachmentUploads: true,
            fileAttachments: { maxUploadBytes: 1048576 },
          },
        },
        providers: [] as unknown[],
      },
    },
  ],
}));

vi.mock("../state/entities", async (importOriginal) => {
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
    ...(await importOriginal<typeof import("../state/entities")>()),
    useThread: useFixtureThread,
    readThread: () => fixture.thread,
    useThreadShell: useFixtureThread,
    useThreadRefs: () => fixture.empty,
    useProjects: () => fixture.empty,
    useProject: () => ({
      id: "factory-run-project",
      environmentId: "factory-run-environment",
      title: "Factory run",
      workspaceRoot: "/tmp/factory-run",
      scripts: [],
      createdAt: "2026-09-28T10:00:00.000Z",
      defaultModelSelection: { instanceId: "claudeAgent", model: "claude-fable-5-1" },
    }),
  };
});
vi.mock("../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/environments")>()),
  useEnvironments: () => ({ environments: fixture.environments, isReady: true }),
  usePrimaryEnvironment: () => null,
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: null,
    error: null,
    isPending: false,
    isSuccess: false,
    refresh: fixture.refresh,
  }),
}));
vi.mock("../state/threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/threads")>();
  const { EMPTY_ENVIRONMENT_THREAD_STATE } = await import("@t3tools/client-runtime/state/threads");
  return { ...actual, useEnvironmentThread: () => EMPTY_ENVIRONMENT_THREAD_STATE };
});
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => fixture.commands.get(command) ?? fixture.noopCommand,
}));
vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => fixture.noopCommand,
}));
// The plan body a `factory.plan` activity names by digest, as the server's
// factoryReadSnapshot RPC would answer it; an unknown digest stays loading.
vi.mock("../state/factory", async () => {
  const { AsyncResult, Atom } = await import("effect/unstable/reactivity");
  return {
    factoryEnvironment: {
      factorySnapshot: ({ input }: { input: { digest: string } }) => {
        const markdown = fixture.factorySnapshots[input.digest];
        const key = `${input.digest}:${markdown === undefined ? "loading" : "ready"}`;
        let atom = fixture.factorySnapshotAtoms.get(key);
        if (atom === undefined) {
          atom = Atom.make(
            markdown === undefined
              ? AsyncResult.initial(true)
              : AsyncResult.success({ digest: input.digest, markdown }),
          );
          fixture.factorySnapshotAtoms.set(key, atom);
        }
        return atom;
      },
      // The run stream: one atom per run, as the real family keys it.
      factoryRun: ({ input }: { input: { threadId: string; runId: string } }) => {
        const key = `${input.threadId}:${input.runId}`;
        let atom = fixture.factoryRunAtoms.get(key);
        if (atom === undefined) {
          atom = Atom.make((get) => {
            fixture.factoryRunInputs.push(input);
            fixture.factoryRunOpened += 1;
            get.addFinalizer(() => {
              fixture.factoryRunEnded += 1;
            });
            return fixture.factoryRunItem === null
              ? AsyncResult.initial(true)
              : AsyncResult.success(fixture.factoryRunItem);
          });
          fixture.factoryRunAtoms.set(key, atom);
        }
        return atom;
      },
    },
  };
});
vi.mock("../hooks/useSettings", async (importOriginal) => {
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts/settings");
  const settings = { ...DEFAULT_CLIENT_SETTINGS, ...DEFAULT_SERVER_SETTINGS };
  return {
    ...(await importOriginal<typeof import("../hooks/useSettings")>()),
    useEnvironmentSettings: () => settings,
    useClientSettings: (select?: (value: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
      select ? select(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS,
    useClientSettingsHydrated: () => true,
  };
});
vi.mock("../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => fixture.noopCommand }));
vi.mock("../hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    settleThread: fixture.noopCommand,
    pinThread: fixture.noopCommand,
    confirmAndUnpinThread: fixture.noopCommand,
  }),
}));
vi.mock("../components/preview/PreviewAutomationHosts", () => ({
  PreviewAutomationHosts: () => null,
}));
vi.mock("../browser/ElectronBrowserHost", () => ({ ElectronBrowserHost: () => null }));
vi.mock("../components/QuitHoldOverlay", () => ({ QuitHoldOverlay: () => null }));
vi.mock("../components/chat/ChatHeader", () => ({ ChatHeader: () => null }));
vi.mock("../components/BranchToolbar", () => ({ BranchToolbar: () => null }));

// happy-dom has no layout. Keep application routing and timeline projection
// real, and replace only the virtual list's measurement boundary.
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
        <div data-timeline-row={item.id} key={item.id}>
          {renderItem({ item })}
        </div>
      ))}
      {ListFooterComponent}
    </div>
  ),
}));

import { AppRoot } from "../AppRoot";
import ChatView from "../components/ChatView";
import { SidebarProvider } from "../components/ui/sidebar";
import { useComposerDraftStore } from "../composerDraftStore";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import eventsJsonl from "../../../../packages/shared/src/fixtures/factory-events.v1.jsonl?raw";

const environmentId = EnvironmentId.make("factory-run-environment");
const threadId = ThreadId.make("factory-run-card-thread");
const runRowId = factoryRunActivityId(threadId, "invoice-csv-export");
const REQUEST = "Let accountants export the invoice list as a CSV file";
let root: Root | undefined;
let container: HTMLDivElement;

const runActivity = (point: FactoryRunFixturePoint) =>
  makeFactoryRunActivity({ threadId, summary: makeFactoryRunSummary(eventsJsonl, point) });

/** Delivers a new thread object, as the thread store does on every event. */
async function showRunAt(point: FactoryRunFixturePoint) {
  fixture.thread = {
    ...fixture.thread!,
    activities: [
      ...fixture.thread!.activities.filter((activity) => activity.id !== runRowId),
      runActivity(point),
    ],
  };
  await act(async () => {
    for (const listener of fixture.threadListeners) listener();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.factorySnapshots = {};
  fixture.factorySnapshotAtoms.clear();
  fixture.factoryRunItem = null;
  fixture.factoryRunAtoms.clear();
  fixture.factoryRunInputs = [];
  fixture.factoryRunOpened = 0;
  fixture.factoryRunEnded = 0;
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  const [environment] = fixture.environments;
  fixture.environments = [
    {
      ...environment!,
      serverConfig: {
        ...environment!.serverConfig,
        providers: makeFactoryRouteProviders().map((provider) => ({
          ...provider,
          workspaceSnapshots: [
            {
              cwd: "/tmp/factory-run",
              checkedAt: "2026-09-28T08:58:00.000Z",
              skills: [],
              slashCommands: [],
            },
          ],
        })),
      },
    },
  ];
  fixture.thread = {
    id: threadId,
    environmentId,
    projectId: ProjectId.make("factory-run-project"),
    title: "Factory run",
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-fable-5-1",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [
      {
        id: MessageId.make("factory-run-approve"),
        role: "user" as const,
        text: "Build the approved plan",
        turnId: null,
        streaming: false,
        createdAt: "2026-09-28T08:58:00.000Z",
        updatedAt: "2026-09-28T08:58:00.000Z",
      },
    ],
    proposedPlans: [],
    checkpoints: [],
    pullRequests: [],
    createdAt: "2026-09-28T08:58:00.000Z",
    updatedAt: "2026-09-28T08:58:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    activities: [],
  } as Thread;
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  useComposerDraftStore.getState().clearComposerContent(scopeThreadRef(environmentId, threadId));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountApp() {
  const route = createRootRoute({
    component: () => (
      <SidebarProvider>
        <ChatView environmentId={environmentId} threadId={threadId} routeKind="server" />
      </SidebarProvider>
    ),
  });
  const index = createRoute({ getParentRoute: () => route, path: "/" });
  const router = createRouter({
    routeTree: route.addChildren([index]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  await act(async () => {
    root = createRoot(container);
    root.render(<AppRoot router={router as unknown as AppRouter} />);
  });
}

/** The run card's own timeline row. */
function runRow(): HTMLElement {
  const row = container.querySelector<HTMLElement>(`[data-timeline-row="${runRowId}"]`);
  expect(row, `Expected the run card's row; rendered: ${container.textContent}`).not.toBeNull();
  return row!;
}

function markLabels(row: HTMLElement): string[] {
  return [...row.querySelectorAll<HTMLElement>("[aria-label^='Phase ']")].map(
    (mark) => mark.getAttribute("aria-label") ?? "",
  );
}

it("phase8 web AC1 renders a factory.run activity as a run card with its request, status, phase, node, marks, returns, cost and last event", async () => {
  fixture.thread = { ...fixture.thread!, activities: [runActivity("verify")] };
  await mountApp();
  const text = runRow().textContent ?? "";

  expect(text).toContain(REQUEST);
  expect(text).toContain("phase 1/2 · Verify ①");
  expect(text).toContain("Serialize the filtered invoice list as CSV");
  expect(text).toContain("1/5 returns");
  expect(text).toContain("$10.03");
  expect(markLabels(runRow())).toEqual(["Phase 1: running", "Phase 2: pending"]);
  expect(runRow().querySelector('time[datetime="2026-09-28T10:18:00.000Z"]')).not.toBeNull();
  // One card, never a work-log row: the activity's summary is not shown anywhere.
  expect(container.textContent).not.toContain("Software Factory run");
});

it("phase8 web AC1 marks a finished run's phases clean and degraded", async () => {
  fixture.thread = { ...fixture.thread!, activities: [runActivity("degraded")] };
  await mountApp();

  expect(runRow().textContent).toContain("degraded");
  expect(markLabels(runRow())).toEqual(["Phase 1: clean", "Phase 2: degraded"]);
});

it("phase8 web AC3 shows the stop question on the run card and reads waiting", async () => {
  fixture.thread = { ...fixture.thread!, activities: [runActivity("waiting")] };
  await mountApp();
  const text = runRow().textContent ?? "";

  expect(text).toContain("waiting");
  expect(text).toContain("Name the file after the filter range or after the export date?");
});

it("phase8 web AC6 updates the run card in place as events arrive without remounting its row", async () => {
  fixture.thread = { ...fixture.thread!, activities: [runActivity("verify")] };
  await mountApp();
  const row = runRow();
  const card = row.firstElementChild;
  expect(card).not.toBeNull();

  await showRunAt("review");
  expect(runRow()).toBe(row);
  expect(row.firstElementChild).toBe(card);
  expect(row.textContent).toContain("phase 1/2 · Review");
  expect(row.textContent).not.toContain("Verify ①");

  await showRunAt("waiting");
  expect(runRow()).toBe(row);
  expect(row.firstElementChild).toBe(card);
  expect(row.textContent).toContain(
    "Name the file after the filter range or after the export date?",
  );
});

it("phase8 web run card of a summary without phase marks renders without marks", async () => {
  fixture.thread = {
    ...fixture.thread!,
    activities: [
      makeFactoryRunActivity({
        threadId,
        summary: withoutFactoryRunMarks(makeFactoryRunSummary(eventsJsonl, "verify")),
      }),
    ],
  };
  await mountApp();

  expect(markLabels(runRow())).toEqual([]);
  expect(runRow().textContent).toContain("phase 1/2 · Verify ①");
  expect(runRow().textContent).toContain(REQUEST);
});

// ---------------------------------------------------------------------------
// Phase 9: the run in the Factory pane's Run tab.
// ---------------------------------------------------------------------------

const threadRef = scopeThreadRef(environmentId, threadId);
const PHASE_1_TITLE = "Serialize the filtered invoice list as CSV";
const PHASE_2_TITLE = "Add the Export button to the invoices page";

/** The stream item the server sends for a run at one point of the fixture. */
function streamRunAt(point: FactoryRunFixturePoint) {
  fixture.factoryRunItem = { state: makeFactoryRunState(eventsJsonl, point), roles: [] };
}

/** Lets the lazy pane load and the registry finalize atoms nobody reads any more. */
async function settle() {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
}

async function openRunFromCard() {
  const open = [...runRow().querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Open",
  );
  expect(open, "Expected the run card's Open").toBeDefined();
  await click(open!);
  // ChatView loads the Factory pane lazily.
  await vi.waitFor(async () => {
    await settle();
    expect(document.querySelector('nav[aria-label="Factory tabs"]')).not.toBeNull();
  });
}

/** The Factory pane: the element holding its tab strip and its content. */
function factoryPane(): HTMLElement {
  const tabs = document.querySelector<HTMLElement>('nav[aria-label="Factory tabs"]');
  expect(tabs, `Expected the Factory pane; rendered: ${document.body.textContent}`).not.toBeNull();
  return tabs!.parentElement!;
}

function factoryTab(label: string): HTMLButtonElement {
  const tab = [
    ...document.querySelectorAll<HTMLButtonElement>('nav[aria-label="Factory tabs"] button'),
  ].find((button) => button.textContent?.trim() === label);
  expect(tab, `Expected the ${label} tab`).toBeDefined();
  return tab!;
}

/** Subscriptions to the run stream that are open now. */
const liveRunSubscriptions = () => fixture.factoryRunOpened - fixture.factoryRunEnded;

const panelState = () =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);

it("phase9 web AC1 opens the run card's run on the Run tab of the Factory pane, maximized, with one rail entry per phase", async () => {
  fixture.thread = { ...fixture.thread!, activities: [runActivity("verify")] };
  streamRunAt("verify");
  await mountApp();
  await openRunFromCard();

  expect(panelState()).toMatchObject({ isOpen: true, activeSurfaceId: "factory" });
  expect(document.querySelector('[data-chat-column-maximized-away="true"]')).not.toBeNull();
  // The panel's own Maximize control reads maximized, as a reader sees it.
  expect(document.querySelector('[aria-label="Maximize panel"]')).toBeNull();
  expect(
    document.querySelector('[aria-label="Restore panel size"]')?.getAttribute("aria-pressed"),
  ).toBe("true");
  expect(factoryTab("Run").disabled).toBe(false);
  expect(factoryTab("Run").getAttribute("aria-pressed")).toBe("true");
  const pane = factoryPane();
  expect(pane.textContent).toContain(PHASE_1_TITLE);
  expect(pane.textContent).toContain(PHASE_2_TITLE);
  const railLabels = [...pane.querySelectorAll<HTMLElement>("[aria-label^='Phase ']")].map(
    (entry) => entry.getAttribute("aria-label"),
  );
  // Amended for review finding P2-2: the title is part of each entry's accessible name.
  expect(railLabels).toEqual([
    `Phase 1: running — ${PHASE_1_TITLE}`,
    `Phase 2: pending — ${PHASE_2_TITLE}`,
  ]);
});

it("phase9 web AC7 shows the run totals with the dollar figure marked as a floor", async () => {
  fixture.thread = { ...fixture.thread!, activities: [runActivity("review")] };
  streamRunAt("review");
  await mountApp();
  await openRunFromCard();

  const text = factoryPane().textContent ?? "";
  expect(text).toContain("$10.03 + 3,161,680 tokens");
  expect(text).toContain("floor");
});

it("phase9 web AC5 opens every turn's prompt and report file of the shown phase in the files panel", async () => {
  fixture.thread = { ...fixture.thread!, activities: [runActivity("degraded")] };
  streamRunAt("degraded");
  await mountApp();
  await openRunFromCard();

  const shownPhase = makeFactoryRunState(eventsJsonl, "degraded").phases[1]!;
  const files = shownPhase.dispatches.flatMap((dispatch) => [
    dispatch.promptFile,
    dispatch.reportFile!,
  ]);
  expect(files).toHaveLength(8);
  for (const path of files) {
    const basename = path.slice(path.lastIndexOf("/") + 1);
    const links = [...factoryPane().querySelectorAll<HTMLElement>("a, button")].filter((element) =>
      element.textContent?.includes(basename),
    );
    expect(links, `Expected one file link for ${basename}`).toHaveLength(1);
    await click(links[0]!);

    // An absolute host path: the files panel shows it read-only.
    const state = panelState();
    expect(state.activeSurfaceId).toBe(`file:${path}`);
    expect(state.surfaces).toContainEqual(
      expect.objectContaining({ id: `file:${path}`, kind: "file" }),
    );
    await act(async () => useRightPanelStore.getState().activateSurface(threadRef, "factory"));
    await settle();
  }
});

it("phase9 web AC6 subscribes to the run stream only while the Run tab is visible and ends it when the pane closes", async () => {
  fixture.thread = { ...fixture.thread!, activities: [runActivity("verify")] };
  streamRunAt("verify");
  await mountApp();
  await settle();
  expect(fixture.factoryRunOpened).toBe(0);

  await openRunFromCard();
  expect(liveRunSubscriptions()).toBe(1);
  expect(fixture.factoryRunInputs).toContainEqual({ threadId, runId: "invoice-csv-export" });

  await click(factoryTab("Plan"));
  expect(liveRunSubscriptions()).toBe(0);

  await click(factoryTab("Run"));
  expect(liveRunSubscriptions()).toBe(1);

  await act(async () => useRightPanelStore.getState().close(threadRef));
  await settle();
  expect(liveRunSubscriptions()).toBe(0);

  await act(async () => useRightPanelStore.getState().show(threadRef));
  await settle();
  expect(liveRunSubscriptions()).toBe(1);

  const closeTab = document.querySelector<HTMLElement>('[aria-label="Close Software Factory"]');
  expect(closeTab, "Expected the Software Factory tab's close control").not.toBeNull();
  await click(closeTab!);
  expect(panelState().surfaces.some((surface) => surface.kind === "factory")).toBe(false);
  expect(liveRunSubscriptions()).toBe(0);
});

/**
 * A window whose width the test moves across the right panel's sheet
 * breakpoint, `(max-width: 980px)`, notifying `useMediaQuery` as a browser does.
 */
function stubViewportWidth(initialWidth: number) {
  let width = initialWidth;
  const listeners = new Set<() => void>();
  const matches = (query: string) => {
    const maxWidth = /max-width:\s*(\d+)px/.exec(query);
    const minWidth = /min-width:\s*(\d+)px/.exec(query);
    if (maxWidth) return width <= Number(maxWidth[1]);
    if (minWidth) return width >= Number(minWidth[1]);
    return false;
  };
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return matches(query);
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    addListener: (listener: () => void) => listeners.add(listener),
    removeListener: (listener: () => void) => listeners.delete(listener),
    dispatchEvent: () => true,
  }));
  return async (nextWidth: number) => {
    width = nextWidth;
    await act(async () => {
      for (const listener of listeners) listener();
    });
    await settle();
  };
}

it("phase9 web AC1 keeps the run opened maximized when a narrow window that opened it as a sheet widens", async () => {
  const resizeTo = stubViewportWidth(800);
  fixture.thread = { ...fixture.thread!, activities: [runActivity("verify")] };
  streamRunAt("verify");
  await mountApp();
  await openRunFromCard();
  expect(factoryTab("Run").getAttribute("aria-pressed")).toBe("true");
  // As a sheet the pane covers the chat by itself; nothing is maximized away.
  expect(document.querySelector('[data-chat-column-maximized-away="true"]')).toBeNull();

  await resizeTo(1440);

  expect(document.querySelector('[data-chat-column-maximized-away="true"]')).not.toBeNull();
  expect(
    document.querySelector('[aria-label="Restore panel size"]')?.getAttribute("aria-pressed"),
  ).toBe("true");
});

it("phase9 web P2-1 opens a turn file whose path holds spaces, parentheses, brackets and angle brackets", async () => {
  const state = makeFactoryRunState(eventsJsonl, "degraded");
  const promptFile = "/srv/factory runs/run (2)/phase-2 [x]/<odd> prompt (1) [a].md";
  const reportFile = "/srv/factory runs/run (2)/phase-2 [x]/report <b>.md";
  const [first, ...rest] = state.phases[1]!.dispatches;
  fixture.factoryRunItem = {
    state: {
      ...state,
      phases: [
        state.phases[0]!,
        { ...state.phases[1]!, dispatches: [{ ...first!, promptFile, reportFile }, ...rest] },
      ],
    },
    roles: [],
  };
  fixture.thread = { ...fixture.thread!, activities: [runActivity("degraded")] };
  await mountApp();
  await openRunFromCard();

  for (const path of [promptFile, reportFile]) {
    const basename = path.slice(path.lastIndexOf("/") + 1);
    const links = [...factoryPane().querySelectorAll<HTMLElement>("a")].filter((element) =>
      element.textContent?.includes(basename),
    );
    expect(links, `Expected one file chip for ${basename}`).toHaveLength(1);
    await click(links[0]!);
    expect(panelState().activeSurfaceId).toBe(`file:${path}`);
    await act(async () => useRightPanelStore.getState().activateSurface(threadRef, "factory"));
    await settle();
  }
});
