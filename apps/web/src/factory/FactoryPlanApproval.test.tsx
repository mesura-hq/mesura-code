// @vitest-environment happy-dom
/**
 * Phase 4 fence on the web: acceptance criteria 1 and 3–7, through the plan
 * card's route rows and its Approve button.
 *
 * Entry point: AppRoot with its memory router and the real ChatView,
 * MessagesTimeline and FactoryPlanCard, as `AppRoot.inlinePendingUserInput`
 * mounts them. The thread, its environment's provider list and the stored plan
 * body are fixtures; `threadEnvironment.startTurn` is a spy, so the sent turn
 * is read from its input. What only a browser shows: the Select popups'
 * placement, and the card's layout on a narrow pane.
 */
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
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  FACTORY_DEFAULT_TEST_ROUTES,
  FACTORY_OTHER_PLAN_DIGEST,
  FACTORY_PLAN_DIGEST,
  FACTORY_REVISED_PLAN_DIGEST,
  makeFactoryPlanActivity,
  makeFactoryPlanPayload,
  makeFactoryRouteProviders,
  readFactoryApprovalMessage,
  writeFactoryApprovalMessage,
} from "@t3tools/client-runtime/factory/testing";
import type { Thread } from "../types";
import type { AppRouter } from "../router";

const fixture = vi.hoisted(() => ({
  thread: null as Thread | null,
  commands: new Map<unknown, unknown>(),
  noopCommand: vi.fn(async () => ({ _tag: "Success", value: undefined })),
  startTurn: vi.fn(async (_input: unknown) => ({ _tag: "Success", value: undefined })),
  refresh: vi.fn(),
  empty: [],
  threadListeners: new Set<() => void>(),
  factorySnapshots: {} as Record<string, string>,
  factorySnapshotAtoms: new Map<string, unknown>(),
  environments: [
    {
      environmentId: "factory-approval-environment",
      label: "Factory approval environment",
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
      id: "factory-approval-project",
      environmentId: "factory-approval-environment",
      title: "Factory approval",
      workspaceRoot: "/tmp/factory-approval",
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
import { threadEnvironment } from "../state/threads";
import { useComposerDraftStore } from "../composerDraftStore";
import { useQueuedMessageStore } from "../queuedMessageStore";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";

const environmentId = EnvironmentId.make("factory-approval-environment");
const threadId = ThreadId.make("factory-approval-thread");
const now = "2026-09-28T10:00:00.000Z";
const PLAN_TITLE = "Plan: the Software Factory inside Mesura Code";
const PLAN_MARKDOWN = `# ${PLAN_TITLE}\n\n## Context\n\nThe developer builds with the factory from a thread.\n`;
const plan = makeFactoryPlanPayload();
const threadModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-fable-5-1",
};
let root: Root | undefined;
let container: HTMLDivElement;

// A workspace snapshot for the project's folder, so the composer does not ask
// the server to refresh its provider list.
// New environment objects, as `useEnvironments` hands out on every change:
// the React compiler memoizes on their identity, so mutating in place would
// never reach the card.
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
            { cwd: "/tmp/factory-approval", checkedAt: now, skills: [], slashCommands: [] },
          ],
        })),
      },
    },
  ];
}

function setThreadMessages(texts: ReadonlyArray<string>) {
  fixture.thread = {
    ...fixture.thread!,
    messages: texts.map((text, index) => ({
      id: MessageId.make(`factory-approval-message-${index}`),
      role: "user" as const,
      text,
      turnId: null,
      streaming: false,
      createdAt: now,
      updatedAt: now,
    })),
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.startTurn.mockClear();
  fixture.commands.set(threadEnvironment.startTurn, fixture.startTurn);
  fixture.factorySnapshots = { [FACTORY_PLAN_DIGEST]: PLAN_MARKDOWN };
  fixture.factorySnapshotAtoms.clear();
  setProviders(makeFactoryRouteProviders());
  fixture.thread = {
    id: threadId,
    environmentId,
    projectId: ProjectId.make("factory-approval-project"),
    title: "Factory approval",
    modelSelection: threadModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
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
    activities: [makeFactoryPlanActivity({ id: "factory-plan:plan-md", createdAt: now })],
  } as Thread;
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  useComposerDraftStore.getState().clearComposerContent(scopeThreadRef(environmentId, threadId));
  useQueuedMessageStore.getState().drain(scopedThreadKey(scopeThreadRef(environmentId, threadId)));
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

/** The plan card's own timeline row. */
function planRow(): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>("[data-timeline-row]")].find((entry) =>
    entry.textContent?.includes(PLAN_TITLE),
  );
  expect(row, `Expected the plan card's row; rendered: ${container.textContent}`).toBeDefined();
  return row!;
}

function combobox(label: string): HTMLElement | null {
  return planRow().querySelector<HTMLElement>(`[role="combobox"][aria-label="${label}"]`);
}

function requireCombobox(label: string): HTMLElement {
  const match = combobox(label);
  expect(match, `Expected the ${label} select; card: ${planRow().textContent}`).not.toBeNull();
  return match!;
}

function approveButton(): HTMLButtonElement | undefined {
  return [...planRow().querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent?.trim() === "Approve",
  );
}

function budgetInput(): HTMLInputElement | null {
  return planRow().querySelector<HTMLInputElement>('input[aria-label="Implementer budget"]');
}

/** The option labels a select offers, read while it is open, then closed again. */
async function readOptions(label: string): Promise<string[]> {
  const trigger = requireCombobox(label);
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
  });
  const listboxes = [...document.querySelectorAll<HTMLElement>('[role="listbox"]')];
  const controlled = trigger.getAttribute("aria-controls");
  const listbox =
    (controlled ? document.getElementById(controlled) : null) ?? listboxes[listboxes.length - 1];
  expect(listbox, `Expected ${label} to open a list`).toBeDefined();
  const labels = [...listbox!.querySelectorAll('[role="option"]')].map(
    (option) => option.textContent?.trim() ?? "",
  );
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
  });
  return labels;
}

async function choose(label: string, optionText: string) {
  const trigger = requireCombobox(label);
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
  });
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (entry) => entry.textContent?.trim() === optionText,
  );
  expect(option, `Expected ${label} to offer ${optionText}`).toBeDefined();
  await act(async () => {
    option!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function typeBudget(value: string) {
  const input = budgetInput();
  expect(input, "Expected the Implementer budget input").not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    input!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function approve() {
  const button = approveButton();
  expect(button, `Expected Approve; card: ${planRow().textContent}`).toBeDefined();
  expect(button!.disabled).toBe(false);
  await act(async () => button!.click());
  await vi.waitFor(() => expect(fixture.startTurn).toHaveBeenCalledOnce());
  return fixture.startTurn.mock.calls[0]![0] as {
    environmentId: string;
    input: {
      threadId: string;
      message: { role: string; text: string };
      modelSelection?: unknown;
      runtimeMode?: string;
      sourceProposedPlan?: unknown;
    };
  };
}

const isClaude = (label: string) => label.startsWith("Claude");
const isCodex = (label: string) => label.startsWith("GPT");

it("phase4 web AC1 ends the plan card with implementer, reviewer and verifier rows showing the defaults", async () => {
  await mountApp();
  const row = planRow();
  const lastPhaseLine = [...row.querySelectorAll("li")].find((entry) =>
    entry.textContent?.includes("Render the plan card and the Factory pane on the web"),
  );
  expect(lastPhaseLine).toBeDefined();
  const rows = ["Implementer", "Reviewer", "Verifier"].map((role) => ({
    role,
    model: requireCombobox(`${role} model`),
    level: requireCombobox(`${role} reasoning`),
  }));
  let previous: Element = lastPhaseLine!;
  for (const entry of rows) {
    expect(
      previous.compareDocumentPosition(entry.model) & Node.DOCUMENT_POSITION_FOLLOWING,
      `${entry.role} comes after what precedes it`,
    ).toBeTruthy();
    expect(row.textContent).toContain(entry.role);
    previous = entry.level;
  }
  // Criterion 2 through the card: newest Opus at high, Sol at high, Luna at max.
  expect(rows.map((entry) => entry.model.textContent?.trim())).toEqual([
    "Claude Opus 5.5",
    "GPT-6 Sol",
    "GPT-6 Luna",
  ]);
  expect(rows.map((entry) => entry.level.textContent?.trim())).toEqual(["High", "High", "Max"]);
  expect(approveButton()?.disabled).toBe(false);
});

it("phase4 web AC3 gives a Claude implementer an editable 25 dollar budget and sends the edited amount", async () => {
  await mountApp();
  expect(budgetInput()?.value).toBe("25");
  await typeBudget("40");
  const sent = await approve();
  expect(readFactoryApprovalMessage(sent.input.message.text).routes).toEqual({
    ...FACTORY_DEFAULT_TEST_ROUTES,
    implementer: { ...FACTORY_DEFAULT_TEST_ROUTES.implementer, budgetUsd: 40 },
  });
});

it("phase4 web AC3 drops the budget when the implementer runs on Codex", async () => {
  await mountApp();
  await choose("Implementer model", "GPT-6 Sol");
  expect(budgetInput()).toBeNull();
  const sent = await approve();
  const routes = readFactoryApprovalMessage(sent.input.message.text).routes as {
    implementer: Record<string, unknown>;
  };
  expect(routes.implementer).toMatchObject({ harness: "codex", model: "gpt-6-sol" });
  expect(routes.implementer).not.toHaveProperty("budgetUsd");
});

it("phase4 web AC4 offers the verifier Codex models only and the reviewer the other family", async () => {
  await mountApp();
  const verifier = await readOptions("Verifier model");
  expect(verifier.length).toBeGreaterThan(0);
  expect(verifier.every(isCodex), verifier.join(", ")).toBe(true);
  const reviewer = await readOptions("Reviewer model");
  expect(reviewer.length).toBeGreaterThan(0);
  expect(reviewer.every(isCodex), reviewer.join(", ")).toBe(true);
  const implementer = await readOptions("Implementer model");
  expect(implementer.some(isClaude) && implementer.some(isCodex)).toBe(true);
});

it("phase4 web AC4 moves the reviewer to Claude's default when the implementer switches to Codex", async () => {
  await mountApp();
  await choose("Implementer model", "GPT-6 Sol");
  expect(requireCombobox("Reviewer model").textContent?.trim()).toBe("Claude Opus 5.5");
  expect(requireCombobox("Reviewer reasoning").textContent?.trim()).toBe("High");
  const reviewer = await readOptions("Reviewer model");
  expect(reviewer.length).toBeGreaterThan(0);
  expect(reviewer.every(isClaude), reviewer.join(", ")).toBe(true);
  const verifier = await readOptions("Verifier model");
  expect(verifier.every(isCodex), verifier.join(", ")).toBe(true);
});

it("phase4 web AC5 shows a role without a model as unavailable with the reason and keeps Approve disabled", async () => {
  setProviders(
    makeFactoryRouteProviders({
      codex: [
        { slug: "gpt-6-sol", name: "GPT-6 Sol" },
        { slug: "gpt-6-astra", name: "GPT-6 Astra" },
      ],
    }),
  );
  await mountApp();
  const text = planRow().textContent ?? "";
  expect(text).toMatch(/unavailable/i);
  expect(text).toMatch(/luna/i);
  expect(approveButton()?.disabled).toBe(true);
  await act(async () => approveButton()?.click());
  expect(fixture.startTurn).not.toHaveBeenCalled();
});

it("phase4 web AC6 sends one approval turn with the digest line, the routes block and the thread's model", async () => {
  await mountApp();
  const sent = await approve();
  expect(sent.environmentId).toBe(environmentId);
  expect(sent.input.threadId).toBe(threadId);
  expect(sent.input.message.role).toBe("user");
  const message = readFactoryApprovalMessage(sent.input.message.text);
  expect(message.firstLine).toBe(`Approve plan sha256:${FACTORY_PLAN_DIGEST}`);
  expect(sent.input.message.text).toContain(`Plan: ${plan.planPath}`);
  expect(sent.input.message.text).toContain(`Intent: ${plan.intentPath}`);
  expect(message.routes).toEqual(FACTORY_DEFAULT_TEST_ROUTES);
  expect(sent.input.modelSelection).toEqual(threadModelSelection);
  expect(sent.input.runtimeMode).toBe("full-access");
  expect(sent.input).not.toHaveProperty("sourceProposedPlan");
});

const approvedRoutes = {
  ...FACTORY_DEFAULT_TEST_ROUTES,
  reviewer: { harness: "codex" as const, model: "gpt-6-astra", effort: "xhigh" },
};

it("phase4 web AC7 shows the approved routes read-only and hides Approve for the approved digest", async () => {
  setThreadMessages([
    writeFactoryApprovalMessage({
      digest: FACTORY_PLAN_DIGEST,
      planPath: plan.planPath,
      intentPath: plan.intentPath,
      routes: approvedRoutes,
    }),
  ]);
  await mountApp();
  expect(approveButton()).toBeUndefined();
  expect(planRow().querySelectorAll('[role="combobox"]')).toHaveLength(0);
  expect(budgetInput()).toBeNull();
  const text = planRow().textContent ?? "";
  expect(text).toMatch(/GPT-6 Astra|gpt-6-astra/);
  expect(text).toMatch(/Extra High|xhigh/i);
  expect(text).not.toContain("Changed since approval");
});

it("phase4 web AC7 reads Changed since approval with editable rows when the plan changed after approval", async () => {
  setThreadMessages([
    writeFactoryApprovalMessage({
      digest: FACTORY_REVISED_PLAN_DIGEST,
      planPath: plan.planPath,
      intentPath: plan.intentPath,
      routes: approvedRoutes,
    }),
  ]);
  await mountApp();
  expect(planRow().textContent).toContain("Changed since approval");
  expect(requireCombobox("Implementer model")).not.toBeNull();
  expect(approveButton()?.disabled).toBe(false);
});

it("phase4 web AC7 ignores an approval of another plan file", async () => {
  setThreadMessages([
    writeFactoryApprovalMessage({
      digest: FACTORY_OTHER_PLAN_DIGEST,
      planPath: "/home/dev/plans/another-feature/plan.md",
      intentPath: "/home/dev/plans/another-feature/intent.md",
      routes: approvedRoutes,
    }),
  ]);
  await mountApp();
  expect(planRow().textContent).not.toContain("Changed since approval");
  expect(requireCombobox("Implementer model")).not.toBeNull();
  expect(approveButton()?.disabled).toBe(false);
});

it("phase4 web guard keeps the plan card's title, context, phase lines and Open", async () => {
  await mountApp();
  const row = planRow();
  expect(row.textContent).toContain(PLAN_TITLE);
  expect(row.textContent).toContain("The developer builds with the factory from a thread.");
  expect(row.textContent).toContain("Snapshot a plan and present it to the thread · 7 criteria");
  expect(
    [...row.querySelectorAll("button")].some((entry) => entry.textContent?.trim() === "Open"),
  ).toBe(true);
  expect(fixture.startTurn).not.toHaveBeenCalled();
});

it("phase4 web guard sends the composer's own message beside a plan card", async () => {
  const target = scopeThreadRef(environmentId, threadId);
  useComposerDraftStore.getState().setPrompt(target, "A normal follow-up");
  await mountApp();
  const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
  expect(send).not.toBeNull();
  await act(async () => send!.click());
  const queued = useQueuedMessageStore.getState().queuesByThreadKey[scopedThreadKey(target)] ?? [];
  const sentTexts = [
    ...fixture.startTurn.mock.calls.map(
      (call) => (call[0] as { input: { message: { text: string } } }).input.message.text,
    ),
    ...queued.map((entry) => JSON.stringify(entry)),
  ];
  expect(sentTexts.some((text) => text.includes("A normal follow-up"))).toBe(true);
  expect(sentTexts.some((text) => text.includes("Approve plan sha256:"))).toBe(false);
});

it("phase4 web decision 4 shows an approval without routes as approved with sf-team choosing them", async () => {
  setThreadMessages([
    `Approve plan sha256:${FACTORY_PLAN_DIGEST}\nPlan: ${plan.planPath}\nBuild it with sf-team.`,
  ]);
  await mountApp();
  expect(approveButton()).toBeUndefined();
  expect(planRow().querySelectorAll('[role="combobox"]')).toHaveLength(0);
  expect(planRow().textContent).toMatch(/routes chosen by sf-team/i);
});

it("phase4 web decision 5 keeps Approve disabled while its turn is sent and after it went out", async () => {
  let release: (value: { _tag: string; value: undefined }) => void = () => undefined;
  fixture.startTurn.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await mountApp();
  const button = approveButton()!;
  await act(async () => button.click());
  expect(fixture.startTurn).toHaveBeenCalledOnce();
  expect(approveButton()?.disabled).toBe(true);
  await act(async () => approveButton()!.click());
  expect(fixture.startTurn).toHaveBeenCalledOnce();
  await act(async () => release({ _tag: "Success", value: undefined }));
  expect(approveButton()?.disabled).toBe(true);
});

it("phase4 web decision 5 enables Approve again when the turn could not be sent", async () => {
  fixture.startTurn.mockImplementationOnce(async () => ({ _tag: "Failure", value: undefined }));
  await mountApp();
  await act(async () => approveButton()!.click());
  await vi.waitFor(() => expect(approveButton()?.disabled).toBe(false));
  expect(fixture.startTurn).toHaveBeenCalledOnce();
});

it("phase4 web P1-1 disables Approve when an edited route's provider is turned off", async () => {
  await mountApp();
  await choose("Reviewer model", "GPT-6 Astra");
  expect(approveButton()?.disabled).toBe(false);
  setProviders(makeFactoryRouteProviders({ codexProvider: { enabled: false } }));
  await act(async () => {
    fixture.thread = { ...fixture.thread! };
    for (const listener of fixture.threadListeners) listener();
  });
  expect(planRow().textContent).toMatch(/Codex is turned off/);
  expect(approveButton()?.disabled).toBe(true);
  await act(async () => approveButton()?.click());
  expect(fixture.startTurn).not.toHaveBeenCalled();
});

it("phase4 web P1-4 says an approval's unreadable routes block could not be read", async () => {
  setThreadMessages([
    [
      `Approve plan sha256:${FACTORY_PLAN_DIGEST}`,
      `Plan: ${plan.planPath}`,
      "Build it with sf-team in this thread, with these routes:",
      "```json",
      "{ not json",
      "```",
    ].join("\n"),
  ]);
  await mountApp();
  expect(approveButton()).toBeUndefined();
  expect(planRow().textContent).toContain("The approval's routes block could not be read.");
});
