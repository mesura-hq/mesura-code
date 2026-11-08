// Real ChatView fence for pending cards and the composer dock.
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
import { usePendingUserInputDraftStore } from "../../pendingUserInputDraftStore";
import { dispatchPickerAction } from "../../lib/pickerActionBus";
import { createDeferredPromise } from "../../test/threadLinkFixture";
import { DISMISSED_QUESTION_ANSWER } from "../../pendingUserInput";
import { focusTestWindow } from "../../test/windowFocus";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

const environmentId = EnvironmentId.make("pinned-dock-environment");
const threadId = ThreadId.make("pinned-dock-thread");
const now = "2026-10-24T10:00:00.000Z";
const PLAN_TITLE = "Plan: the Software Factory inside Mesura Code";
const PLAN_MARKDOWN = `# ${PLAN_TITLE}\n\n## Context\n\nThe developer builds with the factory from a thread.\n`;
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
  const previousPanels = useRightPanelStore.getState();
  useRightPanelStore.setState(useRightPanelStore.getInitialState(), true);
  resources.defer(() => {
    useRightPanelStore.setState(previousPanels, true);
  });
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
  usePendingUserInputDraftStore.setState({ requests: {} });
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

function inlineQuestionCloseButton(container: HTMLElement, requestId: string) {
  const card = container.querySelector<HTMLElement>(
    `[data-pending-user-input-request-id="${requestId}"]`,
  );
  const close = card?.querySelector<HTMLButtonElement>(
    'button[aria-label="Dismiss question without answering"]',
  );
  expect(close, `Expected the inline dismissal for ${requestId}`).toBeTruthy();
  return close!;
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

const WIDTHS = [
  { name: "desktop", viewport: DESKTOP },
  { name: "Pixel 7", viewport: PIXEL_7 },
] as const;

function timelineRows(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>("[data-timeline-row]")];
}

async function refreshThread() {
  await act(async () => {
    fixture.turnItems = [...fixture.turnItems];
    for (const listener of fixture.threadListeners) listener();
  });
}

it.each(WIDTHS)(
  "keeps the full plan and pending questions last through messages and restores their chronological positions at $name width",
  async ({ viewport }) => {
    await using _fixture = await setupDockFixture(viewport, { pending: true });
    await using screen = await mountApp();
    const plan = timelinePlanRow(screen.container);
    const planId = plan.dataset.timelineRow!;
    const pendingIds = () =>
      timelineRows(screen.container)
        .slice(-3)
        .map((row) =>
          row.querySelector("[data-timeline-row-kind]")?.getAttribute("data-timeline-row-kind"),
        );
    await vi.waitFor(() =>
      expect(pendingIds()).toEqual(["factory-plan", "pending-user-input", "pending-user-input"]),
    );
    expect(dockItems(screen.container).map((item) => item.dataset.pinnedActionDockItem)).toEqual([
      "approval",
    ]);
    expect(plan.textContent).toContain("The developer builds with the factory from a thread.");
    expect(plan.querySelector('input[aria-label="Implementer budget"]')).not.toBeNull();
    expect(plan.scrollWidth).toBeLessThanOrEqual(plan.clientWidth);
    await typeTimelineBudget(screen.container, "40");
    const question = screen.container.querySelector<HTMLElement>(
      '[data-pending-user-input-request-id="pinned-dock-message-question"]',
    )!;
    const questionRow = question.closest<HTMLElement>("[data-timeline-row]")!;
    const reply = makeFactoryMessageItem({
      id: "after-pending",
      threadId,
      role: "assistant",
      text: "A reply after the questions",
      createdAt: "2026-10-24T10:06:00.000Z",
    });
    fixture.turnItems = [...fixture.turnItems, reply];
    await refreshThread();
    await vi.waitFor(() =>
      expect(screen.container.textContent).toContain("A reply after the questions"),
    );
    expect(pendingIds()).toEqual(["factory-plan", "pending-user-input", "pending-user-input"]);
    expect(timelinePlanRow(screen.container)).toBe(plan);
    expect(question.closest("[data-timeline-row]")).toBe(questionRow);
    expect(
      plan.querySelector<HTMLInputElement>('input[aria-label="Implementer budget"]')?.value,
    ).toBe("40");
    await act(async () => buttonNamed(plan, "Approve")!.click());
    await vi.waitFor(() => expect(fixture.startTurn).toHaveBeenCalledOnce());
    const sent = fixture.startTurn.mock.calls[0]![0] as { input: { message: { text: string } } };
    fixture.turnItems = [
      ...fixture.turnItems,
      makeFactoryMessageItem({
        id: "approval-message",
        threadId,
        role: "user",
        text: sent.input.message.text,
        createdAt: "2026-10-24T10:07:00.000Z",
      }),
    ];
    await refreshThread();
    await vi.waitFor(() =>
      expect(timelineRows(screen.container)[0]?.dataset.timelineRow).toBe(planId),
    );
    expect(timelinePlanRow(screen.container)).toBe(plan);
    expect(plan.textContent).toContain("Approved");
    expect(sentApproval().routes).toMatchObject({ implementer: { budgetUsd: 40 } });
    const currentQuestion = screen.container.querySelector<HTMLElement>(
      '[data-pending-user-input-request-id="pinned-dock-message-question"]',
    )!;
    const answer = currentQuestion.querySelector<HTMLTextAreaElement>("textarea")!;
    await userEvent.fill(answer, "Update the user docs");
    await act(async () => buttonNamed(currentQuestion, "Submit")!.click());
    await vi.waitFor(() => expect(fixture.respondToUserInput).toHaveBeenCalledOnce());
    fixture.projectionExtras = {
      ...fixture.projectionExtras,
      runtimeRequests: (fixture.projectionExtras.runtimeRequests ?? []).map((request) =>
        request.id === "pinned-dock-message-question"
          ? {
              ...request,
              status: "resolved",
              resolvedAt: DateTime.makeUnsafe("2026-10-24T10:08:00.000Z"),
            }
          : request,
      ),
    };
    fixture.turnItems = fixture.turnItems.map((item) =>
      item.type === "user_input_request" && item.requestId === "pinned-dock-message-question"
        ? {
            ...item,
            questionAnswer: {
              requestId: item.requestId,
              questionTextById: { docs: MESSAGE_QUESTION },
              answers: { docs: "Update the user docs" },
              attachmentsByQuestionId: {},
            },
          }
        : item,
    );
    await refreshThread();
    await vi.waitFor(() =>
      expect(
        screen.container.querySelector(
          '[data-pending-user-input-request-id="pinned-dock-message-question"]',
        ),
      ).toBeNull(),
    );
    const rows = timelineRows(screen.container);
    expect(
      rows
        .at(-1)
        ?.querySelector('[data-pending-user-input-request-id="pinned-dock-live-question"]'),
    ).not.toBeNull();
    const answeredIndex = rows.findIndex((row) =>
      row.textContent?.includes("Update the user docs"),
    );
    const replyIndex = rows.findIndex((row) =>
      row.textContent?.includes("A reply after the questions"),
    );
    expect(answeredIndex).toBeGreaterThan(0);
    expect(answeredIndex).toBeLessThan(replyIndex);
  },
);

it.each(WIDTHS)(
  "the dock leaves the composer input accessible at $name width",
  async ({ viewport }) => {
    await using _fixture = await setupDockFixture(viewport, { pending: true });
    await using screen = await mountApp();
    await vi.waitFor(() => expect(dockItems(screen.container)).toHaveLength(1));
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

it("ignores persisted plan unpins and retains the full plan", async () => {
  await using _fixture = await setupDockFixture();
  localStorage.setItem(
    usePinnedActionDockStore.persist.getOptions().name!,
    JSON.stringify({
      version: 1,
      state: { unpins: { legacy: { planDigests: [FACTORY_PLAN_DIGEST], followUpPlanIds: [] } } },
    }),
  );
  await usePinnedActionDockStore.persist.rehydrate();
  await using screen = await mountApp();
  expect(timelineRows(screen.container).at(-1)).toBe(timelinePlanRow(screen.container));
  expect(dock(screen.container)).toBeNull();
  expect(usePinnedActionDockStore.getState().unpins).toEqual({ legacy: { followUpPlanIds: [] } });
});

it("the full plan Open opens its Factory pane", async () => {
  await using _fixture = await setupDockFixture();
  await using screen = await mountApp();
  const initial = JSON.stringify(useRightPanelStore.getState());
  await act(async () => buttonNamed(timelinePlanRow(screen.container), "Open")!.click());
  expect(JSON.stringify(useRightPanelStore.getState())).not.toBe(initial);
});

it("inline question AC3 the X on a question the provider does not mark dismissible answers it as dismissed", async () => {
  await using _fixture = await setupDockFixture(DESKTOP, { pending: true });
  await using screen = await mountApp();
  const close = await vi.waitFor(() =>
    inlineQuestionCloseButton(screen.container, "pinned-dock-live-question"),
  );
  await act(async () => close.click());
  await vi.waitFor(() => expect(fixture.respondToUserInput).toHaveBeenCalledOnce());
  const sent = fixture.respondToUserInput.mock.calls[0]![0] as {
    input: { requestId: string; answers: Record<string, unknown> };
  };
  expect(sent.input.requestId).toBe("pinned-dock-live-question");
  expect(Object.keys(sent.input.answers).toSorted()).toEqual(["database", "order"]);
  for (const answer of Object.values(sent.input.answers))
    expect(answer).toBe(DISMISSED_QUESTION_ANSWER);
  expect(fixture.dismissUserInput).not.toHaveBeenCalled();
});

it("inline question AC3 the X on a dismissible question goes through the existing dismiss", async () => {
  await using _fixture = await setupDockFixture(DESKTOP, { pending: true });
  await using screen = await mountApp();
  const close = await vi.waitFor(() =>
    inlineQuestionCloseButton(screen.container, "pinned-dock-message-question"),
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

it("the ready-to-close line stays outside the pinned dock and its timeline X clears it", async () => {
  await using _fixture = await setupDockFixture(DESKTOP, {
    agentSignal: {
      kind: "ready_to_close",
      note: null,
      runId: null,
      setAt: "2026-10-24T10:04:00.000Z",
    },
  });
  await using screen = await mountApp();
  const item = screen.container.querySelector<HTMLElement>("[data-thread-agent-signal]")!;
  expect(item).not.toBeNull();
  expect(item.textContent).toContain("The agent thinks this thread is ready to close.");
  await scrollTimeline(screen.container, "top");
  const scroller = timelineScroller(screen.container);
  expect(scroller.contains(item)).toBe(true);
  await vi.waitFor(() =>
    expect(item.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      scroller.getBoundingClientRect().bottom,
    ),
  );
  await scrollTimeline(screen.container, "end");
  expect(
    dockItems(screen.container).map((entry) => entry.dataset.pinnedActionDockItem),
  ).not.toContain("agent-signal");
  await act(async () =>
    item
      .querySelector<HTMLButtonElement>('button[aria-label="Dismiss the agent\'s signal"]')!
      .click(),
  );
  await vi.waitFor(() => expect(fixture.clearAgentSignal).toHaveBeenCalledOnce());
  expect(fixture.clearAgentSignal.mock.calls[0]![0]).toMatchObject({ input: { threadId } });
});

it("phase6 dock browser AC6 at Pixel 7 width the dock expands the two newest items and keeps the input on screen", async () => {
  await using _fixture = await setupDockFixture(PIXEL_7, { pending: true });
  addApproval("newest-approval", "2026-10-24T10:05:00.000Z", "pnpm build");
  addApproval("second-approval", "2026-10-24T10:04:00.000Z", "pnpm install");
  await using screen = await mountApp();
  // Plan follow-ups wait for approvals to clear; three approvals exercise the phone collapse.
  await vi.waitFor(() => expect(dockItems(screen.container)).toHaveLength(3));
  const items = dockItems(screen.container);
  expect(items.map((entry) => entry.dataset.pinnedActionDockItem)).toEqual([
    "approval",
    "approval",
    "approval",
  ]);
  expect(items.map((entry) => entry.dataset.expanded)).toEqual(["true", "true", "false"]);
  const collapsed = items[2]!;
  expect(collapsed.getBoundingClientRect().height).toBeLessThanOrEqual(48);
  // A tap expands a collapsed item; the phone limit of two still holds.
  await userEvent.click(collapsed.querySelector<HTMLElement>("[data-pinned-action-dock-expand]")!);
  await vi.waitFor(() => expect(dockItems(screen.container)[2]!.dataset.expanded).toBe("true"));
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

it("the question shortcut still reveals and focuses the first inline card without a dock Answer button", async () => {
  await using _fixture = await setupDockFixture(DESKTOP, { pending: true });
  await using screen = await mountApp();
  expect(dock(screen.container)?.textContent).not.toContain("Answer");
  expect(dockItems(screen.container).map((entry) => entry.dataset.pinnedActionDockItem)).toEqual([
    "approval",
  ]);
  await scrollTimeline(screen.container, "top");
  const card = screen.container.querySelector<HTMLElement>(
    '[data-pending-user-input-request-id="pinned-dock-live-question"]',
  )!;
  expect(inViewport(card)).toBe(false);
  await act(async () => dispatchPickerAction("question"));
  await vi.waitFor(() => {
    expect(card.contains(document.activeElement)).toBe(true);
    const rect = card.getBoundingClientRect();
    const scroller = timelineScroller(screen.container).getBoundingClientRect();
    expect(rect.bottom > scroller.top && rect.top < scroller.bottom).toBe(true);
  });
  expect(fixture.respondToUserInput).not.toHaveBeenCalled();
});

it("retains route edits and the pending Approve state while the full card leaves the virtualized list", async () => {
  await using _fixture = await setupDockFixture(PIXEL_7, { pending: true });
  await using screen = await mountApp();
  await typeTimelineBudget(screen.container, "40");
  await virtualizeOutTimelinePlanRow(screen.container);
  fixture.hiddenRows.clear();
  await refreshThread();
  let card = await vi.waitFor(() => timelinePlanRow(screen.container));
  expect(
    card.querySelector<HTMLInputElement>('input[aria-label="Implementer budget"]')?.value,
  ).toBe("40");
  await act(async () => buttonNamed(card, "Approve")!.click());
  await vi.waitFor(() => expect(fixture.startTurn).toHaveBeenCalledOnce());
  await virtualizeOutTimelinePlanRow(screen.container);
  fixture.hiddenRows.clear();
  await refreshThread();
  card = await vi.waitFor(() => timelinePlanRow(screen.container));
  expect(buttonNamed(card, "Approve")?.disabled).toBe(true);
  await act(async () => buttonNamed(card, "Approve")!.click());
  expect(fixture.startTurn).toHaveBeenCalledOnce();
  expect(sentApproval().routes).toMatchObject({ implementer: { budgetUsd: 40 } });
});

it("inline question P1-4 the X dismisses a question whose draft still prepares an attachment", async () => {
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
  const close = await vi.waitFor(() =>
    inlineQuestionCloseButton(screen.container, "pinned-dock-live-question"),
  );
  await act(async () => close.click());
  await vi.waitFor(() => expect(fixture.respondToUserInput).toHaveBeenCalledOnce());
  const sent = fixture.respondToUserInput.mock.calls[0]![0] as {
    input: { requestId: string; answers: Record<string, unknown> };
  };
  expect(sent.input.requestId).toBe("pinned-dock-live-question");
  expect(sent.input).not.toHaveProperty("attachmentsByQuestionId");
});

it("inline question P1-4 a dismissal the server refuses shows an error", async () => {
  await using _fixture = await setupDockFixture(DESKTOP, { pending: true });
  fixture.respondToUserInput.mockImplementationOnce(
    async () => AsyncResult.failure(Cause.fail(new Error("the provider is gone"))) as never,
  );
  await using screen = await mountApp();
  const close = await vi.waitFor(() =>
    inlineQuestionCloseButton(screen.container, "pinned-dock-live-question"),
  );
  await act(async () => close.click());
  const card = close.closest("section")!;
  await vi.waitFor(() =>
    expect(card.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not dismiss the request. Try again.",
    ),
  );
  expect(close.disabled).toBe(false);
  expect(screen.container.textContent).toContain(
    "Could not dismiss the question: the provider is gone",
  );
});

it("inline question P1-4 a refused dismissible request keeps its card and shows the dismissal error", async () => {
  await using _fixture = await setupDockFixture(DESKTOP, { pending: true });
  fixture.dismissUserInput.mockImplementationOnce(
    async () => AsyncResult.failure(Cause.fail(new Error("dismissal refused"))) as never,
  );
  await using screen = await mountApp();
  const close = inlineQuestionCloseButton(screen.container, "pinned-dock-message-question");
  await act(async () => close.click());
  await vi.waitFor(() =>
    expect(close.closest("section")?.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not dismiss the request. Try again.",
    ),
  );
  expect(close.disabled).toBe(false);
  expect(fixture.respondToUserInput).not.toHaveBeenCalled();
});

it.each(["live", "message"] as const)(
  "the inline %s question X stays disabled while its dismissal is in flight",
  async (kind) => {
    await using _fixture = await setupDockFixture(DESKTOP, { pending: true });
    const result = createDeferredPromise<{ _tag: string; value: undefined }>();
    const command = kind === "live" ? fixture.respondToUserInput : fixture.dismissUserInput;
    command.mockImplementationOnce(() => result.promise);
    await using screen = await mountApp();
    const close = inlineQuestionCloseButton(screen.container, `pinned-dock-${kind}-question`);
    try {
      await act(async () => close.click());
      await vi.waitFor(() => expect(command).toHaveBeenCalledOnce());
      expect(close.disabled).toBe(true);
      await act(async () => close.click());
      expect(command).toHaveBeenCalledOnce();
    } finally {
      await act(async () => result.resolve({ _tag: "Success", value: undefined }));
    }
    await vi.waitFor(() => expect(close.disabled).toBe(false));
  },
);

it("every inline question X stays disabled while the environment is unavailable", async () => {
  await using _fixture = await setupDockFixture(DESKTOP, { pending: true });
  const environment = fixture.environments[0]!;
  environment.connection.phase = "reconnecting";
  await using _connection = {
    [Symbol.asyncDispose]: async () => {
      environment.connection.phase = "connected";
    },
  };
  await using screen = await mountApp();
  for (const kind of ["live", "message"]) {
    const close = inlineQuestionCloseButton(screen.container, `pinned-dock-${kind}-question`);
    expect(close.disabled).toBe(true);
    await act(async () => close.click());
  }
  expect(fixture.dismissUserInput).not.toHaveBeenCalled();
  expect(fixture.respondToUserInput).not.toHaveBeenCalled();
});

it("the dock stays absent when only questions are pending", async () => {
  await using _fixture = await setupDockFixture(DESKTOP, { pending: true });
  fixture.projectionExtras = {
    ...fixture.projectionExtras,
    runtimeRequests: (fixture.projectionExtras.runtimeRequests ?? []).filter(
      (request) => request.kind === "user_input",
    ),
  };
  fixture.turnItems = fixture.turnItems.filter((item) => item.type !== "approval_request");
  await using screen = await mountApp();
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll("[data-pending-user-input-request-id]")).toHaveLength(
      2,
    ),
  );
  expect(dock(screen.container)).toBeNull();
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
