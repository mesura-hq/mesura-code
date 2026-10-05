// @vitest-environment happy-dom
// Application entry point: _chat.draft.$draftId Route.options.component.
// ChatView, DraftHeroHeadline, the draft store, and defaults resolution remain real.
// Environment I/O and unrelated expensive panels are test boundaries.
import { act, lazy, Suspense, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  type ServerConfig,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

const fixture = vi.hoisted(() => ({
  environments: [] as {
    environmentId: EnvironmentId;
    label: string;
    connection: { phase: string };
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
}));
vi.mock("@tanstack/react-router", () => ({
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
  useLocation: () => ({ href: `/draft/${fixture.draftId}`, key: "draft" }),
}));
vi.mock("../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => fixture.command }));
vi.mock("../hooks/useThreadActions", () => ({ useThreadActions: () => ({}) }));
vi.mock("../hooks/useSettings", () => ({
  useEnvironmentSettings: () => DEFAULT_SERVER_SETTINGS,
  useClientSettingsHydrated: () => true,
  useClientSettings: (select?: (s: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select ? select(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS,
}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: fixture.environments }),
  useEnvironment: (id: string) => fixture.environments.find((e) => e.environmentId === id),
  usePrimaryEnvironment: () => fixture.environments[0],
  usePrimaryEnvironmentId: () => fixture.environments[0]?.environmentId,
}));
vi.mock("../state/entities", () => ({
  useServerConfigs: () => new Map(),
  useProject: (ref: { projectId: string } | null) =>
    fixture.projects.find((p) => p.id === ref?.projectId) ?? null,
  useProjects: () => fixture.projects,
  useThread: () => null,
  useThreadShell: () => null,
  useThreadRefs: () => fixture.empty,
  useThreadShells: () => fixture.empty,
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => fixture.command }));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => fixture.command }));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, isPending: false, refresh: fixture.command }),
}));
vi.mock("../state/threads", () => ({
  threadEnvironment: {},
  useEnvironmentThread: () => ({ data: { _tag: "None" }, status: "idle" }),
}));
vi.mock("../state/server", () => ({
  serverEnvironment: { updateStateAtom: () => "update" },
  primaryServerKeybindingsAtom: "keys",
  primaryServerAvailableEditorsAtom: "editors",
  environmentServerConfigsAtom: "configs",
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) =>
    atom === "keys"
      ? { rules: [] }
      : atom === "editors"
        ? []
        : atom === "configs"
          ? new Map()
          : { status: "idle" },
}));
vi.mock("../state/terminalSessions", () => ({
  useKnownTerminalSessions: () => fixture.empty,
  useThreadRunningTerminalIds: () => fixture.empty,
}));
vi.mock("../state/projectClones", () => ({ useProjectClone: () => null }));
vi.mock("../state/device", () => ({
  useDeviceState: () => ({ state: { sessions: fixture.empty }, loaded: true }),
}));
vi.mock("../components/files/projectFilesQueryState", () => ({
  getProjectFileQueryAtom: (environmentId: string, cwd: string, name: string) => ({
    environmentId,
    cwd,
    name,
  }),
  resolveProjectFileQueryData: (_id: string, _cwd: string, _name: string, data: unknown) => data,
}));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: () => ({ connection: { phase: "connected" } }),
    subscribe: () => () => {},
  },
}));
vi.mock("../state/presentation", () => ({
  environmentPresentations: { presentationAtom: () => "connection" },
}));
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
vi.mock("../components/ui/sidebar", () => ({
  SidebarInset: ({ children }: PropsWithChildren) => <main>{children}</main>,
}));
vi.mock("../components/chat/ChatComposer", () => ({
  ChatComposer: () => <div data-testid="composer" />,
}));
vi.mock("../components/chat/MessagesTimeline", () => ({ MessagesTimeline: () => null }));
vi.mock("../components/BranchToolbar", () => ({ BranchToolbar: () => null }));
vi.mock("../components/chat/ChatHeader", () => ({ ChatHeader: () => null }));
vi.mock("../components/ThreadTerminalDrawer", () => ({ default: () => null }));
vi.mock("../components/WorkspacePageHeader", () => ({ WorkspacePageHeader: () => null }));
vi.mock("../components/chat/ExpandedImageDialog", () => ({ ExpandedImageDialog: () => null }));
vi.mock("../components/PullRequestThreadDialog", () => ({ PullRequestThreadDialog: () => null }));

vi.mock("../components/chat/useAutoBalanceUpdateBanner", () => ({
  useAutoBalanceUpdateBanner: () => null,
}));

vi.mock("../assets/assetUrls", () => ({
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

import { Route } from "./_chat.draft.$draftId";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
let draftId: DraftId;
const initialDraftState = useComposerDraftStore.getState();
const environmentId = EnvironmentId.make("p2-owner");
let root: Root;
let container: HTMLDivElement;
async function renderRoute() {
  await Promise.all(fixture.loads);
  const Entry = Route.options.component!;
  await act(async () =>
    root.render(
      <Suspense>
        <Entry />
      </Suspense>,
    ),
  );
}
beforeEach(() => {
  fixture.draftId = `p2-mounted-${++fixture.sequence}`;
  draftId = DraftId.make(fixture.draftId);
  fixture.reads.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} });
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
    { environmentId, label: "Owner", connection: { phase: "connected" }, serverConfig: null },
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
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function chooseSecondProject() {
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Change project"]');
  expect(trigger).not.toBeNull();
  await act(async () => trigger!.click());
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
    item.textContent?.includes("second"),
  );
  expect(item).toBeDefined();
  await act(async () => item!.click());
  expect(useComposerDraftStore.getState().getDraftSession(draftId)?.projectId).toBe("second");
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
it("P2 regression draft route picker applies the selected checkout after a delayed read", async () => {
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
  await renderRoute();
  await chooseSecondProject();
  expect(selection()).toBeUndefined();
  await act(async () => fixture.finish());
  expect(selection()?.model).toBe("legacy-model");
});
it.each(["before", "during"])(
  "P2 regression draft route picker preserves explicit choices made %s the delayed read",
  async (timing) => {
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
