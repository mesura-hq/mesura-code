import type { ReactNode } from "react";
import type { Thread } from "../types";

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
 * (looked up by the thread ref), every RPC command and query, the chords (the
 * shipped defaults), unrelated chrome, the CSS highlight registry happy-dom
 * lacks (recorded instead of painted), the sidebar's thread list, the file
 * manager layer and the virtual list's measurement.
 */

export const FENCE_ENVIRONMENT_ID = "app-root-fence-environment";
export const FENCE_PROJECT_ID = "app-root-fence-project";

export const appRootFence = {
  threads: new Map<string, Thread>(),
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

type ImportOriginal<Module> = () => Promise<Module>;

const success = () => Promise.resolve({ _tag: "Success" as const, value: { providers: [] } });

export async function mockEntities(
  importOriginal: ImportOriginal<typeof import("../state/entities")>,
) {
  const { useSyncExternalStore } = await import("react");
  const threadFor = (ref: { readonly threadId: string } | null | undefined) =>
    (ref ? appRootFence.threads.get(ref.threadId) : undefined) ?? null;
  const useFixtureThread = (ref: { readonly threadId: string } | null | undefined) =>
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
    useThread: useFixtureThread,
    readThread: threadFor,
    useThreadShell: useFixtureThread,
    useThreadRefs: () => appRootFence.empty,
    useThreadShells: () => appRootFence.empty,
    useProjects: () => appRootFence.empty,
    useProject: () => appRootFence.project,
  };
}

export async function mockEnvironments(
  importOriginal: ImportOriginal<typeof import("../state/environments")>,
) {
  return {
    ...(await importOriginal()),
    useEnvironments: () => ({ environments: appRootFence.environments, isReady: true }),
    usePrimaryEnvironment: () => null,
  };
}

export function mockQuery() {
  return {
    useEnvironmentQuery: () => ({
      data: null,
      error: null,
      isPending: false,
      isSuccess: false,
      refresh: () => undefined,
    }),
  };
}

export async function mockQueries(
  importOriginal: ImportOriginal<typeof import("../state/queries")>,
) {
  return {
    ...(await importOriginal()),
    useThreadSearch: () => ({ matches: [], isPending: false }),
    useProjectPathSearch: () => ({ entries: [], isPending: false, error: null, truncated: false }),
  };
}

export async function mockThreads(
  importOriginal: ImportOriginal<typeof import("../state/threads")>,
) {
  const { EMPTY_ENVIRONMENT_THREAD_STATE } = await import("@t3tools/client-runtime/state/threads");
  return {
    ...(await importOriginal()),
    useEnvironmentThread: () => EMPTY_ENVIRONMENT_THREAD_STATE,
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
  const { Atom } = await import("effect/unstable/reactivity");
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
      <div data-testid={FENCE_SCROLLER_TESTID} style={{ overflowY: "auto" }}>
        {ListHeaderComponent}
        {data.map((item) => (
          <div key={item.id}>{renderItem({ item })}</div>
        ))}
        {ListFooterComponent}
      </div>
    ),
  };
}
