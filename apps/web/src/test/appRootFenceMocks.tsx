import type { ReactNode } from "react";
import type { AsyncResult, Atom } from "effect/reactivity";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentThreadState } from "@t3tools/client-runtime/state/threads";
import type {
  AuthEnvironmentScope,
  AuthSessionState,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";

/**
 * The fixture the `AppRoot.*.fence` tests mount the real app over: the state
 * the replaced boundaries read, and one `vi.mock` factory per boundary.
 * Vitest hoists `vi.mock` per test module, so each fence wires the factories
 * up itself, loading this module from inside the factory through a hoisted
 * loader (a plain top-level `const` is not initialised yet when they run):
 *
 * ```ts
 * const fenceMocks = vi.hoisted(() => () => import("./test/appRootFenceMocks"));
 * vi.mock("./state/entities", async (original) => (await fenceMocks()).mockEntities(original));
 * ```
 *
 * This module must stay free of runtime imports of the app: it is loaded from
 * inside those factories, and an app import would reach a module whose mock
 * is still being built. Mounting helpers live in `appRootFenceApp.tsx`.
 *
 * Boundaries replaced, and nothing else: the environment and thread reads
 * (looked up by the thread ref), HTTP session grants, every RPC command and
 * query, the chords (the shipped defaults), unrelated chrome, the CSS highlight registry happy-dom
 * lacks (recorded instead of painted), the sidebar's thread list, the file
 * manager layer and the virtual list's measurement.
 */

export const FENCE_ENVIRONMENT_ID = "app-root-fence-environment";
export const FENCE_PROJECT_ID = "app-root-fence-project";

export const appRootFence = {
  threads: new Map<string, EnvironmentThreadShell>(),
  threadStates: new Map<string, EnvironmentThreadState>(),
  sessions: new Map<string, AuthSessionState>([[FENCE_ENVIRONMENT_ID, makeFenceSession()]]),
  queryAtoms: new WeakSet<object>(),
  openThreadId: "",
  vimMode: false,
  empty: [] as never[],
  threadListeners: new Set<() => void>(),
  /** The ranges the key surfaces last painted, by highlight name. */
  highlights: new Map<string, ReadonlyArray<Range>>(),
  project: {
    id: FENCE_PROJECT_ID,
    environmentId: FENCE_ENVIRONMENT_ID,
    title: "App root fence",
    workspaceRoot: "/tmp/app-root-fence",
    scripts: [],
    createdAt: "2026-10-08T12:00:00.000Z",
    defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" },
  },
  environments: [
    {
      environmentId: FENCE_ENVIRONMENT_ID,
      label: "Fence environment",
      connection: { phase: "connected" },
      entry: {
        target: {
          _tag: "PrimaryConnectionTarget",
          label: "Fence environment",
          connectionId: `saved:${FENCE_ENVIRONMENT_ID}`,
        },
      },
      displayUrl: null,
      relayManaged: false,
      serverConfig: {
        settings: {},
        environment: {
          capabilities: { threadSettlement: true, threadPinning: true },
          platform: { machine: "laptop" },
        },
        providers: [
          {
            instanceId: "codex",
            driver: "codex",
            enabled: true,
            installed: true,
            status: "ready",
            version: null,
            auth: { status: "authenticated" },
            checkedAt: "2026-10-08T12:00:00.000Z",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ],
      },
    },
  ],
};

/** The testid of the virtual list's scroller. */
export const FENCE_SCROLLER_TESTID = "app-root-fence-scroller";

/** Indexed rectangles for visibility and editor geometry reads in happy-dom. */
export function makeFenceClientRects(rectangles: ReadonlyArray<DOMRect>): DOMRectList {
  const rects = [...rectangles];
  return Object.assign(rects, {
    item: (index: number) => rects[index] ?? null,
  }) as unknown as DOMRectList;
}

/** happy-dom has no FontFaceSet. Keep font-loading listeners real without loading fonts. */
export function installFenceFontEvents() {
  if (document.fonts !== undefined) return () => {};
  const descriptor = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: Object.assign(new EventTarget(), { ready: Promise.resolve() }),
  });
  return () => {
    if (descriptor) Object.defineProperty(document, "fonts", descriptor);
    else Reflect.deleteProperty(document, "fonts");
  };
}

type ImportOriginal<Module> = () => Promise<Module>;

type ModuleWithOverrides<Module, Overrides> = Omit<Module, keyof Overrides> & Overrides;
type RuntimeSessionModule = typeof import("@t3tools/client-runtime/state/session");
type FenceRuntimeSessionModule = ModuleWithOverrides<
  RuntimeSessionModule,
  {
    createEnvironmentSessionAtoms: (
      ...args: Parameters<RuntimeSessionModule["createEnvironmentSessionAtoms"]>
    ) => ModuleWithOverrides<
      ReturnType<RuntimeSessionModule["createEnvironmentSessionAtoms"]>,
      {
        sessionStateAtom: (
          environmentId: EnvironmentId,
        ) => Atom.Atom<
          AsyncResult.Initial<AuthSessionState> | AsyncResult.Success<AuthSessionState>
        >;
      }
    >;
  }
>;
type FenceEnvironmentsModule = ModuleWithOverrides<
  typeof import("../state/environments"),
  {
    useEnvironments: () => {
      environments: typeof appRootFence.environments;
      isReady: boolean;
    };
    useEnvironmentProviders: () => Map<
      string,
      (typeof appRootFence.environments)[number]["serverConfig"]["providers"]
    >;
    usePrimaryEnvironment: () => null;
  }
>;
type FenceQueriesModule = ModuleWithOverrides<
  typeof import("../state/queries"),
  {
    useThreadSearch: () => { matches: never[]; query: string; isPending: boolean };
    useProjectPathSearch: () => {
      entries: never[];
      isPending: boolean;
      error: null;
      truncated: boolean;
    };
  }
>;

/** Explicit grants for chat and file reads. A fence can supply fewer permissions. */
export function makeFenceSession(
  permissions: ReadonlyArray<AuthEnvironmentScope> = [
    "orchestration:read",
    "orchestration:operate",
    "filesystem:read",
  ],
): AuthSessionState {
  return {
    authenticated: true,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "app-root-fence",
    },
    permissions,
  };
}

/** Replace the HTTP session source while retaining the real scope checks and hooks. */
export async function mockRuntimeSession(
  importOriginal: ImportOriginal<typeof import("@t3tools/client-runtime/state/session")>,
): Promise<FenceRuntimeSessionModule> {
  const actual = await importOriginal();
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const sessionStateAtom = Atom.family((environmentId: EnvironmentId) => {
    const atom = Atom.make((get) => {
      const read = () => {
        const session = appRootFence.sessions.get(environmentId);
        return session ? AsyncResult.success(session) : AsyncResult.initial<AuthSessionState>();
      };
      const listener = () => get.setSelf(read());
      appRootFence.threadListeners.add(listener);
      get.addFinalizer(() => appRootFence.threadListeners.delete(listener));
      return read();
    }).pipe(Atom.setIdleTTL(0));
    appRootFence.queryAtoms.add(atom);
    return atom;
  });
  return {
    ...actual,
    createEnvironmentSessionAtoms: (
      ...args: Parameters<typeof actual.createEnvironmentSessionAtoms>
    ) => ({ ...actual.createEnvironmentSessionAtoms(...args), sessionStateAtom }),
  };
}

const success = () => Promise.resolve({ _tag: "Success" as const, value: { providers: [] } });

export async function mockEntities(
  importOriginal: ImportOriginal<typeof import("../state/entities")>,
) {
  const { useSyncExternalStore } = await import("react");
  const threadFor = (ref: { readonly environmentId: string; readonly threadId: string } | null) => {
    const thread = ref ? appRootFence.threads.get(ref.threadId) : undefined;
    return thread?.environmentId === ref?.environmentId ? (thread ?? null) : null;
  };
  const useFixtureThread = (
    ref: { readonly environmentId: string; readonly threadId: string } | null,
  ) =>
    useSyncExternalStore(
      (listener) => {
        appRootFence.threadListeners.add(listener);
        return () => {
          appRootFence.threadListeners.delete(listener);
        };
      },
      () => threadFor(ref),
    );
  return {
    ...(await importOriginal()),
    readThreadShell: threadFor,
    useThreadShell: useFixtureThread,
    useThreadRefs: () => appRootFence.empty,
    useThreadShells: () => appRootFence.empty,
    useProjects: () => appRootFence.empty,
    useProject: () => appRootFence.project,
  };
}

export async function mockEnvironments(
  importOriginal: ImportOriginal<typeof import("../state/environments")>,
): Promise<FenceEnvironmentsModule> {
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  for (const environment of appRootFence.environments) {
    environment.serverConfig.settings = {
      ...DEFAULT_SERVER_SETTINGS,
      ...environment.serverConfig.settings,
    };
  }
  return {
    ...(await importOriginal()),
    useEnvironments: () => ({ environments: appRootFence.environments, isReady: true }),
    useEnvironmentProviders: () =>
      new Map(
        appRootFence.environments.map((environment) => [
          environment.environmentId,
          environment.serverConfig.providers,
        ]),
      ),
    usePrimaryEnvironment: () => null,
  };
}

/** Await this factory so the shell bootstrap read uses the real shell atom identities. */
export async function mockQuery() {
  const { environmentShell } = await import("../state/shell");
  const { EnvironmentId, ProjectId, ProviderInstanceId } = await import("@t3tools/contracts");
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const { useAtomValue } = await import("@effect/atom-react");
  const emptySession = Atom.make(AsyncResult.initial<AuthSessionState>());
  const Option = await import("effect/Option");
  const shellAtoms = new Map<object, string>(
    appRootFence.environments.map(({ environmentId }) => [
      environmentShell.stateAtom(EnvironmentId.make(environmentId)),
      environmentId,
    ]),
  );
  return {
    useEnvironmentQuery: (atom?: object | null) => {
      // Session atoms remain real subscriptions so the filesystem-access hook reads its grant.
      const isSession = atom != null && appRootFence.queryAtoms.has(atom);
      const session = useAtomValue(isSession ? (atom as typeof emptySession) : emptySession);
      if (isSession)
        return {
          data: Option.getOrNull(AsyncResult.value(session)),
          dataUpdatedAt: 0,
          error: null,
          failure: null,
          isPending: session.waiting,
          isSuccess: AsyncResult.isSuccess(session),
          refresh: () => undefined,
        };
      const environmentId = atom == null ? undefined : shellAtoms.get(atom);
      const project = appRootFence.project;
      const snapshot = {
        schemaVersion: 1,
        snapshotSequence: 0,
        threads: [...appRootFence.threads.values()]
          .filter((shell) => shell.environmentId === environmentId)
          .map((shell) => shell.source),
        archivedThreads: [],
        projects:
          project.environmentId === environmentId
            ? [
                {
                  ...project,
                  id: ProjectId.make(project.id),
                  defaultModelSelection: {
                    ...project.defaultModelSelection,
                    instanceId: ProviderInstanceId.make(project.defaultModelSelection.instanceId),
                  },
                  updatedAt: project.createdAt,
                },
              ]
            : [],
      } satisfies import("@t3tools/contracts").OrchestrationV2ShellSnapshot;
      return {
        // The v2 chat layout waits for the environment shell before mounting ThreadRouteView.
        data:
          environmentId === undefined
            ? null
            : { snapshot: Option.some(snapshot), status: "live", error: Option.none() },
        dataUpdatedAt: 0,
        error: null,
        failure: null,
        isPending: false,
        isSuccess: environmentId !== undefined,
        refresh: () => undefined,
      };
    },
  };
}

export async function mockQueries(
  importOriginal: ImportOriginal<typeof import("../state/queries")>,
): Promise<FenceQueriesModule> {
  return {
    ...(await importOriginal()),
    useThreadSearch: () => ({ matches: [], query: "", isPending: false }),
    useProjectPathSearch: () => ({ entries: [], isPending: false, error: null, truncated: false }),
  };
}

export async function mockThreads(
  importOriginal: ImportOriginal<typeof import("../state/threads")>,
): Promise<typeof import("../state/threads")> {
  const { createEnvironmentThreadDetailAtoms, EMPTY_ENVIRONMENT_THREAD_STATE } =
    await import("@t3tools/client-runtime/state/threads");
  const { threadKey, parseThreadKey } = await import("@t3tools/client-runtime/state/entities");
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const { useAtomValue } = await import("@effect/atom-react");
  const stateFor = (key: string) => {
    const ref = parseThreadKey(key);
    const shell = appRootFence.threads.get(ref.threadId);
    return shell?.environmentId === ref.environmentId
      ? (appRootFence.threadStates.get(ref.threadId) ?? EMPTY_ENVIRONMENT_THREAD_STATE)
      : EMPTY_ENVIRONMENT_THREAD_STATE;
  };
  const stateAtom = Atom.family((key: string) =>
    Atom.make((get) => {
      const listener = () => get.setSelf(AsyncResult.success(stateFor(key)));
      appRootFence.threadListeners.add(listener);
      get.addFinalizer(() => appRootFence.threadListeners.delete(listener));
      return AsyncResult.success(stateFor(key));
    }).pipe(Atom.setIdleTTL(0)),
  );
  const emptyAtom = Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE));
  const scopedStateAtom = (environmentId: EnvironmentId, threadId: ThreadId) =>
    stateAtom(threadKey({ environmentId, threadId }));
  return {
    ...(await importOriginal()),
    // Keep the real entity hooks and all v2 detail derivations. Only their source is a fixture.
    environmentThreadDetails: createEnvironmentThreadDetailAtoms(scopedStateAtom),
    useEnvironmentThread: (environmentId: EnvironmentId | null, threadId: ThreadId | null) => {
      const result = useAtomValue(
        environmentId !== null && threadId !== null
          ? scopedStateAtom(environmentId, threadId)
          : emptyAtom,
      );
      return AsyncResult.isSuccess(result) ? result.value : EMPTY_ENVIRONMENT_THREAD_STATE;
    },
  };
}

export function mockAtomCommand() {
  return { useAtomCommand: () => success };
}

export function mockAtomQueryRunner() {
  return { useAtomQueryRunner: () => success };
}

/** The chords the app ships, as a keybindings file with no user rules resolves them. */
export async function mockServer(importOriginal: ImportOriginal<typeof import("../state/server")>) {
  const { Atom } = await import("effect/reactivity");
  const { DEFAULT_RESOLVED_KEYBINDINGS } = await import("@t3tools/shared/keybindings");
  return {
    ...(await importOriginal()),
    primaryServerKeybindingsAtom: Atom.make(() => DEFAULT_RESOLVED_KEYBINDINGS),
  };
}

export async function mockSettings(
  importOriginal: ImportOriginal<typeof import("../hooks/useSettings")>,
) {
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts/settings");
  const clientSettings = () => ({ ...DEFAULT_CLIENT_SETTINGS, vimMode: appRootFence.vimMode });
  return {
    ...(await importOriginal()),
    useEnvironmentSettings: () => ({ ...clientSettings(), ...DEFAULT_SERVER_SETTINGS }),
    useClientSettings: (select?: (value: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
      select ? select(clientSettings()) : clientSettings(),
    useClientSettingsHydrated: () => true,
    useLegacySidebarEnabled: () => false,
  };
}

export async function mockHandleNewThread() {
  const { scopeThreadRef } = await import("@t3tools/client-runtime/environment");
  const { EnvironmentId, ThreadId } = await import("@t3tools/contracts");
  return {
    useNewThreadHandler: () => success,
    useHandleNewThread: () => ({
      activeDraftThread: null,
      activeThread: appRootFence.threads.get(appRootFence.openThreadId) ?? null,
      defaultProjectRef: null,
      handleNewThread: success,
      routeDraftId: null,
      routeThreadRef: scopeThreadRef(
        EnvironmentId.make(FENCE_ENVIRONMENT_ID),
        ThreadId.make(appRootFence.openThreadId),
      ),
    }),
  };
}

export function mockThreadActions() {
  return {
    useAcknowledgeThreadWoke: () => success,
    useThreadActions: () => ({
      settleThread: success,
      pinThread: success,
      confirmAndUnpinThread: success,
    }),
  };
}

/**
 * The sidebar's thread list, reduced to the open thread's row: the element
 * pane focus enters the sidebar through.
 */
export function mockSidebar() {
  return {
    default: () => (
      <ul>
        <li data-thread-item="" data-thread-key="app-root-fence-row">
          <div role="button" tabIndex={0} data-testid="sidebar-thread-row">
            App root fence
          </div>
        </li>
      </ul>
    ),
  };
}

/** A module whose one export, `name`, renders nothing. */
export function mockRendersNothing(name: string) {
  return { [name]: () => null };
}

/**
 * The file manager layer: its focusable root while the store says open. No
 * focus of its own on mount, so only the palette's close can hand it the
 * keyboard.
 */
export async function mockFileManagerLayer() {
  const { useFileManagerStore } =
    await import("../components/files/mesuraFileManager/fileManagerStore");
  const { FILE_MANAGER_ROOT_ATTRIBUTE } =
    await import("../components/files/mesuraFileManager/isFileManagerOpen");
  return {
    MesuraFileManagerLayer: () => {
      const open = useFileManagerStore((state) => state.open);
      return open ? (
        <div {...{ [FILE_MANAGER_ROOT_ATTRIBUTE]: "" }} tabIndex={-1} data-testid="file-manager" />
      ) : null;
    },
  };
}

/** happy-dom has no CSS Custom Highlight API: record what would be painted. */
export function mockHighlights() {
  return {
    paintHighlight: (name: string, ranges: readonly Range[]) => {
      appRootFence.highlights.set(
        name,
        ranges.map((range) => range.cloneRange()),
      );
    },
  };
}

/**
 * happy-dom has no layout. Routing and timeline projection stay real; only
 * the virtual list's measurement is replaced, by a scroller styled to scroll
 * as the real list's is. Its box is the fence's to stub.
 */
export function mockLegendList() {
  return {
    LegendList: <Item,>({
      data,
      renderItem,
      keyExtractor,
      ListHeaderComponent,
      ListFooterComponent,
    }: {
      data: ReadonlyArray<Item>;
      renderItem: (input: { item: Item }) => ReactNode;
      keyExtractor: (item: Item) => string;
      ListHeaderComponent?: ReactNode;
      ListFooterComponent?: ReactNode;
    }) => (
      <div data-testid={FENCE_SCROLLER_TESTID} style={{ overflowY: "auto" }}>
        {ListHeaderComponent}
        {data.map((item) => (
          <div key={keyExtractor(item)}>{renderItem({ item })}</div>
        ))}
        {ListFooterComponent}
      </div>
    ),
  };
}
