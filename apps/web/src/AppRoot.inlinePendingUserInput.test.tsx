// @vitest-environment happy-dom
/**
 * Entry point: AppRoot with its memory router, real ChatView, MessagesTimeline,
 * and ChatComposer. Environment reads and RPC commands use the phase fixture.
 */
import { dispatchPickerAction } from "./lib/pickerActionBus";

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
import { publishFenceThreadProjection, addFenceThread, makeMessage } from "./test/appRootFenceApp";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import type { AppRouter } from "./router";

const fixture = vi.hoisted(() => ({
  markdownRenders: 0,
  pendingRowsVisible: true,
  projection: null as OrchestrationV2ThreadProjection | null,
  commands: new Map<unknown, unknown>(),
  noopCommand: vi.fn(async () => ({ _tag: "Success", value: { providers: [] } })),
  dismiss: vi.fn(async () => ({ _tag: "Success", value: undefined })),
  respond: vi.fn(async () => ({ _tag: "Success", value: undefined })),
  startTurn: vi.fn(async () => ({ _tag: "Success", value: undefined })),
  threadListeners: new Set<() => void>(),
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
import { usePendingUserInputDraftStore } from "./pendingUserInputDraftStore";

import { AppRoot } from "./AppRoot";
import ChatView from "./components/ChatView";
import { SidebarProvider } from "./components/ui/sidebar";
import { threadEnvironment } from "./state/threads";
import { useComposerDraftStore } from "./composerDraftStore";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { questionAttachmentDraftId, useQuestionAttachmentPreparation } from "./questionAttachments";
import * as attachmentUploads from "./lib/attachmentUploadQueue";

const environmentId = EnvironmentId.make(FENCE_ENVIRONMENT_ID);
const threadId = ThreadId.make("phase-two-thread");
const requestId = "phase-two-request";
const now = "2026-09-22T12:00:00.000Z";
let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  fixture.pendingRowsVisible = true;
  usePendingUserInputDraftStore.setState({ requests: {} });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  appRootFence.environments[0]!.connection.phase = "connected";
  fixture.respond.mockReset();
  fixture.respond.mockResolvedValue({ _tag: "Success", value: undefined });
  fixture.startTurn.mockClear();
  fixture.dismiss.mockReset();
  fixture.dismiss.mockResolvedValue({ _tag: "Success", value: undefined });
  fixture.commands.set(threadEnvironment.dismissUserInput, fixture.dismiss);
  fixture.commands.set(threadEnvironment.respondToUserInput, fixture.respond);
  fixture.commands.set(threadEnvironment.startTurn, fixture.startTurn);
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
  vi.restoreAllMocks();
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
    fixture.projection = {
      ...fixture.projection!,
      runtimeRequests: [...fixture.projection!.runtimeRequests],
    };
    publishFenceThreadProjection(fixture.projection!, environmentId);
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
  const send = container.querySelector<HTMLButtonElement>(
    '[data-normal-composer] button[aria-label="Submit message"], [data-normal-composer] button[aria-label="Queue message"]',
  );
  expect(send).not.toBeNull();
  await act(async () => send!.click());
  // V2 queues messages as server runs rather than in the removed local queuedMessageStore.
  expect(fixture.startTurn).toHaveBeenCalledOnce();
  expect(fixture.startTurn).toHaveBeenCalledWith(
    expect.objectContaining({
      environmentId,
      input: expect.objectContaining({ threadId, dispatchMode: "queue" }),
    }),
  );
  expect(fixture.respond).not.toHaveBeenCalled();
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
    fixture.projection = {
      ...fixture.projection!,
      runtimeRequests: fixture.projection!.runtimeRequests.map((request) => ({
        ...request,
        status: "resolved",
        resolvedAt: DateTime.makeUnsafe("2026-09-22T12:00:02.000Z"),
        answers: { scope: ["Workspace"], timing: ["Now"] },
      })),
      visibleTurnItems: [
        {
          item: questionItem(),
          position: 0,
          visibility: "local",
          sourceThreadId: threadId,
          sourceItemId: questionItem().id,
        },
      ],
    };
    publishFenceThreadProjection(fixture.projection!, environmentId);
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
  const item = questionItem();
  const secondRequest = makeFenceUserInput({
    threadId,
    requestId: "second-request",
    createdAt: now,
    questions: item.questions,
    responseMode: "message",
    ordinal: 1,
  });
  fixture.projection = {
    ...fixture.projection!,
    runtimeRequests: [...fixture.projection!.runtimeRequests, secondRequest.request],
    turnItems: [item, secondRequest.item],
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
    fixture.projection = {
      ...fixture.projection!,
      runtimeRequests: fixture.projection!.runtimeRequests.map((request) =>
        request.id === "second-request"
          ? { ...request, status: "resolved", resolvedAt: DateTime.makeUnsafe(now) }
          : request,
      ),
    };
    publishFenceThreadProjection(fixture.projection!, environmentId);
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
  appRootFence.environments[0]!.connection.phase = "reconnecting";
  await mountApp();
  await typeQuestion("scope", "Remote draft");
  expect(questionField("scope")?.disabled).toBe(false);
  expect(button("Submit").disabled).toBe(true);
  expect(container.textContent).toContain("Reconnecting. Your answers are saved.");
  await act(async () => {
    appRootFence.environments[0]!.connection.phase = "connected";
    fixture.projection = {
      ...fixture.projection!,
      runtimeRequests: [...fixture.projection!.runtimeRequests],
    };
    publishFenceThreadProjection(fixture.projection!, environmentId);
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

it("phase two rework unrelated v2 detail update leaves existing Markdown rows unrendered", async () => {
  addFenceThread(threadId, "Question fence", [
    makeMessage("stable-assistant", "assistant", "Stable **answer**"),
  ]);
  fixture.projection = Option.getOrThrow(appRootFence.threadStates.get(threadId)!.data);
  await mountApp();
  const before = fixture.markdownRenders;
  expect(before).toBeGreaterThan(0);
  await act(async () => {
    // An unrelated v2 detail update keeps the same visible item identities.
    fixture.projection = {
      ...fixture.projection!,
      updatedAt: DateTime.makeUnsafe("2026-09-22T12:00:01.000Z"),
    };
    publishFenceThreadProjection(fixture.projection!, environmentId);
    for (const listener of fixture.threadListeners) listener();
  });
  expect(fixture.markdownRenders).toBe(before);
});

it("phase two regression long request keeps answers across virtual scrolling", async () => {
  const item = questionItem();
  const questions = Array.from({ length: 12 }, (_, index) => ({
    id: `long-${index}`,
    header: `Question ${index + 1}`,
    question: `Describe part ${index + 1} of the long request`,
    options: [],
    multiSelect: false,
  }));
  fixture.projection = { ...fixture.projection!, turnItems: [{ ...item, questions }] };
  await mountApp();
  expect(container.querySelectorAll("[data-question-id] textarea")).toHaveLength(12);
  await typeQuestion("long-11", "Last answer\nWith more detail");
  await act(async () => {
    fixture.pendingRowsVisible = false;
    publishFenceThreadProjection(fixture.projection!, environmentId);
    for (const listener of fixture.threadListeners) listener();
  });
  expect(questionField("long-11")).toBeNull();
  expect(container.querySelector("[data-normal-composer]")).not.toBeNull();
  await act(async () => {
    fixture.pendingRowsVisible = true;
    publishFenceThreadProjection(fixture.projection!, environmentId);
    for (const listener of fixture.threadListeners) listener();
  });
  expect(questionField("long-11")?.value).toContain("Last answer\nWith more detail");
  expect(fixture.respond).not.toHaveBeenCalled();
  expect(fixture.startTurn).not.toHaveBeenCalled();
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
