// Mounts the useOpenLink public button entry and activates it through a DOM click.
import { EnvironmentId, ThreadId, type BrowserLinkTarget } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useLayoutEffect, type ReactNode } from "react";
import { act, render, type Screen } from "../../test/render";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  preference: "app" as BrowserLinkTarget,
  coarse: false,
  allowed: true,
  available: true,
  hydrate: vi.fn(),
  open: vi.fn(),
  allocate: vi.fn(),
  external: vi.fn(),
  visit: vi.fn(),
  navigate: vi.fn(),
  defaults: vi.fn(),
}));
vi.mock("~/hooks/useSettings", () => ({
  ensureClientSettingsHydrated: state.hydrate,
  getClientSettings: () => ({ browserLinkTarget: state.preference }),
}));
vi.mock("./previewRuntime", () => ({
  isPreviewAvailableFor: () => state.available,
  previewRuntimeFor: () => undefined,
}));
vi.mock("~/state/server", async () => ({
  environmentServerConfigsAtom: (await import("~/test/threadLinkFixture")).threadLinkFixture
    .configs,
}));
vi.mock("~/connection/catalog", async () => {
  const f = (await import("~/test/threadLinkFixture")).threadLinkFixture;
  return { environmentCatalog: { catalogValueAtom: f.catalog, stateAtom: f.connection } };
});
vi.mock("~/state/session", async () => {
  const f = (await import("~/test/threadLinkFixture")).threadLinkFixture;
  const { appAtomRegistry } = await import("~/rpc/atomRegistry");
  const Option = await import("effect/Option");
  return {
    environmentSession: { preparedConnectionValueAtom: f.prepared },
    readPreparedConnection: (id: import("@t3tools/contracts").EnvironmentId) =>
      Option.getOrNull(appAtomRegistry.get(f.prepared(id))),
    readEnvironmentScope: () => state.allowed,
  };
});
vi.mock("~/state/preview", async () => ({
  previewEnvironment: {
    open: "open",
    openLinkTarget: {
      permissionAtom: (await import("~/test/threadLinkFixture")).threadLinkFixture.permission,
    },
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => (command === "open" ? state.open : state.allocate),
}));
vi.mock("~/localApi", () => ({
  readLocalApi: () => ({ shell: { openExternal: state.external } }),
}));
vi.mock("~/browserHistoryStore", () => ({ recordVisitForThread: state.visit }));
vi.mock("~/assets/assetUrls", () => ({ resolveAssetUrl: vi.fn() }));
vi.mock("./browserDefaults", () => ({
  resolveBrowserDefaults: state.defaults,
  browserDefaultOpenProfileId: (defaults: { profileId: string }) => defaults.profileId,
  browserDefaultOpenViewport: (defaults: { viewport: unknown }) => defaults.viewport,
}));
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
import { useOpenLink } from "./useOpenLink";
import { BrowserSettingsReadError } from "./openFileInPreview";
import * as Option from "effect/Option";
import { reconcilePreviewServerSessions, previewStateAtom } from "~/previewStateStore";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { AllocateThreadLink } from "./openThreadLinkInPreview";

const ref = {
  environmentId: EnvironmentId.make("link-env"),
  threadId: ThreadId.make("link-thread"),
};
let unmountTransport: () => void;
let root: Screen | undefined;
let container: HTMLElement;
let opening: Promise<void>;

async function createLinkFixture() {
  await using resources = new AsyncDisposableStack();
  resources.defer(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  state.preference = "app";
  state.coarse = false;
  state.allowed = true;
  state.available = true;
  state.hydrate.mockReset().mockResolvedValue(undefined);
  state.open.mockReset().mockResolvedValue(AsyncResult.success({ tabId: "link-tab" }));
  resetPreviewStateForTests();
  useRightPanelStore.setState({
    byThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
    pendingMaximizeThreadKey: null,
  });
  installThreadLinkEnvironment(ref);
  state.navigate.mockReset();
  state.defaults.mockReset().mockResolvedValue({ profileId: "work", viewport: { _tag: "fill" } });
  unmountTransport = mountThreadLinkStream(ref, state.navigate);
  state.allocate.mockReset().mockResolvedValue(AsyncResult.success(linkEnvelope(ref)));
  state.external.mockReset().mockResolvedValue(undefined);
  state.visit.mockReset();
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: query === "(pointer: coarse)" && state.coarse })),
  );
  vi.stubGlobal("innerWidth", 1280);
  container = document.createElement("div");
  document.body.append(container);
  root = undefined;
  opening = Promise.resolve();
  resources.defer(async () => {
    unmountTransport();
    try {
      await root?.[Symbol.asyncDispose]();
    } finally {
      root = undefined;
      container.remove();
    }
  });
  return resources.move();
}

function LinkButton({ url }: { url: string }) {
  const open = useOpenLink(ref);
  return (
    <button
      onClick={(event) => {
        opening = open(url, { event });
      }}
    >
      Open link
    </button>
  );
}

async function renderEntry(ui: ReactNode) {
  if (root) await root.rerender(ui);
  else root = await render(ui, { container, router: false });
}

async function mount(url = "https://example.com/docs") {
  await renderEntry(<LinkButton url={url} />);
}

async function click(modifiers: MouseEventInit = {}) {
  await act(async () => {
    container
      .querySelector("button")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, ...modifiers }));
    await opening;
  });
}

it.each([
  [767, false],
  [1280, true],
] as const)(
  "open-link button policy: width %s coarse %s at click uses system",
  async (width, coarse) => {
    await using _fixture = await createLinkFixture();
    await mount();
    vi.stubGlobal("innerWidth", width);
    state.coarse = coarse;
    await click();
    expect(state.external).toHaveBeenCalledExactlyOnceWith("https://example.com/docs");
    expect(state.allocate).not.toHaveBeenCalled();
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
    expect(state.visit).not.toHaveBeenCalled();
  },
);

it.each(["app", "system"] as const)(
  "open-link button policy: desktop saved %s selects the configured destination",
  async (preference) => {
    await using _fixture = await createLinkFixture();
    state.preference = preference;
    await mount();
    await click();
    if (preference === "app") {
      expect(state.allocate).toHaveBeenCalledExactlyOnceWith({
        environmentId: ref.environmentId,
        input: {
          threadId: ref.threadId,
          profileId: "work",
          viewport: { _tag: "fill" },
        },
      });
      expect(readThreadPreviewState(ref).activeTabId).toBe("shared-target");
      expect(state.visit).toHaveBeenCalledExactlyOnceWith(ref, "https://example.com/docs");
      expect(state.external).not.toHaveBeenCalled();
    } else {
      expect(state.external).toHaveBeenCalledOnce();
      expect(state.allocate).not.toHaveBeenCalled();
    }
  },
);

it.each([{ ctrlKey: true }, { metaKey: true }])(
  "open-link button policy: modifier %j uses system",
  async (modifier) => {
    await using _fixture = await createLinkFixture();
    await mount();
    await click(modifier);
    expect(state.external).toHaveBeenCalledOnce();
    expect(state.allocate).not.toHaveBeenCalled();
  },
);

it.each(["mailto:hello@example.com", "vscode://file/work", "#details"])(
  "open-link button policy: scheme %s remains external",
  async (url) => {
    await using _fixture = await createLinkFixture();
    await mount(url);
    await click();
    expect(state.external).toHaveBeenCalledExactlyOnceWith(url);
    expect(state.allocate).not.toHaveBeenCalled();
  },
);

it("open-link button policy: hydration failure opens neither destination", async () => {
  await using _fixture = await createLinkFixture();
  const failure = new Error("Saved settings unavailable");
  state.hydrate.mockRejectedValueOnce(failure);
  await mount();
  const error = await click().catch((error: unknown) => error);
  expect(error).toBeInstanceOf(BrowserSettingsReadError);
  if (!(error instanceof BrowserSettingsReadError)) throw error;
  expect(error.cause).toBe(failure);
  expect(state.external).not.toHaveBeenCalled();
  expect(state.allocate).not.toHaveBeenCalled();
});

it("open-link button policy: reads the saved choice and device after pending hydration", async () => {
  await using _fixture = await createLinkFixture();
  let release = () => {};
  state.preference = "system";
  state.hydrate.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await mount();
  await act(() => container.querySelector("button")!.click());
  expect(state.allocate).not.toHaveBeenCalled();
  expect(state.external).not.toHaveBeenCalled();
  state.preference = "app";
  state.coarse = true;
  await act(async () => {
    release();
    await opening;
  });
  expect(state.external).toHaveBeenCalledExactlyOnceWith("https://example.com/docs");
  expect(state.allocate).not.toHaveBeenCalled();
});

it("open-link button policy: incidental touch leaves the primary fine-pointer desktop in app", async () => {
  await using _fixture = await createLinkFixture();
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: query === "(any-pointer: coarse)" })),
  );
  await mount();
  await click();
  expect(readThreadPreviewState(ref).activeTabId).toBe("shared-target");
  expect(state.external).not.toHaveBeenCalled();
});

it.each(["allowed", "available"] as const)(
  "open-link button policy: missing %s falls back without a preview mutation",
  async (capability) => {
    await using _fixture = await createLinkFixture();
    state[capability] = false;
    if (capability === "allowed")
      appAtomRegistry.set(threadLinkFixture.permission(ref.environmentId), false);
    else appAtomRegistry.set(threadLinkFixture.configs, new Map());
    await mount();
    await click();
    expect(state.external).toHaveBeenCalledOnce();
    expect(state.allocate).not.toHaveBeenCalled();
  },
);

it("thread link integration fence: completed user links allocate a designated target instead of independent previews", async () => {
  await using _fixture = await createLinkFixture();
  await mount();
  await click();
  await click();
  expect(state.open).not.toHaveBeenCalled();
  expect(state.allocate).toHaveBeenCalledTimes(2);
  expect(state.navigate.mock.calls.map((call) => call[0])).toEqual([
    "https://example.com/docs",
    "https://example.com/docs",
  ]);
  expect(Object.keys(readThreadPreviewState(ref).sessions)).toEqual(["shared-target"]);
  expect(readThreadPreviewState(ref).activeTabId).toBe("shared-target");
  expect(state.visit.mock.calls.map((call) => call[1])).toEqual([
    "https://example.com/docs",
    "https://example.com/docs",
  ]);
});

it("thread link integration fence: an explicit off-route thread remains the allocation destination", async () => {
  await using _fixture = await createLinkFixture();
  const destination = {
    environmentId: EnvironmentId.make("other-env"),
    threadId: ThreadId.make("other-thread"),
  };
  installThreadLinkEnvironment(destination);
  state.allocate.mockResolvedValueOnce(AsyncResult.success(linkEnvelope(destination)));
  const stop = mountThreadLinkStream(destination);
  function OverrideButton() {
    const open = useOpenLink(ref);
    return (
      <button
        onClick={() => {
          opening = open("https://example.com/other", { threadRef: destination });
        }}
      >
        Open other thread
      </button>
    );
  }
  try {
    await renderEntry(<OverrideButton />);
    await click();
    expect(state.open).not.toHaveBeenCalled();
    expect(state.allocate).toHaveBeenCalledWith({
      environmentId: destination.environmentId,
      input: {
        threadId: destination.threadId,
        profileId: "work",
        viewport: { _tag: "fill" },
      },
    });
    expect(readThreadPreviewState(destination).snapshot?.navStatus).toMatchObject({
      _tag: "Loading",
      url: "https://example.com/other",
    });
    expect(readThreadPreviewState(ref).sessions).toEqual({});
    expect(state.navigate).not.toHaveBeenCalled();
  } finally {
    stop();
  }
});

it.each([
  { serverBrowser: false, threadLinkPreview: true },
  { serverBrowser: true, threadLinkPreview: false },
  {},
])(
  "thread link integration guard: capability %j cannot allocate even on an available desktop",
  async (capabilities) => {
    await using _fixture = await createLinkFixture();
    appAtomRegistry.set(
      threadLinkFixture.configs,
      new Map([[ref.environmentId, { environment: { capabilities } }]]),
    );
    await mount();
    await click();
    expect(state.allocate).not.toHaveBeenCalled();
    expect(state.external).toHaveBeenCalledExactlyOnceWith("https://example.com/docs");
  },
);

it.each([
  "close",
  "selection",
  "disconnect",
  "reconnect",
  "lease",
  "catalog",
  "permission",
  "epoch",
  "unmount",
] as const)(
  "thread link integration guard: pending allocation cancelled by %s cannot merge or navigate",
  async (change) => {
    await using _fixture = await createLinkFixture();
    const pending = createDeferredPromise<Awaited<ReturnType<AllocateThreadLink>>>();
    state.allocate.mockReturnValueOnce(pending.promise);
    await mount();
    await act(() => container.querySelector("button")!.click());
    expect(state.allocate).toHaveBeenCalledOnce();
    const before = readThreadPreviewState(ref);
    await act(() => {
      const store = useRightPanelStore.getState();
      switch (change) {
        case "close":
          store.closeSurface(ref, "browser:shared-target");
          break;
        case "selection":
          store.openFile(ref, "new-owner.md");
          break;
        case "disconnect":
          appAtomRegistry.set(
            threadLinkFixture.connection(ref.environmentId),
            AsyncResult.success({ phase: "offline", generation: 1 }),
          );
          break;
        case "reconnect":
          appAtomRegistry.set(
            threadLinkFixture.connection(ref.environmentId),
            AsyncResult.success({ phase: "offline", generation: 1 }),
          );
          appAtomRegistry.set(
            threadLinkFixture.connection(ref.environmentId),
            AsyncResult.success({ phase: "connected", generation: 1 }),
          );
          break;
        case "lease":
          appAtomRegistry.set(
            threadLinkFixture.prepared(ref.environmentId),
            Option.some({ lease: {}, httpBaseUrl: "https://fixture.invalid" }),
          );
          break;
        case "catalog":
          appAtomRegistry.set(threadLinkFixture.catalog, { isReady: true, entries: new Map() });
          break;
        case "permission":
          appAtomRegistry.set(threadLinkFixture.permission(ref.environmentId), false);
          break;
        case "epoch":
          reconcilePreviewServerSessions(ref, {
            sessions: [],
            serverEpoch: "replacement",
            revision: 1,
          });
          break;
        case "unmount":
          return root?.unmount();
      }
    });
    await opening;
    pending.resolve(AsyncResult.success(linkEnvelope(ref)));
    await pending.promise;
    expect(readThreadPreviewState(ref).sessions).toEqual(before.sessions);
    expect(state.visit).not.toHaveBeenCalled();
    expect(state.external).not.toHaveBeenCalled();
    expect(useRightPanelStore.getState().pendingMaximizeThreadKey).toBeNull();
  },
);

it.each(["A-first", "B-first"] as const)(
  "thread link integration guard: only the latest intent navigates when replies arrive %s",
  async (order) => {
    await using _fixture = await createLinkFixture();
    const a = createDeferredPromise<Awaited<ReturnType<AllocateThreadLink>>>();
    const b = createDeferredPromise<Awaited<ReturnType<AllocateThreadLink>>>();
    state.allocate.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    await mount("https://example.com/A");
    await act(() => container.querySelector("button")!.click());
    const first = opening;
    await mount("https://example.com/B");
    await act(() => container.querySelector("button")!.click());
    const second = opening;
    if (order === "A-first") a.resolve(AsyncResult.success(linkEnvelope(ref)));
    b.resolve(AsyncResult.success(linkEnvelope(ref)));
    await second;
    a.resolve(AsyncResult.success(linkEnvelope(ref)));
    await first;
    expect(state.allocate).toHaveBeenCalledTimes(2);
    expect(state.visit.mock.calls.map((call) => call[1])).toEqual(["https://example.com/B"]);
    expect(state.external).not.toHaveBeenCalled();
    expect(readThreadPreviewState(ref).snapshot?.navStatus).toMatchObject({
      _tag: "Loading",
      url: "https://example.com/B",
    });
  },
);

it("thread link integration guard: a later system activation cancels the pending app intent", async () => {
  await using _fixture = await createLinkFixture();
  const pending = createDeferredPromise<Awaited<ReturnType<AllocateThreadLink>>>();
  state.allocate.mockReturnValueOnce(pending.promise);
  await mount("https://example.com/A");
  await act(() => container.querySelector("button")!.click());
  const first = opening;
  await mount("https://example.com/B");
  await click({ ctrlKey: true });
  pending.resolve(AsyncResult.success(linkEnvelope(ref)));
  await first;
  expect(state.external).toHaveBeenCalledExactlyOnceWith("https://example.com/B");
  expect(state.allocate).toHaveBeenCalledOnce();
  expect(state.navigate).not.toHaveBeenCalled();
  expect(state.visit).not.toHaveBeenCalled();
  expect(readThreadPreviewState(ref).sessions).toEqual({});
  expect(useRightPanelStore.getState().pendingMaximizeThreadKey).toBeNull();
});

it("thread link integration guard: a newer complete list that omits the allocated target cannot resurrect it", async () => {
  await using _fixture = await createLinkFixture();
  reconcilePreviewServerSessions(ref, { sessions: [], serverEpoch: "epoch-1", revision: 0 });
  const pending = createDeferredPromise<Awaited<ReturnType<AllocateThreadLink>>>();
  state.allocate.mockReturnValueOnce(pending.promise);
  await mount();
  await act(() => container.querySelector("button")!.click());
  reconcilePreviewServerSessions(ref, { sessions: [], serverEpoch: "epoch-1", revision: 9 });
  pending.resolve(AsyncResult.success(linkEnvelope(ref)));
  await opening;
  expect(readThreadPreviewState(ref).serverRevision).toBe(9);
  expect(readThreadPreviewState(ref).sessions).toEqual({});
  expect(state.visit).not.toHaveBeenCalled();
  expect(state.external).not.toHaveBeenCalled();
});

it("thread link integration guard: malformed cross-thread envelope fails before reconciling any session", async () => {
  await using _fixture = await createLinkFixture();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const envelope = linkEnvelope(ref);
  state.allocate.mockResolvedValueOnce(
    AsyncResult.success({
      ...envelope,
      sessions: [
        ...envelope.sessions,
        { ...envelope.sessions[0]!, threadId: ThreadId.make("unrelated"), tabId: "alien" },
      ],
    }),
  );
  await mount();
  await click();
  expect(readThreadPreviewState(ref).sessions).toEqual({});
  expect(state.external).toHaveBeenCalledOnce();
  expect(state.visit).not.toHaveBeenCalled();
});

it("thread link integration guard: a suppressed designated target stays closed after its allocation receipt", async () => {
  await using _fixture = await createLinkFixture();
  const atom = previewStateAtom(scopedThreadKey(ref));
  appAtomRegistry.set(atom, {
    ...readThreadPreviewState(ref),
    serverEpoch: "epoch-1",
    suppressedTabIds: new Set(["shared-target"]),
  });
  await mount();
  await click();
  expect(readThreadPreviewState(ref).sessions).toEqual({});
  expect(state.external).not.toHaveBeenCalled();
  expect(state.visit).not.toHaveBeenCalled();
});

it("thread link integration guard: revoked allocation permission during defaults hydration interrupts without fallback", async () => {
  await using _fixture = await createLinkFixture();
  const defaults = createDeferredPromise<{ profileId: string; viewport: { _tag: "fill" } }>();
  state.defaults.mockReturnValueOnce(defaults.promise);
  await mount();
  await act(() => container.querySelector("button")!.click());
  expect(state.defaults).toHaveBeenCalledOnce();
  appAtomRegistry.set(threadLinkFixture.permission(ref.environmentId), false);
  await opening;
  defaults.resolve({ profileId: "work", viewport: { _tag: "fill" } });
  await defaults.promise;
  expect(state.allocate).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
  expect(state.external).not.toHaveBeenCalled();
});

it("thread link integration guard: the designated result preserves independent manual and agent sessions", async () => {
  await using _fixture = await createLinkFixture();
  const envelope = linkEnvelope(ref);
  const sessions = [
    ...envelope.sessions,
    {
      ...envelope.sessions[0]!,
      tabId: "manual",
      purpose: undefined,
      navStatus: { _tag: "Success" as const, url: "https://example.com/docs", title: "Manual" },
    },
    { ...envelope.sessions[0]!, tabId: "agent", purpose: undefined },
  ];
  state.allocate.mockResolvedValueOnce(AsyncResult.success({ ...envelope, sessions }));
  await mount();
  await click();
  expect(Object.keys(readThreadPreviewState(ref).sessions).sort()).toEqual([
    "agent",
    "manual",
    "shared-target",
  ]);
  expect(readThreadPreviewState(ref).activeTabId).toBe("shared-target");
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith("https://example.com/docs");
});

it.each(["unmount", "selection"] as const)(
  "thread link integration guard: %s during transport readiness clears its unconsumed maximize request",
  async (change) => {
    await using _fixture = await createLinkFixture();
    unmountTransport();
    await mount();
    await act(() => container.querySelector("button")!.click());
    expect(useRightPanelStore.getState().pendingMaximizeThreadKey).toBe(scopedThreadKey(ref));
    await act(() => {
      if (change === "unmount") return root?.unmount();
      else useRightPanelStore.getState().openFile(ref, "later-owner.md");
    });
    await opening;
    expect(useRightPanelStore.getState().pendingMaximizeThreadKey).toBeNull();
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.visit).not.toHaveBeenCalled();
    expect(state.external).not.toHaveBeenCalled();
  },
);

it("thread link integration guard: cancellation cannot clear a later maximize request from another opener", async () => {
  await using _fixture = await createLinkFixture();
  unmountTransport();
  await mount();
  await act(() => container.querySelector("button")!.click());
  useRightPanelStore.getState().requestMaximize(ref);
  await root?.unmount();
  await opening;
  expect(useRightPanelStore.getState().pendingMaximizeThreadKey).toBe(scopedThreadKey(ref));
  expect(state.navigate).not.toHaveBeenCalled();
  expect(state.visit).not.toHaveBeenCalled();
  expect(state.external).not.toHaveBeenCalled();
});

it("thread link integration guard: an old mounted action cannot borrow the new route owner after a commit", async () => {
  await using _fixture = await createLinkFixture();
  const other = { ...ref, threadId: ThreadId.make("replacement-route") };
  installThreadLinkEnvironment(other);
  let retained: ReturnType<typeof useOpenLink> | undefined;
  function OwnerButton({ selected }: { selected: typeof ref }) {
    const open = useOpenLink(selected);
    useLayoutEffect(() => {
      retained = open;
    }, [open]);
    return (
      <button
        onClick={() => {
          opening = open("https://example.com/docs");
        }}
      >
        Open
      </button>
    );
  }
  await renderEntry(<OwnerButton selected={ref} />);
  const oldAction = retained!;
  await renderEntry(<OwnerButton selected={other} />);
  await oldAction("https://example.com/docs");
  await renderEntry(<OwnerButton selected={ref} />);
  await oldAction("https://example.com/returned-route");
  expect(state.allocate).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
  expect(state.external).not.toHaveBeenCalled();
  expect(state.visit).not.toHaveBeenCalled();
});
