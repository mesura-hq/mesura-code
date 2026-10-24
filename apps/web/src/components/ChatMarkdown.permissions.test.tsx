// @vitest-environment jsdom
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type AuthEnvironmentScope,
  type EditorId,
  type ThreadLinkedPullRequest,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { AsyncResult } from "effect/reactivity";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { createRoot, type Root } from "react-dom/client";

const state = vi.hoisted(() => ({
  allowed: true,
  hydrate: vi.fn(),
  hydrated: true,
  allocate: vi.fn(),
  preference: "system" as "system" | "app",
  width: 1280,
  coarse: false,
  previewAvailable: false,
  openPreview: vi.fn(),
  openBrowser: vi.fn(),
  listeners: new Set<() => void>(),
  openEditor: vi.fn(),
  updateMetadata: vi.fn(),
  search: vi.fn(),
  choose: vi.fn(),
  openFile: vi.fn(),
  openExternal: vi.fn(),
  copy: vi.fn(),
  toast: vi.fn(),
  linkedPullRequest: null as ThreadLinkedPullRequest | null,
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => serverConfig }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../hooks/useSettings", () => ({
  ensureClientSettingsHydrated: state.hydrate,
  useClientSettingsHydrated: () => state.hydrated,
  getClientSettings: () => ({ ...DEFAULT_CLIENT_SETTINGS, browserLinkTarget: state.preference }),
  useClientSettings: (select?: (value: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select
      ? select({ ...DEFAULT_CLIENT_SETTINGS, browserLinkTarget: state.preference })
      : DEFAULT_CLIENT_SETTINGS,
}));
vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children?: ReactNode }) =>
    children === undefined ? render : cloneElement(render, undefined, children),
  TooltipPopup: () => null,
}));
vi.mock("./chat/PierreEntryIcon", () => ({ PierreEntryIcon: () => null }));
vi.mock("./ui/toast", () => ({
  toastManager: { add: state.toast },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.search }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === "updateMetadata"
      ? state.updateMetadata
      : typeof command !== "string"
        ? state.allocate
        : command === "openPreview"
          ? state.openPreview
          : state.openEditor,
}));
vi.mock("../state/session", async () => {
  const { useSyncExternalStore } = await import("react");
  const readEnvironmentScope = (id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
    id !== null &&
    (scope !== AuthOrchestrationOperateScope || id !== threadRef.environmentId || state.allowed);
  return {
    // Asset atoms read these at module scope; the markdown tests only exercise
    // the task grant.
    environmentSession: {
      sessionStateAtom: () => ({}),
      preparedConnectionValueAtom: (await import("~/test/threadLinkFixture")).threadLinkFixture
        .prepared,
    },
    readEnvironmentScope,
    readPreparedConnection: (id: EnvironmentId) => {
      const value = appAtomRegistry.get(threadLinkFixture.prepared(id));
      return value._tag === "Some" ? value.value : null;
    },
    useEnvironmentScope: (id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => readEnvironmentScope(id, scope),
      ),
    usePreparedConnection: () => ({ _tag: "None" }),
  };
});
vi.mock("../state/server", async () => ({
  environmentServerConfigsAtom: (await import("~/test/threadLinkFixture")).threadLinkFixture
    .configs,
  serverEnvironment: { configValueAtom: () => "config" },
}));
vi.mock("../state/threads", () => ({
  threadEnvironment: { updateMetadata: "updateMetadata" },
}));
vi.mock("../state/entities", () => ({
  readEnvironmentSupportsServerBrowser: () => false,
  useServerConfigs: () => new Map([[threadRef.environmentId, serverConfig]]),
  readThreadShell: () => ({ linkedPullRequest: state.linkedPullRequest }),
  useProjects: () => [{ id: linkedPullRequest.projectId, environmentId: threadRef.environmentId }],
}));
// Mesura: issue references read their environment's connection; none is connected here.
vi.mock("../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/environments")>()),
  useEnvironment: () => null,
}));
vi.mock("../connection/catalog", async () => {
  const f = (await import("~/test/threadLinkFixture")).threadLinkFixture;
  return { environmentCatalog: { catalogValueAtom: f.catalog, stateAtom: f.connection } };
});
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../hooks/useLocalStorage", () => ({
  useLocalStorage: () => ["vscode", vi.fn()],
  getLocalStorageItem: () => "vscode",
  setLocalStorageItem: vi.fn(),
}));
vi.mock("../hooks/useCopyToClipboard", () => ({
  writeTextToClipboard: state.copy,
  useCopyToClipboard: () => ({ copyToClipboard: state.copy, isCopied: false }),
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({
    contextMenu: { show: state.choose },
    shell: { openExternal: state.openExternal },
  }),
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  resolvePullRequestPreviewTarget: () => null,
  findProjectForChangeRequest: (projects: readonly { id: ProjectId }[]) => projects[0],
  matchesLinkedPullRequestUrl: (candidate: ThreadLinkedPullRequest, href: string) =>
    candidate.url === href,
  parseChangeRequestUrl: (href: string) =>
    href === linkedPullRequest.url
      ? {
          host: "github.com",
          repository: linkedPullRequest.repository,
          number: linkedPullRequest.number,
        }
      : null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

vi.mock("../state/preview", async () => ({
  previewEnvironment: {
    open: "openPreview",
    openLinkTarget: {
      permissionAtom: (await import("~/test/threadLinkFixture")).threadLinkFixture.permission,
    },
  },
}));
vi.mock("../browser/previewRuntime", () => ({
  isPreviewAvailableFor: () => state.previewAvailable,
  previewRuntimeFor: () => undefined,
}));
vi.mock("../browser/browserDefaults", () => ({
  resolveBrowserDefaults: async () => ({ viewport: { _tag: "responsive" }, profileId: "default" }),
  browserDefaultOpenViewport: (defaults: { viewport: unknown }) => defaults.viewport,
  browserDefaultOpenProfileId: (defaults: { profileId: string }) => defaults.profileId,
}));
vi.mock("../previewStateStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../previewStateStore")>()),
  rememberPreviewUrl: vi.fn(),
}));

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
import {
  installThreadLinkEnvironment,
  linkEnvelope,
  mountThreadLinkStream,
  threadLinkFixture,
  createDeferredPromise,
} from "~/test/threadLinkFixture";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { resetPreviewStateForTests, readThreadPreviewState } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
let stopTransport: () => void;
let renderer: ReactTestRenderer | undefined;
const domWindow = window;
let domRoot: Root | undefined;
let domContainer: HTMLDivElement | undefined;

beforeEach(() => {
  state.hydrated = true;
  resetPreviewStateForTests();
  useRightPanelStore.setState({
    byThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
    pendingMaximizeThreadKey: null,
  });
  installThreadLinkEnvironment(threadRef);
  stopTransport = mountThreadLinkStream(threadRef);
  state.allocate.mockReset().mockResolvedValue(AsyncResult.success(linkEnvelope(threadRef)));
  vi.spyOn(useRightPanelStore.getState(), "openFile");
  state.hydrate.mockReset().mockResolvedValue(undefined);
  state.allowed = true;
  state.previewAvailable = false;
  state.preference = "system";
  state.width = 1280;
  state.coarse = false;
  state.openPreview.mockReset().mockResolvedValue(AsyncResult.success({ tabId: "link-tab" }));
  state.openBrowser.mockReset();
  state.listeners.clear();
  state.linkedPullRequest = null;
  state.openEditor.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.updateMetadata.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.search.mockReset().mockResolvedValue(AsyncResult.success({ entries: [] }));
  state.choose.mockReset().mockResolvedValue(null);
  state.openFile.mockReset();
  state.openExternal.mockReset().mockResolvedValue(undefined);
  state.copy.mockReset().mockResolvedValue(undefined);
  state.toast.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    get innerWidth() {
      return state.width;
    },
    matchMedia: () => ({ matches: state.coarse }),
  });
  vi.stubGlobal("navigator", { platform: "Linux", clipboard: { writeText: state.copy } });
});

afterEach(async () => {
  await act(async () => domRoot?.unmount());
  domRoot = undefined;
  domContainer?.remove();
  domContainer = undefined;
  await act(async () => renderer?.unmount());
  renderer = undefined;
  stopTransport();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function configurePreviewEligibility() {
  appAtomRegistry.set(
    threadLinkFixture.configs,
    new Map([
      [
        threadRef.environmentId,
        {
          environment: {
            capabilities: {
              serverBrowser: state.previewAvailable,
              threadLinkPreview: state.previewAvailable,
            },
          },
        },
      ],
    ]),
  );
}

async function renderMarkdown(text: string) {
  configurePreviewEligibility();
  await act(async () => {
    renderer = create(<ChatMarkdown cwd="/work" threadRef={threadRef} text={text} />);
  });
}

async function renderDomMarkdown(text: string) {
  vi.stubGlobal("window", domWindow);
  vi.stubGlobal("innerWidth", state.width);
  vi.stubGlobal("matchMedia", () => ({ matches: state.coarse }));
  configurePreviewEligibility();
  domContainer = document.createElement("div");
  document.body.append(domContainer);
  domRoot = createRoot(domContainer);
  await act(() => domRoot!.render(<ChatMarkdown cwd="/work" threadRef={threadRef} text={text} />));
}

async function activateDomAnchor(modifiers: MouseEventInit = {}) {
  const element = domContainer!.querySelector("a");
  expect(element).not.toBeNull();
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifiers });
  await act(() => {
    element!.dispatchEvent(event);
  });
  return event;
}

it.each(["app", "system"] as const)(
  "thread link DOM hydration fence: pending settings resolves saved %s after anchor interception",
  async (preference) => {
    state.previewAvailable = true;
    state.hydrated = false;
    const persistence = createDeferredPromise<void>();
    state.hydrate.mockReturnValueOnce(persistence.promise);
    await renderDomMarkdown("[External](https://example.com/docs)");
    const event = await activateDomAnchor();
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
      expect(readThreadPreviewState(threadRef).snapshot?.navStatus).toMatchObject({
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
  state.previewAvailable = true;
  state.hydrated = false;
  const persistence = createDeferredPromise<void>();
  state.hydrate.mockReturnValueOnce(persistence.promise);
  vi.spyOn(console, "error").mockImplementation(() => {});
  await renderDomMarkdown("[External](https://example.com/docs)");
  expect((await activateDomAnchor()).defaultPrevented).toBe(true);
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
  { label: "file", href: "docs/readme.md", file: true },
])(
  "thread link DOM hydration guard: $label keeps immediate precedence while settings waits",
  async (entry) => {
    state.previewAvailable = true;
    state.hydrated = false;
    state.hydrate.mockReturnValueOnce(new Promise<void>(() => {}));
    state.width = "width" in entry ? entry.width : 1280;
    state.coarse = "coarse" in entry && entry.coarse;
    await renderDomMarkdown(`[Link](${"href" in entry ? entry.href : "https://example.com/docs"})`);
    const event = await activateDomAnchor({
      ctrlKey: "ctrlKey" in entry && entry.ctrlKey,
      metaKey: "metaKey" in entry && entry.metaKey,
    });
    // The existing fragment handler prevents native navigation and scrolls the
    // same document. It also runs before asynchronous browser settings.
    expect(event.defaultPrevented).toBe("file" in entry || entry.label === "fragment");
    expect(state.hydrate).not.toHaveBeenCalled();
    expect(state.allocate).not.toHaveBeenCalled();
    if ("file" in entry)
      expect(useRightPanelStore.getState().openFile).toHaveBeenCalledWith(
        threadRef,
        entry.href,
        undefined,
      );
  },
);

function menuEvent() {
  return { preventDefault: vi.fn(), stopPropagation: vi.fn(), clientX: 10, clientY: 10 };
}

function anchor() {
  return renderer!.root.findByType("a");
}

async function openContextMenu() {
  await act(async () => anchor().props.onContextMenu(menuEvent()));
}

function offeredActions() {
  return state.choose.mock.lastCall![0].map((item: { id: string }) => item.id);
}

it("removes host actions after revocation while keeping file preview and copying", async () => {
  await renderMarkdown("[Readme](docs/readme.md)");
  await openContextMenu();
  expect(offeredActions()).toEqual(["open", "reveal", "copy-relative", "copy-full"]);
  await act(async () => {
    state.allowed = false;
    for (const listener of state.listeners) listener();
  });
  state.choose.mockResolvedValue("copy-full");
  await openContextMenu();
  expect(offeredActions()).toEqual(["copy-relative", "copy-full"]);
  expect(state.copy).toHaveBeenCalledWith("/work/docs/readme.md");
  await act(async () => anchor().props.onClick(menuEvent()));
  expect(useRightPanelStore.getState().openFile).toHaveBeenCalledWith(
    threadRef,
    "docs/readme.md",
    undefined,
  );
  expect(state.openEditor).not.toHaveBeenCalled();
});

it("does not launch an editor after revocation during a native context menu", async () => {
  let choose: (action: string) => void = () => {
    throw new Error("Menu not opened");
  };
  state.choose.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        choose = resolve;
      }),
  );
  await renderMarkdown("[Readme](docs/readme.md)");
  await openContextMenu();
  expect(offeredActions()).toContain("open");
  await act(async () => {
    state.allowed = false;
    choose("open");
  });
  expect(state.openEditor).not.toHaveBeenCalled();
});

it("does not reveal a file after revocation during its workspace lookup", async () => {
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
  await renderMarkdown("[Readme](readme.md)");
  await openContextMenu();
  expect(state.search).toHaveBeenCalledOnce();
  await act(async () => {
    state.allowed = false;
    finishLookup();
  });
  expect(state.openEditor).not.toHaveBeenCalled();
});

it.each([false, true])(
  "keeps PR links usable without offering metadata edits (linked=%s)",
  async (linked) => {
    state.allowed = false;
    state.linkedPullRequest = linked ? linkedPullRequest : null;
    state.choose.mockResolvedValue("open-external");
    await renderMarkdown(`[Review](${linkedPullRequest.url})`);
    await openContextMenu();
    expect(offeredActions()).toEqual(["open-external", "copy-link"]);
    expect(state.openExternal).toHaveBeenCalledWith(linkedPullRequest.url);
    expect(state.updateMetadata).not.toHaveBeenCalled();
  },
);

it.each(["link-to-thread", "unlink-from-thread"])(
  "rechecks %s after a native context menu returns",
  async (action) => {
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
    await renderMarkdown(`[Review](${linkedPullRequest.url})`);
    await openContextMenu();
    expect(offeredActions()).toContain(action);
    await act(async () => {
      state.allowed = false;
      choose(action);
    });
    expect(state.updateMetadata).not.toHaveBeenCalled();

    await act(async () => {
      state.allowed = true;
      for (const listener of state.listeners) listener();
    });
    state.choose.mockResolvedValue(action);
    await openContextMenu();
    expect(state.updateMetadata).toHaveBeenCalledExactlyOnceWith({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        linkedPullRequest: action === "link-to-thread" ? linkedPullRequest : null,
      },
    });
  },
);

function linkClick(modifiers: { metaKey?: boolean; ctrlKey?: boolean } = {}) {
  return {
    ...menuEvent(),
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...modifiers,
  };
}

it.each([
  [767, false, "app", false],
  [1280, true, "app", false],
  [768, false, "app", true],
  [1280, false, "system", false],
] as const)(
  "markdown link policy: width %s coarse %s saved %s intercepts %s",
  async (width, coarse, preference, intercepted) => {
    state.previewAvailable = true;
    state.preference = preference;
    await renderMarkdown("[External](https://example.com/docs)");
    // The action sees device changes even before any render/subscription notification.
    state.width = width;
    state.coarse = coarse;
    const event = linkClick();
    await act(async () => anchor().props.onClick(event));
    expect(event.preventDefault).toHaveBeenCalledTimes(intercepted ? 1 : 0);
    expect(state.allocate).toHaveBeenCalledTimes(intercepted ? 1 : 0);
    if (intercepted) expect(readThreadPreviewState(threadRef).activeTabId).toBe("shared-target");
    expect(state.openExternal).not.toHaveBeenCalled();
  },
);

it.each([{ metaKey: true }, { ctrlKey: true }])(
  "markdown link policy: modifier %j retains native system navigation",
  async (modifier) => {
    state.previewAvailable = true;
    state.preference = "app";
    await renderMarkdown("[External](https://example.com/docs)");
    const event = linkClick(modifier);
    await act(async () => anchor().props.onClick(event));
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(state.openPreview).not.toHaveBeenCalled();
  },
);

it("markdown link policy: phone files still select the file surface before browser policy", async () => {
  state.previewAvailable = true;
  state.preference = "app";
  state.width = 767;
  await renderMarkdown("[Readme](docs/readme.md)");
  await act(async () => anchor().props.onClick(linkClick()));
  expect(useRightPanelStore.getState().openFile).toHaveBeenCalledWith(
    threadRef,
    "docs/readme.md",
    undefined,
  );
  expect(state.openPreview).not.toHaveBeenCalled();
});

it("markdown link policy: explicit desktop app ignores system preference but stale phone menu uses system", async () => {
  state.previewAvailable = true;
  let choose = () => {};
  state.choose.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        choose = () => resolve("open-in-preview");
      }),
  );
  await renderMarkdown("[External](https://example.com/docs)");
  await openContextMenu();
  expect(offeredActions()).toContain("open-in-preview");
  await act(async () => {
    state.width = 767;
    choose();
  });
  expect(state.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/docs");
  expect(state.openPreview).not.toHaveBeenCalled();
  state.width = 1280;
  state.choose.mockResolvedValue("open-in-preview");
  await openContextMenu();
  expect(readThreadPreviewState(threadRef).activeTabId).toBe("shared-target");
});

it("thread link integration fence: an eligible desktop anchor waits for settings instead of using the schema snapshot", async () => {
  state.previewAvailable = true;
  state.hydrated = false;
  let release = () => {};
  state.hydrate.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await renderMarkdown("[External](https://example.com/docs)");
  const event = linkClick();
  await act(async () => anchor().props.onClick(event));
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(state.openPreview).not.toHaveBeenCalled();
  expect(state.openExternal).not.toHaveBeenCalled();
  await act(async () => release());
  expect(state.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/docs");
});
