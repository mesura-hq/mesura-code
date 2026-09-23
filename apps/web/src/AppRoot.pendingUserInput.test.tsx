// @vitest-environment happy-dom
/**
 * Entry point: AppRoot, with a memory router rendering the real ChatView.
 * ChatView, ChatComposer, the question panel, and primary actions remain real.
 * The fixture replaces environment reads, RPC commands, and unrelated chrome;
 * clicks must travel through the application's selection and submit handlers.
 */
import { act } from "react";
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
  type UserInputQuestion,
} from "@t3tools/contracts";
import type { Thread } from "./types";
import type { AppRouter } from "./router";

const fixture = vi.hoisted(() => ({
  thread: null as Thread | null,
  commands: new Map<unknown, unknown>(),
  noopCommand: vi.fn(async () => ({ _tag: "Success", value: undefined })),
  respond: vi.fn(async () => ({ _tag: "Success", value: undefined })),
  refresh: vi.fn(),
  empty: [],
  threadListeners: new Set<() => void>(),
  environments: [
    {
      environmentId: "phase-one-environment",
      label: "Fence environment",
      connection: { phase: "connected" },
      serverConfig: {
        environment: { capabilities: {} },
        providers: [
          {
            instanceId: "codex",
            driver: "codex",
            enabled: true,
            installed: true,
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
    useThreadShell: useFixtureThread,
    useThreadRefs: () => fixture.empty,
    useProjects: () => fixture.empty,
    useProject: () => null,
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
vi.mock("./components/chat/MessagesTimeline", () => ({ MessagesTimeline: () => null }));
vi.mock("./components/chat/ChatHeader", () => ({ ChatHeader: () => null }));
vi.mock("./components/BranchToolbar", () => ({ BranchToolbar: () => null }));

import { AppRoot } from "./AppRoot";
import ChatView from "./components/ChatView";
import { SidebarProvider } from "./components/ui/sidebar";
import { threadEnvironment } from "./state/threads";
import { useComposerDraftStore } from "./composerDraftStore";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { questionAttachmentDraftId, useQuestionAttachmentPreparation } from "./questionAttachments";

const environmentId = EnvironmentId.make("phase-one-environment");
const threadId = ThreadId.make("phase-one-thread");
const requestId = "phase-one-request";
const now = "2026-09-22T12:00:00.000Z";
let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.respond.mockClear();
  fixture.commands.set(threadEnvironment.respondToUserInput, fixture.respond);
  fixture.thread = {
    id: threadId,
    environmentId,
    projectId: ProjectId.make("phase-one-project"),
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
        id: EventId.make("phase-one-requested"),
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

it("AppRoot selection advances and submits the same scoped request draft", async () => {
  await mountApp();
  await act(async () => button("Workspace").click());
  expect(button("Next").disabled).toBe(false);
  await act(async () => button("Next").click());
  expect(container.textContent).toContain("When should it run?");
  await act(async () => button("Now").click());
  expect(button("Submit").disabled).toBe(false);
  await act(async () => button("Submit").click());
  expect(fixture.respond).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { threadId, requestId, answers: { scope: ["Workspace"], timing: ["Now"] } },
  });
});

it("AppRoot submits a selected final question from its scoped draft", async () => {
  const activity = fixture.thread!.activities[0]!;
  const payload = activity.payload as { questions: unknown[] };
  payload.questions.splice(1);
  await mountApp();
  await act(async () => button("Workspace").click());
  expect(button("Submit").disabled).toBe(false);
  await act(async () => button("Submit").click());
  expect(fixture.respond).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { threadId, requestId, answers: { scope: ["Workspace"] } },
  });
});

it("AppRoot keeps an unanswered request blocked and a selected option visible", async () => {
  await mountApp();
  expect(button("Next").disabled).toBe(true);
  await act(async () => button("Workspace").click());
  expect(button("Workspace").querySelector("svg")).not.toBeNull();
  expect(button("Next").disabled).toBe(false);
  expect(fixture.respond).not.toHaveBeenCalled();
});

it("AppRoot keeps a visible selection and its note through submission", async () => {
  const payload = fixture.thread!.activities[0]!.payload as { questions: unknown[] };
  payload.questions.splice(1);
  await mountApp();
  await act(async () => button("Workspace").click());
  await pasteQuestionNote("Keep the files");
  expect(button("Workspace").querySelector("svg")).not.toBeNull();
  await act(async () => button("Submit").click());
  expect(fixture.respond).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { threadId, requestId, answers: { scope: ["Workspace", "Keep the files"] } },
  });
});

async function pasteQuestionNote(note: string) {
  const editor = container.querySelector<HTMLElement>('[contenteditable="true"]');
  expect(editor).not.toBeNull();
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", note);
  await act(async () => {
    editor!.focus();
    editor!.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
    );
  });
  expect(editor!.textContent).toContain(note);
}

it("AppRoot selecting an option keeps the prior note out of the normal thread draft", async () => {
  const payload = fixture.thread!.activities[0]!.payload as { questions: UserInputQuestion[] };
  payload.questions.splice(1);
  const target = scopeThreadRef(environmentId, threadId);
  useComposerDraftStore.getState().setPrompt(target, "A separate follow-up");
  await mountApp();
  await pasteQuestionNote("Retain these files");
  await act(async () => button("Workspace").click());
  expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
    "A separate follow-up",
  );
  await act(async () => button("Submit").click());
  expect(fixture.respond).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { threadId, requestId, answers: { scope: ["Workspace", "Retain these files"] } },
  });
  expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
    "A separate follow-up",
  );
});

it("AppRoot clears optimistic selection after a noted draft is confirmed during attachment preparation", async () => {
  const activity = fixture.thread!.activities[0]!;
  const payload = activity.payload as { questions: UserInputQuestion[] };
  payload.questions.splice(1);
  payload.questions[0] = { ...payload.questions[0]!, multiSelect: false };
  await mountApp();
  const attachmentKey = questionAttachmentDraftId(
    environmentId,
    threadId,
    ApprovalRequestId.make(requestId),
    "scope",
  );
  await act(async () =>
    useQuestionAttachmentPreparation.setState({ counts: { [attachmentKey]: 1 } }),
  );
  await pasteQuestionNote("Keep this note");
  await act(async () => button("Workspace").click());
  expect(button("Submit").disabled).toBe(true);
  expect(button("Workspace").querySelector("svg")).not.toBeNull();
  // A refreshed request allows multiple choices. Its toggle updates the draft
  // without replacing the previous single-choice optimistic state.
  await act(async () => {
    fixture.thread = {
      ...fixture.thread!,
      activities: [
        {
          ...activity,
          payload: { ...payload, questions: [{ ...payload.questions[0]!, multiSelect: true }] },
        },
      ],
    };
    for (const listener of fixture.threadListeners) listener();
  });
  await act(async () => button("Workspace").click());
  expect(button("Workspace").querySelector("svg")).toBeNull();
  expect(container.querySelector('[contenteditable="true"]')?.textContent).toContain(
    "Keep this note",
  );
  expect(fixture.respond).not.toHaveBeenCalled();
});
