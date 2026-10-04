// @vitest-environment happy-dom
/**
 * Entry point: AppRoot, with a memory router whose root renders the real
 * AppSidebarLayout around the real ChatView, as `_chat.tsx` does. The layout is
 * where the app-wide dictation listener lives, so a job that completes for a
 * thread that is not on screen is still filled.
 *
 * Phase 4 of the STT redesign, criteria 1–8: record in the desktop and web
 * window and place the marker. Phase 5, criteria 1–7: send a draft when its
 * last marker fills, on screen, off screen and from an open question card.
 * Phase 6, criteria 1–4 on the renderer side: a `--dictation …` command line
 * the desktop forwards runs the in-window command, and the widget window's
 * page (`DictationWidgetPage`, mounted beside the app) draws what the app
 * publishes. The desktop bridge is a loopback stand-in for the preload one.
 *
 * Boundaries the fixture replaces, and nothing else:
 * - The browser media APIs, through the `setDictationMediaBackend` seam in
 *   `dictation/recorder.ts` (happy-dom has no getUserMedia, MediaRecorder or
 *   AudioContext).
 * - The upload, at `runAttachmentUploadCycle`, the cycle the plan names, and the check of an
 *   earlier upload, at `verifyPersistedAttachmentUpload`.
 * - Every RPC command, at `runAtomCommand` and `useAtomCommand`, so the
 *   dictation start and setMode commands are observed as they leave.
 * - The job stream, at phase 2's `useDictationJobs` hook: the fixture pushes
 *   job lists through it as the server would.
 * - The sidebars and the thread entity reads, as `AppRoot.pendingUserInput.test.tsx` does,
 *   including the registry reads (`environmentThreadDetails.detailAtom`,
 *   `environmentProjects.projectAtom`) that a send off screen resolves the thread with.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ApprovalRequestId,
  DictationJobId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type DictationJob,
  type DictationMode,
  type DictationTarget,
} from "@t3tools/contracts";
import { findDictationSlots, formatDictationSlot } from "@t3tools/shared/dictationSlots";
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  type LexicalEditor,
  type TextNode,
} from "lexical";
import type { Thread } from "./types";
import type { AppRouter } from "./router";

const fixture = vi.hoisted(() => ({
  thread: null as Thread | null,
  project: {
    id: "dictation-phase-four-project",
    environmentId: "dictation-phase-four-environment",
    title: "Dictation fence",
    workspaceRoot: "/tmp/dictation-fence",
    scripts: [],
    createdAt: "2026-10-03T12:00:00.000Z",
    defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" },
  },
  empty: [],
  threadListeners: new Set<() => void>(),
  /** Set after import: the dictation commands and the turn start, by name. */
  dictationCommands: new Map<unknown, string>(),
  dictationCalls: [] as Array<{ name: string; value: unknown }>,
  uploads: [] as Array<{ upload: unknown; promptAtUpload: string | null }>,
  readPromptAtUpload: (() => null) as () => string | null,
  jobs: [] as unknown[],
  /** Uploads still to fail before one succeeds. */
  failingUploads: 0,
  /** While set, a turn start waits for it. */
  startTurnGate: null as Promise<void> | null,
  /** When set, a turn start is refused by the server. */
  startTurnFails: false,
  /** While set, checking an earlier upload waits for it. */
  verifyGate: null as Promise<void> | null,
  /** False until the subscription's snapshot arrives, as for a fresh subscription. */
  jobsLoaded: true,
  jobListeners: new Set<() => void>(),
  environments: [
    {
      environmentId: "dictation-phase-four-environment",
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
            checkedAt: "2026-10-03T12:00:00.000Z",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ],
      },
    },
  ],
}));

/** Every command goes through here; dictation commands are recorded by name. */
function dispatchCommand(command: unknown, value: unknown) {
  const name = fixture.dictationCommands.get(command);
  if (name) fixture.dictationCalls.push({ name, value });
  if (name === "startTurn" && (fixture.startTurnGate || fixture.startTurnFails)) {
    const gate = fixture.startTurnGate ?? Promise.resolve();
    return gate.then(() =>
      fixture.startTurnFails
        ? { _tag: "Failure" as const, cause: new Error("The provider refused the turn.") }
        : { _tag: "Success" as const, value: { providers: [] } },
    );
  }
  // Shaped for the composer's provider refresh, the one caller that reads a value here.
  return Promise.resolve({ _tag: "Success" as const, value: { providers: [] } });
}

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
    readThread: () => fixture.thread,
    useThreadShell: useFixtureThread,
    useThreadRefs: () => fixture.empty,
    useThreadShells: () => fixture.empty,
    useProjects: () => fixture.empty,
    useProject: () => fixture.project,
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
    refresh: () => undefined,
  }),
}));
vi.mock("./state/threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state/threads")>();
  const { EMPTY_ENVIRONMENT_THREAD_STATE } = await import("@t3tools/client-runtime/state/threads");
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    ...actual,
    useEnvironmentThread: () => EMPTY_ENVIRONMENT_THREAD_STATE,
    environmentThreadDetails: {
      ...actual.environmentThreadDetails,
      detailAtom: (ref: { threadId: string }) =>
        Atom.make(() => (fixture.thread?.id === ref.threadId ? fixture.thread : null)),
    },
  };
});
vi.mock("./state/projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state/projects")>();
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    ...actual,
    environmentProjects: {
      ...actual.environmentProjects,
      projectAtom: (ref: { projectId: string }) =>
        Atom.make(() => (ref.projectId === fixture.project.id ? fixture.project : null)),
    },
  };
});
vi.mock("./state/dictation", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    fixture.jobListeners.add(listener);
    return () => {
      fixture.jobListeners.delete(listener);
    };
  };
  const none: unknown[] = [];
  return {
    ...(await importOriginal<typeof import("./state/dictation")>()),
    useDictationJobs: (environmentId: string | null) => {
      const jobs = useSyncExternalStore(subscribe, () =>
        environmentId === fixture.environments[0]!.environmentId ? fixture.jobs : none,
      );
      const loaded = useSyncExternalStore(subscribe, () => fixture.jobsLoaded);
      return { jobs, loaded };
    },
  };
});
vi.mock("./state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => (value: unknown) => dispatchCommand(command, value),
}));
vi.mock("./state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => () => dispatchCommand(null, null),
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: (_registry: unknown, command: unknown, value: unknown) =>
    dispatchCommand(command, value),
}));
vi.mock("@t3tools/client-runtime/state/attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/attachments")>()),
  runAttachmentUploadCycle: async (input: { upload: unknown }) => {
    fixture.uploads.push({ upload: input.upload, promptAtUpload: fixture.readPromptAtUpload() });
    if (fixture.failingUploads > 0) {
      fixture.failingUploads -= 1;
      return { status: "failed", error: new Error("The upload failed.") };
    }
    return { status: "uploaded", attachmentId: `dictation-audio-${fixture.uploads.length}` };
  },
  // A draft file uploaded before is checked against the server before it is sent.
  verifyPersistedAttachmentUpload: async () => {
    await fixture.verifyGate;
    return { status: "verified" };
  },
}));
// The toggle ships unbound; this fixture binds it the way a user's keybindings file would.
vi.mock("./state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state/server")>();
  const { Atom } = await import("effect/unstable/reactivity");
  const { compileResolvedKeybindingsConfig, mergeWithDefaultKeybindings } =
    await import("@t3tools/shared/keybindings");
  return {
    ...actual,
    primaryServerKeybindingsAtom: Atom.make(() =>
      mergeWithDefaultKeybindings(
        compileResolvedKeybindingsConfig([
          { key: "ctrl+alt+d", command: "dictation.toggle" as never },
        ]),
      ),
    ),
  };
});
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
    useLegacySidebarEnabled: () => false,
  };
});
vi.mock("./hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => () => dispatchCommand(null, null),
}));
vi.mock("./hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    settleThread: () => dispatchCommand(null, null),
    pinThread: () => dispatchCommand(null, null),
    confirmAndUnpinThread: () => dispatchCommand(null, null),
  }),
}));
vi.mock("./components/Sidebar", () => ({ default: () => null }));
vi.mock("./components/LegacySidebar", () => ({ default: () => null }));
vi.mock("./components/preview/PreviewAutomationHosts", () => ({
  PreviewAutomationHosts: () => null,
}));
vi.mock("./browser/ElectronBrowserHost", () => ({ ElectronBrowserHost: () => null }));
vi.mock("./components/QuitHoldOverlay", () => ({ QuitHoldOverlay: () => null }));
vi.mock("./components/chat/ChatHeader", () => ({ ChatHeader: () => null }));
vi.mock("./components/BranchToolbar", () => ({ BranchToolbar: () => null }));
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
        <div key={item.id}>{renderItem({ item })}</div>
      ))}
      {ListFooterComponent}
    </div>
  ),
}));

import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AppRoot } from "./AppRoot";
import { AppSidebarLayout } from "./components/AppSidebarLayout";
import ChatView from "./components/ChatView";
import { toastManager } from "./components/ui/toast";
import {
  type ComposerFileAttachment,
  persistComposerDrafts,
  useComposerDraftStore,
} from "./composerDraftStore";
import {
  editPendingUserInputAnswerText,
  pendingUserInputRequestKey,
  usePendingUserInputDraftStore,
} from "./pendingUserInputDraftStore";
import { DictationWidgetPage } from "./dictation/DictationWidget";
import { useDictationSessionStore } from "./dictation/dictationSessionStore";
import { useDictationWidgetActivityStore } from "./dictation/dictationWidgetState";
import { createFakeMedia } from "./dictation/dictationMedia.testFixtures";
import { setDictationMediaBackend } from "./dictation/recorder";
import { useQueuedMessageStore } from "./queuedMessageStore";
import { dictationEnvironment } from "./state/dictation";
import { threadEnvironment } from "./state/threads";

const environmentId = EnvironmentId.make("dictation-phase-four-environment");
const threadId = ThreadId.make("dictation-phase-four-thread");
const offScreenThreadId = ThreadId.make("dictation-phase-four-other-thread");
const onScreenTarget = scopeThreadRef(environmentId, threadId);
const offScreenTarget = scopeThreadRef(environmentId, offScreenThreadId);
const now = "2026-10-03T12:00:00.000Z";
let root: Root | undefined;
let container: HTMLDivElement;
let media: ReturnType<typeof createFakeMedia>;
let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

// ── Fixture ─────────────────────────────────────────────────────────────────

function makeThread(): Thread {
  return {
    id: threadId,
    environmentId,
    projectId: ProjectId.make("dictation-phase-four-project"),
    title: "Dictation fence",
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
    activities: [],
  } as unknown as Thread;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.thread = makeThread();
  fixture.dictationCalls.length = 0;
  fixture.uploads.length = 0;
  fixture.jobs = [];
  fixture.jobsLoaded = true;
  fixture.failingUploads = 0;
  fixture.startTurnGate = null;
  fixture.startTurnFails = false;
  fixture.verifyGate = null;
  fixture.dictationCommands = new Map<unknown, string>([
    [dictationEnvironment.start, "start"],
    [dictationEnvironment.retry, "retry"],
    [dictationEnvironment.cancel, "cancel"],
    [dictationEnvironment.setMode, "setMode"],
    [threadEnvironment.startTurn, "startTurn"],
    [threadEnvironment.respondToUserInput, "respond"],
  ]);
  fixture.readPromptAtUpload = () => promptOf(onScreenTarget);
  media = createFakeMedia();
  setDictationMediaBackend(media.backend);
  writeText = vi.fn(async (_text: string) => undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  vi.spyOn(toastManager, "add");
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  setDictationMediaBackend(null);
  useComposerDraftStore.getState().clearComposerContent(onScreenTarget);
  useComposerDraftStore.getState().clearComposerContent(offScreenTarget);
  usePendingUserInputDraftStore.setState({ requests: {} });
  useQueuedMessageStore.getState().drain(scopedThreadKey(onScreenTarget));
  Reflect.deleteProperty(navigator, "clipboard");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

let router: ReturnType<typeof createRouter> | undefined;

/** The modules an app mount is built from; a reload passes freshly imported ones. */
interface AppModules {
  readonly AppRoot: typeof AppRoot;
  readonly AppSidebarLayout: typeof AppSidebarLayout;
  readonly ChatView: typeof ChatView;
  readonly createRootRoute: typeof createRootRoute;
  readonly createRoute: typeof createRoute;
  readonly createRouter: typeof createRouter;
  readonly createMemoryHistory: typeof createMemoryHistory;
  readonly Outlet: typeof Outlet;
}

async function mountApp(
  modules: AppModules = {
    AppRoot,
    AppSidebarLayout,
    ChatView,
    createRootRoute,
    createRoute,
    createRouter,
    createMemoryHistory,
    Outlet,
  },
) {
  const {
    AppRoot,
    AppSidebarLayout,
    ChatView,
    createRootRoute,
    createRoute,
    createRouter,
    createMemoryHistory,
    Outlet,
  } = modules;
  const route = createRootRoute({
    component: () => (
      <AppSidebarLayout>
        <Outlet />
      </AppSidebarLayout>
    ),
  });
  const index = createRoute({
    getParentRoute: () => route,
    path: "/",
    component: () => (
      <ChatView environmentId={environmentId} threadId={threadId} routeKind="server" />
    ),
  });
  // A page without the thread, so its composer is not on screen.
  const elsewhere = createRoute({
    getParentRoute: () => route,
    path: "/elsewhere",
    component: () => <p>Elsewhere</p>,
  });
  router = createRouter({
    routeTree: route.addChildren([index, elsewhere]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  await act(async () => {
    root = createRoot(container);
    root.render(<AppRoot router={router as unknown as AppRouter} />);
  });
}

/**
 * A page reload: the app unmounts, every module starts over and reads storage again, and the
 * server's job list is empty until its snapshot arrives, as a fresh subscription's is.
 */
async function reloadApp() {
  await act(async () => root?.unmount());
  root = undefined;
  vi.resetModules();
  const router = await import("@tanstack/react-router");
  const freshCommands = (await import("./state/dictation")).dictationEnvironment;
  fixture.dictationCommands.set(freshCommands.start, "start");
  fixture.dictationCommands.set(freshCommands.setMode, "setMode");
  const freshThreads = (await import("./state/threads")).threadEnvironment;
  fixture.dictationCommands.set(freshThreads.startTurn, "startTurn");
  await act(async () => {
    fixture.jobs = [];
    fixture.jobsLoaded = false;
    for (const listener of fixture.jobListeners) listener();
  });
  await mountApp({
    AppRoot: (await import("./AppRoot")).AppRoot,
    AppSidebarLayout: (await import("./components/AppSidebarLayout")).AppSidebarLayout,
    ChatView: (await import("./components/ChatView")).default,
    createRootRoute: router.createRootRoute,
    createRoute: router.createRoute,
    createRouter: router.createRouter,
    createMemoryHistory: router.createMemoryHistory,
    Outlet: router.Outlet,
  });
  await settle();
}

async function navigateAwayFromThread() {
  await act(async () => {
    await router!.navigate({ to: "/elsewhere" as never });
  });
  await settle();
  expect(container.querySelector('[data-lexical-editor="true"]')).toBeNull();
}

/** Lets promise chains (getUserMedia, Blob reads, upload, start) settle inside React's act. */
async function settle() {
  await act(async () => {
    for (let round = 0; round < 10; round += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  });
}

function promptOf(target: typeof onScreenTarget): string | null {
  return useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? null;
}

function buttonLabelled(label: string | RegExp): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => {
    const name = button.getAttribute("aria-label") ?? button.textContent ?? "";
    return typeof label === "string" ? name === label : label.test(name);
  });
}

function requireButton(label: string | RegExp): HTMLButtonElement {
  const button = buttonLabelled(label);
  expect(
    button,
    `Expected a button labelled ${String(label)}; buttons: ${[
      ...document.querySelectorAll("button"),
    ]
      .map((entry) => entry.getAttribute("aria-label") ?? entry.textContent)
      .join(" | ")}`,
  ).toBeDefined();
  return button!;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await settle();
}

/** The microphone in the composer: the same control the Shell path labels "Start voice dictation". */
async function startRecordingFromMicrophone() {
  const microphone = requireButton("Start voice dictation");
  expect(microphone.getAttribute("aria-disabled")).not.toBe("true");
  await click(microphone);
}

async function stopRecordingFromStrip() {
  await click(requireButton("Stop and transcribe"));
}

async function pressKey(init: KeyboardEventInit & { key: string }, target?: Element | null) {
  const element = target ?? document.activeElement ?? document.body;
  // happy-dom reports AltGraph whenever Alt is held; a browser on Linux reports it only for
  // the right Alt key, so the left Alt chords here behave as they do in the app.
  const keyEvent = (type: string) => {
    const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
    const original = event.getModifierState.bind(event);
    Object.defineProperty(event, "getModifierState", {
      value: (key: string) => (key === "AltGraph" ? false : original(key)),
    });
    return event;
  };
  await act(async () => {
    element.dispatchEvent(keyEvent("keydown"));
    element.dispatchEvent(keyEvent("keyup"));
  });
  await settle();
}

const altKey = (key: string, code: string) => ({ key, code, altKey: true });
const ALT_S = altKey("s", "KeyS");
const ALT_I = altKey("i", "KeyI");
const ALT_ENTER = altKey("Enter", "Enter");
const TOGGLE = { key: "d", code: "KeyD", ctrlKey: true, altKey: true };

function composerEditorElement(): HTMLElement {
  const editor = container.querySelector<HTMLElement>('[data-lexical-editor="true"]');
  expect(editor, "Expected the composer editor").not.toBeNull();
  return editor!;
}

function lexicalEditor(): LexicalEditor {
  const editor = (composerEditorElement() as unknown as { __lexicalEditor?: LexicalEditor })
    .__lexicalEditor;
  expect(editor, "Expected the Lexical editor on the composer element").toBeDefined();
  return editor!;
}

/** Puts the composer's caret right after `before` in the text node that contains it. */
async function placeCaretAfter(before: string) {
  const editor = lexicalEditor();
  await act(async () => {
    editor.update(
      () => {
        const nodes = $getRoot().getAllTextNodes();
        for (const node of nodes) {
          const offset = node.getTextContent().indexOf(before);
          if (offset >= 0) {
            node.select(offset + before.length, offset + before.length);
            return;
          }
        }
        throw new Error(`No text node holds ${before}`);
      },
      { discrete: true },
    );
  });
  expect(textBeforeCaret(), "the fixture placed the caret").toMatch(new RegExp(`${before}$`));
}

/** The composer's text up to the caret, counting text nodes only (a marker chip has none). */
function textBeforeCaret(): string {
  return lexicalEditor()
    .getEditorState()
    .read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return "<no caret>";
      const anchor = selection.anchor.getNode();
      let text = "";
      for (const node of $getRoot().getAllTextNodes()) {
        if (node.is(anchor) && $isTextNode(anchor)) {
          return text + (anchor as TextNode).getTextContent().slice(0, selection.anchor.offset);
        }
        text += node.getTextContent();
      }
      return "<caret outside text>";
    });
}

function startCalls() {
  return fixture.dictationCalls.filter((call) => call.name === "start");
}

function setModeCalls() {
  return fixture.dictationCalls.filter((call) => call.name === "setMode");
}

function startedJob(index: number) {
  const call = startCalls()[index];
  expect(call, `Expected dictation start #${index + 1}`).toBeDefined();
  return call!.value as {
    environmentId: string;
    input: {
      jobId: string;
      attachmentId: string;
      durationMs: number;
      mode: DictationMode;
      target: DictationTarget;
    };
  };
}

function job(
  id: string,
  overrides: Partial<Omit<DictationJob, "id">> & Pick<DictationJob, "status">,
): DictationJob {
  return {
    id: DictationJobId.make(id),
    target: { kind: "thread", environmentId, threadId },
    mode: "inject",
    durationMs: 4_000,
    createdAt: now,
    ...overrides,
  };
}

async function pushJobs(jobs: ReadonlyArray<DictationJob>) {
  await act(async () => {
    fixture.jobs = [...jobs];
    fixture.jobsLoaded = true;
    for (const listener of fixture.jobListeners) listener();
  });
  await settle();
}

function transcriptionsNotices() {
  return vi
    .mocked(toastManager.add)
    .mock.calls.map(([toast]) => `${String(toast.title ?? "")} ${String(toast.description ?? "")}`)
    .filter((text) => /transcriptions/i.test(text));
}

/** Marker insertion may leave one or two spaces; the criteria are about order, not spacing. */
function squash(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function slotsIn(prompt: string | null) {
  return findDictationSlots(prompt ?? "");
}

// ── Specs ───────────────────────────────────────────────────────────────────

describe("dictation phase 4 fence", () => {
  it("dictation phase 4 AC1: the microphone button and the toggle command record with MediaRecorder behind the shipped strip controls", async () => {
    await mountApp();

    await startRecordingFromMicrophone();
    expect(media.constraints).toHaveLength(1);
    expect(media.constraints[0]).toEqual(expect.objectContaining({ audio: expect.anything() }));
    expect(media.recorders).toHaveLength(1);
    expect(media.recorders[0]!.options).toMatchObject({
      mimeType: "audio/webm;codecs=opus",
      audioBitsPerSecond: 32_000,
    });
    expect(media.recorders[0]!.calls).toContain("start");
    // The shipped DictationStripBanner controls.
    for (const label of [
      "Pause recording",
      "Restart recording",
      "Cancel dictation",
      "Stop and transcribe",
      "Delivery mode: submit",
    ]) {
      requireButton(label);
    }

    await click(requireButton("Pause recording"));
    expect(media.recorders[0]!.state).toBe("paused");
    await click(requireButton("Resume recording"));
    expect(media.recorders[0]!.state).toBe("recording");

    await click(requireButton("Cancel dictation"));
    expect(buttonLabelled("Stop and transcribe")).toBeUndefined();
    expect(fixture.uploads).toHaveLength(0);
    expect(startCalls()).toHaveLength(0);

    // The toggle command starts a recording, and the same command stops it.
    await pressKey(TOGGLE);
    expect(media.recorders).toHaveLength(2);
    expect(media.recorders[1]!.calls).toContain("start");
    requireButton("Stop and transcribe");
    await pressKey(TOGGLE);
    expect(media.recorders[1]!.calls).toContain("stop");
    expect(buttonLabelled("Stop and transcribe")).toBeUndefined();
    expect(startCalls()).toHaveLength(1);
  });

  it("dictation phase 4 AC2: Alt+S, Alt+I and Alt+Enter select the mode while recording and while the last job transcribes", async () => {
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Keep this draft");
    await mountApp();

    await startRecordingFromMicrophone();
    await pressKey(ALT_S);
    requireButton("Delivery mode: clipboard");
    await pressKey(ALT_I);
    requireButton("Delivery mode: inject");
    await stopRecordingFromStrip();
    const started = startedJob(0);
    expect(started.input.mode).toBe("inject");
    const jobId = started.input.jobId;

    // The last stopped job is still transcribing: the keys reach it through setMode.
    await pushJobs([job(jobId, { status: "transcribing", mode: "inject" })]);
    const editor = composerEditorElement();
    await pressKey(ALT_ENTER, editor);
    // Alt+Enter selected a mode; it did not send or clear the draft.
    expect(promptOf(onScreenTarget)).toContain("Keep this draft");
    expect(slotsIn(promptOf(onScreenTarget))).toHaveLength(1);
    await pressKey(ALT_S);
    expect(setModeCalls().map((call) => call.value)).toEqual([
      { environmentId, input: { jobId, mode: "submit" } },
      { environmentId, input: { jobId, mode: "clipboard" } },
    ]);
    // Save takes the stopped job's marker out of the draft at once.
    expect(promptOf(onScreenTarget)).toContain("Keep this draft");
    expect(slotsIn(promptOf(onScreenTarget))).toHaveLength(0);

    // Once the last job has completed, the keys select nothing.
    await pushJobs([job(jobId, { status: "completed", mode: "clipboard", text: "done" })]);
    await pressKey(ALT_I);
    expect(setModeCalls()).toHaveLength(2);
  });

  it("dictation phase 4 AC3: stopping drops the marker at the composer caret, then uploads and starts the job", async () => {
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Hello world");
    await mountApp();
    await placeCaretAfter("Hello");

    await startRecordingFromMicrophone();
    await stopRecordingFromStrip();

    const prompt = promptOf(onScreenTarget)!;
    const [slot, ...others] = slotsIn(prompt);
    expect(slot, `Expected one marker in ${JSON.stringify(prompt)}`).toBeDefined();
    expect(others).toHaveLength(0);
    expect(prompt.slice(0, slot!.start).trimEnd()).toBe("Hello");
    expect(prompt.slice(slot!.end).trimStart()).toBe("world");

    // Marker first, then the upload, then the job, all for the same id.
    expect(fixture.uploads).toHaveLength(1);
    expect(slotsIn(fixture.uploads[0]!.promptAtUpload).map((entry) => entry.jobId)).toEqual([
      slot!.jobId,
    ]);
    expect(fixture.uploads[0]!.upload).toMatchObject({
      type: "file",
      mimeType: expect.stringMatching(/^audio\/webm/),
      sizeBytes: 7,
    });
    expect(startedJob(0)).toEqual({
      environmentId,
      input: {
        jobId: slot!.jobId,
        attachmentId: "dictation-audio-1",
        durationMs: expect.any(Number),
        mode: "submit",
        target: { kind: "thread", environmentId, threadId },
      },
    });
    // The microphone is released and the strip goes away once recording stops.
    expect(media.stoppedTracks).toEqual([1]);
    expect(buttonLabelled("Stop and transcribe")).toBeUndefined();
  });

  it("dictation phase 4 AC3: a composer without a caret gets the marker at the end", async () => {
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Existing draft");
    await mountApp();
    // No caret: the editor holds no selection at all.
    await act(async () => {
      lexicalEditor().update(() => $setSelection(null), { discrete: true });
    });
    expect(textBeforeCaret()).toBe("<no caret>");

    await startRecordingFromMicrophone();
    await stopRecordingFromStrip();

    const prompt = promptOf(onScreenTarget)!;
    const [slot] = slotsIn(prompt);
    expect(slot, `Expected a marker in ${JSON.stringify(prompt)}`).toBeDefined();
    expect(prompt.slice(0, slot!.start).trimEnd()).toBe("Existing draft");
    expect(prompt.slice(slot!.end).trim()).toBe("");
    expect(startCalls()).toHaveLength(1);
  });

  it("dictation phase 4 AC4: the marker draws six stepped wave bars and the mode icon, and holds still under reduced motion", async () => {
    await mountApp();
    await startRecordingFromMicrophone();
    await stopRecordingFromStrip();
    const { jobId } = startedJob(0).input;
    await pushJobs([job(jobId, { status: "transcribing", mode: "submit" })]);

    const editor = composerEditorElement();
    const waves = editor.querySelectorAll('[aria-label="Transcribing"]');
    expect(waves, `Expected one marker wave; composer: ${editor.innerHTML}`).toHaveLength(1);
    expect(waves[0]!.children).toHaveLength(6);
    const chip = waves[0]!.parentElement!;
    expect(chip.querySelector('svg[data-material-symbol="send"]')).not.toBeNull();

    // The motion itself lives in the stylesheet: `dictation/dictationSlot.test.ts` pins it.
    expect(chip.classList.contains("dictation-slot")).toBe(true);
    expect(waves[0]!.classList.contains("dictation-slot-wave")).toBe(true);
  });

  it("dictation phase 4 AC5: a completed job replaces its marker on screen and in a draft that is not on screen", async () => {
    // A marker this client did not drop: another device's job, which only that device fills.
    const foreignJobId = "6f1c2a9e-0d3b-4c8e-9a51-2b7d4e8f0a13";
    const foreignDraft = `Before ${formatDictationSlot(DictationJobId.make(foreignJobId))} after`;
    useComposerDraftStore.getState().setPrompt(offScreenTarget, foreignDraft);
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Hello big world");
    await mountApp();
    await placeCaretAfter("Hello");
    // Insert mode: since phase 5, a send-mode draft sends itself once its markers fill.
    await recordInMode("insert");
    const first = startedJob(0).input.jobId;

    // The user moved on and dictated again after "big", past the first marker.
    await placeCaretAfter("big");
    await recordInMode("insert");
    const second = startedJob(1).input.jobId;
    expect(slotsIn(promptOf(onScreenTarget)).map((slot) => slot.jobId)).toEqual([first, second]);

    // On screen: the transcript replaces its marker and the caret stays after the second one.
    const foreignJob = job(foreignJobId, {
      status: "completed",
      text: "desde otro dispositivo",
      target: { kind: "thread", environmentId, threadId: offScreenThreadId },
    });
    await pushJobs([job(first, { status: "completed", text: "hola mundo" }), foreignJob]);
    expect(squash(promptOf(onScreenTarget)).replace(/\[Transcribing\]\([^)]*\)/, "<m>")).toBe(
      "Hello hola mundo big <m> world",
    );
    expect(squash(composerEditorElement().textContent)).toContain("Hello hola mundo big");
    expect(squash(textBeforeCaret())).toBe("Hello hola mundo big");

    // Not on screen: the thread's composer is gone and the draft is still filled.
    await navigateAwayFromThread();
    await pushJobs([
      job(first, { status: "completed", text: "hola mundo" }),
      job(second, { status: "completed", text: "desde lejos" }),
      foreignJob,
    ]);
    expect(squash(promptOf(onScreenTarget))).toBe("Hello hola mundo big desde lejos world");
    expect(promptOf(offScreenTarget)).toBe(foreignDraft);

    // A job is filled once: the same completed jobs arriving again change nothing.
    await pushJobs([
      job(first, { status: "completed", text: "hola mundo" }),
      job(second, { status: "completed", text: "desde lejos" }),
      foreignJob,
    ]);
    expect(squash(promptOf(onScreenTarget))).toBe("Hello hola mundo big desde lejos world");
    expect(promptOf(offScreenTarget)).toBe(foreignDraft);
    expect(transcriptionsNotices()).toEqual([]);
  });

  it("dictation phase 4 AC6: a completed job whose marker was deleted keeps its text in the Transcriptions list with one notice", async () => {
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Draft");
    await mountApp();
    // Insert mode: since phase 5, a send-mode draft sends itself once its markers fill.
    await recordInMode("insert");
    const { jobId } = startedJob(0).input;
    await pushJobs([job(jobId, { status: "transcribing" })]);

    // The user deletes the marker.
    await act(async () => {
      useComposerDraftStore.getState().setPrompt(onScreenTarget, "Draft edited");
    });
    await settle();

    await pushJobs([job(jobId, { status: "completed", text: "texto perdido" })]);
    expect(promptOf(onScreenTarget)).toBe("Draft edited");
    expect(transcriptionsNotices()).toHaveLength(1);

    await pushJobs([job(jobId, { status: "completed", text: "texto perdido" })]);
    expect(transcriptionsNotices()).toHaveLength(1);
  });

  it("dictation phase 4 AC7: save mode drops no marker and copies the text when it arrives", async () => {
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Untouched");
    await mountApp();
    await startRecordingFromMicrophone();
    await pressKey(ALT_S);
    await stopRecordingFromStrip();

    expect(promptOf(onScreenTarget)).toBe("Untouched");
    const started = startedJob(0);
    expect(started.input).toMatchObject({ mode: "clipboard", target: null });
    expect(fixture.uploads).toHaveLength(1);
    expect(writeText).not.toHaveBeenCalled();

    await pushJobs([
      job(started.input.jobId, {
        status: "completed",
        mode: "clipboard",
        target: null,
        text: "para el portapapeles",
      }),
    ]);
    expect(writeText).toHaveBeenCalledExactlyOnceWith("para el portapapeles");
    expect(promptOf(onScreenTarget)).toBe("Untouched");
    expect(transcriptionsNotices()).toEqual([]);
  });

  it("dictation phase 4 AC8: a second recording starts while the first job is still transcribing", async () => {
    await mountApp();
    await startRecordingFromMicrophone();
    await stopRecordingFromStrip();
    const first = startedJob(0).input.jobId;
    await pushJobs([job(first, { status: "transcribing", mode: "submit" })]);

    await startRecordingFromMicrophone();
    expect(media.recorders).toHaveLength(2);
    requireButton("Stop and transcribe");
    await stopRecordingFromStrip();

    const second = startedJob(1).input.jobId;
    expect(second).not.toBe(first);
    expect(fixture.uploads).toHaveLength(2);
    expect(slotsIn(promptOf(onScreenTarget)).map((slot) => slot.jobId)).toEqual(
      expect.arrayContaining([first, second]),
    );
    expect(slotsIn(promptOf(onScreenTarget))).toHaveLength(2);
  });
});

describe("dictation phase 4 regressions", () => {
  it("dictation phase 4 regression: after a page reload the mode keys steer the job that is still transcribing", async () => {
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Before the reload");
    await mountApp();
    await startRecordingFromMicrophone();
    await stopRecordingFromStrip();
    const { jobId } = startedJob(0).input;
    expect(persistComposerDrafts()).toBe(true);

    await reloadApp();
    // The subscription's snapshot arrives after the app is up, with the job still transcribing.
    await pushJobs([job(jobId, { status: "transcribing", mode: "submit" })]);
    await pressKey(ALT_I);
    await pressKey(ALT_S);
    expect(setModeCalls().map((call) => call.value)).toEqual([
      { environmentId, input: { jobId, mode: "inject" } },
      { environmentId, input: { jobId, mode: "clipboard" } },
    ]);
  });

  it("dictation phase 4 regression: two transcripts landing together keep the caret where the user left it", async () => {
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Hello big world");
    await mountApp();
    await placeCaretAfter("Hello");
    // Insert mode: since phase 5, a send-mode draft sends itself once its markers fill.
    await recordInMode("insert");
    await placeCaretAfter("world");
    await recordInMode("insert");
    const [first, second] = [startedJob(0).input.jobId, startedJob(1).input.jobId];
    // The user goes back between the two markers.
    await placeCaretAfter("big");

    await pushJobs([
      job(first, { status: "completed", text: "hola mundo" }),
      job(second, { status: "completed", text: "y adios" }),
    ]);
    expect(squash(promptOf(onScreenTarget))).toBe("Hello hola mundo big world y adios");
    expect(squash(textBeforeCaret())).toBe("Hello hola mundo big");
  });
});

describe("dictation phase 4 guards", () => {
  it("dictation phase 4 guard: typing into the composer and pressing Send still starts a turn with the text", async () => {
    await mountApp();
    const editor = composerEditorElement();
    await act(async () => {
      editor.focus();
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "Ship the dictation fence");
      editor.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
      );
    });
    await settle();
    expect(promptOf(onScreenTarget)).toBe("Ship the dictation fence");

    const sendButton = requireButton("Send message");
    await click(sendButton);
    const turns = fixture.dictationCalls.filter((call) => call.name === "startTurn");
    expect(turns).toHaveLength(1);
    expect(JSON.stringify(turns[0]!.value)).toContain("Ship the dictation fence");
    expect(fixture.uploads).toHaveLength(0);
    expect(startCalls()).toHaveLength(0);
  });
});

// ── Phase 5: send a draft when its last marker fills ────────────────────────

interface StartedTurn {
  readonly environmentId: string;
  readonly input: {
    readonly threadId: string;
    readonly commandId?: string;
    readonly message: {
      readonly text: string;
      readonly attachments: ReadonlyArray<Record<string, unknown>>;
    };
  };
}

function turnStarts(): StartedTurn[] {
  return fixture.dictationCalls
    .filter((call) => call.name === "startTurn")
    .map((call) => call.value as StartedTurn);
}

function onlyTurnText(): string {
  const turns = turnStarts();
  expect(turns, "Expected exactly one turn start").toHaveLength(1);
  return turns[0]!.input.message.text;
}

function respondCalls() {
  return fixture.dictationCalls.filter((call) => call.name === "respond");
}

const VOICED = "[voiced] ";

function voicedCount(text: string): number {
  return text.split("[voiced]").length - 1;
}

/** The send-when-ready banner, worded as in the prototype's `SendWhenReadyBanner`. */
function sendWhenReadyBannerShown(): boolean {
  return /sends when (the transcription|\d+ transcriptions) lands?/i.test(
    document.body.textContent ?? "",
  );
}

async function recordInMode(mode: "send" | "insert") {
  await startRecordingFromMicrophone();
  // The session starts in send mode; Alt+I selects insert.
  if (mode === "insert") await pressKey(ALT_I);
  await stopRecordingFromStrip();
}

const questionRequestId = ApprovalRequestId.make("dictation-phase-five-question");

function withOpenQuestion(thread: Thread): Thread {
  return {
    ...thread,
    activities: [
      {
        id: "dictation-phase-five-question-requested",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        turnId: null,
        createdAt: now,
        payload: {
          requestId: questionRequestId,
          questions: [
            {
              id: "scope",
              header: "Scope",
              question: "Which scope first?",
              multiSelect: false,
              options: [{ label: "Workspace", description: "Current workspace" }],
            },
          ],
        },
      },
    ],
  } as unknown as Thread;
}

function withPendingApproval(thread: Thread): Thread {
  return {
    ...thread,
    activities: [
      {
        id: "dictation-phase-five-approval-requested",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "info",
        turnId: null,
        createdAt: now,
        payload: {
          requestId: "dictation-phase-five-approval",
          requestType: "command_execution_approval",
          detail: "rm -rf build",
        },
      },
    ],
  } as unknown as Thread;
}

function questionAnswerText(): string {
  const key = pendingUserInputRequestKey(environmentId, threadId, questionRequestId);
  return usePendingUserInputDraftStore.getState().requests[key]?.answers.scope?.customAnswer ?? "";
}

const attachedFile: ComposerFileAttachment = {
  type: "file",
  id: "dictation-phase-five-file",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 12,
  file: null,
  uploadedAttachmentId: "uploaded-notes",
  uploadEnvironmentId: environmentId,
};

describe("dictation phase 5 fence", () => {
  it("dictation phase 5 AC1: a recording finished in send mode sends its draft once no marker remains", async () => {
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Hello big world");
    await mountApp();
    await placeCaretAfter("Hello");
    await recordInMode("send");
    await placeCaretAfter("world");
    await recordInMode("send");
    const [first, second] = [startedJob(0).input.jobId, startedJob(1).input.jobId];
    expect(turnStarts()).toHaveLength(0);

    // One marker is still pending: nothing leaves.
    await pushJobs([job(first, { status: "completed", mode: "submit", text: "hola mundo" })]);
    expect(turnStarts()).toHaveLength(0);
    expect(slotsIn(promptOf(onScreenTarget))).toHaveLength(1);

    await pushJobs([
      job(first, { status: "completed", mode: "submit", text: "hola mundo" }),
      job(second, { status: "completed", mode: "submit", text: "y adios" }),
    ]);
    expect(squash(onlyTurnText())).toBe("[voiced] Hello hola mundo big world y adios");
    expect(squash(promptOf(onScreenTarget))).toBe("");

    // The same completed jobs arriving again send nothing more.
    await pushJobs([
      job(first, { status: "completed", mode: "submit", text: "hola mundo" }),
      job(second, { status: "completed", mode: "submit", text: "y adios" }),
    ]);
    expect(turnStarts()).toHaveLength(1);
  });

  it("dictation phase 5 AC1: an armed draft stays armed across a page reload", async () => {
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Before the reload");
    await mountApp();
    await recordInMode("send");
    const { jobId } = startedJob(0).input;
    expect(persistComposerDrafts()).toBe(true);

    await reloadApp();
    await pushJobs([job(jobId, { status: "completed", mode: "submit", text: "después" })]);
    expect(squash(onlyTurnText())).toBe("[voiced] Before the reload después");
  });

  it("dictation phase 5 AC2: pressing Send while a marker is pending arms the draft and shows the banner", async () => {
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Draft");
    await mountApp();
    await recordInMode("insert");
    const { jobId } = startedJob(0).input;
    await pushJobs([job(jobId, { status: "transcribing", mode: "inject" })]);
    expect(sendWhenReadyBannerShown()).toBe(false);

    const send = requireButton("Send message");
    expect(send.disabled, "Send stays enabled so that pressing it can arm the draft").toBe(false);
    await click(send);
    expect(turnStarts()).toHaveLength(0);
    expect(slotsIn(promptOf(onScreenTarget))).toHaveLength(1);
    expect(sendWhenReadyBannerShown()).toBe(true);

    await pushJobs([job(jobId, { status: "completed", mode: "inject", text: "hola mundo" })]);
    expect(squash(onlyTurnText())).toBe("[voiced] Draft hola mundo");
    expect(sendWhenReadyBannerShown()).toBe(false);
  });

  it("dictation phase 5 AC3: Don't send disarms the draft and keeps its text", async () => {
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Draft");
    await mountApp();
    await recordInMode("send");
    const { jobId } = startedJob(0).input;
    await pushJobs([job(jobId, { status: "transcribing", mode: "submit" })]);
    expect(sendWhenReadyBannerShown()).toBe(true);

    await click(requireButton("Don't send"));
    expect(sendWhenReadyBannerShown()).toBe(false);

    await pushJobs([job(jobId, { status: "completed", mode: "submit", text: "hola mundo" })]);
    expect(turnStarts()).toHaveLength(0);
    expect(squash(promptOf(onScreenTarget))).toBe("Draft hola mundo");
  });

  it("dictation phase 5 AC4: an armed draft whose thread is not on screen sends through the directed path with its files and is cleared", async () => {
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Read the notes");
    // Attached as the composer attaches it: the file's chip goes into the prompt.
    useComposerDraftStore
      .getState()
      .addFiles(onScreenTarget, [attachedFile], { appendReference: true });
    await mountApp();
    await recordInMode("send");
    const { jobId } = startedJob(0).input;
    await navigateAwayFromThread();

    await pushJobs([job(jobId, { status: "completed", mode: "submit", text: "y resume" })]);
    const turns = turnStarts();
    expect(turns).toHaveLength(1);
    const [turn] = turns;
    expect(turn!.environmentId).toBe(environmentId);
    expect(turn!.input.threadId).toBe(threadId);
    // The job id of the last filled marker is the command id, so a repeat is deduplicated.
    expect(turn!.input.commandId).toBe(jobId);
    const text = squash(turn!.input.message.text);
    expect(text.startsWith("[voiced] Read the notes"), text).toBe(true);
    expect(text.endsWith("y resume"), text).toBe(true);
    expect(voicedCount(text)).toBe(1);
    expect(turn!.input.message.attachments).toEqual([
      expect.objectContaining({ type: "file", name: "notes.txt" }),
    ]);
    const draft = useComposerDraftStore.getState().getComposerDraft(onScreenTarget);
    expect(squash(draft?.prompt)).toBe("");
    expect(draft?.files ?? []).toHaveLength(0);

    await pushJobs([job(jobId, { status: "completed", mode: "submit", text: "y resume" })]);
    expect(turnStarts()).toHaveLength(1);
  });

  it("dictation phase 5 AC5: a message with dictated parts carries one [voiced] prefix, and a typed one carries none", async () => {
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Hello big world");
    await mountApp();
    await placeCaretAfter("Hello");
    await recordInMode("insert");
    await placeCaretAfter("world");
    await recordInMode("insert");
    const [first, second] = [startedJob(0).input.jobId, startedJob(1).input.jobId];
    await pushJobs([
      job(first, { status: "completed", mode: "inject", text: "hola mundo" }),
      job(second, { status: "completed", mode: "inject", text: "y adios" }),
    ]);
    expect(turnStarts()).toHaveLength(0);
    expect(slotsIn(promptOf(onScreenTarget))).toHaveLength(0);

    await click(requireButton("Send message"));
    const text = onlyTurnText();
    expect(text.startsWith(VOICED), JSON.stringify(text)).toBe(true);
    expect(voicedCount(text)).toBe(1);
    expect(squash(text)).toBe("[voiced] Hello hola mundo big world y adios");

    // The next message is typed only; the dictated flag went with the last send. A reload
    // stands in for the server's echo, which this fixture never sends to end the first send.
    await reloadApp();
    const freshDrafts = (await import("./composerDraftStore")).useComposerDraftStore;
    await act(async () => {
      freshDrafts.getState().setPrompt(onScreenTarget, "Typed by hand");
    });
    await settle();
    await click(requireButton("Send message"));
    const typed = turnStarts()[1]?.input.message.text;
    expect(typed).toBe("Typed by hand");
  });

  it("dictation phase 5 AC6: a failed marker keeps the draft armed and unsent until a retry fills it", async () => {
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Hello world");
    await mountApp();
    await placeCaretAfter("Hello");
    await recordInMode("send");
    const { jobId } = startedJob(0).input;

    await pushJobs([job(jobId, { status: "failed", mode: "submit", failure: "Network error" })]);
    expect(turnStarts()).toHaveLength(0);
    expect(slotsIn(promptOf(onScreenTarget))).toHaveLength(1);
    expect(sendWhenReadyBannerShown()).toBe(true);

    await click(requireButton("Retry transcription"));
    expect(fixture.dictationCalls.filter((call) => call.name === "retry")).toHaveLength(1);
    await pushJobs([job(jobId, { status: "transcribing", mode: "submit" })]);
    expect(turnStarts()).toHaveLength(0);
    await pushJobs([job(jobId, { status: "completed", mode: "submit", text: "hola mundo" })]);
    expect(squash(onlyTurnText())).toBe("[voiced] Hello hola mundo world");
  });

  it("dictation phase 5 AC6: discarding the failed marker sends what the draft holds", async () => {
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Hello world");
    await mountApp();
    await placeCaretAfter("Hello");
    await recordInMode("send");
    const { jobId } = startedJob(0).input;
    await pushJobs([job(jobId, { status: "failed", mode: "submit", failure: "Network error" })]);
    expect(turnStarts()).toHaveLength(0);
    expect(sendWhenReadyBannerShown()).toBe(true);

    await click(requireButton("Discard transcription marker"));
    // Nothing was dictated into the message that leaves.
    expect(squash(onlyTurnText())).toBe("Hello world");
  });

  it("dictation phase 5 AC7: a recording stopped while a question card has focus fills the card's answer, and send mode submits it", async () => {
    fixture.thread = withOpenQuestion(makeThread());
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Composer draft");
    await mountApp();
    const field = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Which scope first?"]',
    );
    expect(field, "Expected the question card's answer field").not.toBeNull();
    await act(async () => field!.focus());
    await settle();

    const microphone = requireButton("Dictate into Scope");
    expect(microphone.getAttribute("aria-disabled")).not.toBe("true");
    await click(microphone);
    expect(media.recorders).toHaveLength(1);
    await stopRecordingFromStrip();

    const { jobId } = startedJob(0).input;
    expect(slotsIn(questionAnswerText()).map((slot) => slot.jobId)).toEqual([jobId]);
    expect(promptOf(onScreenTarget)).toBe("Composer draft");
    expect(respondCalls()).toHaveLength(0);

    await pushJobs([job(jobId, { status: "completed", mode: "submit", text: "solo la web" })]);
    expect(respondCalls()).toHaveLength(1);
    const response = JSON.stringify(respondCalls()[0]!.value);
    expect(response).toContain(questionRequestId);
    expect(response).toContain("[voiced] solo la web");
    expect(response).not.toContain("t3-context://");
    expect(turnStarts()).toHaveLength(0);
    expect(promptOf(onScreenTarget)).toBe("Composer draft");
  });
});

describe("dictation phase 5 guards", () => {
  it("dictation phase 5 guard: a filled send-mode draft is not sent while a button approval is pending", async () => {
    fixture.thread = withPendingApproval(makeThread());
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Draft");
    await mountApp();
    await pressKey(TOGGLE);
    await pressKey(TOGGLE);
    const { jobId, mode } = startedJob(0).input;
    expect(mode).toBe("submit");

    await pushJobs([job(jobId, { status: "completed", mode: "submit", text: "hola mundo" })]);
    expect(turnStarts()).toHaveLength(0);
    expect(squash(promptOf(onScreenTarget))).toBe("Draft hola mundo");
  });
});

describe("dictation phase 5 rework regressions", () => {
  async function focusQuestionAnswer(): Promise<HTMLTextAreaElement> {
    const field = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Which scope first?"]',
    );
    expect(field, "Expected the question card's answer field").not.toBeNull();
    await act(async () => field!.focus());
    await settle();
    return field!;
  }

  async function recordIntoQuestion(mode: "send" | "insert") {
    await click(requireButton("Dictate into Scope"));
    if (mode === "insert") await pressKey(ALT_I);
    await stopRecordingFromStrip();
  }

  it("dictation phase 5 regression: what the user writes while an armed send is acknowledged stays in the draft", async () => {
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Draft");
    await mountApp();
    await recordInMode("send");
    const { jobId } = startedJob(0).input;
    await navigateAwayFromThread();
    let release: () => void = () => undefined;
    fixture.startTurnGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    await pushJobs([job(jobId, { status: "completed", mode: "submit", text: "hola mundo" })]);
    expect(turnStarts()).toHaveLength(1);
    await act(async () => {
      useComposerDraftStore.getState().setPrompt(onScreenTarget, "Next message");
    });
    await act(async () => release());
    await settle();

    expect(squash(onlyTurnText())).toBe("[voiced] Draft hola mundo");
    expect(promptOf(onScreenTarget)).toBe("Next message");
  });

  it("dictation phase 5 regression: an edit made while an armed draft's files upload goes out with it", async () => {
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Read the notes");
    useComposerDraftStore
      .getState()
      // Its own file: the upload state of `attachedFile` outlives the earlier specs.
      .addFiles(onScreenTarget, [{ ...attachedFile, id: "dictation-phase-five-edited-file" }], {
        appendReference: true,
      });
    // The check of the file's earlier upload is still out when the transcript lands.
    let release: () => void = () => undefined;
    fixture.verifyGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await mountApp();
    await recordInMode("send");
    const { jobId } = startedJob(0).input;
    await navigateAwayFromThread();

    await pushJobs([job(jobId, { status: "completed", mode: "submit", text: "y resume" })]);
    expect(turnStarts()).toHaveLength(0);
    await act(async () => {
      const draft = useComposerDraftStore.getState().getComposerDraft(onScreenTarget)!;
      useComposerDraftStore.getState().setPrompt(onScreenTarget, `${draft.prompt} con cuidado`);
    });
    await act(async () => release());
    await settle();

    const text = squash(onlyTurnText());
    expect(text.startsWith("[voiced] Read the notes"), text).toBe(true);
    expect(text).toContain("y resume con cuidado");
    expect(squash(promptOf(onScreenTarget))).toBe("");
  });

  it("dictation phase 5 regression: an armed send the server refuses puts the draft back and stays unsent", async () => {
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Draft");
    await mountApp();
    await recordInMode("send");
    const { jobId } = startedJob(0).input;
    await navigateAwayFromThread();
    fixture.startTurnFails = true;

    await pushJobs([job(jobId, { status: "completed", mode: "submit", text: "hola mundo" })]);
    expect(turnStarts()).toHaveLength(1);
    expect(squash(promptOf(onScreenTarget))).toBe("Draft hola mundo");
    expect(vi.mocked(toastManager.add).mock.calls.map(([toast]) => toast.title)).toContain(
      "The dictated message was not sent",
    );
  });

  it("dictation phase 5 regression: a failed upload keeps the marker and the armed draft until Retry starts the job", async () => {
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Must wait");
    fixture.failingUploads = 1;
    await mountApp();
    await recordInMode("send");

    expect(startCalls()).toHaveLength(0);
    expect(slotsIn(promptOf(onScreenTarget))).toHaveLength(1);
    expect(turnStarts()).toHaveLength(0);
    expect(sendWhenReadyBannerShown()).toBe(true);

    await click(requireButton("Retry transcription"));
    expect(fixture.uploads).toHaveLength(2);
    const { jobId } = startedJob(0).input;
    expect(slotsIn(promptOf(onScreenTarget)).map((slot) => slot.jobId)).toEqual([jobId]);
    expect(turnStarts()).toHaveLength(0);

    await pushJobs([job(jobId, { status: "completed", mode: "submit", text: "el texto" })]);
    expect(squash(onlyTurnText())).toBe("[voiced] Must wait el texto");
  });

  it("dictation phase 5 regression: a send-mode answer is submitted with its voiced tag while its thread is not on screen", async () => {
    fixture.thread = withOpenQuestion(makeThread());
    await mountApp();
    await focusQuestionAnswer();
    await recordIntoQuestion("send");
    const { jobId } = startedJob(0).input;
    await navigateAwayFromThread();

    await pushJobs([
      job(jobId, { status: "completed", mode: "submit", text: "fuera de pantalla" }),
    ]);
    expect(respondCalls()).toHaveLength(1);
    expect(respondCalls()[0]!.value).toMatchObject({
      environmentId,
      input: {
        threadId,
        requestId: questionRequestId,
        answers: { scope: "[voiced] fuera de pantalla" },
      },
    });
  });

  it("dictation phase 5 regression: Submit with a pending answer marker shows the banner, and Don't send keeps the answer unsent", async () => {
    fixture.thread = withOpenQuestion(makeThread());
    await mountApp();
    await focusQuestionAnswer();
    await recordIntoQuestion("insert");
    const { jobId } = startedJob(0).input;
    expect(sendWhenReadyBannerShown()).toBe(false);

    await click(requireButton("Submit"));
    expect(respondCalls()).toHaveLength(0);
    expect(sendWhenReadyBannerShown()).toBe(true);

    await click(requireButton("Don't send"));
    expect(sendWhenReadyBannerShown()).toBe(false);
    await pushJobs([job(jobId, { status: "completed", mode: "inject", text: "respuesta" })]);
    expect(respondCalls()).toHaveLength(0);
    expect(questionAnswerText()).toBe("respuesta");
  });

  it("dictation phase 5 regression: the answer's marker goes at the field's caret", async () => {
    fixture.thread = withOpenQuestion(makeThread());
    await mountApp();
    const field = await focusQuestionAnswer();
    await act(async () => {
      editPendingUserInputAnswerText(
        pendingUserInputRequestKey(environmentId, threadId, questionRequestId),
        "scope",
        () => "Hello world",
      );
    });
    await settle();
    expect(questionAnswerText()).toBe("Hello world");
    field.setSelectionRange(5, 5);

    await recordIntoQuestion("insert");
    const answer = questionAnswerText();
    const [slot] = slotsIn(answer);
    expect(slot, `Expected a marker in ${JSON.stringify(answer)}`).toBeDefined();
    expect(answer.slice(0, slot!.start).trimEnd()).toBe("Hello");
    expect(answer.slice(slot!.end).trimStart()).toBe("world");
  });

  it("dictation phase 5 regression: a dictated draft that goes to the queue keeps its voiced tag", async () => {
    // An open question makes Send queue the message.
    fixture.thread = withOpenQuestion(makeThread());
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Queued");
    await mountApp();
    await recordInMode("insert");
    const { jobId } = startedJob(0).input;
    await pushJobs([job(jobId, { status: "completed", mode: "inject", text: "dictado" })]);

    await click(requireButton(/^(Send message|Queue message)$/));
    expect(turnStarts()).toHaveLength(0);
    const queued =
      useQueuedMessageStore.getState().queuesByThreadKey[scopedThreadKey(onScreenTarget)];
    expect(JSON.stringify(queued)).toContain("[voiced] Queued dictado");
  });

  it("dictation phase 5 regression: a file sent off screen carries its context record, so its reference resolves", async () => {
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Read the notes");
    useComposerDraftStore
      .getState()
      .addFiles(onScreenTarget, [attachedFile], { appendReference: true });
    await mountApp();
    await recordInMode("send");
    const { jobId } = startedJob(0).input;
    await navigateAwayFromThread();

    await pushJobs([job(jobId, { status: "completed", mode: "submit", text: "y resume" })]);
    const text = onlyTurnText();
    // A server without inline context gets the record serialized: the raw link is replaced.
    expect(text).not.toContain("t3-context://");
    expect(text).toContain("notes.txt");
  });
});

// ── Phase 6: the desktop command line and the widget ───────────────────────

/**
 * The preload's `mesuraDictationBridge`, looped back: what the app publishes for the widget
 * reaches the widget page's listener, as the main process relays it to the widget window.
 */
function installLoopbackDesktopBridge() {
  const commandListeners = new Set<(command: unknown) => void>();
  const widgetListeners = new Set<(state: unknown) => void>();
  const published: unknown[] = [];
  const bridge = {
    onCommandLine: (listener: (command: unknown) => void) => {
      commandListeners.add(listener);
      return () => void commandListeners.delete(listener);
    },
    acknowledgeWidgetState: (_sequence: number) => undefined,
    publishWidgetState: (state: unknown) => {
      published.push(state);
      for (const listener of widgetListeners) listener(state);
    },
    onWidgetState: (listener: (state: unknown) => void) => {
      widgetListeners.add(listener);
      if (published.length > 0) listener(published.at(-1));
      return () => void widgetListeners.delete(listener);
    },
  };
  Object.assign(window, { mesuraDictationBridge: bridge });
  return {
    published,
    /** What a second launch with `--dictation …` hands the renderer. */
    async forward(command: string) {
      expect(commandListeners.size, "Expected the app to listen for forwarded commands").toBe(1);
      await act(async () => {
        for (const listener of commandListeners) listener(command);
      });
      await settle();
    },
  };
}

let widgetRoot: Root | undefined;
let widgetContainer: HTMLDivElement | undefined;

async function mountWidgetPage() {
  widgetContainer = document.createElement("div");
  document.body.append(widgetContainer);
  await act(async () => {
    widgetRoot = createRoot(widgetContainer!);
    widgetRoot.render(<DictationWidgetPage />);
  });
  return widgetContainer;
}

describe("dictation phase 6 fence", () => {
  // The widget draws module state an earlier test's stopped recording may have left behind.
  beforeEach(() => {
    useDictationSessionStore.setState({ session: null, lastJob: null });
    useDictationWidgetActivityStore.setState({ transcribing: {}, delivered: null, failed: null });
  });

  afterEach(async () => {
    await act(async () => widgetRoot?.unmount());
    widgetRoot = undefined;
    widgetContainer?.remove();
    widgetContainer = undefined;
    Reflect.deleteProperty(window, "mesuraDictationBridge");
  });

  it("dictation phase 6 AC1: a forwarded toggle records in the running app, and a second one stops into the composer", async () => {
    const desktop = installLoopbackDesktopBridge();
    await mountApp();

    await desktop.forward("dictation.toggle");
    expect(media.recorders).toHaveLength(1);
    expect(media.recorders[0]!.calls).toContain("start");
    requireButton("Stop and transcribe");

    await desktop.forward("dictation.toggle");
    expect(media.recorders[0]!.calls).toContain("stop");
    expect(startCalls()).toHaveLength(1);
    expect(slotsIn(promptOf(onScreenTarget))).toHaveLength(1);
  });

  it("dictation phase 6 AC2: forwarded mode, pause, restart and cancel steer the recording like the in-window keys", async () => {
    const desktop = installLoopbackDesktopBridge();
    await mountApp();
    await desktop.forward("dictation.toggle");

    await desktop.forward("dictation.mode.inject");
    requireButton("Delivery mode: inject");
    await desktop.forward("dictation.mode.clipboard");
    requireButton("Delivery mode: clipboard");
    await desktop.forward("dictation.mode.submit");
    requireButton("Delivery mode: submit");

    await desktop.forward("dictation.pause");
    expect(media.recorders[0]!.state).toBe("paused");
    await desktop.forward("dictation.pause");
    expect(media.recorders[0]!.state).toBe("recording");

    await desktop.forward("dictation.restart");
    expect(media.recorders).toHaveLength(2);
    expect(media.recorders[1]!.calls).toContain("start");

    await desktop.forward("dictation.cancel");
    expect(buttonLabelled("Stop and transcribe")).toBeUndefined();
    expect(fixture.uploads).toHaveLength(0);
    expect(startCalls()).toHaveLength(0);
  });

  it("dictation phase 6 AC1: with the thread off screen, a forwarded stop drops the marker into the last composer shown", async () => {
    const desktop = installLoopbackDesktopBridge();
    await mountApp();
    await navigateAwayFromThread();

    await desktop.forward("dictation.toggle");
    await desktop.forward("dictation.toggle");
    expect(startedJob(0).input.target).toEqual({ kind: "thread", environmentId, threadId });
    expect(slotsIn(promptOf(onScreenTarget))).toHaveLength(1);
  });

  it("dictation phase 6 AC3: the widget page draws the timer, the waveform, the mode and the target of the recording", async () => {
    const desktop = installLoopbackDesktopBridge();
    await mountApp();
    const widget = await mountWidgetPage();
    expect(widget.textContent ?? "").toBe("");

    await desktop.forward("dictation.toggle");
    const text = widget.textContent ?? "";
    expect(text, `widget: ${widget.innerHTML}`).toMatch(/\b\d{2}:\d{2}\b/);
    expect(text).toContain("Dictation fence");
    expect(widget.querySelector("[data-dictation-waveform]")).not.toBeNull();
    expect(widget.querySelector('svg[data-material-symbol="send"]')).not.toBeNull();

    await desktop.forward("dictation.mode.clipboard");
    expect(widget.querySelector('svg[data-material-symbol="content_copy"]')).not.toBeNull();
    expect(desktop.published.at(-1)).toMatchObject({ recording: true });

    await desktop.forward("dictation.cancel");
    expect(widget.textContent ?? "").toBe("");
    expect(desktop.published.at(-1)).toMatchObject({
      recording: false,
      transcribing: false,
      deliveredAt: null,
    });
  });

  it("dictation phase 6 AC3: a stopped recording publishes its transcription, and the widget says it is transcribing", async () => {
    const desktop = installLoopbackDesktopBridge();
    await mountApp();
    const widget = await mountWidgetPage();
    await desktop.forward("dictation.toggle");
    await desktop.forward("dictation.mode.inject");
    await desktop.forward("dictation.toggle");
    const { jobId } = startedJob(0).input;
    await pushJobs([job(jobId, { status: "transcribing", mode: "inject" })]);

    expect(desktop.published.at(-1)).toMatchObject({ recording: false, transcribing: true });
    expect(widget.textContent ?? "").toMatch(/transcribing/i);
  });

  it("dictation phase 6 AC4: a delivered transcript publishes its delivery time, and the widget shows the result", async () => {
    const desktop = installLoopbackDesktopBridge();
    await mountApp();
    const widget = await mountWidgetPage();
    await desktop.forward("dictation.toggle");
    await desktop.forward("dictation.mode.inject");
    await desktop.forward("dictation.toggle");
    const { jobId } = startedJob(0).input;
    await pushJobs([job(jobId, { status: "completed", mode: "inject", text: "hola mundo" })]);

    const last = desktop.published.at(-1) as { deliveredAt?: unknown };
    expect(last).toMatchObject({ recording: false, transcribing: false });
    expect(typeof last.deliveredAt).toBe("number");
    expect(widget.textContent ?? "").not.toBe("");
  });
});

describe("dictation phase 6 regressions", () => {
  beforeEach(() => {
    useDictationSessionStore.setState({ session: null, lastJob: null });
    useDictationWidgetActivityStore.setState({ transcribing: {}, delivered: null, failed: null });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "mesuraDictationBridge");
  });

  it("dictation phase 6 regression: a stop goes straight from recording to transcribing, with no idle frame that would hide the widget", async () => {
    const desktop = installLoopbackDesktopBridge();
    await mountApp();
    await desktop.forward("dictation.toggle");
    const fromStop = desktop.published.length;
    await desktop.forward("dictation.toggle");

    const afterStop = desktop.published.slice(fromStop) as Array<{
      recording: boolean;
      transcribing: boolean;
      deliveredAt: number | null;
    }>;
    expect(afterStop.length).toBeGreaterThan(0);
    for (const frame of afterStop) {
      expect(
        frame.recording || frame.transcribing || frame.deliveredAt !== null,
        JSON.stringify(frame),
      ).toBe(true);
    }
    expect(afterStop.at(-1)).toMatchObject({ recording: false, transcribing: true });
  });
});

describe("dictation phase 6 fence: a failed transcription", () => {
  beforeEach(() => {
    useDictationSessionStore.setState({ session: null, lastJob: null });
    useDictationWidgetActivityStore.setState({ transcribing: {}, delivered: null, failed: null });
  });

  afterEach(async () => {
    await act(async () => widgetRoot?.unmount());
    widgetRoot = undefined;
    widgetContainer?.remove();
    widgetContainer = undefined;
    Reflect.deleteProperty(window, "mesuraDictationBridge");
  });

  async function recordAndFail(desktop: ReturnType<typeof installLoopbackDesktopBridge>) {
    await desktop.forward("dictation.toggle");
    await desktop.forward("dictation.mode.inject");
    await desktop.forward("dictation.toggle");
    const { jobId } = startedJob(0).input;
    await pushJobs([job(jobId, { status: "transcribing", mode: "inject" })]);
    await pushJobs([
      job(jobId, { status: "failed", mode: "inject", failure: "The provider timed out." }),
    ]);
  }

  it("dictation phase 6 failure: this device's failed job reaches the widget with the target", async () => {
    const desktop = installLoopbackDesktopBridge();
    await mountApp();
    const widget = await mountWidgetPage();
    await recordAndFail(desktop);

    const last = desktop.published.at(-1) as { failedAt?: unknown };
    expect(last).toMatchObject({ recording: false, transcribing: false });
    expect(typeof last.failedAt).toBe("number");
    expect(widget.textContent).toBe(
      "Transcription failed in Dictation fence. Open Mesura to retry.",
    );
  });

  it("dictation phase 6 failure: a new recording replaces the failure in the widget", async () => {
    const desktop = installLoopbackDesktopBridge();
    await mountApp();
    const widget = await mountWidgetPage();
    await recordAndFail(desktop);

    await desktop.forward("dictation.toggle");
    expect(desktop.published.at(-1)).toMatchObject({ recording: true, failedAt: null });
    expect(widget.textContent ?? "").not.toMatch(/failed/i);
    expect(widget.querySelector("[data-dictation-waveform]")).not.toBeNull();
    await desktop.forward("dictation.cancel");
  });

  it("dictation phase 6 failure: a failed job this device did not start is not a widget failure", async () => {
    const desktop = installLoopbackDesktopBridge();
    await mountApp();
    const widget = await mountWidgetPage();
    await pushJobs([
      job("6c1f0b5e-6a4b-4b8e-9d3a-1f2e3d4c5b6a", { status: "transcribing", mode: "inject" }),
    ]);
    await pushJobs([
      job("6c1f0b5e-6a4b-4b8e-9d3a-1f2e3d4c5b6a", { status: "failed", mode: "inject" }),
    ]);
    expect(desktop.published.at(-1)).toMatchObject({ failedAt: null });
    expect(widget.textContent).toBe("");
  });
});

describe("dictation phase 6 rework", () => {
  beforeEach(() => {
    useDictationSessionStore.setState({ session: null, lastJob: null });
    useDictationWidgetActivityStore.setState({ transcribing: {}, delivered: null, failed: null });
  });

  afterEach(async () => {
    await act(async () => widgetRoot?.unmount());
    widgetRoot = undefined;
    widgetContainer?.remove();
    widgetContainer = undefined;
    Reflect.deleteProperty(window, "mesuraDictationBridge");
  });

  it("dictation phase 6 rework: a retried job that fails again reports the new failure", async () => {
    const desktop = installLoopbackDesktopBridge();
    await mountApp();
    const widget = await mountWidgetPage();
    await desktop.forward("dictation.toggle");
    await desktop.forward("dictation.mode.inject");
    await desktop.forward("dictation.toggle");
    const { jobId } = startedJob(0).input;
    await pushJobs([job(jobId, { status: "transcribing", mode: "inject" })]);
    await pushJobs([
      job(jobId, { status: "failed", mode: "inject", completedAt: "2026-10-03T12:00:05.000Z" }),
    ]);
    const first = (desktop.published.at(-1) as { failedAt: number | null }).failedAt;
    expect(typeof first).toBe("number");

    // Retried with the same id: transcribing again clears the old notice ...
    await pushJobs([job(jobId, { status: "transcribing", mode: "inject" })]);
    expect(desktop.published.at(-1)).toMatchObject({ transcribing: true, failedAt: null });
    // ... and its next failure is a new one.
    await pushJobs([
      job(jobId, { status: "failed", mode: "inject", completedAt: "2026-10-03T12:00:09.000Z" }),
    ]);
    const second = (desktop.published.at(-1) as { failedAt: number | null }).failedAt;
    expect(second).toBeGreaterThan(first!);
    expect(widget.textContent).toBe(
      "Transcription failed in Dictation fence. Open Mesura to retry.",
    );
  });

  it("dictation phase 6 rework: level samples are published only while the window does not have focus", async () => {
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const desktop = installLoopbackDesktopBridge();
    await mountApp();
    await desktop.forward("dictation.toggle");
    const whileFocused = desktop.published.length;
    // The recorder samples the level every 100 ms.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 450)));
    expect(desktop.published.length).toBe(whileFocused);

    // A lifecycle change still goes out with focus.
    await desktop.forward("dictation.mode.inject");
    expect(desktop.published.length).toBe(whileFocused + 1);

    focus.mockReturnValue(false);
    const unfocused = desktop.published.length;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 450)));
    expect(desktop.published.length).toBeGreaterThanOrEqual(unfocused + 3);
    await desktop.forward("dictation.cancel");
  });
});

describe("dictation phase 6 repair: Retry from the marker", () => {
  beforeEach(() => {
    useDictationSessionStore.setState({ session: null, lastJob: null });
    useDictationWidgetActivityStore.setState({ transcribing: {}, delivered: null, failed: null });
  });

  afterEach(async () => {
    await act(async () => widgetRoot?.unmount());
    widgetRoot = undefined;
    widgetContainer?.remove();
    widgetContainer = undefined;
    Reflect.deleteProperty(window, "mesuraDictationBridge");
  });

  it("dictation phase 6 repair: the marker's Retry that fails again shows a new failure, with no transcribing in between", async () => {
    const desktop = installLoopbackDesktopBridge();
    await mountApp();
    const widget = await mountWidgetPage();
    await desktop.forward("dictation.toggle");
    await desktop.forward("dictation.mode.inject");
    await desktop.forward("dictation.toggle");
    const { jobId } = startedJob(0).input;
    const failedAt = (completedAt: string) =>
      job(jobId, {
        status: "failed",
        mode: "inject",
        failure: "Add an OpenAI API key in Settings → Dictation.",
        completedAt,
      });
    await pushJobs([failedAt("2026-10-03T12:00:05.000Z")]);
    const first = (desktop.published.at(-1) as { failedAt: number | null }).failedAt;
    expect(typeof first).toBe("number");

    // The same path the chip takes: its Retry button, then the server's retry command.
    await click(requireButton("Retry transcription"));
    expect(fixture.dictationCalls.filter((call) => call.name === "retry")).toHaveLength(1);
    expect(desktop.published.at(-1)).toMatchObject({ failedAt: null });

    // The server publishes the retry only when its attempt ends: one coalesced `failed`.
    await pushJobs([failedAt("2026-10-03T12:00:09.000Z")]);
    const second = (desktop.published.at(-1) as { failedAt: number | null }).failedAt;
    expect(second).toBeGreaterThan(first!);
    expect(widget.textContent).toBe(
      "Transcription failed in Dictation fence. Open Mesura to retry.",
    );

    // The same failed attempt arriving again is not a new failure.
    const published = desktop.published.length;
    await pushJobs([
      failedAt("2026-10-03T12:00:09.000Z"),
      job("unrelated", { status: "transcribing" }),
    ]);
    expect(
      desktop.published
        .slice(published)
        .filter((frame) => (frame as { failedAt: unknown }).failedAt !== second),
    ).toEqual([]);
  });
});

// Phase 8 removes Symmetria Shell's dictation link. The strip stops reading a
// Shell session shape (the `HACK` in `dictation/DictationControls.tsx`), and the
// question card stops keeping Shell's microphone (the `WORKAROUND` in
// `InlinePendingUserInputCard.tsx`). "dictation phase 5 AC7" pins the card's
// microphone on the server path; this pins the strip.
describe("dictation phase 8 guards", () => {
  it("dictation phase 8 guard: the composer strip shows a Mesura recording's phase, timer and mode", async () => {
    await mountApp();
    await startRecordingFromMicrophone();

    const strips = document.querySelectorAll<HTMLElement>(".mesura-dictation-strip");
    expect(strips).toHaveLength(1);
    const strip = strips[0]!;
    expect(strip.getAttribute("data-phase")).toBe("recording");
    expect(strip.querySelector('[aria-label="Voice dictation: Recording"]')).not.toBeNull();
    expect(strip.textContent).toMatch(/\d+:\d{2}/);
    expect(strip.querySelector('[aria-label="Delivery mode: submit"]')).not.toBeNull();

    await click(requireButton("Pause recording"));
    expect(strip.getAttribute("data-phase")).toBe("paused");
    expect(strip.querySelector('[aria-label="Voice dictation: Paused"]')).not.toBeNull();
    await click(requireButton("Resume recording"));
    expect(strip.getAttribute("data-phase")).toBe("recording");

    await click(requireButton("Delivery mode: submit"));
    expect(strip.querySelector('[aria-label="Delivery mode: submit"]')).toBeNull();
    expect(strip.querySelector('[aria-label^="Delivery mode: "]')).not.toBeNull();

    await stopRecordingFromStrip();
    expect(document.querySelector(".mesura-dictation-strip")).toBeNull();
  });
});
