import "../index.css";
import "../mesura.css";

import { act, render as renderBrowser, type Screen } from "../../test/render";
// Application entry point: ThreadRouteView, rendered by the _chat route layout.
// The draft leaf route is empty so draft promotion retains the ChatView instance.
// ChatView, DraftHeroHeadline, the draft store, and defaults resolution remain real.
// Environment I/O and unrelated expensive panels are test boundaries.
import { lazy, type PropsWithChildren } from "react";
import { expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  type ServerConfig,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { DEFAULT_CLIENT_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";

import * as Option from "effect/Option";
import { EMPTY_THREAD_HISTORY_META } from "@t3tools/client-runtime/state/threads";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

const fixture = vi.hoisted(() => ({
  environments: [] as {
    environmentId: EnvironmentId;
    label: string;
    connection: { phase: string };
    entry: { target: { _tag: "PrimaryConnectionTarget" }; profile: Option.Option<never> };
    serverConfig: ServerConfig | null;
  }[],
  projects: [] as EnvironmentProject[],
  draftId: "",
  sequence: 0,
  reads: vi.fn(),
  loads: [] as Promise<unknown>[],
  contents: null as string | null,
  pending: Promise.resolve(),
  finish: () => {},
  preview: { sessions: {}, serverEpoch: null },
  command: vi.fn(),
  empty: [] as never[],
  providersByEnvironment: new Map<EnvironmentId, ServerConfig["providers"]>(),
  serverConfigs: new Map<EnvironmentId, ServerConfig>(),
}));
const fenceMocks = vi.hoisted(() => () => import("../test/appRootFenceMocks"));
vi.mock("../connection/runtime", async () => (await fenceMocks()).mockConnectionRuntime());
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({
    options,
    useParams: () => ({ draftId: fixture.draftId }),
  }),
  lazyRouteComponent: (load: () => Promise<Record<string, React.ComponentType>>, name: string) => {
    const pending = load().then((m) => ({ default: m[name]! }));
    fixture.loads.push(pending);
    return lazy(() => pending);
  },
  useNavigate: () => fixture.command,
  useRouter: () => ({ navigate: fixture.command }),
  useLocation: (options?: { select?: (location: unknown) => unknown }) => {
    const location = { href: `/draft/${fixture.draftId}`, state: { __TSR_key: "draft" } };
    return options?.select ? options.select(location) : location;
  },
}));
vi.mock("../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => fixture.command,
  useHandleNewThread: () => ({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: null,
    handleNewThread: fixture.command,
    routeDraftId: null,
    routeThreadRef: null,
  }),
}));
vi.mock("../hooks/useThreadActions", async (original) => ({
  ...(await original<typeof import("../hooks/useThreadActions")>()),
  useThreadActions: () => ({}),
}));
vi.mock("../hooks/useSettings", async (importOriginal) => {
  const original = await importOriginal<typeof import("../hooks/useSettings")>();
  const settings = original.mergeEnvironmentSettings(
    DEFAULT_SERVER_SETTINGS,
    DEFAULT_CLIENT_SETTINGS,
  );
  return {
    ...original,
    useEnvironmentSettings: (
      _environmentId: string,
      select?: (settings: UnifiedSettings) => unknown,
    ) => {
      return select ? select(settings) : settings;
    },
    useClientSettingsHydrated: () => true,
    useClientSettings: (select?: (s: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
      select ? select(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS,
  };
});
vi.mock("../hooks/useTheme", async (original) => ({
  ...(await original<typeof import("../hooks/useTheme")>()),
  useTheme: () => ({ resolvedTheme: "light" }),
}));
vi.mock("../hooks/useMediaQuery", async (original) => ({
  ...(await original<typeof import("../hooks/useMediaQuery")>()),
  useMediaQuery: () => false,
}));
vi.mock("../state/environments", async (original) => ({
  ...(await original<typeof import("../state/environments")>()),
  useEnvironments: () => ({ environments: fixture.environments }),
  useEnvironment: (id: string) => fixture.environments.find((e) => e.environmentId === id),
  usePrimaryEnvironment: () => fixture.environments[0],
  usePrimaryEnvironmentId: () => fixture.environments[0]?.environmentId,
  useEnvironmentProviders: () => fixture.providersByEnvironment,
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useServerConfigs: () => fixture.serverConfigs,
  useProject: (ref: { projectId: string } | null) =>
    fixture.projects.find((p) => p.id === ref?.projectId) ?? null,
  useProjects: () => fixture.projects,
  useThread: () => null,
  useThreadShell: () => null,
  useQuietThreadShell: () => null,
  useEnvironmentSupportsServerBrowser: () => false,
  useThreadRefs: () => fixture.empty,
  useEnvironmentThreadRefs: () => fixture.empty,
  useThreadProjection: () => null,
  useThreadStatus: () => "empty",
  useThreadHistory: () => EMPTY_THREAD_HISTORY_META,
  useThreadVisibleTurnItems: () => fixture.empty,
  useThreadCheckpointSummaries: () => fixture.empty,
  useThreadShells: () => fixture.empty,
}));
vi.mock("../state/session", async (original) => ({
  ...(await original<typeof import("../state/session")>()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => fixture.command }));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => fixture.command }));
vi.mock("../state/query", async (original) => ({
  ...(await original<typeof import("../state/query")>()),
  useEnvironmentQuery: () => ({ data: null, isPending: false, refresh: fixture.command }),
}));
vi.mock("../state/threads", async (original) => ({
  ...(await original<typeof import("../state/threads")>()),
  useEnvironmentThread: () => ({ data: { _tag: "None" }, status: "idle" }),
}));
vi.mock("../state/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("../state/server")>();
  const { Atom } = await import("effect/reactivity");
  const updateStateAtom = Atom.make({ status: "idle" as const });
  return {
    ...original,
    serverEnvironment: {
      ...original.serverEnvironment,
      updateStateAtom: () => updateStateAtom,
      configValueAtom: Atom.family((id: EnvironmentId | null) =>
        Atom.make(
          () =>
            fixture.environments.find((environment) => environment.environmentId === id)
              ?.serverConfig ?? null,
        ),
      ),
    },
    primaryServerKeybindingsAtom: Atom.make(DEFAULT_RESOLVED_KEYBINDINGS),
    primaryServerAvailableEditorsAtom: Atom.make([]),
    environmentServerConfigsAtom: Atom.make(() => fixture.serverConfigs),
  };
});
vi.mock("../state/shell", async (original) => ({
  ...(await original<typeof import("../state/shell")>()),
  useEnvironmentShellStatus: () => "live",
  useEnvironmentShellHasSnapshot: () => true,
}));
vi.mock("../state/terminalSessions", async (original) => ({
  ...(await original<typeof import("../state/terminalSessions")>()),
  useKnownTerminalSessions: () => fixture.empty,
  useThreadRunningTerminalIds: () => fixture.empty,
}));
vi.mock("../state/projectClones", async (original) => ({
  ...(await original<typeof import("../state/projectClones")>()),
  useProjectClone: () => null,
}));
vi.mock("../state/device", async (original) => ({
  ...(await original<typeof import("../state/device")>()),
  useDeviceState: () => ({ state: { sessions: fixture.empty }, loaded: true }),
}));
vi.mock("../components/files/projectFilesQueryState", async (original) => ({
  ...(await original<typeof import("../components/files/projectFilesQueryState")>()),
  useProjectFileQuery: () => ({
    data: null,
    isPending: false,
    error: null,
    refresh: fixture.command,
  }),
  getProjectFileQueryAtom: (environmentId: string, cwd: string, name: string) => ({
    environmentId,
    cwd,
    name,
  }),
  resolveProjectFileQueryData: (_id: string, _cwd: string, _name: string, data: unknown) => data,
}));
vi.mock("../state/presentation", async (importOriginal) => {
  const original = await importOriginal<typeof import("../state/presentation")>();
  const { Atom } = await import("effect/reactivity");
  return {
    ...original,
    environmentPresentations: {
      ...original.environmentPresentations,
      presentationAtom: Atom.family((id: string) =>
        Atom.make(
          () =>
            fixture.environments.find((environment) => environment.environmentId === id) ?? null,
        ),
      ),
    },
    useEnvironmentPresentation: (id: string | null) => ({
      isReady: true,
      presentation:
        fixture.environments.find((environment) => environment.environmentId === id) ?? null,
    }),
  };
});
vi.mock("@t3tools/client-runtime/state/runtime", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/state/runtime")>()),
  executeAtomQuery: async (
    _registry: unknown,
    query: { environmentId: string; cwd: string; name: string },
  ) => {
    fixture.reads(query);
    if (query.cwd === "/second") await fixture.pending;
    return {
      _tag: "Success",
      value:
        query.name === ".mesura.json" && fixture.contents
          ? { contents: fixture.contents, truncated: false }
          : null,
    };
  },
}));
vi.mock("../components/ui/sidebar", async (original) => ({
  ...(await original<typeof import("../components/ui/sidebar")>()),
  SidebarInset: ({ children }: PropsWithChildren) => <main>{children}</main>,
}));
vi.mock("../components/chat/ChatComposer", () => ({
  ChatComposer: () => <div data-testid="composer" />,
}));
vi.mock("../components/chat/MessagesTimeline", () => ({ MessagesTimeline: () => null }));
vi.mock("../components/BranchToolbar", () => ({ BranchToolbar: () => null }));
vi.mock("../components/chat/ChatHeader", () => ({ ChatHeader: () => null }));
vi.mock("../components/ThreadTerminalDrawer", async (original) => ({
  ...(await original<typeof import("../components/ThreadTerminalDrawer")>()),
  default: () => null,
}));
vi.mock("../components/WorkspacePageHeader", () => ({ WorkspacePageHeader: () => null }));
vi.mock("../components/chat/ExpandedImageDialog", () => ({
  ExpandedImageDialog: () => null,
  ExpandedImageDialogHost: () => null,
  openExpandedImagePreview: () => undefined,
}));
vi.mock("../components/PullRequestThreadDialog", () => ({ PullRequestThreadDialog: () => null }));

vi.mock("../components/chat/useAutoBalanceUpdateBanner", () => ({
  useAutoBalanceUpdateBanner: () => null,
}));

vi.mock("../assets/assetUrls", async (original) => ({
  ...(await original<typeof import("../assets/assetUrls")>()),
  useAssetUrls: () => fixture.empty,
  useAssetUrl: () => null,
}));

vi.mock("../hooks/useLoadBalancedEnvironment", () => ({
  useLoadBalancedEnvironment: () => ({
    pending: false,
    environmentId: null,
    failed: false,
    refresh: fixture.command,
  }),
}));

vi.mock("../previewStateStore", async (original) => ({
  ...(await original<typeof import("../previewStateStore")>()),
  useThreadPreviewState: () => fixture.preview,
}));

vi.mock("../components/ProjectFavicon", () => ({ ProjectFavicon: () => null }));

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { appAtomRegistry, AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom, serverEnvironment } from "../state/server";
import { environmentPresentations } from "../state/presentation";
const { Suspense } = await import("react");
const { ThreadRouteView } = await import("../components/ThreadRouteView");

let draftId: DraftId;
const initialDraftState = useComposerDraftStore.getState();
const environmentId = EnvironmentId.make("p2-owner");
let root: Screen;
let container: HTMLDivElement;
async function renderRoute() {
  await Promise.all(fixture.loads);
  fixture.providersByEnvironment = new Map(
    fixture.environments.map((environment) => [
      environment.environmentId,
      environment.serverConfig?.providers ?? fixture.empty,
    ]),
  );
  fixture.serverConfigs = new Map(
    fixture.environments.flatMap((environment) =>
      environment.serverConfig
        ? [[environment.environmentId, environment.serverConfig] as const]
        : [],
    ),
  );
  await act(async () => {
    appAtomRegistry.refresh(environmentServerConfigsAtom);
    appAtomRegistry.refresh(serverEnvironment.configValueAtom(environmentId));
    appAtomRegistry.refresh(environmentPresentations.presentationAtom(environmentId));
    await root.rerender(
      <AppAtomRegistryProvider>
        <Suspense>
          <ThreadRouteView target={{ kind: "draft", draftId }} />
        </Suspense>
      </AppAtomRegistryProvider>,
    );
  });
}
async function setupBrowserFixture0() {
  fixture.draftId = `p2-mounted-${++fixture.sequence}`;
  draftId = DraftId.make(fixture.draftId);
  fixture.reads.mockClear();
  fixture.command.mockClear();

  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} }),
  );
  fixture.projects = ["first", "second"].map((id) => ({
    id: ProjectId.make(id),
    environmentId,
    title: id,
    workspaceRoot: `/${id}`,
    scripts: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    repositoryIdentity: null,
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "legacy-model" },
  }));
  fixture.environments = [
    {
      environmentId,
      label: "Owner",
      connection: { phase: "connected" },
      entry: { target: { _tag: "PrimaryConnectionTarget" }, profile: Option.none() },
      serverConfig: null,
    },
  ];
  fixture.contents = null;
  fixture.pending = new Promise<void>((resolve) => {
    fixture.finish = resolve;
  });
  useComposerDraftStore.setState(initialDraftState, true);
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId({ environmentId, projectId: ProjectId.make("first") }, draftId, {
      threadId: ThreadId.make("p2-thread"),
      envMode: "local",
      envModeExplicit: false,
    });
  // The picker retargets a draft with content; an empty draft opens the selected project draft.
  useComposerDraftStore.getState().setPrompt(draftId, "Keep this prompt while changing projects");
  container = document.createElement("div");
  document.body.append(container);
  root = await renderBrowser(null, { container: container, router: false });

  return {
    async [Symbol.asyncDispose]() {
      await act(async () => root[Symbol.asyncDispose]());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

async function selectSecondProject() {
  const trigger = container.querySelector<HTMLButtonElement>("[data-draft-project-trigger]");
  expect(trigger).not.toBeNull();
  await act(async () => trigger!.click());
  const item = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
    item.textContent?.includes("second"),
  );
  expect(item).toBeDefined();
  await act(async () => item!.click());
}
async function chooseSecondProject() {
  await selectSecondProject();
  expect(useComposerDraftStore.getState().getDraftSession(draftId)?.projectId).toBe("second");
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
    "Keep this prompt while changing projects",
  );
}
function config(): ServerConfig {
  return {
    settings: DEFAULT_SERVER_SETTINGS,
    environment: { label: "Owner", capabilities: {}, platform: { machine: "desktop" } },
    providers: [
      {
        instanceId: "codex",
        driver: "codex",
        enabled: true,
        installed: true,
        status: "ready",
        version: null,
        checkedAt: "2026-01-01T00:00:00Z",
        slashCommands: [],
        skills: [],
        auth: { status: "authenticated" },
        models: ["portable-model", "safe-model"].map((slug) => ({
          slug,
          name: slug,
          isCustom: false,
          capabilities: null,
        })),
      },
    ],
  } as unknown as ServerConfig;
}
function selection() {
  return useComposerDraftStore.getState().getComposerDraft(draftId)?.modelSelectionByProvider[
    ProviderInstanceId.make("codex")
  ];
}
it("portable draft route guard: an empty draft opens the selected project draft without retargeting", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  useComposerDraftStore.getState().setPrompt(draftId, "");
  await renderRoute();
  await selectSecondProject();
  expect(fixture.command).toHaveBeenCalledWith({
    environmentId,
    projectId: ProjectId.make("second"),
  });
  expect(useComposerDraftStore.getState().getDraftSession(draftId)?.projectId).toBe("first");
});

it("P2 regression draft route picker applies the selected checkout after a delayed read", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  fixture.environments[0]!.serverConfig = config();
  await renderRoute();
  fixture.contents =
    '{"version":1,"defaultThreadEnvMode":"worktree","defaultModelSelection":{"provider":"codex","model":"portable-model"}}';
  await chooseSecondProject();
  expect(selection()?.model).not.toBe("portable-model");
  expect(useComposerDraftStore.getState().getDraftSession(draftId)?.envMode).toBe("local");
  await act(async () => fixture.finish());
  expect(selection()?.model).toBe("portable-model");
  expect(useComposerDraftStore.getState().getDraftSession(draftId)?.envMode).toBe("worktree");
  expect(fixture.reads).toHaveBeenCalledWith({
    environmentId,
    cwd: "/second",
    name: ".mesura.json",
  });
});
it("P2 regression draft route picker retains the project fallback without server configuration", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  await renderRoute();
  await chooseSecondProject();
  expect(selection()).toBeUndefined();
  await act(async () => fixture.finish());
  expect(selection()?.model).toBe("legacy-model");
});
it.each(["before", "during"])(
  "P2 regression draft route picker preserves explicit choices made %s the delayed read",
  async (timing) => {
    await using _browserFixture0 = await setupBrowserFixture0();

    fixture.environments[0]!.serverConfig = config();
    const chooseExplicit = () => {
      const store = useComposerDraftStore.getState();
      store.setModelSelection(
        draftId,
        { instanceId: ProviderInstanceId.make("codex"), model: "manual-model" },
        { explicit: true },
      );
      store.setDraftThreadContext(draftId, { envMode: "local" });
    };
    await renderRoute();
    fixture.contents =
      '{"version":1,"defaultThreadEnvMode":"worktree","defaultModelSelection":{"provider":"codex","model":"portable-model"}}';
    if (timing === "before") await act(async () => chooseExplicit());
    await chooseSecondProject();
    if (timing === "during") await act(async () => chooseExplicit());
    await act(async () => fixture.finish());
    expect(selection()?.model).toBe("manual-model");
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
      envMode: "local",
      envModeExplicit: true,
    });
  },
);
it("P2 regression mounted ChatView logs an unsafe model once across repeated provider status updates", async () => {
  await using _browserFixture0 = await setupBrowserFixture0();

  fixture.environments[0]!.serverConfig = config();
  fixture.contents = '{"version":1,"defaultModelSelection":{"provider":"codex","model":"missing"}}';
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    await renderRoute();
    const warnings = () =>
      warn.mock.calls.filter(([message]) =>
        String(message).includes("Repository model codex/missing"),
      );
    expect(warnings()).toHaveLength(1);
    expect(selection()?.model).toBe("portable-model");
    for (let update = 0; update < 3; update++) {
      fixture.environments = fixture.environments.map((environment) => ({
        ...environment,
        serverConfig: {
          ...environment.serverConfig!,
          providers: environment.serverConfig!.providers.map((provider) => ({
            ...provider,
            checkedAt: new Date(update).toISOString(),
          })),
        },
      }));
      await renderRoute();
    }
    expect(warnings()).toHaveLength(1);
    expect(selection()?.model).toBe("portable-model");
    expect(container.querySelector('[data-testid="composer"]')).not.toBeNull();
  } finally {
    warn.mockRestore();
  }
});
