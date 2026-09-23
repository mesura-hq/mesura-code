// @vitest-environment happy-dom
// Application entry point: NewTaskRouteScreen (RootStack > NewTaskSheet > NewTask),
// mounted with its production NewTaskFlowProvider. Native views/navigation and
// environment I/O are test boundaries; project selection and task construction are real.
import { act, useLayoutEffect, useSyncExternalStore, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ServerConfig,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { QueuedThreadMessage } from "../../state/thread-outbox";
import type { ComposerDraft } from "../../state/use-composer-drafts";

const fixture = vi.hoisted(() => ({
  drafts: {} as Record<string, ComposerDraft>,
  queued: [] as QueuedThreadMessage[],
  flush: vi.fn(async () => true),
  listeners: new Set<() => void>(),
  nextDraft: 0,
  repositoryPending: false,
  connectionPhase: "connected",
  repositoryContents:
    '{"version":1,"defaultThreadEnvMode":"worktree","defaultModelSelection":{"provider":"codex","model":"portable-model"}}',
  reads: vi.fn(),
  navigation: {
    getState: () => ({ index: 1, routes: [{ name: "NewTaskDraft" }, { name: "NewTask" }] }),
    goBack: vi.fn(),
    dispatch: vi.fn(),
  },
}));

const primaryId = EnvironmentId.make("p2-primary");
const remoteId = EnvironmentId.make("p2-remote");
const projectId = ProjectId.make("p2-project");
const projects: EnvironmentProject[] = [primaryId, remoteId].map((environmentId) => ({
  id: projectId,
  environmentId,
  title: environmentId === remoteId ? "Remote checkout" : "Primary checkout",
  workspaceRoot: environmentId === remoteId ? "/remote/checkout" : "/primary/checkout",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-23T00:00:00.000Z",
  updatedAt: "2026-09-23T00:00:00.000Z",
}));
let remoteConfig = {
  settings: {
    ...DEFAULT_SERVER_SETTINGS,
    projectSettingsOverrides: {
      [projectId]: {
        defaultThreadEnvMode: "local",
        defaultModelSelection: { instanceId: "codex", model: "machine-model" },
      },
    },
  },
  providers: [
    {
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      models: ["machine-model", "portable-model", "manual-model"].map((slug) => ({
        slug,
        name: slug,
        isCustom: false,
        capabilities: null,
      })),
    },
  ],
} as unknown as ServerConfig;
const primaryConfig = {
  ...remoteConfig,
  providers: [{ ...remoteConfig.providers[0]!, models: [remoteConfig.providers[0]!.models[0]!] }],
};
const emptyDraft: ComposerDraft = { text: "", attachments: [] };
function publishDraft(key: string, patch: Partial<ComposerDraft>) {
  fixture.drafts = {
    ...fixture.drafts,
    [key]: { ...(fixture.drafts[key] ?? emptyDraft), ...patch },
  };
  fixture.listeners.forEach((listener) => listener());
}

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  Alert: { alert: vi.fn() },
  View: ({ children }: PropsWithChildren) => <div>{children}</div>,
  ScrollView: ({ children }: PropsWithChildren) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    disabled,
  }: PropsWithChildren<{ onPress: () => void; disabled?: boolean }>) => (
    <button onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
  ActivityIndicator: () => null,
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => fixture.navigation,
  useIsFocused: () => true,
  StackActions: { push: vi.fn() },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../native/StackHeader", () => ({
  NativeHeaderToolbar: () => null,
  NativeStackScreenOptions: () => null,
}));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: PropsWithChildren) => <span>{children}</span>,
}));
vi.mock("../../components/AndroidScreenHeader", () => ({ AndroidScreenHeader: () => null }));
vi.mock("../../components/ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({ layout: { usesSplitView: false } }),
}));
vi.mock("../sharing/IncomingShareProvider", () => ({
  useIncomingShare: () => ({ getShare: () => null, releaseShareReservation: vi.fn() }),
}));
vi.mock("../../state/workspace", () => ({
  useWorkspaceState: () => ({ state: { hasReadyEnvironment: true } }),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => projects,
  useThreadShells: () => [],
  useEnvironmentServerConfig: (id: string) => (id === remoteId ? remoteConfig : primaryConfig),
}));
vi.mock("../../state/project-grouping", () => ({
  useMobileProjectGroupingSettings: () => ({ sidebarProjectGroupingMode: "physical" }),
}));
vi.mock("./use-legacy-plan-mode-enabled", () => ({
  useLegacyPlanModeState: () => ({ enabled: false, loaded: true }),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({ savedConnectionsById: {} }),
  setPendingConnectionError: vi.fn(),
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { get: () => fixture.drafts } }));
vi.mock("../../state/projects", () => ({
  projectEnvironment: {
    readFile: (request: unknown) => {
      fixture.reads(request);
      return { kind: "file", ...(request as object) };
    },
  },
}));
vi.mock("../../state/vcs", () => ({ vcsEnvironment: { status: () => ({ kind: "status" }) } }));
const refreshFileQuery = vi.hoisted(() => vi.fn());
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({
    presentation: { connection: { phase: fixture.connectionPhase } },
  }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (
    query: { kind: string; environmentId?: string; input?: { relativePath: string } } | null,
  ) => {
    if (query?.kind === "file") {
      const mesura = query.input?.relativePath === ".mesura.json";
      return {
        refresh: refreshFileQuery,
        isPending: mesura && fixture.repositoryPending,
        data:
          mesura && !fixture.repositoryPending
            ? {
                contents:
                  query.environmentId === remoteId
                    ? fixture.repositoryContents
                    : '{"version":1,"defaultThreadEnvMode":"local"}',
                truncated: false,
              }
            : null,
      };
    }
    return { data: null, isPending: false, refresh: refreshFileQuery };
  },
}));
vi.mock("../../state/queries", () => ({
  useDebouncedValue: (value: string) => value,
  usePaginatedBranches: () => ({
    refs: [],
    data: null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
    loadNext: vi.fn(),
  }),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  composerDraftsAtom: {},
  useComposerDraft: (key: string | null) =>
    useSyncExternalStore(
      (listener) => {
        fixture.listeners.add(listener);
        return () => {
          fixture.listeners.delete(listener);
        };
      },
      () => (key ? (fixture.drafts[key] ?? emptyDraft) : emptyDraft),
    ),
  createNewTaskDraft: (project: { environmentId: EnvironmentId; projectId: ProjectId }) => {
    const key = `new-task:p2-${++fixture.nextDraft}`;
    publishDraft(key, { project: { ...project, createdAt: "2026-09-23T00:00:00.000Z" } });
    return key;
  },
  retargetNewTaskDraft: (key: string, project: ComposerDraft["project"]) =>
    publishDraft(key, { project }),
  isNewTaskDraftKey: (key: string) => key.startsWith("new-task:"),
  getComposerDraftSnapshot: (key: string) => fixture.drafts[key] ?? emptyDraft,
  updateComposerDraftSettings: publishDraft,
  setComposerDraftText: (key: string, text: string) => publishDraft(key, { text }),
  useStickyComposerModelSelection: () => null,
  setStickyComposerModelSelection: vi.fn(),
  clearComposerDraft: vi.fn(),
  appendComposerDraftAttachments: vi.fn(),
  removeComposerDraftAttachment: vi.fn(),
  replaceComposerDraftAttachments: vi.fn(),
  setComposerDraftContext: vi.fn(),
  isComposerDraftEmpty: () => true,
  scheduleUnusedComposerAttachmentCleanup: vi.fn(),
}));
vi.mock("../../state/pending-task-editor-writes", () => ({
  capturePendingTaskEditorWriteBaseline: vi.fn(),
  flushPendingTaskEditorWrite: fixture.flush,
}));
vi.mock("../../state/thread-outbox", () => ({
  flattenQueuedThreadMessages: () => fixture.queued,
  threadOutboxManager: {},
}));
vi.mock("../../state/use-thread-outbox", () => ({
  holdEditingQueuedMessage: vi.fn(),
  releaseEditingQueuedMessage: vi.fn(),
  useThreadOutboxMessages: () => ({}),
}));

import { NewTaskRouteScreen } from "./NewTaskRouteScreen";
import { NewTaskFlowProvider, useNewTaskFlow } from "./new-task-flow-provider";

let flow: ReturnType<typeof useNewTaskFlow>;
function ObserveFlow() {
  const value = useNewTaskFlow();
  useLayoutEffect(() => {
    flow = value;
  });
  return null;
}
let root: Root;
let container: HTMLDivElement;
async function renderRoute() {
  await act(async () => {
    root.render(
      <NewTaskFlowProvider>
        <NewTaskRouteScreen route={{ params: undefined }} />
        <ObserveFlow />
      </NewTaskFlowProvider>,
    );
  });
}
async function selectRemoteCheckout() {
  const button = [...container.querySelectorAll("button")].find((entry) =>
    entry.textContent?.includes("Remote checkout"),
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(flow.selectedProject?.workspaceRoot).toBe("/remote/checkout");
  expect(fixture.navigation.goBack).toHaveBeenCalledOnce();
}
function buildTask() {
  return flow.buildPendingTaskMessage({
    threadId: "p2-mobile-thread",
    commandId: "p2-mobile-command",
    messageId: "p2-mobile-message",
    createdAt: "2026-09-23T00:00:00.000Z",
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.drafts = {};
  fixture.queued = [];
  fixture.flush.mockClear();
  fixture.nextDraft = 0;
  fixture.repositoryPending = false;
  fixture.repositoryContents =
    '{"version":1,"defaultThreadEnvMode":"worktree","defaultModelSelection":{"provider":"codex","model":"portable-model"}}';
  fixture.connectionPhase = "connected";
  fixture.reads.mockClear();
  fixture.navigation.goBack.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  fixture.listeners.clear();
  vi.unstubAllGlobals();
});

it("P2 RED mobile project route applies workspace and model from the selected remote checkout", async () => {
  await renderRoute();
  await selectRemoteCheckout();
  await act(async () => flow.setPrompt("Implement the task"));
  const task = buildTask();
  expect(task?.environmentId).toBe(remoteId);
  expect(task?.creation?.projectCwd).toBe("/remote/checkout");
  expect.soft(task?.creation?.workspaceMode).toBe("worktree");
  expect.soft(task?.modelSelection).toEqual({ instanceId: "codex", model: "portable-model" });
  expect.soft(fixture.reads).toHaveBeenCalledWith({
    environmentId: remoteId,
    input: { cwd: "/remote/checkout", relativePath: ".mesura.json" },
  });
});

it("P2 GUARD mobile project route retains explicit draft choices after the repository read settles", async () => {
  fixture.repositoryPending = true;
  await renderRoute();
  await selectRemoteCheckout();
  await act(async () => {
    flow.setSelectedModelKey("codex:manual-model");
    flow.setWorkspaceMode("local");
    flow.setPrompt("Keep my choices");
  });
  fixture.repositoryPending = false;
  await renderRoute();
  const task = buildTask();
  expect(task?.creation?.workspaceMode).toBe("local");
  expect(task?.modelSelection).toEqual({
    instanceId: ProviderInstanceId.make("codex"),
    model: "manual-model",
  });
  expect(flow.selectedModel?.model).toBe("manual-model");
});

it.each(["connecting", "reconnecting", "offline"])(
  "P2 rework mobile queues with an unsettled repository read while %s",
  async (phase) => {
    fixture.connectionPhase = phase;
    fixture.repositoryPending = true;
    await renderRoute();
    await selectRemoteCheckout();
    await act(async () => flow.setPrompt("Queue while disconnected"));
    expect(buildTask()).toMatchObject({
      text: "Queue while disconnected",
      modelSelection: { model: "machine-model" },
      creation: { workspaceMode: "local" },
    });
  },
);
it("P2 rework mobile waits for a connected repository read before freezing task defaults", async () => {
  fixture.repositoryPending = true;
  await renderRoute();
  await selectRemoteCheckout();
  await act(async () => flow.setPrompt("Wait for defaults"));
  expect(buildTask()).toBeNull();
  fixture.repositoryPending = false;
  await renderRoute();
  expect(buildTask()?.modelSelection?.model).toBe("portable-model");
});

it("P2 rework mobile flushes pending-task edits while reconnecting with an unsettled file read", async () => {
  fixture.connectionPhase = "reconnecting";
  fixture.repositoryPending = true;
  await renderRoute();
  await selectRemoteCheckout();
  await act(async () => flow.setPrompt("Original queued task"));
  const queued = buildTask()!;
  fixture.queued = [queued];
  await act(async () => {
    expect(flow.beginEditingPendingTask(queued.messageId)).toBe(true);
  });
  await act(async () => flow.setPrompt("Edited while disconnected"));
  await act(async () => flow.cancelEditingPendingTask());
  expect(fixture.flush).toHaveBeenCalledWith(
    expect.objectContaining({
      message: expect.objectContaining({
        text: "Edited while disconnected",
        modelSelection: queued.modelSelection,
      }),
    }),
  );
});

it("P2 regression mobile reports an unsafe repository model once across provider status updates", async () => {
  fixture.repositoryContents =
    '{"version":1,"defaultModelSelection":{"provider":"codex","model":"missing"}}';
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const originalConfig = remoteConfig;
  try {
    await renderRoute();
    await selectRemoteCheckout();
    const warnings = () =>
      warn.mock.calls.filter(([message]) =>
        String(message).includes("Repository model codex/missing"),
      );
    expect(warnings()).toHaveLength(1);
    expect(flow.selectedModel?.model).toBe("machine-model");
    remoteConfig = {
      ...remoteConfig,
      providers: remoteConfig.providers.map((provider) => ({ ...provider })),
    };
    await renderRoute();
    await act(async () => flow.setPrompt("Keep working through status pushes"));
    expect(warnings()).toHaveLength(1);
    expect(buildTask()?.modelSelection?.model).toBe("machine-model");
  } finally {
    remoteConfig = originalConfig;
    warn.mockRestore();
  }
});
