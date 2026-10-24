// @vitest-environment happy-dom
/**
 * Entry point: AppRoot, with a memory router rendering the real ChatView.
 * ChatView, MessagesTimeline, ChatComposer, and primary actions remain real.
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
  type OrchestrationV2ThreadProjection,
  ApprovalRequestId,
} from "@t3tools/contracts";
import {
  makeFenceThreadProjection,
  makeFenceThreadShell,
  makeFenceUserInput,
  FENCE_USER_INPUT_QUESTIONS,
  readFenceUserInputItem,
} from "./test/fenceThreadShell";
import {
  appRootFence,
  FENCE_ENVIRONMENT_ID,
  FENCE_PROJECT_ID,
  installFenceFontEvents,
} from "./test/appRootFenceMocks";
import { publishFenceThreadProjection } from "./test/appRootFenceApp";
import type { AppRouter } from "./router";

const fixture = vi.hoisted(() => ({
  projection: null as OrchestrationV2ThreadProjection | null,
  commands: new Map<unknown, unknown>(),
  noopCommand: vi.fn(async () => ({ _tag: "Success", value: { providers: [] } })),
  respond: vi.fn(async () => ({ _tag: "Success", value: undefined })),
}));

const fenceMocks = vi.hoisted(() => () => import("./test/appRootFenceMocks"));
vi.mock("@t3tools/client-runtime/state/session", async (original) =>
  (await fenceMocks()).mockRuntimeSession(original),
);
vi.mock("./state/entities", async (original) => (await fenceMocks()).mockEntities(original));
vi.mock("./state/environments", async (original) =>
  (await fenceMocks()).mockEnvironments(original),
);
vi.mock("./state/query", async () => (await fenceMocks()).mockQuery());
vi.mock("./state/threads", async (original) => (await fenceMocks()).mockThreads(original));
vi.mock("./state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => fixture.commands.get(command) ?? fixture.noopCommand,
}));
vi.mock("./state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => fixture.noopCommand }));
vi.mock("./hooks/useSettings", async (original) => (await fenceMocks()).mockSettings(original));
vi.mock("./hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => fixture.noopCommand }));
vi.mock("./hooks/useThreadActions", async () => (await fenceMocks()).mockThreadActions());
vi.mock("./components/preview/PreviewAutomationHosts", () => ({
  PreviewAutomationHosts: () => null,
}));
vi.mock("./browser/ElectronBrowserHost", () => ({ ElectronBrowserHost: () => null }));
vi.mock("./components/QuitHoldOverlay", () => ({ QuitHoldOverlay: () => null }));
vi.mock("./components/chat/ChatHeader", () => ({ ChatHeader: () => null }));
vi.mock("./components/BranchToolbar", () => ({ BranchToolbar: () => null }));

// happy-dom has no layout. Keep application routing and timeline projection
// real, and replace only the virtual list's measurement boundary.
vi.mock("@legendapp/list/react", async () => (await fenceMocks()).mockLegendList());
import { usePendingUserInputDraftStore } from "./pendingUserInputDraftStore";

import { AppRoot } from "./AppRoot";
import ChatView from "./components/ChatView";
import { SidebarProvider } from "./components/ui/sidebar";
import { threadEnvironment } from "./state/threads";
import { useComposerDraftStore } from "./composerDraftStore";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { questionAttachmentDraftId, useQuestionAttachmentPreparation } from "./questionAttachments";

const environmentId = EnvironmentId.make(FENCE_ENVIRONMENT_ID);
const threadId = ThreadId.make("phase-one-thread");
const requestId = "phase-one-request";
const now = "2026-09-22T12:00:00.000Z";
let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  usePendingUserInputDraftStore.setState({ requests: {} });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.respond.mockClear();
  fixture.commands.set(threadEnvironment.respondToUserInput, fixture.respond);
  installFenceFontEvents();
  Object.assign(appRootFence.environments[0]!.serverConfig.environment.capabilities, {
    questionAttachments: true,
    attachmentUploads: true,
    fileAttachments: { maxUploadBytes: 1048576 },
  });
  const shell = makeFenceThreadShell({
    id: threadId,
    environmentId,
    projectId: ProjectId.make(FENCE_PROJECT_ID),
    title: "Question fence",
    createdAt: now,
  });
  const { request, item } = makeFenceUserInput({
    threadId,
    requestId,
    createdAt: now,
    questions: FENCE_USER_INPUT_QUESTIONS,
  });
  fixture.projection = makeFenceThreadProjection(shell, {
    runtimeRequests: [request],
    turnItems: [item],
  });
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  appRootFence.threads.clear();
  appRootFence.threadStates.clear();
  useComposerDraftStore.getState().clearComposerContent(scopeThreadRef(environmentId, threadId));
  useQuestionAttachmentPreparation.setState({ counts: {} });
  vi.unstubAllGlobals();
});

async function mountApp() {
  publishFenceThreadProjection(fixture.projection!, environmentId);
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

const questionItem = () => readFenceUserInputItem(fixture.projection!);

function button(text: string) {
  const match = [...container.querySelectorAll("button")].find((entry) =>
    entry.textContent?.includes(text),
  );
  expect(match, `Expected button ${text}; rendered: ${container.textContent}`).toBeDefined();
  return match!;
}

it("AppRoot selection submits the same scoped request draft", async () => {
  await mountApp();
  await act(async () => button("Workspace").click());
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
  const item = questionItem();
  fixture.projection = {
    ...fixture.projection!,
    turnItems: [{ ...item, questions: item.questions.slice(0, 1) }],
  };
  await mountApp();
  await act(async () => button("Workspace").click());
  expect(button("Submit").disabled).toBe(false);
  await act(async () => button("Submit").click());
  expect(fixture.respond).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { threadId, requestId, answers: { scope: ["Workspace"] } },
  });
});

it("AppRoot keeps an unanswered request unsent and a selected option visible", async () => {
  await mountApp();
  expect(button("Submit").disabled).toBe(false);
  await act(async () => button("Workspace").click());
  expect(button("Workspace").querySelector("svg")).not.toBeNull();
  expect(button("Submit").disabled).toBe(false);
  expect(fixture.respond).not.toHaveBeenCalled();
});

it("AppRoot keeps a visible selection and its note through submission", async () => {
  const item = questionItem();
  fixture.projection = {
    ...fixture.projection!,
    turnItems: [{ ...item, questions: item.questions.slice(0, 1) }],
  };
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
  const editor = container.querySelector<HTMLElement>(
    '[data-question-id="scope"] textarea, [data-question-id="scope"] [contenteditable="true"]',
  );
  expect(editor).not.toBeNull();
  await act(async () => {
    editor!.focus();
    if (editor instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(editor, note);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", note);
      editor!.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
      );
    }
  });
  expect(editor instanceof HTMLTextAreaElement ? editor.value : editor!.textContent).toContain(
    note,
  );
}

it("AppRoot selecting an option keeps the prior note out of the normal thread draft", async () => {
  const item = questionItem();
  fixture.projection = {
    ...fixture.projection!,
    turnItems: [{ ...item, questions: item.questions.slice(0, 1) }],
  };
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
  const item = questionItem();
  fixture.projection = {
    ...fixture.projection!,
    turnItems: [{ ...item, questions: [{ ...item.questions[0]!, multiSelect: false }] }],
  };
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
    fixture.projection = {
      ...fixture.projection!,
      turnItems: [{ ...item, questions: [{ ...item.questions[0]!, multiSelect: true }] }],
    };
    publishFenceThreadProjection(fixture.projection!, environmentId);
  });
  await act(async () => button("Workspace").click());
  expect(button("Workspace").querySelector("svg")).toBeNull();
  expect(
    container.querySelector<HTMLTextAreaElement>('[data-question-id="scope"] textarea')?.value,
  ).toContain("Keep this note");
  expect(fixture.respond).not.toHaveBeenCalled();
});
