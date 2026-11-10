import { flushBrowserTasks } from "../test/browserTasks";
import { act, render as renderBrowser, type Screen } from "../../test/render";
/**
 * AppRoot with the real ChatView, MessagesTimeline and FactoryRunCard over fixture thread shells
 * and turn items; the `factoryEnvironment.factoryRun` family is one recording atom per run, so a
 * spec sees when a run stream subscription opens and ends. Colours, mark shapes and the narrow
 * layout are left to a real browser.
 */
/// <reference types="vite-plus/client" />
import { type ReactNode } from "react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import {
  EnvironmentId,
  factoryRunActivityId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import {
  makeFactoryRouteProviders,
  makeFactoryCardTurnItem,
  makeFactoryRunState,
  makeFactoryRunSummary,
  withoutFactoryRunMarks,
  type FactoryRunFixturePoint,
} from "@t3tools/client-runtime/factory/testing";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { makeFenceThreadShell } from "../test/fenceThreadShell";
import { appRootFence, installFenceFontEvents, makeFenceSession } from "../test/appRootFenceMocks";
import { makeFactoryMessageItem } from "./factoryTestFixtures";
import type { AppRouter } from "../router";

const fixture = vi.hoisted(() => ({
  thread: null as EnvironmentThreadShell | null,
  turnItems: [] as OrchestrationV2TurnItem[],
  commands: new Map<unknown, unknown>(),
  noopCommand: vi.fn(async () => ({ _tag: "Success", value: { providers: [] } })),
  empty: [],
  threadListeners: new Set<() => void>(),
  factorySnapshots: {} as Record<string, string>,
  factorySnapshotAtoms: new Map<string, unknown>(),
  factoryRunUsage: null as unknown,
  factoryRunUsageAtoms: new Map<string, unknown>(),
  factoryRunItem: null as unknown,
  factoryRunAtoms: new Map<string, unknown>(),
  factoryRunInputs: [] as unknown[],
  factoryRunOpened: 0,
  factoryRunEnded: 0,
  /** Every source the Mermaid stub drew while this file ran. */
  mermaidRenders: [] as string[],
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

vi.mock("@t3tools/client-runtime/state/session", async (importOriginal) =>
  (await import("../test/appRootFenceMocks")).mockRuntimeSession(importOriginal),
);
vi.mock("../connection/runtime", async () =>
  (await import("../test/appRootFenceMocks")).mockConnectionRuntime(),
);
vi.mock("../state/presentation", async (importOriginal) =>
  (await import("../test/appRootFenceMocks")).mockPresentation(
    importOriginal,
    fixture.environments,
  ),
);
vi.mock("../state/entities", async (importOriginal) => {
  const { factoryThreadFixtureReads } = await import("./factoryTestFixtures");
  const threadReads = factoryThreadFixtureReads(fixture);
  return {
    ...(await importOriginal<typeof import("../state/entities")>()),
    ...threadReads,
    useQuietThreadShell: threadReads.useThreadShell,
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
  useEnvironment: (environmentId: EnvironmentId | null) =>
    fixture.environments.find((environment) => environment.environmentId === environmentId) ?? null,
  useEnvironmentProviders: () =>
    new Map(
      fixture.environments.map((environment) => [
        environment.environmentId,
        environment.serverConfig.providers,
      ]),
    ),
  usePrimaryEnvironment: () => null,
}));
vi.mock("../state/query", async (original) =>
  (await import("../test/appRootFenceMocks")).mockQuery(original),
);
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
// The plan body a `factory_card` turn item names by digest, as the server's
// factoryReadSnapshot RPC would answer it; an unknown digest stays loading.
vi.mock("../state/factory", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return {
    factoryEnvironment: {
      // What a run used of the plans: one answer per run, or loading while none is set.
      factoryRunUsage: ({ input }: { input: { threadId: string; runId: string } }) => {
        const key = `${input.threadId}:${input.runId}:${fixture.factoryRunUsage === null ? "loading" : "ready"}`;
        let atom = fixture.factoryRunUsageAtoms.get(key);
        if (atom === undefined) {
          atom = Atom.make(
            fixture.factoryRunUsage === null
              ? AsyncResult.initial(true)
              : AsyncResult.success(fixture.factoryRunUsage),
          );
          fixture.factoryRunUsageAtoms.set(key, atom);
        }
        return atom;
      },
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
// A video capture's signed URL; every other asset resolves as it does in the app.
vi.mock("../assets/assetUrls", async (original) => {
  const actual = await original<typeof import("../assets/assetUrls")>();
  return {
    ...actual,
    useAssetUrlState: (...args: Parameters<typeof actual.useAssetUrlState>) => {
      const [, resource] = args;
      const state = actual.useAssetUrlState(...args);
      return resource?._tag === "media-file" && resource.path.endsWith(".webm")
        ? { _tag: "Success", url: `https://assets.test/${resource.path}` }
        : state;
    },
  };
});
// Mermaid draws in a browser only; the stub records each source it was handed.
vi.mock("mermaid", () => ({
  default: {
    initialize: () => {},
    render: async (id: string, source: string) => {
      fixture.mermaidRenders.push(source);
      return { svg: `<svg id="${id}" data-mermaid-stub="true"></svg>` };
    },
  },
}));
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
  useAcknowledgeThreadWoke: () => fixture.noopCommand,
  useThreadActions: () => ({
    settleThread: fixture.noopCommand,
    pinThread: fixture.noopCommand,
    confirmAndUnpinThread: fixture.noopCommand,
  }),
}));
vi.mock("../browser/ElectronBrowserHost", () => ({ ElectronBrowserHost: () => null }));
vi.mock("../components/QuitHoldOverlay", () => ({ QuitHoldOverlay: () => null }));
vi.mock("../components/chat/ChatHeader", () => ({ ChatHeader: () => null }));
vi.mock("../components/BranchToolbar", () => ({ BranchToolbar: () => null }));

// Keep timeline rows mounted so card assertions do not depend on list virtualization.
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

const { AppRoot } = await import("../AppRoot");
const { default: ChatView } = await import("../components/ChatView");
const { SidebarProvider } = await import("../components/ui/sidebar");
import { useComposerDraftStore } from "../composerDraftStore";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import eventsJsonl from "../../../../packages/shared/src/fixtures/factory-events.v1.jsonl?raw";

const environmentId = EnvironmentId.make("factory-run-environment");
const threadId = ThreadId.make("factory-run-card-thread");
const runRowId = factoryRunActivityId(threadId, "invoice-csv-export");
const REQUEST = "Let accountants export the invoice list as a CSV file";
let root: Screen | undefined;
let container: HTMLDivElement;
let restoreDocumentFonts: () => void;

const runCard = (point: FactoryRunFixturePoint) =>
  makeFactoryCardTurnItem({
    id: runRowId,
    threadId,
    createdAt: makeFactoryRunSummary(eventsJsonl, point).startedAt ?? "2026-09-28T08:59:00.000Z",
    card: { kind: "run", payload: { threadId, ...makeFactoryRunSummary(eventsJsonl, point) } },
  });

/** Delivers an immutable turn item update through the thread projection hooks. */
async function showRunAt(point: FactoryRunFixturePoint) {
  fixture.turnItems = [...fixture.turnItems.filter((item) => item.id !== runRowId), runCard(point)];
  await act(async () => {
    for (const listener of fixture.threadListeners) listener();
  });
}

// Preload the lazy pane so assertions observe its state instead of module loading.
async function setupBrowserFixture0() {
  const previousViewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1440, 900);
  await import("./FactoryPane");

  restoreDocumentFonts = installFenceFontEvents();
  appRootFence.sessions.set(environmentId, makeFenceSession());
  fixture.factorySnapshots = {};
  fixture.factorySnapshotAtoms.clear();
  fixture.factoryRunUsage = null;
  fixture.factoryRunUsageAtoms.clear();
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
              checkedAt: "2026-09-28T09:00:00.000Z",
              skills: [],
              slashCommands: [],
            },
          ],
        })),
      },
    },
  ];
  fixture.thread = makeFenceThreadShell({
    id: threadId,
    environmentId,
    projectId: ProjectId.make("factory-run-project"),
    title: "Factory run",
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-fable-5-1",
    },
    createdAt: "2026-09-28T08:58:00.000Z",
  });
  fixture.turnItems = [
    makeFactoryMessageItem({
      id: "factory-run-approve",
      role: "user",
      text: "Build the approved plan",
      threadId,
      createdAt: "2026-09-28T08:58:00.000Z",
    }),
  ];
  container = document.createElement("div");
  document.body.append(container);

  return {
    async [Symbol.asyncDispose]() {
      await root?.[Symbol.asyncDispose]();
      root = undefined;
      container.remove();
      useComposerDraftStore
        .getState()
        .clearComposerContent(scopeThreadRef(environmentId, threadId));
      restoreDocumentFonts();
      appRootFence.sessions.delete(environmentId);
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      await page.viewport(previousViewport.width, previousViewport.height);
    },
  };
}

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
    // AppRoot owns this fixture's memory router.
    root = await renderBrowser(null, { container, router: false });
    await root.rerender(<AppRoot router={router as unknown as AppRouter} />);
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

it("phase8 web AC1 renders a factory.run turn item as a run card with its request, status, phase, node, marks, returns, cost and last event", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  fixture.turnItems = [runCard("verify")];
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
  await using _browserFixture0 = await setupBrowserFixture0();

  fixture.turnItems = [runCard("degraded")];
  await mountApp();

  expect(runRow().textContent).toContain("degraded");
  expect(markLabels(runRow())).toEqual(["Phase 1: clean", "Phase 2: degraded"]);
});

it("phase8 web AC3 shows the stop question on the run card and reads waiting", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  fixture.turnItems = [runCard("waiting")];
  await mountApp();
  const text = runRow().textContent ?? "";

  expect(text).toContain("waiting");
  expect(text).toContain("Name the file after the filter range or after the export date?");
});

it("phase8 web AC6 updates the run card in place as events arrive without remounting its row", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  fixture.turnItems = [runCard("verify")];
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
  await using _browserFixture0 = await setupBrowserFixture0();

  fixture.turnItems = [
    makeFactoryCardTurnItem({
      id: runRowId,
      threadId,
      createdAt:
        makeFactoryRunSummary(eventsJsonl, "verify").startedAt ?? "2026-09-28T08:59:00.000Z",
      card: {
        kind: "run",
        payload: {
          threadId,
          ...withoutFactoryRunMarks(makeFactoryRunSummary(eventsJsonl, "verify")),
        },
      },
    }),
  ];
  await mountApp();

  expect(markLabels(runRow())).toEqual([]);
  expect(runRow().textContent).toContain("phase 1/2 · Verify ①");
  expect(runRow().textContent).toContain(REQUEST);
});

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
      await flushBrowserTasks();
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

it("phase9 web AC1 opens the run card's run on the Run tab of the Factory pane, maximized, with one trace lane per phase", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  fixture.turnItems = [runCard("verify")];
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
  // The trace's phase lanes replaced the rail and keep its accessible names.
  expect(railLabels).toEqual([
    `Phase 1: running, ${PHASE_1_TITLE}`,
    `Phase 2: pending, ${PHASE_2_TITLE}`,
  ]);
});

it("phase9 web AC7 shows the run totals with the dollar figure marked as a floor", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  fixture.turnItems = [runCard("review")];
  streamRunAt("review");
  await mountApp();
  await openRunFromCard();

  const text = factoryPane().textContent ?? "";
  expect(text).toContain("$10.03 + 3,161,680 tokens");
  expect(text).toContain("floor");
});

it("phase9 web AC5 opens every turn's prompt and report file of the shown phase in the files panel", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  fixture.turnItems = [runCard("degraded")];
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
  await using _browserFixture0 = await setupBrowserFixture0();

  fixture.turnItems = [runCard("verify")];
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
  const queries: { query: string; listeners: Set<(event: MediaQueryListEvent) => void> }[] = [];
  const matches = (query: string) => {
    const maxWidth = /max-width:\s*(\d+)px/.exec(query);
    const minWidth = /min-width:\s*(\d+)px/.exec(query);
    if (maxWidth) return width <= Number(maxWidth[1]);
    if (minWidth) return width >= Number(minWidth[1]);
    return false;
  };
  vi.stubGlobal("matchMedia", (query: string) => {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    queries.push({ query, listeners });
    return {
      get matches() {
        return matches(query);
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.delete(listener),
      addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
      removeListener: (listener: (event: MediaQueryListEvent) => void) =>
        listeners.delete(listener),
      dispatchEvent: () => true,
    };
  });
  return async (nextWidth: number) => {
    const previousMatches = queries.map(({ query }) => matches(query));
    width = nextWidth;
    await act(async () => {
      // REGRESSION: Calling every listener without an event broke Monaco's media listeners in CI.
      // A browser emits a change event only for queries whose matches value changed.
      for (const [index, { query, listeners }] of queries.entries()) {
        if (matches(query) === previousMatches[index]) continue;
        const event = new MediaQueryListEvent("change", { matches: matches(query), media: query });
        for (const listener of listeners) listener(event);
      }
    });
    await settle();
  };
}

it("phase9 web AC1 keeps the run opened maximized when a narrow window that opened it as a sheet widens", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  const resizeTo = stubViewportWidth(800);
  fixture.turnItems = [runCard("verify")];
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
  await using _browserFixture0 = await setupBrowserFixture0();

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
  fixture.turnItems = [runCard("degraded")];
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

// The report body is the `factoryReadSnapshot` answer for the turn item's
// digest; the frame comes from the `subscribeFactoryRun` item for the run.
// What only a browser shows: the error tone of a degraded phase and a failed
// result, and the drawn diagram.

import {
  FACTORY_REPORT_DIGEST,
  foldFactoryRunTestLines,
  makeFactoryReportPayload,
} from "@t3tools/client-runtime/factory/testing";
import { factoryReportActivityId } from "@t3tools/contracts";
import reportMarkdown from "../../../../packages/shared/src/fixtures/invoice-csv-export.report.md?raw";

const reportRowId = factoryReportActivityId(threadId, "invoice-csv-export");
const HOW_IT_WAS_BUILT_PROSE = "The export is one endpoint beside the list endpoint";
const VERIFIED_COMMENT = "The quoting of commas and quotes rests on authored tests only";
const STEP_LINE = "pnpm lint failed on an unused import in the CSV serializer";

/**
 * The thread after `report.written`: its run card and its report card, the
 * body stored by digest. The stream answers only the Report tab; the card
 * reads the run's `factory_card` turn item.
 */
function showReport(point: FactoryRunFixturePoint = "degraded", markdown: string = reportMarkdown) {
  fixture.factorySnapshots[FACTORY_REPORT_DIGEST] = markdown;
  streamRunAt(point);
  fixture.turnItems = [
    runCard(point),
    makeFactoryCardTurnItem({
      id: reportRowId,
      threadId,
      createdAt: makeFactoryReportPayload().writtenAt,
      card: { kind: "report", payload: makeFactoryReportPayload() },
    }),
  ];
}

/** The report card's own timeline row, once its body and its run state arrived. */
async function reportRow(): Promise<HTMLElement> {
  let row: HTMLElement | null = null;
  await vi.waitFor(async () => {
    await settle();
    row = container.querySelector<HTMLElement>(`[data-timeline-row="${reportRowId}"]`);
    expect(
      row,
      `Expected the report card's row; rendered: ${container.textContent}`,
    ).not.toBeNull();
    expect(row!.textContent).toContain("criteria passed");
  });
  return row!;
}

async function openReportFromCard() {
  const open = [...(await reportRow()).querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Open",
  );
  expect(open, "Expected the report card's Open").toBeDefined();
  await click(open!);
  await vi.waitFor(async () => {
    await settle();
    expect(document.querySelector('nav[aria-label="Factory tabs"]')).not.toBeNull();
    expect(factoryPane().textContent).toContain("What is unresolved");
  });
}

/** Text a reader sees in the pane: folded content that is mounted but hidden does not count. */
function visiblePaneText(): string {
  const clone = factoryPane().cloneNode(true) as HTMLElement;
  for (const hidden of clone.querySelectorAll("[hidden], [aria-hidden='true']")) hidden.remove();
  return (clone.textContent ?? "").replace(/\s+/g, " ");
}

/** The first element in the pane whose whole text is `text`. */
/**
 * The verification table's phase folds, each opened so its criteria render: a
 * phase's summary reads `<n>. <title>` over `<passed>/<total> passed`.
 */
async function openVerificationPhases(): Promise<HTMLElement[]> {
  const folds = () =>
    [...factoryPane().querySelectorAll<HTMLButtonElement>("button")].filter((button) =>
      /^\d+\. .*\d+\/\d+ passed/.test(button.textContent?.replace(/\s+/g, " ").trim() ?? ""),
    );
  expect(folds().length, "Expected the verification table's phase folds").toBeGreaterThan(0);
  for (const fold of folds()) {
    if (fold.getAttribute("aria-expanded") !== "true") await click(fold);
  }
  await settle();
  return folds();
}

function paneElementWithText(text: string): HTMLElement {
  const element = [...factoryPane().querySelectorAll<HTMLElement>("*")].find(
    (node) => node.textContent?.replace(/\s+/g, " ").trim() === text,
  );
  expect(
    element,
    `Expected "${text}" in the pane; pane: ${factoryPane().textContent}`,
  ).toBeDefined();
  return element!;
}

const precedes = (left: Node, right: Node) =>
  (left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

it("phase11 web AC1 renders a factory.report turn item as a report card with its Context, What was built bullets, coverage and degraded count", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  showReport();
  await mountApp();
  const row = await reportRow();
  // Every section starts folded, with its heading in view.
  expect(row.textContent).toContain("How it was built");
  expect(row.textContent).not.toContain("Accountants close each month from the invoice list");
  await openSections(row, ["Context", "What was built"]);
  const text = row.textContent ?? "";

  expect(text).toContain("Accountants close each month from the invoice list");
  expect(text).toContain("Export the invoices the current filter shows as a CSV file.");
  expect(text).toContain("Keep every amount with two decimals and its invoice currency.");
  expect(text).toContain(
    "Download the file from an Export button on the invoices page, named after the export date.",
  );
  expect(text).toContain("4/5 criteria passed");
  expect(text).toContain("1 degraded phase");
  // A section left folded shows its heading and not its prose.
  expect(text).toContain("How it was built");
  expect(text).toContain("Check it yourself");
  expect(text).not.toContain(HOW_IT_WAS_BUILT_PROSE);
  // The run card stays; the report card is a second row, never a work-log row.
  expect(runRow()).not.toBe(await reportRow());
  // Its frame comes from the run's record, which the card reads while it is mounted.
  expect(fixture.factoryRunOpened).toBe(1);
});

it("phase11 web AC6 report card reads coverage and degraded count from the run state, not from report.md", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  showReport(
    "done",
    reportMarkdown.replace(
      "Accountants close each month from the invoice list",
      "Every one of the 5 criteria passed and 2 phases degraded. Accountants close each month from the invoice list",
    ),
  );
  await mountApp();
  const text = (await reportRow()).textContent ?? "";

  expect(text).toContain("4/5 criteria passed");
  expect(text).toContain("0 degraded phases");
});

it("phase11 web AC1 report card Open opens the Report tab of the Factory pane, maximized", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  showReport();
  await mountApp();
  await openReportFromCard();

  expect(panelState()).toMatchObject({ isOpen: true, activeSurfaceId: "factory" });
  expect(document.querySelector('[data-chat-column-maximized-away="true"]')).not.toBeNull();
  expect(factoryTab("Report").disabled).toBe(false);
  expect(factoryTab("Report").getAttribute("aria-pressed")).toBe("true");
  expect(factoryTab("Run").getAttribute("aria-pressed")).not.toBe("true");
});

it("phase11 web AC2 Report tab shows the clock band, then the authored sections in the contract's order, then the step record", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  showReport();
  await mountApp();
  await openReportFromCard();

  const text = visiblePaneText();
  expect(text).toMatch(/elapsed\s*4h 49m/i);
  expect(text).toMatch(/machine\s*4h 24m/i);
  expect(text).toMatch(/waiting\s*25m/i);
  expect(text).toContain(HOW_IT_WAS_BUILT_PROSE);

  const headings = [
    "Context",
    "What was built",
    "How it was built",
    "Where this differs from the plan",
    "How it was verified",
    "Architecture",
    "What is unresolved",
    "The run, step by step",
  ].map(paneElementWithText);
  for (let index = 1; index < headings.length; index += 1) {
    expect(
      precedes(headings[index - 1]!, headings[index]!),
      `"${headings[index - 1]!.textContent}" before "${headings[index]!.textContent}"`,
    ).toBe(true);
  }
  const showsElapsed = (node: Element) => /elapsed\s*4h 49m/i.test(node.textContent ?? "");
  // The smallest element that reads the elapsed time: the clock band, not an ancestor.
  const clock = [...factoryPane().querySelectorAll<HTMLElement>("*")].find(
    (node) => showsElapsed(node) && ![...node.children].some(showsElapsed),
  );
  expect(clock, "Expected the clock band").toBeDefined();
  expect(clock!.contains(headings[0]!)).toBe(false);
  expect(precedes(clock!, headings[0]!), "the clock band before Context").toBe(true);
});

it("phase11 web AC2 AC3 Report tab draws the verification table inside How it was verified, before its comment, marking results and authored-tests-only", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  showReport();
  await mountApp();
  await openReportFromCard();

  const phases = await openVerificationPhases();
  const table = phases[0]!;
  expect(precedes(paneElementWithText("How it was verified"), table)).toBe(true);
  expect(precedes(phases.at(-1)!, paneElementWithText("Architecture"))).toBe(true);
  const comment = [...factoryPane().querySelectorAll<HTMLElement>("p, li")].find((node) =>
    node.textContent?.includes(VERIFIED_COMMENT),
  );
  expect(comment, "Expected the authored comment").toBeDefined();
  expect(precedes(table, comment!), "the derived table before the authored comment").toBe(true);

  const row = (criterion: string) => {
    const match = [...factoryPane().querySelectorAll("li")].find(
      (candidate) =>
        candidate.textContent?.includes(criterion) && candidate.querySelector("li") === null,
    );
    expect(match, `Expected a row for "${criterion}"`).toBeDefined();
    return match!.textContent?.replace(/\s+/g, " ") ?? "";
  };
  expect(phases.map((phase) => phase.textContent).join(" ")).toContain(
    "Serialize the filtered invoice list as CSV",
  );
  expect(phases.map((phase) => phase.textContent).join(" ")).toContain(
    "Add the Export button to the invoices page",
  );
  const quoting = row("A field that contains a comma or a quote is quoted per RFC 4180");
  expect(quoting).toMatch(/pass/i);
  expect(quoting).toMatch(/authored tests only/i);
  const rows = row("GET /invoices/export.csv returns the rows the current filter shows");
  expect(rows).toMatch(/pass/i);
  expect(rows).not.toMatch(/authored tests only/i);
  expect(row("The Export button downloads invoices-<date>.csv")).toMatch(/not exercised/i);
  expect(row("The button is disabled while the list is empty")).toMatch(/pass/i);
});

it("phase11 web AC4 Report tab draws the Architecture diagram with its reading and legend and folds the step record per phase", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  showReport();
  await mountApp();
  await openReportFromCard();
  await vi.waitFor(async () => {
    await settle();
    // The loader caches a drawn diagram for the module's life, so the record
    // spans the file: an earlier spec may have drawn this one already.
    expect(fixture.mermaidRenders.some((source) => source.includes("EX[Export endpoint]"))).toBe(
      true,
    );
    const svg = factoryPane().querySelector('svg[data-mermaid-stub="true"]');
    expect(svg, "Expected the drawn diagram in the pane").not.toBeNull();
    expect(precedes(paneElementWithText("Architecture"), svg!)).toBe(true);
    expect(precedes(svg!, paneElementWithText("What is unresolved"))).toBe(true);
  });

  const text = visiblePaneText();
  expect(text).toContain("The page asks the endpoint for the file with its own filter");
  expect(text).toContain("the invoices page, which owns the filter.");
  expect(paneElementWithText("IP")).toBeDefined();
  expect(text).not.toContain("```mermaid");

  const stepRecord = paneElementWithText("The run, step by step");
  const phaseFolds = [...factoryPane().querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) =>
      precedes(stepRecord, button) &&
      (button.textContent?.includes("Serialize the filtered invoice list as CSV") ||
        button.textContent?.includes("Add the Export button to the invoices page")),
  );
  expect(phaseFolds, "Expected one fold per phase under the step record").toHaveLength(2);
  expect(text).not.toContain(STEP_LINE);

  await click(phaseFolds[0]!);
  expect(visiblePaneText()).toContain(STEP_LINE);
});

it("phase11 web AC5 Report tab renders an unknown heading as a plain section and names a missing section", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  const withoutDifferences = reportMarkdown.replace(
    /## Where this differs from the plan\n[\s\S]*?(?=## How it was verified)/,
    "",
  );
  showReport(
    "degraded",
    withoutDifferences.replace(
      "## How it was built",
      "## Screenshots\n\nTwo screenshots of the Export button, before and after.\n\n## How it was built",
    ),
  );
  await mountApp();
  await openReportFromCard();

  const text = visiblePaneText();
  expect(precedes(paneElementWithText("What was built"), paneElementWithText("Screenshots"))).toBe(
    true,
  );
  expect(text).toContain("Two screenshots of the Export button, before and after.");
  expect(text).toContain("Missing from report.md: Where this differs from the plan");
});

it("phase11 web review P2-1 Report tab keeps the verification table at its contract place when report.md leaves the section out", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  showReport(
    "degraded",
    reportMarkdown.replace(/## How it was verified\n[\s\S]*?(?=## Architecture)/, ""),
  );
  await mountApp();
  await openReportFromCard();

  const table = (await openVerificationPhases())[0]!;
  const heading = paneElementWithText("How it was verified");
  expect(precedes(paneElementWithText("Where this differs from the plan"), heading)).toBe(true);
  expect(precedes(heading, table)).toBe(true);
  expect(precedes(table, paneElementWithText("Architecture"))).toBe(true);
  expect(visiblePaneText()).toContain("Missing from report.md: How it was verified");
  expect(visiblePaneText()).not.toContain(VERIFIED_COMMENT);
});

/** Buttons of `root` whose text matches, e.g. a phase fold or a trace lane. */
const buttonsMatching = (root: HTMLElement, pattern: RegExp) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].filter((button) =>
    pattern.test(button.textContent?.replace(/\s+/g, " ").trim() ?? ""),
  );

/** Opens the report card's folded sections by heading: every section starts closed. */
async function openSections(root: HTMLElement, headings: ReadonlyArray<string>) {
  for (const heading of headings) {
    const [fold] = buttonsMatching(root, new RegExp(`^${heading}$`));
    expect(fold, `Expected a ${heading} fold`).toBeDefined();
    await click(fold!);
  }
}

it("trace draws the run card's strip from its summary, and opens the full trace only on demand", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  fixture.turnItems = [runCard("degraded")];
  streamRunAt("degraded");
  await mountApp();

  // 09:00 to 13:49, twelve role turns, and the 25-minute stop that waited for the developer.
  expect(runRow().textContent).toMatch(/4h 49m\s*agents 3h 06m\s*waiting for you 25m/);
  expect(fixture.factoryRunOpened).toBe(0);

  const trigger = runRow().querySelector<HTMLElement>('[aria-label="Run trace"]');
  expect(trigger, "Expected the trace strip's fold").not.toBeNull();
  await click(trigger!);
  await settle();
  expect(fixture.factoryRunOpened).toBe(1);
  expect(runRow().textContent).toContain("coordinator, checks");
  const lane = buttonsMatching(runRow(), /^1\. /)[0];
  expect(lane, "Expected phase 1's lane").toBeDefined();
  await click(lane!);
  await settle();
  const turns = runRow().querySelector<HTMLElement>('[aria-label="Turns of phase 1"]');
  expect(turns, "Expected phase 1's turns").not.toBeNull();
  // Each turn names the step it ran in: the implementer wrote the fence before implementing.
  const steps = [...turns!.querySelectorAll("li")].map((item) => item.textContent ?? "");
  expect(steps[0]).toMatch(/Fence\s*implementer 1/);
  expect(steps[1]).toMatch(/Implement\s*implementer 2/);
});

it("report card shows each criterion's captures, marks an on-screen criterion without one, and lists the suites to run again", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  showReport();
  const lines = eventsJsonl.split("\n").filter((line) => line.trim().length > 0);
  // Phase 2's first verdict marks its criterion 2 as something on screen; no capture follows.
  lines[59] = JSON.stringify(
    ((verdict) => ({
      ...verdict,
      criteria: verdict.criteria.map((criterion: { n: number }) =>
        criterion.n === 2 ? { ...criterion, visual: true } : criterion,
      ),
    }))(JSON.parse(lines[59]!)),
  );
  // Phase 2's harden checks name the directory the suite ran in.
  lines[67] = lines[67]!.replace(
    '{"command":"pnpm test","exit":0}',
    '{"command":"pnpm test","exit":0,"cwd":"apps/web"}',
  );
  lines.push(
    JSON.stringify({
      v: 1,
      at: "2026-09-28T13:50:00.000Z",
      type: "evidence.recorded",
      phase: 1,
      criterion: 1,
      kind: "image",
      path: "evidence/01-export.png",
      caption: "The exported CSV opened in a spreadsheet.",
      source: "live",
      viewport: "desktop",
    }),
  );
  fixture.factoryRunItem = { state: foldFactoryRunTestLines(lines), roles: [] };
  fixture.factoryRunUsage = {
    runId: "invoice-csv-export",
    providers: [
      {
        provider: "claude",
        windows: [
          {
            window: "seven_day",
            firstPercent: 16,
            lastPercent: 24,
            movedPercent: 8,
            samples: 3,
            resets: 0,
            firstAt: "2026-09-28T09:09:00.000Z",
            lastAt: "2026-09-28T13:32:00.000Z",
          },
        ],
        runSpendUsd: 57.6,
        machineSpendUsd: 128,
        estimate: {
          window: "seven_day",
          percent: 3.6,
          runShareOfSpend: 0.45,
          runSpendUsd: 54,
          machineSpendUsd: 120,
        },
      },
    ],
    machineSpend: "read",
    readAt: "2026-09-28T14:00:00.000Z",
  };
  await mountApp();
  const row = await reportRow();

  expect(row.textContent).toContain("Share of your plans");
  expect(row.textContent).toContain("3.6% of week");
  expect(row.textContent).toContain("account +8% · run $54 of $120");

  await openSections(row, ["How it was verified", "Check it yourself"]);
  for (const fold of buttonsMatching(row, /^[12]\. .*passed/)) await click(fold);
  await settle();
  expect(row.textContent).toContain("Live · desktop: The exported CSV opened in a spreadsheet.");
  expect(row.textContent).toContain("1 capture");
  expect(row.textContent).toContain("shows something on screen, no capture");
  expect(row.textContent).toContain("1 without capture");

  expect(row.textContent).toContain("Check it yourself");
  expect(row.textContent).toContain("(cd apps/web && pnpm test)");
});

it("report card opens a video capture in the app's media viewer", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  showReport();
  const lines = eventsJsonl.split("\n").filter((line) => line.trim().length > 0);
  lines.push(
    JSON.stringify({
      v: 1,
      at: "2026-09-28T13:50:00.000Z",
      type: "evidence.recorded",
      phase: 1,
      criterion: 1,
      kind: "video",
      path: "evidence/01-export.webm",
      caption: "The export downloading.",
      source: "live",
      viewport: "phone",
    }),
  );
  fixture.factoryRunItem = { state: foldFactoryRunTestLines(lines), roles: [] };
  await mountApp();
  const row = await reportRow();
  await openSections(row, ["How it was verified"]);
  for (const fold of buttonsMatching(row, /^1\. .*passed/)) await click(fold);
  await settle();

  const play = row.querySelector('button[aria-label="Play The export downloading."]');
  expect(play).not.toBeNull();
  await click(play!);
  expect(document.querySelector('[aria-label="Close video preview"]')).not.toBeNull();
});

it("opens the run card's trace from the keyboard and walks into its phase lanes", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  fixture.turnItems = [runCard("degraded")];
  streamRunAt("degraded");
  await mountApp();
  const trigger = runRow().querySelector<HTMLElement>('[aria-label="Run trace"]');
  expect(trigger, "Expected the run card's trace fold").not.toBeNull();
  // The composer takes focus once the thread settles; the reader then clicks into the card.
  await settle();
  trigger!.focus();
  expect(document.activeElement).toBe(trigger);
  const press = async (key: string) =>
    act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
      await settle();
    });

  await press("l");
  await vi.waitFor(() => expect(buttonsMatching(runRow(), /^1\. /)).toHaveLength(1));
  expect(trigger!.hasAttribute("data-panel-open")).toBe(true);
  // Opening mounts the trace's stream, and the harness's composer takes focus back on that render.
  trigger!.focus();
  await press("j");
  const lane = buttonsMatching(runRow(), /^1\. /)[0]!;
  expect(document.activeElement).toBe(lane);
  await press("l");
  expect(lane.getAttribute("aria-expanded")).toBe("true");
  await press("h");
  expect(lane.getAttribute("aria-expanded")).toBe("false");
  await press("h");
  expect(document.activeElement).toBe(trigger);
});

it("walks the Factory pane's phase lanes from the keyboard", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  fixture.turnItems = [runCard("degraded")];
  streamRunAt("degraded");
  await mountApp();
  await openRunFromCard();
  await settle();
  const pane = factoryPane();
  const [first, second] = [/^1\. /, /^2\. /].map((pattern) => buttonsMatching(pane, pattern)[0]!);
  expect(first, "Expected phase 1's lane").toBeDefined();
  expect(second, "Expected phase 2's lane").toBeDefined();
  first!.focus();
  const press = async (key: string) =>
    act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
      await settle();
    });

  await press("j");
  expect(document.activeElement).toBe(second);
  // In the pane a lane is a choice, not a fold: Right selects it, Left leaves it selected.
  await press("l");
  expect(second!.getAttribute("aria-expanded")).toBe("true");
  await press("h");
  expect(second!.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(second);
  await press("k");
  expect(document.activeElement).toBe(first);
});
