/**
 * Phase 6 fence (thread-attention plan) in the browser: the pinned Factory plan card in the
 * dock above the composer, acceptance criteria 1, 2 and 7.
 *
 * Entry point: AppRoot with its memory router and the real ChatView, MessagesTimeline,
 * ChatComposer, ComposerBannerStack, PinnedActionDock and FactoryPlanCard, mounted as
 * `FactoryPlanApproval.browser.test.tsx` mounts them. The thread, its provider list and the
 * stored plan body are fixtures; `threadEnvironment.startTurn` is a spy, so an approval is read
 * from its input. What only a browser shows: the dock at any timeline scroll position, at
 * desktop and Pixel 7 widths, the composer input left uncovered, and the unpin surviving a
 * remount from the same browser storage.
 */
import "~/index.css";
import { type ReactNode } from "react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import {
  EnvironmentId,
  ProjectId,
  MessageId,
  NodeId,
  PlanId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type ServerProvider,
  type ThreadAgentSignal,
} from "@t3tools/contracts";
import {
  FACTORY_DEFAULT_TEST_ROUTES,
  FACTORY_PLAN_DIGEST,
  makeFactoryCardTurnItem,
  makeFactoryPlanPayload,
  makeFactoryRouteProviders,
  readFactoryApprovalMessage,
} from "@t3tools/client-runtime/factory/testing";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { act, render, type Screen } from "../../../test/render";
import { makeFenceThreadShell, makeFenceUserInput } from "../../test/fenceThreadShell";
import {
  appRootFence,
  installFenceFontEvents,
  makeFenceSession,
} from "../../test/appRootFenceMocks";
import {
  makeFactoryMessageItem,
  type FactoryProjectionExtras,
} from "../../factory/factoryTestFixtures";
import type { AppRouter } from "../../router";

const fixture = vi.hoisted(() => ({
  thread: null as EnvironmentThreadShell | null,
  turnItems: [] as OrchestrationV2TurnItem[],
  projectionExtras: {} as FactoryProjectionExtras,
  planMode: false,
  commands: new Map<unknown, unknown>(),
  respondToApproval: vi.fn(async (_input: unknown) => ({ _tag: "Success", value: undefined })),
  respondToUserInput: vi.fn(async (_input: unknown) => ({ _tag: "Success", value: undefined })),
  dismissUserInput: vi.fn(async (_input: unknown) => ({ _tag: "Success", value: undefined })),
  clearAgentSignal: vi.fn(async (_input: unknown) => ({ _tag: "Success", value: undefined })),
  noopCommand: vi.fn(async () => ({ _tag: "Success", value: { providers: [] } })),
  startTurn: vi.fn(async (_input: unknown) => ({ _tag: "Success", value: undefined })),
  empty: [],
  threadListeners: new Set<() => void>(),
  // Rows the mocked list leaves out, as a virtualized list does once they scroll far away.
  hiddenRows: new Set<string>(),
  factorySnapshots: {} as Record<string, string>,
  factorySnapshotAtoms: new Map<string, unknown>(),
  environments: [
    {
      environmentId: "pinned-dock-environment",
      label: "Pinned dock environment",
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
  (await import("../../test/appRootFenceMocks")).mockRuntimeSession(importOriginal),
);
vi.mock("../../connection/runtime", async () =>
  (await import("../../test/appRootFenceMocks")).mockConnectionRuntime(),
);
vi.mock("../../state/presentation", async (importOriginal) =>
  (await import("../../test/appRootFenceMocks")).mockPresentation(
    importOriginal,
    fixture.environments,
  ),
);
vi.mock("../../state/entities", async (importOriginal) => {
  const { factoryThreadFixtureReads } = await import("../../factory/factoryTestFixtures");
  const threadReads = factoryThreadFixtureReads(fixture);
  return {
    ...(await importOriginal<typeof import("../../state/entities")>()),
    ...threadReads,
    useQuietThreadShell: threadReads.useThreadShell,
    useThreadRefs: () => fixture.empty,
    useProjects: () => fixture.empty,
    useProject: () => ({
      id: "pinned-dock-project",
      environmentId: "pinned-dock-environment",
      title: "Pinned dock",
      workspaceRoot: "/tmp/pinned-dock",
      scripts: [],
      createdAt: "2026-10-24T10:00:00.000Z",
      defaultModelSelection: { instanceId: "claudeAgent", model: "claude-fable-5-1" },
    }),
  };
});
vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
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
vi.mock("../../state/query", async (original) =>
  (await import("../../test/appRootFenceMocks")).mockQuery(original),
);
vi.mock("../../state/threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/threads")>();
  const { EMPTY_ENVIRONMENT_THREAD_STATE } = await import("@t3tools/client-runtime/state/threads");
  return { ...actual, useEnvironmentThread: () => EMPTY_ENVIRONMENT_THREAD_STATE };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => fixture.commands.get(command) ?? fixture.noopCommand,
}));
vi.mock("../../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => fixture.noopCommand,
}));
// The plan body a `factory_card` turn item names by digest, as the server's
// factoryReadSnapshot RPC would answer it.
vi.mock("../../state/factory", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
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
    },
  };
});
vi.mock("../../hooks/useSettings", async (importOriginal) => {
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts/settings");
  const settings = { ...DEFAULT_CLIENT_SETTINGS, ...DEFAULT_SERVER_SETTINGS };
  const planModeSettings = { ...settings, planModeEnabled: true };
  return {
    ...(await importOriginal<typeof import("../../hooks/useSettings")>()),
    useEnvironmentSettings: () => (fixture.planMode ? planModeSettings : settings),
    useClientSettings: (select?: (value: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
      select ? select(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS,
    useClientSettingsHydrated: () => true,
  };
});
vi.mock("../../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => fixture.noopCommand,
}));
vi.mock("../../hooks/useThreadActions", () => ({
  useAcknowledgeThreadWoke: () => fixture.noopCommand,
  useThreadActions: () => ({
    settleThread: fixture.noopCommand,
    pinThread: fixture.noopCommand,
    confirmAndUnpinThread: fixture.noopCommand,
  }),
}));
vi.mock("../../browser/ElectronBrowserHost", () => ({ ElectronBrowserHost: () => null }));
vi.mock("../QuitHoldOverlay", () => ({ QuitHoldOverlay: () => null }));
vi.mock("./ChatHeader", () => ({ ChatHeader: () => null }));
vi.mock("../BranchToolbar", () => ({ BranchToolbar: () => null }));

// Keep timeline rows mounted, so the timeline's own plan card is always in the DOM and only
// scrolling decides whether it is on screen. The real list brings its own scroll viewport; this
// one bounds itself to half the screen so the page around it keeps the app's height.
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
    <div style={{ maxHeight: "50dvh", overflowY: "auto" }}>
      {ListHeaderComponent}
      {data
        .filter((item) => !fixture.hiddenRows.has(item.id))
        .map((item) => (
          <div data-timeline-row={item.id} key={item.id}>
            {renderItem({ item })}
          </div>
        ))}
      {ListFooterComponent}
    </div>
  ),
}));

const { AppRoot } = await import("../../AppRoot");
const { default: ChatView } = await import("../ChatView");
const { SidebarProvider } = await import("../ui/sidebar");
import { threadEnvironment } from "../../state/threads";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useRightPanelStore } from "../../rightPanelStore";
import {
  changeQuestionAttachmentPreparation,
  questionAttachmentDraftId,
} from "../../questionAttachments";
import { usePinnedActionDockStore } from "./pinnedActionDockStore";
import { focusTestWindow } from "../../test/windowFocus";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

const environmentId = EnvironmentId.make("pinned-dock-environment");
const threadId = ThreadId.make("pinned-dock-thread");
const now = "2026-10-24T10:00:00.000Z";
const PLAN_TITLE = "Plan: the Software Factory inside Mesura Code";
const PLAN_MARKDOWN = `# ${PLAN_TITLE}\n\n## Context\n\nThe developer builds with the factory from a thread.\n`;
const UNPIN_LABEL = `Unpin plan: ${PLAN_TITLE}`;
const DESKTOP = { width: 1280, height: 800 };
// Playwright's `devices['Pixel 7']` viewport.
const PIXEL_7 = { width: 412, height: 839 };

function setProviders(providers: ReadonlyArray<ServerProvider>) {
  const [environment] = fixture.environments;
  fixture.environments = [
    {
      ...environment!,
      serverConfig: {
        ...environment!.serverConfig,
        providers: providers.map((provider) => ({
          ...provider,
          workspaceSnapshots: [
            { cwd: "/tmp/pinned-dock", checkedAt: now, skills: [], slashCommands: [] },
          ],
        })),
      },
    },
  ];
}

const LIVE_QUESTION = "Which database should the migration target?";
const MESSAGE_QUESTION = "Should the agent also update the docs?";
const APPROVAL_COMMAND = "rm -rf build";

/**
 * One approval and two questions, oldest first: a live question the provider does not mark
 * dismissible, and a message-mode question it does.
 */
function addPendingRequests() {
  const approval = makeFenceUserInput({
    threadId,
    requestId: "pinned-dock-approval",
    createdAt: "2026-10-24T10:01:00.000Z",
    questions: [],
  });
  const live = makeFenceUserInput({
    threadId,
    requestId: "pinned-dock-live-question",
    createdAt: "2026-10-24T10:02:00.000Z",
    questions: [
      {
        id: "database",
        header: "Database",
        question: LIVE_QUESTION,
        options: [{ label: "Postgres", description: "The main database" }],
      },
      {
        id: "order",
        header: "Order",
        question: "Which table goes first?",
        options: [{ label: "Users", description: "The users table" }],
      },
    ],
  });
  const message = makeFenceUserInput({
    threadId,
    requestId: "pinned-dock-message-question",
    createdAt: "2026-10-24T10:03:00.000Z",
    responseMode: "message",
    questions: [
      {
        id: "docs",
        header: "Docs",
        question: MESSAGE_QUESTION,
        options: [{ label: "Yes", description: "Update them" }],
      },
    ],
  });
  fixture.projectionExtras = {
    ...fixture.projectionExtras,
    runtimeRequests: [{ ...approval.request, kind: "command" }, live.request, message.request],
  };
  fixture.turnItems = [
    ...fixture.turnItems,
    {
      ...approval.item,
      type: "approval_request",
      requestKind: "command",
      prompt: APPROVAL_COMMAND,
    } as OrchestrationV2TurnItem,
    live.item,
    message.item,
  ];
}

/** Adds one more command approval, as the provider asking while the thread is open. */
function addApproval(requestId: string, createdAt: string, prompt: string) {
  const approval = makeFenceUserInput({ threadId, requestId, createdAt, questions: [] });
  fixture.projectionExtras = {
    ...fixture.projectionExtras,
    runtimeRequests: [
      ...(fixture.projectionExtras.runtimeRequests ?? []),
      { ...approval.request, kind: "command" },
    ],
  };
  fixture.turnItems = [
    ...fixture.turnItems,
    {
      ...approval.item,
      type: "approval_request",
      requestKind: "command",
      prompt,
    } as OrchestrationV2TurnItem,
  ];
}

const FOLLOW_UP_TITLE = "Ship the dock";

/** One finished run, so the thread reads as settled. */
function completedRun(): OrchestrationV2Run {
  const at = DateTime.makeUnsafe(now);
  return {
    id: RunId.make("pinned-dock-run"),
    threadId,
    ordinal: 1,
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-fable-5-1",
    },
    providerThreadId: null,
    userMessageId: MessageId.make("pinned-dock-run-message"),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt: at,
    startedAt: at,
    completedAt: at,
    checkpointId: null,
    contextHandoffId: null,
  };
}

/** A settled thread in plan mode with an active proposed plan: the composer's plan follow-up. */
function addProposedPlan() {
  fixture.planMode = true;
  fixture.thread = { ...fixture.thread!, interactionMode: "plan" };
  fixture.projectionExtras = {
    ...fixture.projectionExtras,
    runs: [completedRun()],
    plans: [
      {
        id: PlanId.make("pinned-dock-proposed-plan"),
        threadId,
        runId: null,
        nodeId: NodeId.make("pinned-dock-proposed-plan-node"),
        status: "active",
        kind: "proposed_plan",
        markdown: `# ${FOLLOW_UP_TITLE}\n\nPin every card above the composer.\n`,
      },
    ],
  };
}

/** The plan card first, then enough long replies that the timeline overflows past it. */
function seedLongThread() {
  const filler = "A long assistant reply that pushes the plan card out of view. ".repeat(12);
  fixture.turnItems = [
    makeFactoryCardTurnItem({
      id: "factory-plan:plan-md",
      threadId,
      createdAt: now,
      card: { kind: "plan", payload: makeFactoryPlanPayload() },
    }),
    ...Array.from({ length: 30 }, (_, index) =>
      makeFactoryMessageItem({
        id: `pinned-dock-reply-${index}`,
        role: "assistant",
        text: `Reply ${index}. ${filler}`,
        createdAt: now,
        threadId,
      }),
    ),
  ];
}

async function setupDockFixture(
  viewport: { width: number; height: number } = DESKTOP,
  options: {
    readonly pending?: boolean;
    readonly agentSignal?: ThreadAgentSignal;
    readonly proposedPlan?: boolean;
  } = {},
) {
  await using resources = new AsyncDisposableStack();
  const previousViewport = { width: window.innerWidth, height: window.innerHeight };
  resources.defer(() => page.viewport(previousViewport.width, previousViewport.height));
  await page.viewport(viewport.width, viewport.height);
  const restoreFonts = installFenceFontEvents();
  resources.defer(restoreFonts);
  appRootFence.sessions.set(environmentId, makeFenceSession());
  resources.defer(() => {
    appRootFence.sessions.delete(environmentId);
  });
  for (const [command, spy] of [
    [threadEnvironment.startTurn, fixture.startTurn],
    [threadEnvironment.respondToApproval, fixture.respondToApproval],
    [threadEnvironment.respondToUserInput, fixture.respondToUserInput],
    [threadEnvironment.dismissUserInput, fixture.dismissUserInput],
    [threadEnvironment.clearAgentSignal, fixture.clearAgentSignal],
  ] as const) {
    spy.mockClear();
    fixture.commands.set(command, spy);
  }
  fixture.projectionExtras = {};
  fixture.planMode = false;
  fixture.hiddenRows.clear();
  fixture.factorySnapshots = { [FACTORY_PLAN_DIGEST]: PLAN_MARKDOWN };
  fixture.factorySnapshotAtoms.clear();
  setProviders(makeFactoryRouteProviders());
  fixture.thread = makeFenceThreadShell({
    id: threadId,
    environmentId,
    projectId: ProjectId.make("pinned-dock-project"),
    title: "Pinned dock",
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-fable-5-1",
    },
    createdAt: now,
  });
  seedLongThread();
  if (options.pending) addPendingRequests();
  if (options.proposedPlan) addProposedPlan();
  if (options.agentSignal) fixture.thread = { ...fixture.thread, agentSignal: options.agentSignal };
  // Dock unpins persist in browser storage; every test starts from none, in storage and memory.
  localStorage.clear();
  usePinnedActionDockStore.setState({ unpins: {} });
  resources.defer(() => {
    localStorage.clear();
    useComposerDraftStore.getState().clearComposerContent(scopeThreadRef(environmentId, threadId));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  return resources.move();
}

async function mountApp(): Promise<Screen> {
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
  await focusTestWindow();
  const container = document.createElement("div");
  container.style.height = "100dvh";
  container.style.overflow = "hidden";
  document.body.append(container);
  // AppRoot owns this fixture's memory router.
  const screen = await render(null, { container, router: false });
  await act(async () => {
    await screen.rerender(<AppRoot router={router as unknown as AppRouter} />);
  });
  return screen;
}

function timelinePlanRow(container: HTMLElement): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>("[data-timeline-row]")].find((entry) =>
    entry.textContent?.includes(PLAN_TITLE),
  );
  expect(
    row,
    `Expected the plan card's timeline row; rendered: ${container.textContent}`,
  ).toBeDefined();
  return row!;
}

/** The nearest ancestor of the timeline's plan card that scrolls: the timeline's viewport. */
function timelineScroller(container: HTMLElement): HTMLElement {
  const describe: string[] = [];
  for (
    let element = timelinePlanRow(container).parentElement;
    element !== null;
    element = element.parentElement
  ) {
    const overflowY = getComputedStyle(element).overflowY;
    describe.push(
      `${element.tagName}.${element.className} ${overflowY} ${element.scrollHeight}/${element.clientHeight}`,
    );
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      element.scrollHeight > element.clientHeight
    )
      return element;
  }
  expect.fail(`Expected the timeline to scroll; ancestors: ${describe.join(" | ")}`);
}

async function scrollTimeline(container: HTMLElement, to: "top" | "end") {
  const scroller = timelineScroller(container);
  await act(() => {
    scroller.scrollTop = to === "top" ? 0 : scroller.scrollHeight;
    scroller.dispatchEvent(new Event("scroll"));
  });
}

function dock(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[role="region"][aria-label="Pending actions"]');
}

/** The dock's pinned plan card: the dock entry that names the plan. */
function pinnedPlanCard(container: HTMLElement): HTMLElement | null {
  const region = dock(container);
  if (region === null) return null;
  const unpin = region.querySelector<HTMLElement>(`button[aria-label="${UNPIN_LABEL}"]`);
  return unpin?.closest<HTMLElement>("[data-pinned-action-dock-item]") ?? null;
}

function requirePinnedPlanCard(container: HTMLElement): HTMLElement {
  const card = pinnedPlanCard(container);
  expect(
    card,
    `Expected a pinned plan card in the Pending actions dock; dock: ${dock(container)?.outerHTML ?? "none"}`,
  ).not.toBeNull();
  return card!;
}

/** The dock's X whose accessible name starts with `prefix` and names `subject`. */
function dockCloseButton(container: HTMLElement, prefix: string, subject: string) {
  const region = dock(container);
  expect(region, "Expected the Pending actions dock").not.toBeNull();
  const button = [...region!.querySelectorAll<HTMLButtonElement>("button[aria-label]")].find(
    (entry) => {
      const label = entry.getAttribute("aria-label") ?? "";
      return label.startsWith(prefix) && label.includes(subject);
    },
  );
  expect(
    button,
    `Expected a dock button "${prefix} … ${subject}"; dock: ${region!.textContent}`,
  ).toBeDefined();
  return button!;
}

function dockItems(container: HTMLElement): HTMLElement[] {
  return [
    ...(dock(container)?.querySelectorAll<HTMLElement>("[data-pinned-action-dock-item]") ?? []),
  ];
}

/** Drops the timeline's plan row, as the virtualized list does once it scrolls far away. */
async function virtualizeOutTimelinePlanRow(container: HTMLElement) {
  fixture.hiddenRows.add(timelinePlanRow(container).dataset.timelineRow!);
  await act(async () => {
    fixture.turnItems = [...fixture.turnItems];
    for (const listener of fixture.threadListeners) listener();
  });
  await vi.waitFor(() =>
    expect(
      [...container.querySelectorAll("[data-timeline-row]")].some((row) =>
        row.textContent?.includes(PLAN_TITLE),
      ),
    ).toBe(false),
  );
}

async function typeTimelineBudget(container: HTMLElement, value: string) {
  const input = timelinePlanRow(container).querySelector<HTMLInputElement>(
    'input[aria-label="Implementer budget"]',
  );
  expect(input, "Expected the timeline card's Implementer budget input").not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    input!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function dockItem(container: HTMLElement, kind: string): HTMLElement {
  const match = dockItems(container).find((entry) => entry.dataset.pinnedActionDockItem === kind);
  expect(match, `Expected a ${kind} item in the dock`).toBeDefined();
  return match!;
}

function buttonNamed(scope: HTMLElement, name: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent?.trim() === name || entry.getAttribute("aria-label") === name,
  );
}

function inViewport(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return (
    rect.height > 0 &&
    rect.top >= 0 &&
    rect.bottom <= window.innerHeight &&
    rect.left >= 0 &&
    rect.right <= window.innerWidth
  );
}

function composerEditor(container: HTMLElement): HTMLElement {
  const editor = container.querySelector<HTMLElement>('[data-testid="composer-editor"]');
  expect(editor, "Expected the composer input").not.toBeNull();
  return editor!;
}

function sentApproval() {
  const sent = fixture.startTurn.mock.calls[0]![0] as {
    input: { message: { text: string } };
  };
  return readFactoryApprovalMessage(sent.input.message.text);
}

it("phase6 dock browser guard the long fixture thread scrolls the timeline card out of view", async () => {
  await using _fixture = await setupDockFixture();
  await using screen = await mountApp();
  const scroller = await vi.waitFor(() => timelineScroller(screen.container));
  expect(scroller.scrollHeight - scroller.clientHeight).toBeGreaterThan(scroller.clientHeight);
  await scrollTimeline(screen.container, "end");
  expect(inViewport(timelinePlanRow(screen.container))).toBe(false);
});

const WIDTHS = [
  { name: "desktop", viewport: DESKTOP },
  { name: "Pixel 7", viewport: PIXEL_7 },
] as const;

it.each(WIDTHS)(
  "phase6 dock browser AC1 keeps the pinned plan card on screen at the end and the top of the timeline at $name width",
  async ({ viewport }) => {
    await using _fixture = await setupDockFixture(viewport);
    await using screen = await mountApp();
    for (const position of ["end", "top"] as const) {
      await scrollTimeline(screen.container, position);
      await vi.waitFor(() => {
        const card = requirePinnedPlanCard(screen.container);
        expect(inViewport(card), `pinned plan card on screen at the ${position}`).toBe(true);
      });
    }
    const card = requirePinnedPlanCard(screen.container);
    expect(card.textContent).toContain(PLAN_TITLE);
    expect(card.textContent).toContain("2 phases");
    expect(buttonNamed(card, "Open")).toBeDefined();
    expect(buttonNamed(card, "Approve")?.disabled).toBe(false);
    expect(buttonNamed(card, UNPIN_LABEL)).toBeDefined();
  },
);

it.each(WIDTHS)(
  "phase6 dock browser AC7 the dock never covers the composer input at $name width",
  async ({ viewport }) => {
    await using _fixture = await setupDockFixture(viewport);
    await using screen = await mountApp();
    await vi.waitFor(() => requirePinnedPlanCard(screen.container));
    const region = dock(screen.container)!;
    const editor = composerEditor(screen.container);
    const editorRect = editor.getBoundingClientRect();
    expect(region.getBoundingClientRect().bottom).toBeLessThanOrEqual(editorRect.top + 0.5);
    expect(inViewport(editor)).toBe(true);
    const hit = document.elementFromPoint(
      editorRect.left + editorRect.width / 2,
      editorRect.top + editorRect.height / 2,
    );
    expect(hit !== null && editor.contains(hit)).toBe(true);
  },
);

it("phase6 dock browser AC1 the pinned Approve sends the same approval as the timeline card", async () => {
  await using _fixture = await setupDockFixture();
  await using screen = await mountApp();
  await scrollTimeline(screen.container, "end");
  const card = await vi.waitFor(() => requirePinnedPlanCard(screen.container));
  await act(async () => buttonNamed(card, "Approve")!.click());
  await vi.waitFor(() => expect(fixture.startTurn).toHaveBeenCalledOnce());
  const message = sentApproval();
  expect(message.firstLine).toBe(`Approve plan sha256:${FACTORY_PLAN_DIGEST}`);
  expect(message.routes).toEqual(FACTORY_DEFAULT_TEST_ROUTES);
});

it("phase6 dock browser AC1 the pinned Open opens the same plan view as the timeline card", async () => {
  await using _fixture = await setupDockFixture();
  await using screen = await mountApp();
  const initialPanels = useRightPanelStore.getState();
  await act(async () => buttonNamed(timelinePlanRow(screen.container), "Open")!.click());
  const fromTimeline = JSON.stringify(useRightPanelStore.getState());
  await act(async () => useRightPanelStore.setState(initialPanels, true));
  const card = await vi.waitFor(() => requirePinnedPlanCard(screen.container));
  await act(async () => buttonNamed(card, "Open")!.click());
  expect(JSON.stringify(useRightPanelStore.getState())).toBe(fromTimeline);
  expect(fromTimeline).not.toBe(JSON.stringify(initialPanels));
});

it("phase6 dock browser AC2 the X unpins the plan card and the timeline card still approves", async () => {
  await using _fixture = await setupDockFixture();
  await using screen = await mountApp();
  const card = await vi.waitFor(() => requirePinnedPlanCard(screen.container));
  await act(async () => buttonNamed(card, UNPIN_LABEL)!.click());
  await vi.waitFor(() => expect(pinnedPlanCard(screen.container)).toBeNull());
  expect(fixture.startTurn).not.toHaveBeenCalled();
  const timelineApprove = buttonNamed(timelinePlanRow(screen.container), "Approve");
  expect(timelineApprove?.disabled).toBe(false);
  await act(async () => timelineApprove!.click());
  await vi.waitFor(() => expect(fixture.startTurn).toHaveBeenCalledOnce());
  expect(sentApproval().firstLine).toBe(`Approve plan sha256:${FACTORY_PLAN_DIGEST}`);
});

it("phase6 dock browser AC2 an unpinned plan card stays unpinned after a reload", async () => {
  await using _fixture = await setupDockFixture();
  {
    await using screen = await mountApp();
    const card = await vi.waitFor(() => requirePinnedPlanCard(screen.container));
    await act(async () => buttonNamed(card, UNPIN_LABEL)!.click());
    await vi.waitFor(() => expect(pinnedPlanCard(screen.container)).toBeNull());
  }
  // A reload: the in-memory store is gone and only browser storage remains. Clearing memory
  // writes through to storage, so the stored value is put back before rehydrating from it.
  const storageKey = usePinnedActionDockStore.persist.getOptions().name!;
  const stored = localStorage.getItem(storageKey);
  expect(stored, "Expected the unpin in browser storage").not.toBeNull();
  usePinnedActionDockStore.setState({ unpins: {} });
  localStorage.setItem(storageKey, stored!);
  await usePinnedActionDockStore.persist.rehydrate();
  await using reloaded = await mountApp();
  // The timeline card is back, so the thread rendered; the dock still leaves the plan out.
  timelinePlanRow(reloaded.container);
  expect(pinnedPlanCard(reloaded.container)).toBeNull();
});

it("phase6 dock browser AC7 the X is a focusable button that a keyboard press closes", async () => {
  await using _fixture = await setupDockFixture(PIXEL_7);
  await using screen = await mountApp();
  const card = await vi.waitFor(() => requirePinnedPlanCard(screen.container));
  const unpin = buttonNamed(card, UNPIN_LABEL)!;
  expect(unpin.tagName).toBe("BUTTON");
  expect(unpin.tabIndex).toBeGreaterThanOrEqual(0);
  // Touch-sized: at least 24 CSS px in each direction (WCAG 2.2 target size).
  const rect = unpin.getBoundingClientRect();
  expect(Math.min(rect.width, rect.height)).toBeGreaterThanOrEqual(24);
  unpin.focus();
  expect(document.activeElement).toBe(unpin);
  await userEvent.keyboard("{Escape}");
  expect(pinnedPlanCard(screen.container)).not.toBeNull();
  unpin.focus();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(pinnedPlanCard(screen.container)).toBeNull());
});

it("phase6 dock browser AC3 the X on a question the provider does not mark dismissible answers it as dismissed", async () => {
  await using _fixture = await setupDockFixture(DESKTOP, { pending: true });
  await using screen = await mountApp();
  const close = await vi.waitFor(() => dockCloseButton(screen.container, "Dismiss", LIVE_QUESTION));
  await act(async () => close.click());
  await vi.waitFor(() => expect(fixture.respondToUserInput).toHaveBeenCalledOnce());
  const sent = fixture.respondToUserInput.mock.calls[0]![0] as {
    input: { requestId: string; answers: Record<string, unknown> };
  };
  expect(sent.input.requestId).toBe("pinned-dock-live-question");
  expect(Object.keys(sent.input.answers).toSorted()).toEqual(["database", "order"]);
  for (const answer of Object.values(sent.input.answers)) expect(answer).toMatch(/dismissed/i);
  expect(fixture.dismissUserInput).not.toHaveBeenCalled();
});

it("phase6 dock browser AC3 the X on a dismissible question goes through the existing dismiss", async () => {
  await using _fixture = await setupDockFixture(DESKTOP, { pending: true });
  await using screen = await mountApp();
  const close = await vi.waitFor(() =>
    dockCloseButton(screen.container, "Dismiss", MESSAGE_QUESTION),
  );
  await act(async () => close.click());
  await vi.waitFor(() => expect(fixture.dismissUserInput).toHaveBeenCalledOnce());
  expect(fixture.dismissUserInput.mock.calls[0]![0]).toMatchObject({
    input: { threadId, requestId: "pinned-dock-message-question" },
  });
  expect(fixture.respondToUserInput).not.toHaveBeenCalled();
});

it("phase6 dock browser AC4 the X on an approval declines it", async () => {
  await using _fixture = await setupDockFixture(DESKTOP, { pending: true });
  await using screen = await mountApp();
  const close = await vi.waitFor(() => dockCloseButton(screen.container, "Decline", "ommand"));
  await act(async () => close.click());
  await vi.waitFor(() => expect(fixture.respondToApproval).toHaveBeenCalledOnce());
  expect(fixture.respondToApproval.mock.calls[0]![0]).toMatchObject({
    input: { threadId, requestId: "pinned-dock-approval", decision: "decline" },
  });
});

it("phase6 dock browser AC5 the agent signal sits in the dock and its X clears it", async () => {
  await using _fixture = await setupDockFixture(DESKTOP, {
    agentSignal: {
      kind: "needs_input",
      note: "Pick the migration order",
      runId: null,
      setAt: "2026-10-24T10:04:00.000Z",
    },
  });
  await using screen = await mountApp();
  await scrollTimeline(screen.container, "top");
  const item = await vi.waitFor(() => {
    const match = dockItems(screen.container).find(
      (entry) => entry.dataset.pinnedActionDockItem === "agent-signal",
    );
    expect(match, "Expected the agent signal in the dock").toBeDefined();
    return match!;
  });
  expect(inViewport(item)).toBe(true);
  expect(item.textContent).toContain("Pick the migration order");
  await act(async () => dockCloseButton(screen.container, "Dismiss", "agent").click());
  await vi.waitFor(() => expect(fixture.clearAgentSignal).toHaveBeenCalledOnce());
  expect(fixture.clearAgentSignal.mock.calls[0]![0]).toMatchObject({ input: { threadId } });
});

it("phase6 dock browser AC6 at Pixel 7 width the dock expands the two newest items and keeps the input on screen", async () => {
  await using _fixture = await setupDockFixture(PIXEL_7, { pending: true });
  await using screen = await mountApp();
  // Newest first: the message question, the live question, the approval, then the plan.
  await vi.waitFor(() => expect(dockItems(screen.container)).toHaveLength(4));
  const items = dockItems(screen.container);
  expect(items.map((entry) => entry.dataset.pinnedActionDockItem)).toEqual([
    "question",
    "question",
    "approval",
    "plan",
  ]);
  expect(items.map((entry) => entry.dataset.expanded)).toEqual(["true", "true", "false", "false"]);
  const collapsed = items[3]!;
  expect(collapsed.getBoundingClientRect().height).toBeLessThanOrEqual(48);
  // A tap expands a collapsed item; the phone limit of two still holds.
  await userEvent.click(collapsed.querySelector<HTMLElement>("[data-pinned-action-dock-expand]")!);
  await vi.waitFor(() => expect(dockItems(screen.container)[3]!.dataset.expanded).toBe("true"));
  expect(
    dockItems(screen.container).filter((entry) => entry.dataset.expanded === "true"),
  ).toHaveLength(2);
  const region = dock(screen.container)!;
  const editor = composerEditor(screen.container);
  expect(inViewport(editor)).toBe(true);
  expect(region.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    editor.getBoundingClientRect().top + 0.5,
  );
});

it("phase6 dock browser guard the composer approval panel still declines through its own Decline", async () => {
  await using _fixture = await setupDockFixture(DESKTOP, { pending: true });
  await using screen = await mountApp();
  const panel = await vi.waitFor(() => {
    const match = screen.container.querySelector<HTMLElement>(
      '[data-chat-composer-top-drawer="true"]',
    );
    expect(match?.textContent, "Expected the composer approval panel").toContain(APPROVAL_COMMAND);
    return match!;
  });
  await act(async () => buttonNamed(panel, "Decline")!.click());
  await vi.waitFor(() => expect(fixture.respondToApproval).toHaveBeenCalledOnce());
  expect(fixture.respondToApproval.mock.calls[0]![0]).toMatchObject({
    input: { threadId, requestId: "pinned-dock-approval", decision: "decline" },
  });
});

it("phase6 dock browser guard the inline question cards still show both pending questions", async () => {
  await using _fixture = await setupDockFixture(DESKTOP, { pending: true });
  await using screen = await mountApp();
  await vi.waitFor(() => {
    const cards = [
      ...screen.container.querySelectorAll<HTMLElement>("[data-pending-user-input-request-id]"),
    ];
    expect(cards.map((card) => card.dataset.pendingUserInputRequestId).toSorted()).toEqual([
      "pinned-dock-live-question",
      "pinned-dock-message-question",
    ]);
  });
  const dismissible = screen.container.querySelector<HTMLElement>(
    '[data-pending-user-input-request-id="pinned-dock-message-question"]',
  )!;
  await act(async () => buttonNamed(dismissible, "Dismiss question without answering")!.click());
  await vi.waitFor(() => expect(fixture.dismissUserInput).toHaveBeenCalledOnce());
});

it("phase6 dock browser AC3 a question's Answer scrolls its inline card into view and focuses it", async () => {
  await using _fixture = await setupDockFixture(DESKTOP, { pending: true });
  await using screen = await mountApp();
  await scrollTimeline(screen.container, "top");
  const entry = await vi.waitFor(() => {
    const match = dockItems(screen.container).find((item) =>
      item.textContent?.includes(LIVE_QUESTION),
    );
    expect(match, "Expected the live question's dock entry").toBeDefined();
    return match!;
  });
  const card = screen.container.querySelector<HTMLElement>(
    '[data-pending-user-input-request-id="pinned-dock-live-question"]',
  )!;
  expect(inViewport(card)).toBe(false);
  await act(async () => buttonNamed(entry, "Answer")!.click());
  await vi.waitFor(() => {
    expect(card.contains(document.activeElement)).toBe(true);
    const rect = card.getBoundingClientRect();
    const scroller = timelineScroller(screen.container).getBoundingClientRect();
    expect(rect.bottom > scroller.top && rect.top < scroller.bottom).toBe(true);
  });
  expect(fixture.respondToUserInput).not.toHaveBeenCalled();
});

it("phase6 dock browser P1-2 edited routes survive the timeline card leaving the list and the dock plan collapsing", async () => {
  await using _fixture = await setupDockFixture(PIXEL_7, { pending: true });
  await using screen = await mountApp();
  await vi.waitFor(() => expect(dockItems(screen.container)).toHaveLength(4));
  await typeTimelineBudget(screen.container, "40");
  // Expand the plan, so its body mounts, then drop the timeline card from the list.
  await userEvent.click(
    dockItem(screen.container, "plan").querySelector<HTMLElement>(
      "[data-pinned-action-dock-expand]",
    )!,
  );
  await vi.waitFor(() => expect(dockItem(screen.container, "plan").dataset.expanded).toBe("true"));
  await virtualizeOutTimelinePlanRow(screen.container);
  // Expanding the approval collapses the plan at phone width, unmounting its body.
  await userEvent.click(
    dockItem(screen.container, "approval").querySelector<HTMLElement>(
      "[data-pinned-action-dock-expand]",
    )!,
  );
  await vi.waitFor(() => expect(dockItem(screen.container, "plan").dataset.expanded).toBe("false"));
  await userEvent.click(
    dockItem(screen.container, "plan").querySelector<HTMLElement>(
      "[data-pinned-action-dock-expand]",
    )!,
  );
  const plan = await vi.waitFor(() => {
    const entry = dockItem(screen.container, "plan");
    expect(entry.dataset.expanded).toBe("true");
    return entry;
  });
  await act(async () => buttonNamed(plan, "Approve")!.click());
  await vi.waitFor(() => expect(fixture.startTurn).toHaveBeenCalledOnce());
  expect(sentApproval().routes).toMatchObject({ implementer: { budgetUsd: 40 } });
});

it("phase6 dock browser P1-3 the timeline and dock Approve send one approval between them", async () => {
  await using _fixture = await setupDockFixture();
  let release: (value: { _tag: string; value: undefined }) => void = () => undefined;
  fixture.startTurn.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await using screen = await mountApp();
  const card = await vi.waitFor(() => requirePinnedPlanCard(screen.container));
  await act(async () => buttonNamed(timelinePlanRow(screen.container), "Approve")!.click());
  expect(fixture.startTurn).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(buttonNamed(card, "Approve")?.disabled).toBe(true));
  await act(async () => buttonNamed(card, "Approve")!.click());
  expect(fixture.startTurn).toHaveBeenCalledOnce();
  await act(async () => release({ _tag: "Success", value: undefined }));
});

it("phase6 dock browser P1-4 the X dismisses a question whose draft still prepares an attachment", async () => {
  await using _fixture = await setupDockFixture(DESKTOP, { pending: true });
  const draftId = questionAttachmentDraftId(
    environmentId,
    threadId,
    RuntimeRequestId.make("pinned-dock-live-question"),
    "database",
  );
  changeQuestionAttachmentPreparation(draftId, 1);
  await using _preparation = {
    [Symbol.asyncDispose]: async () => changeQuestionAttachmentPreparation(draftId, -1),
  };
  await using screen = await mountApp();
  const close = await vi.waitFor(() => dockCloseButton(screen.container, "Dismiss", LIVE_QUESTION));
  await act(async () => close.click());
  await vi.waitFor(() => expect(fixture.respondToUserInput).toHaveBeenCalledOnce());
  const sent = fixture.respondToUserInput.mock.calls[0]![0] as {
    input: { requestId: string; answers: Record<string, unknown> };
  };
  expect(sent.input.requestId).toBe("pinned-dock-live-question");
  expect(sent.input).not.toHaveProperty("attachmentsByQuestionId");
});

it("phase6 dock browser P1-4 a dismissal the server refuses shows an error", async () => {
  await using _fixture = await setupDockFixture(DESKTOP, { pending: true });
  fixture.respondToUserInput.mockImplementationOnce(
    async () => AsyncResult.failure(Cause.fail(new Error("the provider is gone"))) as never,
  );
  await using screen = await mountApp();
  const close = await vi.waitFor(() => dockCloseButton(screen.container, "Dismiss", LIVE_QUESTION));
  await act(async () => close.click());
  await vi.waitFor(() =>
    expect(screen.container.textContent).toContain(
      "Could not dismiss the question: the provider is gone",
    ),
  );
});

it("phase6 dock browser P1-5 guard the plan follow-up sits in the dock at desktop width", async () => {
  await using _fixture = await setupDockFixture(DESKTOP, { proposedPlan: true });
  await using screen = await mountApp();
  const item = await vi.waitFor(() => dockItem(screen.container, "plan-follow-up"));
  expect(item.textContent).toContain(FOLLOW_UP_TITLE);
});

it("phase6 dock browser P1-5 the plan follow-up stays in the dock with an unfocused phone composer", async () => {
  await using _fixture = await setupDockFixture(PIXEL_7, { proposedPlan: true });
  await using screen = await mountApp();
  // The composer takes focus a frame after mount; the developer reading the thread has left it.
  // Blur only once it holds focus, or the late focus lands after the blur and keeps it expanded.
  const editor = composerEditor(screen.container);
  await vi.waitFor(() => expect(document.activeElement).toBe(editor));
  await act(async () => editor.blur());
  await vi.waitFor(() =>
    expect(
      screen.container.querySelector('[data-chat-composer-mobile-collapsed="true"]'),
      "Expected the phone composer collapsed while unfocused",
    ).not.toBeNull(),
  );
  const item = await vi.waitFor(() => dockItem(screen.container, "plan-follow-up"));
  expect(item.textContent).toContain(FOLLOW_UP_TITLE);
  expect(
    dockCloseButton(screen.container, "Dismiss plan follow-up", FOLLOW_UP_TITLE),
  ).toBeDefined();
});

it("phase6 dock browser P1-6 an approval arriving while typing stays out of the dock and a send declines only the shown one", async () => {
  await using _fixture = await setupDockFixture(DESKTOP);
  addApproval("pinned-dock-shown-approval", "2026-10-24T10:01:00.000Z", "rm -rf build");
  await using screen = await mountApp();
  await vi.waitFor(() =>
    expect(dockItems(screen.container).map((item) => item.dataset.pinnedActionDockItem)).toContain(
      "approval",
    ),
  );
  const editor = composerEditor(screen.container);
  await userEvent.click(editor);
  await userEvent.keyboard("Use the staging database instead");
  await act(async () => {
    addApproval("pinned-dock-held-approval", "2026-10-24T10:05:00.000Z", "git push --force");
    for (const listener of fixture.threadListeners) listener();
  });
  const approvalTexts = () =>
    dockItems(screen.container)
      .filter((item) => item.dataset.pinnedActionDockItem === "approval")
      .map((item) => item.textContent ?? "");
  await vi.waitFor(() => expect(approvalTexts()).toHaveLength(1));
  expect(approvalTexts()[0]).toContain("rm -rf build");
  expect(screen.container.textContent).not.toContain("git push --force");
  const send = screen.container.querySelector<HTMLButtonElement>(
    'button[aria-label="Submit message"]',
  );
  expect(send?.disabled).toBe(false);
  await act(async () => send!.click());
  await vi.waitFor(() => expect(fixture.respondToApproval).toHaveBeenCalled());
  const declined = fixture.respondToApproval.mock.calls.map(
    (call) => (call[0] as { input: { requestId: string; decision: string } }).input,
  );
  expect(declined).toEqual([
    expect.objectContaining({ requestId: "pinned-dock-shown-approval", decision: "decline" }),
  ]);
});
