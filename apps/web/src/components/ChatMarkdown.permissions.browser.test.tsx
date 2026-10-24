import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type AuthEnvironmentScope,
  type EditorId,
  type ThreadLinkedPullRequest,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import * as Option from "effect/Option";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  installThreadLinkEnvironment,
  linkEnvelope,
  mountThreadLinkStream,
  threadLinkFixture,
  createDeferredPromise,
} from "~/test/threadLinkFixture";
import { readThreadPreviewState, resetPreviewStateForTests } from "~/previewStateStore";
import { useRightPanelStore } from "../rightPanelStore";

const state = vi.hoisted(() => ({
  allowed: true,
  hydrated: true,
  hydrate: vi.fn(),
  allocate: vi.fn(),
  preference: "system" as "system" | "app",
  width: 1280,
  coarse: false,
  previewAvailable: false,
  toast: vi.fn(),
  listeners: new Set<() => void>(),
  openEditor: vi.fn(),
  updateMetadata: vi.fn(),
  search: vi.fn(),
  choose: vi.fn(),
  openFile: vi.fn(),
  openExternal: vi.fn(),
  copy: vi.fn(),
  linkedPullRequest: null as ThreadLinkedPullRequest | null,
}));

vi.mock(import("../state/use-atom-query-runner"), async (original) => ({
  ...(await original()),
  useAtomQueryRunner: (() => state.search) as never,
}));
vi.mock(import("../state/use-atom-command"), async (original) => {
  const { threadEnvironment } = await import("../state/threads");
  const { previewEnvironment } = await import("../state/preview");
  return {
    ...(await original()),
    useAtomCommand: ((command: unknown) =>
      command === threadEnvironment.updateMetadata
        ? state.updateMetadata
        : command === previewEnvironment.openLinkTarget
          ? state.allocate
          : state.openEditor) as never,
  };
});
vi.mock(import("../state/session"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const actual = await original();
  const fixture = (await import("~/test/threadLinkFixture")).threadLinkFixture;
  const readEnvironmentScope = (id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
    id !== null &&
    (scope !== AuthOrchestrationOperateScope || id !== threadRef.environmentId || state.allowed);
  return {
    ...actual,
    readEnvironmentScope,
    environmentSession: {
      ...actual.environmentSession,
      preparedConnectionValueAtom: fixture.prepared as never,
    },
    readPreparedConnection: ((id: EnvironmentId) =>
      Option.getOrNull(appAtomRegistry.get(threadLinkFixture.prepared(id)))) as never,
    useEnvironmentScope: (id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => readEnvironmentScope(id, scope),
      ),
  };
});
// Atoms derived from the server config run in the real registry over this config.
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make(() => serverConfig);
  const fixture = (await import("~/test/threadLinkFixture")).threadLinkFixture;
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => config) as never },
    environmentServerConfigsAtom: fixture.configs as never,
  };
});
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  readThreadShell: (() => ({ linkedPullRequest: state.linkedPullRequest })) as never,
  useProjects: (() => [
    { id: linkedPullRequest.projectId, environmentId: threadRef.environmentId },
  ]) as never,
}));
vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
vi.mock(import("../hooks/useLocalStorage"), async (original) => ({
  ...(await original()),
  useLocalStorage: (() => ["vscode", vi.fn()]) as never,
  getLocalStorageItem: (() => "vscode") as never,
}));
vi.mock(import("../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: () =>
    ({
      contextMenu: { show: state.choose },
      shell: { openExternal: state.openExternal },
    }) as never,
}));
vi.mock(import("~/lib/openPullRequestLink"), async (original) => ({
  ...(await original()),
  resolvePullRequestPreviewTarget: () => null,
  findProjectForChangeRequest: ((projects: readonly { id: ProjectId }[]) => projects[0]) as never,
  matchesLinkedPullRequestUrl: (candidate: ThreadLinkedPullRequest, href: string) =>
    candidate.url === href,
  parseChangeRequestUrl: ((href: string) =>
    href === linkedPullRequest.url
      ? {
          host: "github.com",
          repository: linkedPullRequest.repository,
          number: linkedPullRequest.number,
        }
      : null) as never,
}));

vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  ensureClientSettingsHydrated: state.hydrate,
  useClientSettingsHydrated: () => state.hydrated,
  getClientSettings: () => ({ ...DEFAULT_CLIENT_SETTINGS, browserLinkTarget: state.preference }),
  useClientSettings: ((select?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select
      ? select({ ...DEFAULT_CLIENT_SETTINGS, browserLinkTarget: state.preference })
      : DEFAULT_CLIENT_SETTINGS) as never,
}));
vi.mock(import("../browser/previewRuntime"), async (original) => ({
  ...(await original()),
  isPreviewAvailableFor: () => state.previewAvailable,
}));
vi.mock(import("../browser/browserDefaults"), async (original) => ({
  ...(await original()),
  resolveBrowserDefaults: (async () => ({
    viewport: { _tag: "fill" },
    profileId: "default",
  })) as never,
}));
vi.mock(import("../state/preview"), async (original) => {
  const actual = await original();
  const fixture = (await import("~/test/threadLinkFixture")).threadLinkFixture;
  return {
    ...actual,
    previewEnvironment: {
      ...actual.previewEnvironment,
      openLinkTarget: { permissionAtom: fixture.permission } as never,
    },
  };
});
vi.mock(import("../connection/catalog"), async (original) => {
  const actual = await original();
  const fixture = (await import("~/test/threadLinkFixture")).threadLinkFixture;
  return {
    ...actual,
    environmentCatalog: {
      ...actual.environmentCatalog,
      catalogValueAtom: fixture.catalog as never,
      stateAtom: fixture.connection as never,
    },
  };
});
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: () => null,
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } };
});

import ChatMarkdown from "./ChatMarkdown";

const threadRef = {
  environmentId: EnvironmentId.make("selected"),
  threadId: ThreadId.make("thread"),
};
const linkedPullRequest: ThreadLinkedPullRequest = {
  projectId: ProjectId.make("project"),
  repository: "example/repo",
  number: 42,
  url: "https://github.com/example/repo/pull/42",
};
const serverConfig = {
  availableEditors: ["vscode", "file-manager"] as readonly EditorId[],
  shellRevealInFileManager: true,
  shellRevealInFileManagerKind: "xdg-open",
  environment: { platform: { os: "linux" }, capabilities: { threadPullRequestLinking: true } },
};

function setup() {
  using stack = new DisposableStack();
  state.hydrated = true;
  state.hydrate.mockReset().mockResolvedValue(undefined);
  state.previewAvailable = false;
  state.preference = "system";
  state.width = 1280;
  state.coarse = false;
  state.toast.mockReset();
  resetPreviewStateForTests();
  useRightPanelStore.setState({
    byThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
    pendingMaximizeThreadKey: null,
  });
  installThreadLinkEnvironment(threadRef);
  stack.defer(mountThreadLinkStream(threadRef));
  state.allocate.mockReset().mockResolvedValue(AsyncResult.success(linkEnvelope(threadRef)));
  const widthDescriptor = Object.getOwnPropertyDescriptor(window, "innerWidth");
  Object.defineProperty(window, "innerWidth", { configurable: true, get: () => state.width });
  stack.defer(() => {
    if (widthDescriptor) Object.defineProperty(window, "innerWidth", widthDescriptor);
    else Reflect.deleteProperty(window, "innerWidth");
  });
  stack.use(
    vi
      .spyOn(window, "matchMedia")
      .mockImplementation(() => ({ matches: state.coarse }) as MediaQueryList),
  );
  state.allowed = true;
  state.listeners.clear();
  state.linkedPullRequest = null;
  state.openEditor.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.updateMetadata.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.search.mockReset().mockResolvedValue(AsyncResult.success({ entries: [] }));
  state.choose.mockReset().mockResolvedValue(null);
  state.openFile.mockReset();
  state.openExternal.mockReset().mockResolvedValue(undefined);
  state.copy.mockReset().mockResolvedValue(undefined);
  const { openFile } = useRightPanelStore.getState();
  useRightPanelStore.setState({ openFile: state.openFile });
  stack.defer(() => useRightPanelStore.setState({ openFile }));
  stack.use(vi.spyOn(navigator.clipboard, "writeText").mockImplementation(state.copy));
  stack.use(
    vi.spyOn(navigator.clipboard, "write").mockImplementation(async (items) => {
      const item = items[0]!;
      await state.copy(await (await item.getType("text/plain")).text());
    }),
  );
  return stack.move();
}

async function renderMarkdown(text: string) {
  appAtomRegistry.set(
    threadLinkFixture.configs,
    new Map([
      [
        threadRef.environmentId,
        {
          ...serverConfig,
          environment: {
            ...serverConfig.environment,
            capabilities: {
              ...serverConfig.environment.capabilities,
              serverBrowser: state.previewAvailable,
              threadLinkPreview: state.previewAvailable,
            },
          },
        },
      ],
    ]),
  );
  const screen = await render(<ChatMarkdown cwd="/work" threadRef={threadRef} text={text} />);
  const anchor = () => screen.container.querySelector("a")!;
  return Object.assign(screen, {
    anchor,
    openContextMenu: () =>
      act(async () => {
        anchor().dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 10,
            clientY: 10,
          }),
        );
      }),
  });
}

function offeredActions() {
  return state.choose.mock.lastCall![0].map((item: { id: string }) => item.id);
}

async function setAllowed(allowed: boolean) {
  await act(async () => {
    state.allowed = allowed;
    for (const listener of state.listeners) listener();
  });
}

it("removes host actions after revocation while keeping file preview and copying", async () => {
  using _setup = setup();
  await using screen = await renderMarkdown("[Readme](docs/readme.md)");
  await screen.openContextMenu();
  expect(offeredActions()).toEqual(["open", "reveal", "copy-relative", "copy-full"]);
  await setAllowed(false);
  state.choose.mockResolvedValue("copy-full");
  await screen.openContextMenu();
  expect(offeredActions()).toEqual(["copy-relative", "copy-full"]);
  await vi.waitFor(() => expect(state.copy).toHaveBeenCalledWith("/work/docs/readme.md"));
  await act(async () => screen.anchor().click());
  expect(state.openFile).toHaveBeenCalledWith(threadRef, "docs/readme.md", undefined);
  expect(state.openEditor).not.toHaveBeenCalled();
});

it("does not launch an editor after revocation during a native context menu", async () => {
  using _setup = setup();
  let choose: (action: string) => void = () => {
    throw new Error("Menu not opened");
  };
  state.choose.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        choose = resolve;
      }),
  );
  await using screen = await renderMarkdown("[Readme](docs/readme.md)");
  await screen.openContextMenu();
  expect(offeredActions()).toContain("open");
  await act(async () => {
    state.allowed = false;
    choose("open");
  });
  expect(state.openEditor).not.toHaveBeenCalled();
});

it("does not reveal a file after revocation during its workspace lookup", async () => {
  using _setup = setup();
  let finishLookup: () => void = () => {
    throw new Error("Lookup not started");
  };
  state.search.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishLookup = () => resolve(AsyncResult.success({ entries: [] }));
      }),
  );
  state.choose.mockResolvedValue("reveal");
  await using screen = await renderMarkdown("[Readme](readme.md)");
  await screen.openContextMenu();
  expect(state.search).toHaveBeenCalledOnce();
  await act(async () => {
    state.allowed = false;
    finishLookup();
  });
  expect(state.openEditor).not.toHaveBeenCalled();
});

it.each(["link-to-thread", "unlink-from-thread"])(
  "rechecks %s after a native context menu returns",
  async (action) => {
    using _setup = setup();
    state.linkedPullRequest = action === "unlink-from-thread" ? linkedPullRequest : null;
    let choose: (action: string) => void = () => {
      throw new Error("Menu not opened");
    };
    state.choose.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          choose = resolve;
        }),
    );
    await using screen = await renderMarkdown(`[Review](${linkedPullRequest.url})`);
    await screen.openContextMenu();
    expect(offeredActions()).toContain(action);
    await act(async () => {
      state.allowed = false;
      choose(action);
    });
    expect(state.updateMetadata).not.toHaveBeenCalled();

    await setAllowed(true);
    state.choose.mockResolvedValue(action);
    await screen.openContextMenu();
    await vi.waitFor(() =>
      expect(state.updateMetadata).toHaveBeenCalledExactlyOnceWith({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          linkedPullRequest: action === "link-to-thread" ? linkedPullRequest : null,
        },
      }),
    );
  },
);

async function activateAnchor(anchor: HTMLAnchorElement, modifiers: MouseEventInit = {}) {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifiers });
  let intercepted = false;
  let suppressedNativeNavigation = false;
  const stopNativeNavigation = (received: Event) => {
    if (received !== event) return;
    intercepted = received.defaultPrevented;
    suppressedNativeNavigation = true;
    received.preventDefault();
  };
  document.addEventListener("click", stopNativeNavigation);
  try {
    await act(() => {
      anchor.dispatchEvent(event);
    });
  } finally {
    document.removeEventListener("click", stopNativeNavigation);
  }
  return { defaultPrevented: suppressedNativeNavigation ? intercepted : event.defaultPrevented };
}
it.each(["app", "system"] as const)(
  "thread link DOM hydration fence: pending settings resolves saved %s after anchor interception",
  async (preference) => {
    using _setup = setup();
    state.previewAvailable = true;
    state.hydrated = false;
    const persistence = createDeferredPromise<void>();
    state.hydrate.mockReturnValueOnce(persistence.promise);
    await using screen = await renderMarkdown("[External](https://example.com/docs)");
    const event = await activateAnchor(screen.anchor());
    expect(event.defaultPrevented).toBe(true);
    expect(state.hydrate).toHaveBeenCalledOnce();
    expect(state.allocate).not.toHaveBeenCalled();
    expect(state.openExternal).not.toHaveBeenCalled();
    await act(async () => {
      state.preference = preference;
      persistence.resolve();
      await persistence.promise;
    });
    if (preference === "app") {
      expect(state.allocate).toHaveBeenCalledOnce();
      expect(readThreadPreviewState(threadRef).sessions["shared-target"]?.navStatus).toMatchObject({
        _tag: "Loading",
        url: "https://example.com/docs",
      });
      expect(state.openExternal).not.toHaveBeenCalled();
    } else {
      expect(state.allocate).not.toHaveBeenCalled();
      expect(state.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/docs");
    }
  },
);

it("thread link DOM hydration fence: rejected persistence shows the typed settings error without fallback", async () => {
  using _setup = setup();
  state.previewAvailable = true;
  state.hydrated = false;
  const persistence = createDeferredPromise<void>();
  state.hydrate.mockReturnValueOnce(persistence.promise);
  using _console = vi.spyOn(console, "error").mockImplementation(() => {});
  await using screen = await renderMarkdown("[External](https://example.com/docs)");
  expect((await activateAnchor(screen.anchor())).defaultPrevented).toBe(true);
  await act(async () => {
    persistence.reject(new Error("Synthetic persistence failure"));
    await persistence.promise.catch(() => {});
  });
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "error",
      title: "Unable to open link in browser",
      description: "Saved browser settings could not be loaded.",
    }),
  );
  expect(state.allocate).not.toHaveBeenCalled();
  expect(state.openExternal).not.toHaveBeenCalled();
});

it.each([
  { label: "phone", width: 767 },
  { label: "primary coarse", coarse: true },
  { label: "Ctrl", ctrlKey: true },
  { label: "Cmd", metaKey: true },
  { label: "fragment", href: "#details" },
  { label: "nonweb", href: "mailto:hello@example.com" },
  { label: "file", width: 767, href: "docs/readme.md", file: true },
])(
  "thread link DOM hydration guard: $label keeps immediate precedence while settings waits",
  async (entry) => {
    using _setup = setup();
    state.previewAvailable = true;
    state.hydrated = false;
    state.hydrate.mockReturnValueOnce(new Promise<void>(() => {}));
    state.width = "width" in entry ? entry.width : 1280;
    state.coarse = "coarse" in entry && entry.coarse;
    await using screen = await renderMarkdown(
      `[Link](${"href" in entry ? entry.href : "https://example.com/docs"})`,
    );
    const event = await activateAnchor(screen.anchor(), {
      ctrlKey: "ctrlKey" in entry && entry.ctrlKey,
      metaKey: "metaKey" in entry && entry.metaKey,
    });
    // The existing fragment handler prevents native navigation and scrolls the
    // same document. It also runs before asynchronous browser settings.
    expect(event.defaultPrevented).toBe("file" in entry || entry.label === "fragment");
    expect(state.hydrate).not.toHaveBeenCalled();
    expect(state.allocate).not.toHaveBeenCalled();
    if ("file" in entry)
      expect(state.openFile).toHaveBeenCalledWith(threadRef, entry.href, undefined);
  },
);

it.each([
  [767, false, "app", false],
  [1280, true, "app", false],
  [768, false, "app", true],
  [1280, false, "system", false],
] as const)(
  "markdown link policy: width %s coarse %s saved %s intercepts %s",
  async (width, coarse, preference, intercepted) => {
    using _setup = setup();
    state.previewAvailable = true;
    state.preference = preference;
    await using screen = await renderMarkdown("[External](https://example.com/docs)");
    state.width = width;
    state.coarse = coarse;
    const event = await activateAnchor(screen.anchor());
    expect(event.defaultPrevented).toBe(intercepted);
    expect(state.allocate).toHaveBeenCalledTimes(intercepted ? 1 : 0);
    if (intercepted) expect(readThreadPreviewState(threadRef).activeTabId).toBe("shared-target");
    expect(state.openExternal).not.toHaveBeenCalled();
  },
);
it("markdown link policy: explicit desktop app ignores system preference but stale phone menu uses system", async () => {
  using _setup = setup();
  state.previewAvailable = true;
  const choice = createDeferredPromise<string>();
  state.choose.mockReturnValueOnce(choice.promise);
  await using screen = await renderMarkdown("[External](https://example.com/docs)");
  await screen.openContextMenu();
  expect(offeredActions()).toContain("open-in-preview");
  await act(() => {
    state.width = 767;
    choice.resolve("open-in-preview");
  });
  expect(state.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/docs");
  expect(state.allocate).not.toHaveBeenCalled();
  state.width = 1280;
  state.choose.mockResolvedValue("open-in-preview");
  await screen.openContextMenu();
  expect(readThreadPreviewState(threadRef).activeTabId).toBe("shared-target");
});
