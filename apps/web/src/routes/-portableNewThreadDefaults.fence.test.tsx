// Application entry point: Route.options.component from _chat.index.tsx.
import { act, lazy, Suspense } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

const state = vi.hoisted(() => {
  let completeRepositoryRead: () => void = () => undefined;
  let repositoryRead: Promise<void> = Promise.resolve();
  const project = {
    id: "remote-project",
    environmentId: "remote-environment",
    workspaceRoot: "/remote/selected-checkout",
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
  };
  const setLogicalProjectDraftThreadId = vi.fn();
  const setModelSelection = vi.fn();
  let storedDraft: {
    draftId: string;
    environmentId: string;
    threadId: string;
    projectId: string;
    promotedTo: null;
    envMode?: "local";
    envModeExplicit?: boolean;
    logicalProjectKey?: string;
  } | null = null;
  return {
    project,
    connectionListeners: new Set<() => void>(),
    readCount: 0,
    phase: "connected",
    ambiguous: false,
    models: ["portable-model"],
    explicitModel: true,
    openDraft: false,
    carryModel: false,
    sticky: vi.fn(),
    context: vi.fn(),
    routeLoads: [] as Promise<unknown>[],
    repositoryContents: '{"version":1,"defaultThreadEnvMode":"worktree"}',
    setLogicalProjectDraftThreadId,
    setModelSelection,
    get storedDraft() {
      return storedDraft;
    },
    router: {
      state: { location: { href: "/" }, matches: [{ params: {} }] },
      navigate: vi.fn(async () => undefined),
    },
    reset() {
      setLogicalProjectDraftThreadId.mockClear();
      setModelSelection.mockClear();
      this.repositoryContents = '{"version":1,"defaultThreadEnvMode":"worktree"}';
      storedDraft = null;
      this.readCount = 0;
      this.phase = "connected";
      this.ambiguous = false;
      this.models = ["portable-model"];
      this.explicitModel = true;
      this.openDraft = false;
      this.carryModel = false;
      this.sticky.mockClear();
      this.context.mockClear();
      repositoryRead = new Promise<void>((resolve) => {
        completeRepositoryRead = resolve;
      });
    },
    finishRead() {
      completeRepositoryRead();
    },
    mutateDraft() {
      if (storedDraft) storedDraft = { ...storedDraft, envMode: "local", envModeExplicit: true };
    },
    useExistingDraft() {
      storedDraft = {
        draftId: "explicit-draft",
        environmentId: "remote-environment",
        threadId: "explicit-thread",
        projectId: "remote-project",
        promotedTo: null,
        logicalProjectKey: "remote-project",
      };
    },
    get repositoryRead() {
      return repositoryRead;
    },
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () =>
    new Map([
      [
        "remote-environment",
        {
          providers: (state.ambiguous ? ["codex_one", "codex_two"] : ["codex"]).map(
            (instanceId) => ({
              instanceId,
              driver: "codex",
              enabled: true,
              installed: true,
              auth: { status: "authenticated" },
              models: state.models.map((slug) => ({ slug, capabilities: null })),
            }),
          ),
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            defaultThreadEnvMode: "local",
            projectSettingsOverrides: {
              "remote-project": {
                defaultThreadEnvMode: "local",
                defaultModelSelection: { instanceId: "codex", model: "machine-default" },
              },
            },
          },
        },
      ],
    ]),
}));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopeProjectRef: (environmentId: string, projectId: string) => ({
    environmentId,
    projectId,
  }),
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
  scopedProjectKey: () => "remote-project",
}));
vi.mock("@tanstack/react-router", () => ({
  lazyRouteComponent: (load: () => Promise<Record<string, React.ComponentType>>, name: string) => {
    const loaded = load().then((module) => ({ default: module[name]! }));
    state.routeLoads.push(loaded);
    return lazy(() => loaded);
  },
  createFileRoute: () => (options: unknown) => ({
    options,
    useRouteContext: () => ({ authGateState: { status: "local" } }),
  }),
  Link: () => null,
  useParams: () => null,
  useRouter: () => state.router,
}));
vi.mock("../components/Sidebar.logic", () => ({
  orderItemsByPreferredIds: () => [],
  sortScopedProjectsForSidebar: (projects: unknown[]) => projects,
}));
vi.mock("../composerDraftStore", () => ({
  composerDraftHasUserContent: () => false,
  markPromotedDraftThreadByRef: vi.fn(),
  useComposerDraftStore: {
    getState: () => ({
      getComposerDraft: () =>
        state.storedDraft
          ? {
              activeProvider: "codex",
              modelSelectionByProvider: { codex: { instanceId: "codex", model: "user-choice" } },
              modelSelectionExplicit: state.explicitModel,
            }
          : state.carryModel
            ? {
                activeProvider: "codex",
                modelSelectionByProvider: { codex: { instanceId: "codex", model: "unsafe-carry" } },
              }
            : {},
      getDraftSessionByLogicalProjectKey: () => state.storedDraft,
      getDraftSession: () => state.storedDraft,
      getDraftThread: () => null,
      applyStickyState: state.sticky,
      setDraftThreadContext: state.context,
      setLogicalProjectDraftThreadId: state.setLogicalProjectDraftThreadId,
      setModelSelection: state.setModelSelection,
    }),
  },
}));
vi.mock("../lib/utils", () => ({
  newDraftId: () => "draft-from-index",
  newThreadId: () => "thread-from-index",
}));
vi.mock("../logicalProject", () => ({
  deriveLogicalProjectKeyFromSettings: () => "remote-project",
  getProjectOrderKey: () => "remote-project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../state/entities", () => ({
  readProjects: () => [state.project],
  readThreadShell: () => null,
  useProjects: () => [state.project],
  useThread: () => null,
  useThreadShells: () => [],
  useAllEnvironmentShellsBootstrapped: () => true,
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: [], isReady: true }),
}));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../threadRoutes", () => ({
  resolveThreadRouteTarget: () =>
    state.openDraft
      ? { kind: "draft", draftId: "explicit-draft" }
      : state.carryModel
        ? { kind: "server", threadRef: {} }
        : null,
}));
vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: () => "remote-project",
  useUiStateStore: () => [],
}));
vi.mock("../hooks/useSettings", () => ({ useClientSettings: () => ({}) }));
vi.mock("../components/files/projectFilesQueryState", () => ({
  getProjectFileQueryAtom: (_environmentId: string, _cwd: string, name: string) => name,
  resolveProjectFileQueryData: (
    _environmentId: string,
    _cwd: string,
    _name: string,
    data: unknown,
  ) => data,
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: async (_registry: unknown, name: string, options: { signal: AbortSignal }) => {
    state.readCount++;
    if (name === ".mesura.json") {
      await Promise.race([
        state.repositoryRead,
        new Promise<void>((resolve) =>
          options.signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
      if (options.signal.aborted) return { _tag: "Failure" };
      return {
        _tag: "Success",
        value: { contents: state.repositoryContents, truncated: false },
      };
    }
    return { _tag: "Success", value: null };
  },
}));
vi.mock("../state/presentation", () => ({
  environmentPresentations: { presentationAtom: () => "connection" },
}));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: () => ({ connection: { phase: state.phase } }),
    subscribe: (_atom: unknown, listener: () => void) => {
      state.connectionListeners.add(listener);
      return () => state.connectionListeners.delete(listener);
    },
  },
}));
vi.mock("../components/NoProjectsHero", () => ({ NoProjectsHero: () => null }));
vi.mock("../components/WorkspacePageHeader", () => ({ WorkspacePageHeader: () => null }));
vi.mock("../components/ui/button", () => ({ Button: () => null }));
vi.mock("../components/ui/empty", () => ({
  Empty: () => null,
  EmptyDescription: () => null,
  EmptyHeader: () => null,
  EmptyTitle: () => null,
}));
vi.mock("../components/ui/sidebar", () => ({ SidebarInset: () => null }));

import { Route } from "./_chat.index";
import { readRepositoryDefaults } from "../lib/t3ProjectFileDefaults";

describe("phase 2 web index route", () => {
  let renderer: ReactTestRenderer | undefined;
  afterEach(async () => {
    if (renderer) await act(() => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  it("P2 RED index entry waits for the selected remote checkout before creating an implicit workspace draft", async () => {
    state.reset();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await Promise.all(state.routeLoads);
    const Entry = Route.options.component!;
    await act(async () => {
      renderer = create(
        <Suspense>
          <Entry />
        </Suspense>,
      );
    });
    expect(state.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();

    await act(async () => state.finishRead());
    expect(state.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      { environmentId: "remote-environment", projectId: "remote-project" },
      "draft-from-index",
      expect.objectContaining({ envMode: "worktree" }),
    );
  });

  it("P2 GUARD an explicit draft model survives opening its project from the index route", async () => {
    state.reset();
    state.useExistingDraft();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await Promise.all(state.routeLoads);
    const Entry = Route.options.component!;
    await act(async () => {
      renderer = create(
        <Suspense>
          <Entry />
        </Suspense>,
      );
    });
    await act(async () => state.finishRead());

    expect(state.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      { environmentId: "remote-environment", projectId: "remote-project" },
      "explicit-draft",
      expect.any(Object),
    );
    expect(state.setModelSelection).not.toHaveBeenCalled();
  });
  it("P2 implementation index entry seeds the repository model instead of the machine-local model", async () => {
    state.reset();
    state.repositoryContents =
      '{"version":1,"defaultModelSelection":{"provider":"codex","model":"portable-model"}}';
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await Promise.all(state.routeLoads);
    const Entry = Route.options.component!;
    await act(async () => {
      renderer = create(
        <Suspense>
          <Entry />
        </Suspense>,
      );
    });
    expect(state.setModelSelection).not.toHaveBeenCalled();
    await act(async () => state.finishRead());
    expect(state.setModelSelection).toHaveBeenCalledWith(
      "draft-from-index",
      {
        instanceId: "codex",
        model: "portable-model",
      },
      { replaceOptions: true },
    );
  });
  async function mountEntry() {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await Promise.all(state.routeLoads);
    const Entry = Route.options.component!;
    await act(async () => {
      renderer = create(
        <Suspense>
          <Entry />
        </Suspense>,
      );
    });
  }
  it("P2 rework web replaces an unavailable repository model with a usable catalog fallback", async () => {
    state.reset();
    state.repositoryContents =
      '{"version":1,"defaultModelSelection":{"provider":"codex","model":"missing"}}';
    await mountEntry();
    await act(async () => state.finishRead());
    expect(state.setModelSelection).toHaveBeenCalledWith(
      "draft-from-index",
      { instanceId: "codex", model: "portable-model" },
      { replaceOptions: true },
    );
  });
  it("P2 rework web clears an unsafe model without restoring carry or sticky state", async () => {
    state.reset();
    state.models = [];
    state.carryModel = true;
    state.repositoryContents =
      '{"version":1,"defaultModelSelection":{"provider":"codex","model":"missing"}}';
    await mountEntry();
    await act(async () => state.finishRead());
    expect(state.setModelSelection).toHaveBeenCalledWith("draft-from-index", null, {
      replaceOptions: true,
    });
    expect(state.sticky).not.toHaveBeenCalled();
  });
  it("P2 rework web abandons an empty draft changed during the repository read", async () => {
    state.reset();
    state.useExistingDraft();
    state.explicitModel = false;
    await mountEntry();
    state.mutateDraft();
    await act(async () => state.finishRead());
    expect(state.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();
    expect(state.setModelSelection).not.toHaveBeenCalled();
  });
  it("P2 rework web reuses the open draft without repository RPCs", async () => {
    state.reset();
    state.useExistingDraft();
    state.openDraft = true;
    await mountEntry();
    expect(state.readCount).toBe(0);
    expect(state.context).not.toHaveBeenCalled();
    expect(state.setModelSelection).not.toHaveBeenCalled();
  });
  it("P2 rework web preserves an explicit workspace on an empty reopened draft", async () => {
    state.reset();
    state.useExistingDraft();
    state.mutateDraft();
    await mountEntry();
    await act(async () => state.finishRead());
    expect(state.context).not.toHaveBeenCalled();
    expect(state.setLogicalProjectDraftThreadId).toHaveBeenCalled();
  });
  it("P2 rework web creates a draft during reconnect without waiting for repository RPCs", async () => {
    state.reset();
    state.phase = "reconnecting";
    await mountEntry();
    expect(state.readCount).toBe(0);
    expect(state.setLogicalProjectDraftThreadId).toHaveBeenCalled();
  });

  it("P2 rework web finishes draft creation when the owning connection drops during a file read", async () => {
    state.reset();
    await mountEntry();
    expect(state.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();
    await act(async () => {
      state.phase = "reconnecting";
      for (const listener of state.connectionListeners) listener();
    });
    expect(state.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      { environmentId: "remote-environment", projectId: "remote-project" },
      "draft-from-index",
      expect.objectContaining({ envMode: "local" }),
    );
    expect(state.connectionListeners.size).toBe(0);
  });

  it("P2 rework web does not seed an ambiguous portable model from a custom instance", async () => {
    state.reset();
    state.ambiguous = true;
    state.repositoryContents =
      '{"version":1,"defaultModelSelection":{"provider":"codex","model":"portable-model"}}';
    await mountEntry();
    await act(async () => state.finishRead());
    expect(state.setModelSelection).toHaveBeenCalledWith("draft-from-index", null, {
      replaceOptions: true,
    });
    expect(state.sticky).not.toHaveBeenCalled();
  });
  it("P2 regression web creation shares its checkout result and a new draft reads changed file bytes", async () => {
    state.reset();
    await mountEntry();
    await act(async () => state.finishRead());
    expect(state.readCount).toBe(2);
    const environmentId = EnvironmentId.make(state.project.environmentId);
    const mountedDefaults = await readRepositoryDefaults(
      environmentId,
      state.project.workspaceRoot,
      "draft-from-index",
    );
    expect(mountedDefaults.defaultThreadEnvMode.value).toBe("worktree");
    expect(state.readCount).toBe(2);
    state.repositoryContents = '{"version":1,"defaultThreadEnvMode":"local"}';
    const nextDefaults = await readRepositoryDefaults(
      environmentId,
      state.project.workspaceRoot,
      "next-draft",
    );
    expect(nextDefaults.defaultThreadEnvMode.value).toBe("local");
    expect(state.readCount).toBe(4);
  });

  it("P2 regression reopening an implicit empty draft clears an unsafe model without sticky reseeding", async () => {
    state.reset();
    state.useExistingDraft();
    state.explicitModel = false;
    state.models = [];
    state.repositoryContents =
      '{"version":1,"defaultModelSelection":{"provider":"codex","model":"missing"}}';
    await mountEntry();
    await act(async () => state.finishRead());
    expect(state.setModelSelection).toHaveBeenCalledWith("explicit-draft", null, {
      replaceOptions: true,
    });
    expect(state.sticky).not.toHaveBeenCalled();
    expect(state.setLogicalProjectDraftThreadId).toHaveBeenCalled();
  });
});
