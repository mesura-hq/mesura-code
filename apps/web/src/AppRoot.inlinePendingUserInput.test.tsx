// @vitest-environment happy-dom
/**
 * Entry point: AppRoot with its memory router, real ChatView, MessagesTimeline,
 * and ChatComposer. Environment reads and RPC commands use the phase fixture.
 */
import { dispatchPickerAction } from "./lib/pickerActionBus";

import { SymmetriaDictationSessionId } from "@symmetria/broker-contract";
import { act, useSyncExternalStore, type ReactNode, type ComponentProps } from "react";
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
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  EventId,
  ApprovalRequestId,
  CommandId,
  MessageId,
} from "@t3tools/contracts";
import type { Thread } from "./types";
import type { AppRouter } from "./router";

const fixture = vi.hoisted(() => ({
  markdownRenders: 0,
  pendingRowsVisible: true,
  savedThreads: new Map<string, Thread>(),
  thread: null as Thread | null,
  commands: new Map<unknown, unknown>(),
  noopCommand: vi.fn(async () => ({ _tag: "Success", value: undefined })),
  dismiss: vi.fn(async () => ({ _tag: "Success", value: undefined })),
  respond: vi.fn(async () => ({ _tag: "Success", value: undefined })),
  startTurn: vi.fn(async () => ({ _tag: "Success", value: undefined })),
  refresh: vi.fn(),
  empty: [],
  threadListeners: new Set<() => void>(),
  environments: [
    {
      environmentId: "phase-two-environment",
      label: "Fence environment",
      connection: { phase: "connected" },
      serverConfig: {
        environment: {
          capabilities: {
            questionAttachments: true,
            attachmentUploads: true,
            fileAttachments: { maxUploadBytes: 1048576 },
          },
        },
        providers: [
          {
            instanceId: "codex",
            driver: "codex",
            enabled: true,
            installed: true,
            workspaceSnapshots: [{ cwd: "/tmp/question-fence", skills: [], slashCommands: [] }],
            status: "ready",
            version: null,
            auth: { status: "authenticated" },
            checkedAt: "2026-09-22T12:00:00.000Z",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ],
      },
    },
  ],
}));

vi.mock("./components/ChatMarkdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./components/ChatMarkdown")>();
  return {
    ...actual,
    default: (props: ComponentProps<typeof actual.default>) => {
      fixture.markdownRenders += 1;
      return <actual.default {...props} />;
    },
  };
});
vi.mock("./state/entities", async (importOriginal) => {
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
    ...(await importOriginal<typeof import("./state/entities")>()),
    useThread: useFixtureThread,
    readThread: (ref: { environmentId: string; threadId: string }) =>
      fixture.thread?.id === ref.threadId && fixture.thread.environmentId === ref.environmentId
        ? fixture.thread
        : (fixture.savedThreads.get(JSON.stringify([ref.environmentId, ref.threadId])) ?? null),
    useThreadShell: useFixtureThread,
    useThreadRefs: () => fixture.empty,
    useProjects: () => fixture.empty,
    useProject: () => ({
      id: "phase-two-project",
      environmentId: "phase-two-environment",
      title: "Question fence",
      workspaceRoot: "/tmp/question-fence",
      scripts: [],
      createdAt: "2026-09-22T12:00:00.000Z",
      defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" },
    }),
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
    refresh: fixture.refresh,
  }),
}));
vi.mock("./state/threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state/threads")>();
  const { EMPTY_ENVIRONMENT_THREAD_STATE } = await import("@t3tools/client-runtime/state/threads");
  return { ...actual, useEnvironmentThread: () => EMPTY_ENVIRONMENT_THREAD_STATE };
});
vi.mock("./state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => fixture.commands.get(command) ?? fixture.noopCommand,
}));
vi.mock("./state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => fixture.noopCommand }));
vi.mock("./hooks/useSettings", async (importOriginal) => {
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts/settings");
  const settings = { ...DEFAULT_CLIENT_SETTINGS, ...DEFAULT_SERVER_SETTINGS };
  return {
    ...(await importOriginal<typeof import("./hooks/useSettings")>()),
    useEnvironmentSettings: () => settings,
    useClientSettings: (select?: (value: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
      select ? select(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS,
    useClientSettingsHydrated: () => true,
  };
});
vi.mock("./hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => fixture.noopCommand }));
vi.mock("./hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    settleThread: fixture.noopCommand,
    pinThread: fixture.noopCommand,
    confirmAndUnpinThread: fixture.noopCommand,
  }),
}));
vi.mock("./components/preview/PreviewAutomationHosts", () => ({
  PreviewAutomationHosts: () => null,
}));
vi.mock("./browser/ElectronBrowserHost", () => ({ ElectronBrowserHost: () => null }));
vi.mock("./components/QuitHoldOverlay", () => ({ QuitHoldOverlay: () => null }));
vi.mock("./components/chat/ChatHeader", () => ({ ChatHeader: () => null }));
vi.mock("./components/BranchToolbar", () => ({ BranchToolbar: () => null }));

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
  }) => {
    const pendingRowsVisible = useSyncExternalStore(
      (listener) => {
        fixture.threadListeners.add(listener);
        return () => {
          fixture.threadListeners.delete(listener);
        };
      },
      () => fixture.pendingRowsVisible,
    );
    return (
      <div>
        {ListHeaderComponent}
        {data
          .filter((item) => pendingRowsVisible || !item.id.startsWith("pending-user-input:"))
          .map((item) => (
            <div key={item.id}>{renderItem({ item })}</div>
          ))}
        {ListFooterComponent}
      </div>
    );
  },
}));
import {
  pendingUserInputRequestKey,
  usePendingUserInputDraftStore,
} from "./pendingUserInputDraftStore";

import { AppRoot } from "./AppRoot";
import ChatView from "./components/ChatView";
import { SidebarProvider } from "./components/ui/sidebar";
import { threadEnvironment } from "./state/threads";
import { useComposerDraftStore } from "./composerDraftStore";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { questionAttachmentDraftId, useQuestionAttachmentPreparation } from "./questionAttachments";
import * as attachmentUploads from "./lib/attachmentUploadQueue";
import { dictationCoordinator } from "./symmetria/dictationCoordinator";
import { useQueuedMessageStore } from "./queuedMessageStore";

const environmentId = EnvironmentId.make("phase-two-environment");
const threadId = ThreadId.make("phase-two-thread");
const requestId = "phase-two-request";
const now = "2026-09-22T12:00:00.000Z";
let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  fixture.pendingRowsVisible = true;
  fixture.savedThreads.clear();
  dictationCoordinator.restoreSession(null);
  usePendingUserInputDraftStore.setState({ requests: {} });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.environments[0]!.connection.phase = "connected";
  fixture.respond.mockReset();
  fixture.respond.mockResolvedValue({ _tag: "Success", value: undefined });
  fixture.startTurn.mockClear();
  fixture.dismiss.mockReset();
  fixture.dismiss.mockResolvedValue({ _tag: "Success", value: undefined });
  fixture.commands.set(threadEnvironment.dismissUserInput, fixture.dismiss);
  fixture.commands.set(threadEnvironment.respondToUserInput, fixture.respond);
  fixture.commands.set(threadEnvironment.startTurn, fixture.startTurn);
  fixture.thread = {
    id: threadId,
    environmentId,
    projectId: ProjectId.make("phase-two-project"),
    title: "Question fence",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
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
    activities: [
      {
        id: EventId.make("phase-two-requested"),
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        turnId: null,
        createdAt: now,
        payload: {
          requestId,
          questions: [
            {
              id: "scope",
              header: "Scope",
              question: "Which scope first?",
              multiSelect: true,
              options: [{ label: "Workspace", description: "Current workspace" }],
            },
            {
              id: "timing",
              header: "Timing",
              question: "When should it run?",
              multiSelect: true,
              options: [{ label: "Now", description: "Run now" }],
            },
          ],
        },
      },
    ],
  };
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  useComposerDraftStore.getState().clearComposerContent(scopeThreadRef(environmentId, threadId));
  useQuestionAttachmentPreparation.setState({ counts: {} });
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

function button(text: string) {
  const match = [...container.querySelectorAll("button")].find((entry) =>
    entry.textContent?.includes(text),
  );
  expect(match, `Expected button ${text}; rendered: ${container.textContent}`).toBeDefined();
  return match!;
}

function questionField(questionId: string) {
  return container.querySelector<HTMLTextAreaElement>(
    `[data-question-id="${questionId}"] textarea`,
  );
}

it("phase two inline card shows every pending question in one conversation row", async () => {
  await mountApp();
  const cards = container.querySelectorAll(
    '[data-pending-user-input-request-id="phase-two-request"]',
  );
  expect(cards).toHaveLength(1);
  expect(cards[0]?.textContent).toContain("Which scope first?");
  expect(cards[0]?.textContent).toContain("When should it run?");
  expect(cards[0]?.textContent).toContain("Workspace");
  expect(cards[0]?.textContent).toContain("Now");
  expect(questionField("scope")).not.toBeNull();
  expect(questionField("timing")).not.toBeNull();
});

it("phase two incomplete inline request focuses its missing question and retains both drafts", async () => {
  await mountApp();
  await act(async () => button("Workspace").click());
  await act(async () => button("Submit").click());
  expect(fixture.respond).not.toHaveBeenCalled();
  expect(questionField("timing")).toBe(document.activeElement);
  expect(questionField("scope")?.disabled).toBe(false);
  expect(questionField("timing")?.disabled).toBe(false);
});

it("phase two pending row survives a thread refresh and remains outside collapsed work", async () => {
  await mountApp();
  await act(async () => {
    fixture.thread = { ...fixture.thread!, activities: [...fixture.thread!.activities] };
    for (const listener of fixture.threadListeners) listener();
  });
  expect(
    container.querySelectorAll('[data-pending-user-input-request-id="phase-two-request"]'),
  ).toHaveLength(1);
});

it("phase two normal composer keeps its own message draft during a pending request", async () => {
  const target = scopeThreadRef(environmentId, threadId);
  useComposerDraftStore.getState().setPrompt(target, "A separate normal message");
  await mountApp();
  expect(questionField("scope")).not.toBeNull();
  expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
    "A separate normal message",
  );
  expect(container.querySelector("[data-normal-composer]")?.textContent).toContain(
    "A separate normal message",
  );
  const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
  expect(send).not.toBeNull();
  await act(async () => send!.click());
  const queued = useQueuedMessageStore.getState().queuesByThreadKey[scopedThreadKey(target)] ?? [];
  expect(fixture.startTurn.mock.calls.length + queued.length).toBeGreaterThan(0);
  expect(fixture.respond).not.toHaveBeenCalled();
});

it("phase two dictation targets a focused question without submitting the request", async () => {
  await mountApp();
  const field = questionField("timing");
  expect(field).not.toBeNull();
  await act(async () => field!.focus());
  const protocolVersion = { major: 1 as const, minor: 2 };
  const reservation = await dictationCoordinator.reserve({
    protocolVersion,
    sessionId: SymmetriaDictationSessionId.make("inline-question-dictation"),
    commandId: CommandId.make("reserve-inline"),
    createdAt: now,
    source: "shell",
  });
  await act(async () => questionField("scope")!.focus());
  let outcome: string | undefined;
  await act(async () => {
    const receipt = await dictationCoordinator.deliver({
      type: "dictation.deliver",
      protocolVersion,
      sessionId: SymmetriaDictationSessionId.make("inline-question-dictation"),
      commandId: CommandId.make("deliver-inline"),
      createdAt: now,
      target: reservation.target,
      mode: "submit",
      text: "Tomorrow morning",
    });
    outcome = receipt.outcome;
  });
  expect(outcome).toBe("inserted");
  expect(questionField("timing")?.value).toBe("[voiced] Tomorrow morning");
  expect(questionField("scope")?.value).toBe("");
  expect(fixture.respond).not.toHaveBeenCalled();
  expect(fixture.startTurn).not.toHaveBeenCalled();
});

it("phase two per-question upload state appears beside its own text field", async () => {
  const key = questionAttachmentDraftId(
    environmentId,
    threadId,
    ApprovalRequestId.make(requestId),
    "timing",
  );
  useQuestionAttachmentPreparation.setState({ counts: { [key]: 1 } });
  await mountApp();
  const field = questionField("timing");
  expect(field).not.toBeNull();
  expect(field?.parentElement?.textContent).toMatch(/upload|prepar/i);
});

it("phase two failed answer retains an inline retry and resolved request keeps history", async () => {
  fixture.respond.mockRejectedValue(new Error("Provider refused"));
  await mountApp();
  await act(async () => button("Workspace").click());
  await act(async () => button("Now").click());
  await act(async () => button("Submit").click());
  expect(
    container.querySelector('[data-pending-user-input-request-id="phase-two-request"]'),
  ).not.toBeNull();
  fixture.respond.mockResolvedValue({ _tag: "Success", value: undefined });
  await act(async () => button("Retry").click());
  expect(fixture.respond).toHaveBeenCalledTimes(2);
  await act(async () => {
    fixture.thread = {
      ...fixture.thread!,
      activities: [
        ...fixture.thread!.activities,
        {
          id: EventId.make("phase-two-answer-submitted"),
          kind: "user-input.answer-submitted",
          summary: "User input submitted",
          tone: "info",
          turnId: null,
          createdAt: "2026-09-22T12:00:01.000Z",
          payload: {
            requestId,
            questionTextById: { scope: "Which scope first?", timing: "When should it run?" },
            answers: { scope: ["Workspace"], timing: ["Now"] },
            attachmentsByQuestionId: {},
          },
        },
        {
          id: EventId.make("phase-two-resolved"),
          kind: "user-input.resolved",
          summary: "User input resolved",
          tone: "info",
          turnId: null,
          createdAt: "2026-09-22T12:00:02.000Z",
          payload: { requestId },
        },
      ],
    };
    for (const listener of fixture.threadListeners) listener();
  });
  expect(
    container.querySelector('[data-pending-user-input-request-id="phase-two-request"]'),
  ).toBeNull();
  expect(container.textContent).toContain("Workspace");
});

it("phase two guard keeps a normal message draft while an option is selected", async () => {
  const target = scopeThreadRef(environmentId, threadId);
  useComposerDraftStore.getState().setPrompt(target, "Keep the normal message");
  await mountApp();
  await act(async () => button("Workspace").click());
  expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
    "Keep the normal message",
  );
  expect(fixture.respond).not.toHaveBeenCalled();
});

it("phase two guard keeps attachment drafts separate by question", () => {
  const first = questionAttachmentDraftId(
    environmentId,
    threadId,
    ApprovalRequestId.make(requestId),
    "scope",
  );
  const second = questionAttachmentDraftId(
    environmentId,
    threadId,
    ApprovalRequestId.make(requestId),
    "timing",
  );
  useComposerDraftStore.getState().setPrompt(first, "First answer");
  useComposerDraftStore.getState().setPrompt(second, "Second answer");
  expect(useComposerDraftStore.getState().getComposerDraft(first)?.prompt).toBe("First answer");
  expect(useComposerDraftStore.getState().getComposerDraft(second)?.prompt).toBe("Second answer");
  useComposerDraftStore.getState().clearComposerContent(first);
  useComposerDraftStore.getState().clearComposerContent(second);
});

async function typeQuestion(questionId: string, text: string) {
  const field = questionField(questionId)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("phase two inline keyboard choices and multiline text submit one complete request", async () => {
  await mountApp();
  await act(async () => {
    const option = button("Workspace");
    option.focus();
    option.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
  });
  expect(button("Workspace").getAttribute("aria-pressed")).toBe("true");
  await typeQuestion("timing", "Tomorrow\nAfter the backup");
  expect(questionField("timing")?.value).toBe("Tomorrow\nAfter the backup");
  expect(fixture.respond).not.toHaveBeenCalled();
  await act(async () => button("Submit").click());
  expect(fixture.respond).toHaveBeenCalledOnce();
  expect(fixture.respond.mock.calls[0]).toEqual([
    expect.objectContaining({
      environmentId,
      input: expect.objectContaining({
        threadId,
        requestId,
        answers: { scope: ["Workspace"], timing: "Tomorrow\nAfter the backup" },
      }),
    }),
  ]);
});

it("phase two inline drafts survive app remount without entering the normal composer", async () => {
  await mountApp();
  await typeQuestion("scope", "Keep this answer");
  await act(async () => root!.unmount());
  root = undefined;
  await mountApp();
  expect(questionField("scope")?.value).toBe("Keep this answer");
  expect(container.querySelector("[data-normal-composer]")?.textContent).not.toContain(
    "Keep this answer",
  );
});

it("phase two independent requests keep their own submit and dismissal boundaries", async () => {
  const activity = fixture.thread!.activities[0]!;
  fixture.thread = {
    ...fixture.thread!,
    activities: [
      activity,
      {
        ...activity,
        id: EventId.make("second-inline-request"),
        payload: {
          ...(activity.payload as Record<string, unknown>),
          requestId: "second-request",
          responseMode: "message",
        },
      },
    ],
  };
  await mountApp();
  expect(container.querySelectorAll("[data-pending-user-input-request-id]")).toHaveLength(2);
  const second = container.querySelector('[data-pending-user-input-request-id="second-request"]')!;
  const dismiss = second.querySelector<HTMLButtonElement>(
    'button[aria-label="Dismiss question without answering"]',
  );
  expect(dismiss).not.toBeNull();
  fixture.dismiss.mockRejectedValueOnce(new Error("Disconnected"));
  await act(async () => dismiss!.click());
  expect(dismiss!.disabled).toBe(false);
  expect(second.textContent).toContain("Could not dismiss");
  expect(
    [...second.querySelectorAll("button")].find((button) => button.textContent === "Submit"),
  ).toBeDefined();
  expect(second.textContent).not.toContain("Retry");
  const persisted = JSON.parse(localStorage.getItem("mesura-pending-question-drafts")!);
  expect(JSON.stringify(persisted)).not.toContain("Could not dismiss");
  await act(async () => dismiss!.click());
  expect(fixture.dismiss).toHaveBeenLastCalledWith({
    environmentId,
    input: { threadId, requestId: "second-request" },
  });
  await act(async () => {
    fixture.thread = {
      ...fixture.thread!,
      activities: [
        ...fixture.thread!.activities,
        {
          id: EventId.make("dismissed-second"),
          kind: "user-input.resolved",
          summary: "User input dismissed",
          tone: "info",
          turnId: null,
          createdAt: now,
          payload: { requestId: "second-request" },
        },
      ],
    };
    for (const listener of fixture.threadListeners) listener();
  });
  expect(container.querySelectorAll("[data-pending-user-input-request-id]")).toHaveLength(1);
  expect(
    container.querySelector('[data-pending-user-input-request-id="phase-two-request"]'),
  ).not.toBeNull();
  expect(fixture.respond).not.toHaveBeenCalled();
});

it("phase two question upload failure stays beside its field and blocks request submission", async () => {
  vi.spyOn(attachmentUploads, "startAttachmentUpload").mockImplementation(() => {});
  const key = questionAttachmentDraftId(
    environmentId,
    threadId,
    ApprovalRequestId.make(requestId),
    "timing",
  );
  useComposerDraftStore.getState().addFiles(
    key,
    [
      {
        type: "file",
        id: "inline-failed-file",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
        file: new File(["useful notes"], "notes.txt", { type: "text/plain" }),
      },
    ],
    { appendReference: false },
  );
  attachmentUploads.useAttachmentUploadStore.setState({
    uploadsByImageId: {
      "inline-failed-file": { status: "failed", environmentId, reason: "Connection lost" },
    },
  });
  await mountApp();
  expect(questionField("timing")?.parentElement?.textContent).toContain("Connection lost");
  expect(questionField("scope")?.parentElement?.textContent).not.toContain("notes.txt");
  expect(button("Submit").disabled).toBe(true);
  const retry = vi.spyOn(attachmentUploads, "retryAttachmentUpload").mockImplementation(() => {});
  await act(async () => button("Retry upload").click());
  expect(retry).toHaveBeenCalledWith(expect.objectContaining({ environmentId, draftTarget: key }));
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Remove notes.txt"]')!.click(),
  );
  expect(button("Submit").disabled).toBe(false);
  expect(questionField("timing")?.parentElement?.textContent).not.toContain("notes.txt");
});

it("phase two remote reconnect keeps editable answers and resumes the same request", async () => {
  fixture.environments[0]!.connection.phase = "reconnecting";
  await mountApp();
  await typeQuestion("scope", "Remote draft");
  expect(questionField("scope")?.disabled).toBe(false);
  expect(button("Submit").disabled).toBe(true);
  expect(container.textContent).toContain("Reconnecting. Your answers are saved.");
  await act(async () => {
    fixture.environments[0]!.connection.phase = "connected";
    fixture.thread = { ...fixture.thread!, activities: [...fixture.thread!.activities] };
    for (const listener of fixture.threadListeners) listener();
  });
  expect(questionField("scope")?.value).toBe("Remote draft");
  expect(button("Submit").disabled).toBe(false);
  expect(fixture.respond).not.toHaveBeenCalled();
});

it("phase two picked question file uses the shared upload draft and request attachment map", async () => {
  const upload = vi.spyOn(attachmentUploads, "startAttachmentUpload").mockImplementation(() => {});
  await mountApp();
  const input = container.querySelector<HTMLInputElement>(
    '[data-question-id="timing"] input[type="file"]',
  )!;
  expect(input).not.toBeNull();
  await act(async () => {
    Object.defineProperty(input, "files", {
      value: [new File(["notes"], "context.txt", { type: "text/plain" })],
      configurable: true,
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const key = questionAttachmentDraftId(
    environmentId,
    threadId,
    ApprovalRequestId.make(requestId),
    "timing",
  );
  const attachment = useComposerDraftStore.getState().getComposerDraft(key)?.files[0];
  expect(attachment?.name).toBe("context.txt");
  expect(upload).toHaveBeenCalledWith(expect.objectContaining({ environmentId, draftTarget: key }));
  expect(button("Submit").disabled).toBe(true);
  await act(async () => {
    attachmentUploads.useAttachmentUploadStore.setState({
      uploadsByImageId: {
        [attachment!.id]: {
          status: "ready",
          environmentId,
          attachmentId: "uploaded-question-file",
        },
      },
    });
    button("Workspace").click();
  });
  expect(questionField("timing")?.parentElement?.textContent).toContain("Ready");
  await act(async () => button("Submit").click());
  expect(fixture.respond).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        attachmentsByQuestionId: {
          timing: [expect.objectContaining({ id: "uploaded-question-file", name: "context.txt" })],
        },
      }),
    }),
  );
  useComposerDraftStore.getState().clearComposerContent(key);
});

async function reserveQuestion(sessionId: string) {
  return dictationCoordinator.reserve({
    protocolVersion: { major: 1, minor: 2 },
    sessionId,
    commandId: CommandId.make(`reserve-${sessionId}`),
    createdAt: now,
    source: "shell",
  });
}

it("phase two rework restores normal dictation when the focused request resolves", async () => {
  await mountApp();
  await act(async () => questionField("timing")!.focus());
  expect((await reserveQuestion("before-resolution")).target.kind).toBe("draft");
  await act(async () => {
    fixture.thread = {
      ...fixture.thread!,
      activities: [
        ...fixture.thread!.activities,
        {
          id: EventId.make("rework-resolved"),
          kind: "user-input.resolved",
          summary: "Resolved",
          tone: "info",
          turnId: null,
          createdAt: now,
          payload: { requestId },
        },
      ],
    };
    for (const listener of fixture.threadListeners) listener();
  });
  expect((await reserveQuestion("after-resolution")).target).toEqual({
    kind: "thread",
    environmentId,
    threadId,
  });
});

it("phase two rework delivers reserved question dictation after its application unmounts", async () => {
  await mountApp();
  await act(async () => questionField("timing")!.focus());
  const { target } = await reserveQuestion("question-unmount");
  const originalThread = fixture.thread!;
  fixture.savedThreads.set(JSON.stringify([environmentId, threadId]), originalThread);
  await act(async () => root!.unmount());
  root = undefined;
  fixture.thread = null;
  const receipt = await dictationCoordinator.deliver({
    type: "dictation.deliver",
    protocolVersion: { major: 1, minor: 2 },
    sessionId: SymmetriaDictationSessionId.make("question-unmount"),
    commandId: CommandId.make("unmounted-transcript"),
    createdAt: now,
    target,
    mode: "submit",
    text: "After navigation",
  });
  expect(receipt.outcome).toBe("inserted");
  expect(
    usePendingUserInputDraftStore.getState().requests[
      pendingUserInputRequestKey(environmentId, threadId, ApprovalRequestId.make(requestId))
    ]?.answers.timing?.customAnswer,
  ).toBe("[voiced] After navigation");
  expect(fixture.respond).not.toHaveBeenCalled();
  fixture.thread = originalThread;
  await mountApp();
  expect(questionField("timing")?.value).toBe("[voiced] After navigation");
});

it("phase two rework focuses a choice-only question without keeping an old dictation target", async () => {
  const activity = fixture.thread!.activities[0]!;
  const payload = activity.payload as { questions: Array<Record<string, unknown>> };
  fixture.thread = {
    ...fixture.thread!,
    activities: [
      {
        ...activity,
        payload: {
          ...payload,
          requestId,
          questions: payload.questions.map((question) =>
            question.id === "timing" ? { ...question, allowCustomAnswer: false } : question,
          ),
        },
      },
    ],
  };
  await mountApp();
  await act(async () => questionField("scope")!.focus());
  await act(async () => button("Now").focus());
  expect((await reserveQuestion("choice-only-focus")).target).toEqual({
    kind: "thread",
    environmentId,
    threadId,
  });
});

it("phase two rework clears missing-answer feedback as soon as a choice answers it", async () => {
  await mountApp();
  await act(async () => button("Submit").click());
  expect(questionField("scope")?.getAttribute("aria-invalid")).toBe("true");
  await act(async () => button("Workspace").click());
  expect(questionField("scope")?.getAttribute("aria-invalid")).toBeNull();
  expect(questionField("scope")?.parentElement?.textContent).not.toContain(
    "Answer this question before submitting.",
  );
});

it("phase two rework question shortcut focuses the first unanswered inline field", async () => {
  await mountApp();
  await act(async () => button("Workspace").click());
  await act(async () => dispatchPickerAction("question"));
  expect(document.activeElement).toBe(questionField("timing"));
});

it("phase two rework unrelated activity leaves existing Markdown rows unrendered", async () => {
  fixture.thread = {
    ...fixture.thread!,
    activities: [],
    messages: [
      {
        id: MessageId.make("stable-assistant"),
        role: "assistant",
        text: "Stable **answer**",
        createdAt: now,
        updatedAt: now,
        streaming: false,
        turnId: null,
      },
    ],
  };
  await mountApp();
  const before = fixture.markdownRenders;
  expect(before).toBeGreaterThan(0);
  await act(async () => {
    fixture.thread = {
      ...fixture.thread!,
      activities: [
        {
          id: EventId.make("unrelated-activity"),
          kind: "provider.session.updated",
          summary: "Session metadata",
          tone: "info",
          turnId: null,
          createdAt: now,
          payload: {},
        },
      ],
    };
    for (const listener of fixture.threadListeners) listener();
  });
  expect(fixture.markdownRenders).toBe(before);
});

it("phase two regression long request keeps answers and reserved dictation across virtual scrolling", async () => {
  const activity = fixture.thread!.activities[0]!;
  const questions = Array.from({ length: 12 }, (_, index) => ({
    id: `long-${index}`,
    header: `Question ${index + 1}`,
    question: `Describe part ${index + 1} of the long request`,
    options: [],
    multiSelect: false,
  }));
  fixture.thread = {
    ...fixture.thread!,
    activities: [{ ...activity, payload: { requestId, questions } }],
  };
  await mountApp();
  expect(container.querySelectorAll("[data-question-id] textarea")).toHaveLength(12);
  await typeQuestion("long-11", "Last answer\nWith more detail");
  await act(async () => questionField("long-11")!.focus());
  const { target } = await reserveQuestion("scrolled-question");
  await act(async () => {
    fixture.pendingRowsVisible = false;
    for (const listener of fixture.threadListeners) listener();
  });
  expect(questionField("long-11")).toBeNull();
  expect(container.querySelector("[data-normal-composer]")).not.toBeNull();
  await act(async () => {
    const receipt = await dictationCoordinator.deliver({
      type: "dictation.deliver",
      protocolVersion: { major: 1, minor: 2 },
      sessionId: SymmetriaDictationSessionId.make("scrolled-question"),
      commandId: CommandId.make("scrolled-transcript"),
      createdAt: now,
      target,
      mode: "submit",
      text: "Keep this too",
    });
    expect(receipt.outcome).toBe("inserted");
  });
  expect((await reserveQuestion("normal-after-scroll")).target).toEqual({
    kind: "thread",
    environmentId,
    threadId,
  });
  await act(async () => {
    fixture.pendingRowsVisible = true;
    for (const listener of fixture.threadListeners) listener();
  });
  expect(questionField("long-11")?.value).toContain("Last answer\nWith more detail");
  expect(questionField("long-11")?.value).toContain("[voiced] Keep this too");
  expect(fixture.respond).not.toHaveBeenCalled();
  expect(fixture.startTurn).not.toHaveBeenCalled();
});

it("phase two regression resolved question refuses a delayed transcript instead of recreating its answer", async () => {
  await mountApp();
  await act(async () => questionField("scope")!.focus());
  const { target } = await reserveQuestion("resolved-question");
  await act(async () => {
    fixture.thread = {
      ...fixture.thread!,
      activities: [
        ...fixture.thread!.activities,
        {
          id: EventId.make("resolved-before-transcript"),
          kind: "user-input.resolved",
          summary: "Resolved",
          tone: "info",
          turnId: null,
          createdAt: now,
          payload: { requestId },
        },
      ],
    };
    for (const listener of fixture.threadListeners) listener();
  });
  const receipt = await dictationCoordinator.deliver({
    type: "dictation.deliver",
    protocolVersion: { major: 1, minor: 2 },
    sessionId: SymmetriaDictationSessionId.make("resolved-question"),
    commandId: CommandId.make("late-resolved-transcript"),
    createdAt: now,
    target,
    mode: "submit",
    text: "Must not land",
  });
  expect(receipt.outcome).toBe("refused");
  expect(JSON.stringify(usePendingUserInputDraftStore.getState().requests)).not.toContain(
    "Must not land",
  );
  expect(fixture.respond).not.toHaveBeenCalled();
});

it("phase two regression both file pickers preserve normal and question attachment ownership", async () => {
  vi.spyOn(attachmentUploads, "startAttachmentUpload").mockImplementation(() => {});
  await mountApp();
  const normalInput = container.querySelector<HTMLInputElement>(
    '[data-normal-composer] input[type="file"]',
  )!;
  const questionInput = container.querySelector<HTMLInputElement>(
    '[data-question-id="scope"] input[type="file"]',
  )!;
  expect(normalInput).not.toBeNull();
  expect(questionInput).not.toBeNull();
  for (const [input, name] of [
    [normalInput, "normal.txt"],
    [questionInput, "question.txt"],
  ] as const) {
    await act(async () => {
      Object.defineProperty(input, "files", {
        value: [new File([name], name, { type: "text/plain" })],
        configurable: true,
      });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  const normalTarget = scopeThreadRef(environmentId, threadId);
  const questionTarget = questionAttachmentDraftId(
    environmentId,
    threadId,
    ApprovalRequestId.make(requestId),
    "scope",
  );
  expect(
    useComposerDraftStore
      .getState()
      .getComposerDraft(normalTarget)
      ?.files.map((file) => file.name),
  ).toEqual(["normal.txt"]);
  expect(
    useComposerDraftStore
      .getState()
      .getComposerDraft(questionTarget)
      ?.files.map((file) => file.name),
  ).toEqual(["question.txt"]);
  for (const input of [normalInput, questionInput]) {
    await act(async () => {
      Object.defineProperty(input, "files", {
        value: [new File(["svg"], "bad.svg", { type: "image/svg+xml" })],
        configurable: true,
      });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  expect(questionField("scope")?.parentElement?.textContent).toContain(
    "Attach GIF, HEIC, HEIF, JPEG, PNG, or WebP images.",
  );
  expect(useComposerDraftStore.getState().getComposerDraft(normalTarget)?.images).toHaveLength(0);
  expect(useComposerDraftStore.getState().getComposerDraft(questionTarget)?.images).toHaveLength(0);
  useComposerDraftStore.getState().clearComposerContent(questionTarget);
});
